/**
 * What Teamarr knows about a stream that Dispatcharr cannot say.
 *
 * Two rule types have always been holes in the simulation. `epg_match` reads
 * whether Teamarr attached a stream from EPG programme data, `stream_type`
 * reads whether it matched as an event or a team feed, and both live in
 * Teamarr's own `managed_channel_streams` table -- nowhere in Dispatcharr, and
 * so nowhere Podium could reach. `compileRules` declared them unevaluable,
 * which made every rule set carrying one *approximate*, which in turn dragged
 * the push's before/after comparison toward a regression that might not be
 * real. That is the reason `force` exists.
 *
 * They were never unknowable, only unasked for. Teamarr's own channels API
 * returns both, per stream, per channel -- so this reads them and hands back an
 * index the scorer can consult.
 *
 * The cost is the reason this is a module with a policy rather than two lines
 * in the client. There is no bulk endpoint: it is one HTTP call per channel,
 * and each one makes Teamarr refresh its stats cache from Dispatcharr for any
 * stream whose reading is absent or over an hour old. So the read is scoped to
 * the channels the check will actually score, capped, and run a few at a time
 * -- and every failure degrades to exactly the behaviour that was there before
 * rather than failing the pass.
 */

import type { ChannelStreamRow, TeamarrClient } from './teamarr-client';

/** Teamarr's attach-time verdict on one stream of one channel. */
export interface StreamMatch {
  matchMethod: string | null;
  matchType: string | null;
}

/**
 * The lookup, keyed by channel *and* stream.
 *
 * Not by stream alone, and the distinction is the whole point of the feature:
 * an EPG-matched stream is a time-shared linear channel sitting on every
 * fixture that airs on it, and it can be an `epg` match on one and a name match
 * on another. Keying by stream would collapse those into whichever was read
 * last.
 */
export type MatchIndex = Map<string, StreamMatch>;

export function matchKey(channelId: number, streamId: number): string {
  return `${channelId}:${streamId}`;
}

/**
 * How much of Teamarr's inventory carries a reading, split by how it was
 * attached.
 *
 * The number this feature exists to produce. A `stats_metric` rule does not
 * fire on a stream with no `stream_stats`, so a bitrate rule only ever sorts
 * the probed part of the catalogue -- and if that part is mostly one match
 * class, the rule is a bonus for being in that class wearing a bitrate's name.
 * Whether that is happening is not a matter of judgement once this is measured.
 */
export interface MatchCoverage {
  /** Channels Teamarr answered for. */
  channels: number;
  /** (channel, stream) rows read. */
  streams: number;
  /** Of those, how many Teamarr holds a stats reading for. */
  withStats: number;
  /** The same split by `matchMethod`, with `unknown` standing in for null. */
  byMethod: Record<string, { streams: number; withStats: number }>;
  /** Channels asked about that Teamarr does not manage. */
  unmatched: number;
  /** Channels left unread because the cap was reached. */
  skipped: number;
}

export interface MatchRead {
  index: MatchIndex;
  coverage: MatchCoverage;
}

export interface ReadOptions {
  /**
   * Most channels to read in one pass.
   *
   * A ceiling on somebody else's database, not on Podium's patience. Each
   * channel is one request that can make Teamarr fetch from Dispatcharr, so an
   * install with thousands of fixtures should not have all of them swept
   * because a rule check ran. Channels beyond it are counted in
   * `coverage.skipped` rather than silently dropped -- a partial index is
   * honest, an unremarked one is not.
   */
  maxChannels?: number;
  /** How many of those requests may be in flight at once. */
  concurrency?: number;
}

const DEFAULT_MAX_CHANNELS = 250;
const DEFAULT_CONCURRENCY = 4;

/** An empty read, which is what every caller falls back to. */
export function noMatches(): MatchRead {
  return {
    index: new Map(),
    coverage: { channels: 0, streams: 0, withStats: 0, byMethod: {}, unmatched: 0, skipped: 0 },
  };
}

function count(coverage: MatchCoverage, row: ChannelStreamRow): void {
  const method = row.matchMethod ?? 'unknown';
  coverage.byMethod[method] ??= { streams: 0, withStats: 0 };
  const bucket = coverage.byMethod[method];
  coverage.streams += 1;
  bucket.streams += 1;
  if (row.hasStats) {
    coverage.withStats += 1;
    bucket.withStats += 1;
  }
}

/**
 * Read match state for the given Dispatcharr channels.
 *
 * `wanted` is the population the caller is about to score, not everything
 * Teamarr manages: a channel with nothing to check costs a request and buys
 * nothing. Channels Teamarr does not manage are counted and skipped, which is
 * the ordinary case rather than an error -- Podium probes far more channels
 * than Teamarr creates.
 *
 * Throws only where the *first* call fails, which is the case that means the
 * URL or the instance is wrong. A per-channel failure after that is dropped:
 * a fixture deleted between the list and the read is a race, not a fault, and
 * losing one channel from the index costs the simulation one channel's worth of
 * precision.
 */
export async function readMatches(
  client: TeamarrClient,
  wanted: Iterable<number>,
  options: ReadOptions = {},
): Promise<MatchRead> {
  const maxChannels = options.maxChannels ?? DEFAULT_MAX_CHANNELS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const want = new Set(wanted);
  const { index, coverage } = noMatches();
  if (want.size === 0) return { index, coverage };

  const managed = await client.managedChannels();
  const byDispatcharr = new Map(managed.map((row) => [row.dispatcharrChannelId, row.id]));

  const targets: Array<{ dispatcharrId: number; teamarrId: number }> = [];
  for (const dispatcharrId of want) {
    const teamarrId = byDispatcharr.get(dispatcharrId);
    if (teamarrId === undefined) {
      coverage.unmatched += 1;
      continue;
    }
    targets.push({ dispatcharrId, teamarrId });
  }

  // Lowest id first, so a capped read is the same read twice running rather
  // than a different arbitrary quarter of the catalogue each time. A coverage
  // number that moves because the sample moved is not a measurement.
  targets.sort((a, b) => a.dispatcharrId - b.dispatcharrId);
  if (targets.length > maxChannels) {
    coverage.skipped = targets.length - maxChannels;
    targets.length = maxChannels;
  }

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const target = targets[next++];
      if (!target) return;
      let streams: ChannelStreamRow[];
      try {
        streams = await client.channelStreams(target.teamarrId);
      } catch {
        // See above: one channel lost, not the read.
        continue;
      }
      coverage.channels += 1;
      for (const row of streams) {
        index.set(matchKey(target.dispatcharrId, row.dispatcharrStreamId), {
          matchMethod: row.matchMethod,
          matchType: row.matchType,
        });
        count(coverage, row);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return { index, coverage };
}

/** A read that already knows what to do when Teamarr is unreachable. */
export interface AttemptedRead extends MatchRead {
  /**
   * Whether the read happened at all.
   *
   * The flag `compileRules` needs, and the reason this is not simply "is the
   * index empty". An install where Teamarr manages nothing returns an empty
   * index from a read that succeeded, and the honest thing to do with an
   * `epg_match` rule there is to score it as matching nothing -- which is what
   * it does. An install where the call failed knows nothing, and has to say so.
   */
  known: boolean;
  /** Why the read did not happen, for the operator rather than for the scorer. */
  error?: string;
}

/**
 * Read match state, treating a failure as an absence rather than an error.
 *
 * Every caller wants this rather than `readMatches`. A rule check that cannot
 * reach Teamarr is the check Podium ran for its whole life before this existed:
 * degraded to `approximate`, still worth running. Failing it instead would make
 * a reporting feature into a dependency.
 */
export async function tryReadMatches(
  client: TeamarrClient,
  wanted: Iterable<number>,
  options: ReadOptions = {},
): Promise<AttemptedRead> {
  try {
    return { ...(await readMatches(client, wanted, options)), known: true };
  } catch (error) {
    return { ...noMatches(), known: false, error: String(error).slice(0, 300) };
  }
}

/**
 * The coverage skew in a sentence, or null when there is nothing to say.
 *
 * Deliberately a statement about *stats coverage by match class* rather than a
 * verdict on the rules. Whether a bitrate ladder should be exported on an
 * install where only EPG-matched streams carry readings is a judgement; that
 * only they do is a fact, and it is the one an operator cannot get anywhere
 * else.
 */
export function describeSkew(coverage: MatchCoverage): string | null {
  if (coverage.streams === 0) return null;
  // Said whatever the match mix is: a ladder that fires on nothing is worth
  // knowing about on an install with no EPG-matched inventory too.
  if (coverage.withStats === 0) {
    return 'Teamarr holds no stats for any stream it scores, so stats_metric rules match nothing';
  }
  const epg = coverage.byMethod.epg;
  if (!epg || epg.streams === 0) return null;
  const other = coverage.withStats - epg.withStats;
  const epgShare = Math.round((epg.withStats / coverage.withStats) * 100);
  const epgRate = Math.round((epg.withStats / epg.streams) * 100);
  const otherStreams = coverage.streams - epg.streams;
  const otherRate = otherStreams > 0 ? Math.round((other / otherStreams) * 100) : 0;
  return (
    `${epgShare}% of the streams carrying stats are EPG-matched ` +
    `(${epgRate}% of EPG-matched streams have a reading, against ${otherRate}% of the rest)`
  );
}
