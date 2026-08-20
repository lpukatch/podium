/**
 * Prometheus exposition, derived from SQLite rather than in-process counters.
 *
 * Reading the database means the numbers are the same whether the worker shares
 * a process with the web server (the default) or runs on its own — an
 * in-process counter would silently report zeros in a split deployment.
 *
 * Hand-rolled rather than pulling in a client library: the text format is a
 * dozen lines, and everything here is a gauge computed at scrape time, so a
 * registry buys nothing.
 */

import { DEAD_REASONS, type DeadReason, deadReason, type ProbeResult } from './probe';
import { DEFAULT_WEIGHTS, isUsable, score } from './scoring';
import { type Progress, STALE_LOCK_MS, type Store } from './store';

type Labels = Record<string, string>;

/** Label values may contain a backslash, quote or newline; all three escape. */
function renderLabels(labels: Labels): string {
  const parts = Object.entries(labels).map(
    ([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
  );
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

class Exposition {
  private readonly lines: string[] = [];
  private readonly declared = new Set<string>();

  add(name: string, help: string, type: 'gauge' | 'counter', value: number, labels: Labels = {}) {
    if (!Number.isFinite(value)) return; // never emit NaN; Prometheus rejects it
    if (!this.declared.has(name)) {
      this.declared.add(name);
      this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    }
    this.lines.push(`${name}${renderLabels(labels)} ${value}`);
  }

  toString(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

const PHASES: Array<Progress['phase']> = [
  'idle',
  'fetching',
  'planning',
  'probing',
  'paused',
  'done',
  'failed',
];

/** One-hot verdict states, in isUsable's precedence order. */
const STATES = ['alive', 'dead', 'black', 'low_bitrate', 'unmeasured'] as const;
type ProviderStreamState = (typeof STATES)[number];

/**
 * The middle value, or the mean of the two middle ones. Callers guarantee a
 * non-empty list; sorting a copy because the samples are collected in
 * catalogue order and the caller may still want them that way.
 */
function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Resolution buckets by measured height. */
const RESOLUTIONS = ['uhd', 'fhd', 'hd', 'sd', 'unknown'] as const;
type ProviderResolution = (typeof RESOLUTIONS)[number];

export interface MetricsOptions {
  /** Freshness target, so compliance can be expressed as a ratio. */
  maxAgeMs: number;
  /** Beyond this with no heartbeat, the worker is considered absent. */
  staleLockMs?: number;
  /**
   * Expose the per-channel source series. Off unless asked, so a caller that
   * does not care never pays the cardinality; the route passes
   * `PODIUM_METRICS_CHANNELS`, which defaults on.
   */
  channelMetrics?: boolean;
  now?: number;
}

export function renderMetrics(store: Store, options: MetricsOptions): string {
  const now = options.now ?? Date.now();
  const staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
  const out = new Exposition();

  out.add('podium_up', 'Always 1; presence of this series means the API answered.', 'gauge', 1);

  // --- worker liveness -----------------------------------------------------
  // The question this whole endpoint exists to answer: is anything still
  // running? A stale ordering looks identical to a correct one from outside.
  const lock = store.lockState();
  const heartbeatAge = lock ? now - lock.heartbeat : null;
  out.add(
    'podium_worker_running',
    'Whether a worker holds the lock with a fresh heartbeat.',
    'gauge',
    heartbeatAge !== null && heartbeatAge < staleLockMs ? 1 : 0,
  );
  if (heartbeatAge !== null) {
    out.add(
      'podium_worker_heartbeat_age_seconds',
      'Seconds since the worker last touched its lock.',
      'gauge',
      Math.round(heartbeatAge / 1000),
    );
  }

  // --- current run ---------------------------------------------------------
  const progress = store.getProgress();
  for (const phase of PHASES) {
    out.add(
      'podium_run_phase',
      'Current run phase, one series per phase, 1 on the active one.',
      'gauge',
      progress.phase === phase ? 1 : 0,
      { phase },
    );
  }
  out.add('podium_run_probed', 'Streams probed in the current run.', 'gauge', progress.probed);
  out.add('podium_run_total', 'Streams selected for the current run.', 'gauge', progress.total);
  out.add('podium_run_dead', 'Dead streams found in the current run.', 'gauge', progress.dead);
  out.add(
    'podium_run_deferred',
    'Streams deferred because a provider had no spare capacity.',
    'gauge',
    progress.deferred,
  );
  if (progress.updatedAt > 0) {
    out.add(
      'podium_progress_age_seconds',
      'Seconds since progress was last written.',
      'gauge',
      Math.round((now - progress.updatedAt) / 1000),
    );
  }

  // --- provider lanes ------------------------------------------------------
  // Per provider, because the whole scheduling design is per provider: a lane
  // pinned at its limit while others idle is the signal worth alerting on.
  for (const lane of progress.lanes) {
    const labels = { provider: lane.name };
    out.add(
      'podium_lane_limit',
      'Concurrency limit for this provider.',
      'gauge',
      lane.limit,
      labels,
    );
    out.add('podium_lane_queued', 'Streams queued on this lane.', 'gauge', lane.queued, labels);
    out.add('podium_lane_done', 'Streams completed on this lane.', 'gauge', lane.done, labels);
    out.add(
      'podium_lane_dead',
      'Streams found dead on this lane.',
      'gauge',
      lane.dead ?? 0,
      labels,
    );
    out.add(
      'podium_lane_failed',
      'Streams whose probe errored on this lane.',
      'gauge',
      lane.failed,
      labels,
    );
    out.add(
      'podium_lane_in_flight',
      'Streams being probed on this lane right now.',
      'gauge',
      lane.current?.length ?? 0,
      labels,
    );
  }

  // --- lifetime totals -----------------------------------------------------
  const totals = store.runTotals();
  out.add('podium_runs_total', 'Runs recorded.', 'counter', totals.runs);
  out.add('podium_runs_failed_total', 'Runs that ended in an error.', 'counter', totals.failed);
  out.add('podium_streams_probed_total', 'Streams probed, all runs.', 'counter', totals.probed);
  out.add('podium_streams_cached_total', 'Probes served from cache.', 'counter', totals.cached);
  out.add('podium_streams_dead_total', 'Dead verdicts recorded.', 'counter', totals.dead);
  out.add('podium_channels_reordered_total', 'Channels reordered.', 'counter', totals.reordered);
  out.add(
    'podium_streams_assigned_total',
    'Streams put onto a channel that did not carry them, all runs. Zero unless PODIUM_AUTO_ASSIGN is on.',
    'counter',
    totals.assigned,
  );
  out.add('podium_probes_skipped_total', 'Probes skipped by an abort.', 'counter', totals.skipped);

  const lastRun = store.recentRuns(1)[0];
  if (lastRun) {
    out.add(
      'podium_last_run_start_timestamp_seconds',
      'Unix time the most recent run started.',
      'gauge',
      Math.round(lastRun.started_at / 1000),
    );
    if (lastRun.finished_at) {
      out.add(
        'podium_last_run_duration_seconds',
        'Duration of the most recent completed run.',
        'gauge',
        Math.round((lastRun.finished_at - lastRun.started_at) / 1000),
      );
    }
    out.add(
      'podium_last_run_failed',
      'Whether the most recent run ended in an error.',
      'gauge',
      lastRun.error ? 1 : 0,
    );
  }

  // --- freshness -----------------------------------------------------------
  const cache = store.cacheStats();
  out.add('podium_cache_entries', 'Streams with a cached verdict.', 'gauge', cache.total);
  out.add('podium_cache_alive', 'Cached verdicts that were alive.', 'gauge', cache.alive);
  out.add('podium_cache_dead', 'Cached verdicts that were dead.', 'gauge', cache.dead);
  // Prefer the worker's managed-oldest over the cache-wide MIN: the cache counts
  // verdicts on excluded, unmatched, and removed streams the pacer never
  // rechecks, which would flag a breach that is not real. Falls back to the
  // cache before the first pass (or from an older worker).
  const oldestAt = progress.oldestManagedProbedAt ?? cache.oldestProbedAt;
  if (oldestAt !== null) {
    const oldest = Math.round((now - oldestAt) / 1000);
    out.add(
      'podium_oldest_probe_age_seconds',
      'Age of the least recently probed stream the worker manages.',
      'gauge',
      oldest,
    );
    out.add(
      'podium_freshness_target_seconds',
      'The freshness target the pacer works towards.',
      'gauge',
      Math.round(options.maxAgeMs / 1000),
    );
    out.add(
      'podium_freshness_breaching',
      'Whether the oldest managed probe is past the freshness target.',
      'gauge',
      now - oldestAt > options.maxAgeMs ? 1 : 0,
    );
  }

  // --- provider quality -----------------------------------------------------
  // The catalogue snapshot joined against the probe cache, folded the same way
  // the UI folds it (`verdicts`: best variant per stream, default weights), so
  // the numbers here are the numbers every podium page already shows. Empty
  // until the first pass that fetches a catalogue -- an unconfigured install
  // reports nothing rather than zeros, because there is no catalogue to sum.
  const { rows, writtenAt } = store.catalogue();
  if (writtenAt !== null) {
    out.add(
      'podium_catalogue_age_seconds',
      'Seconds since a pass last wrote the whole catalogue snapshot.',
      'gauge',
      Math.round((now - writtenAt) / 1000),
    );
  }
  if (rows.length > 0) {
    const verdicts = store.verdicts([...new Set(rows.map((r) => r.streamId))]);

    // The same precedence `isUsable` applies when ranking: dead first, then a
    // black screen, then an honest-but-starved bitrate. 'alive' is therefore
    // exactly "would rank as usable", not merely "answered ffprobe".
    const stateOf = (result: ProbeResult | undefined): ProviderStreamState => {
      if (!result) return 'unmeasured';
      if (!result.alive) return 'dead';
      if (result.black) return 'black';
      if (result.bitrateKbps > 0 && result.bitrateKbps < DEFAULT_WEIGHTS.minBitrateKbps)
        return 'low_bitrate';
      return 'alive';
    };
    const resolutionOf = (
      result: ProbeResult | undefined,
      state: ProviderStreamState,
    ): ProviderResolution => {
      // A dead or unmeasured stream has no resolution worth reporting: a dead
      // verdict can carry the dimensions it died with, which would read as
      // "this provider has a 1080p stream" for a stream that answers nothing.
      if (state === 'dead' || state === 'unmeasured') return 'unknown';
      const h = result?.height ?? 0;
      if (h >= 2160) return 'uhd';
      if (h >= 1080) return 'fhd';
      if (h >= 720) return 'hd';
      if (h > 0) return 'sd';
      return 'unknown';
    };

    // Distinct streams and distinct channels per provider, not catalogue rows.
    // A stream matched onto twelve channels is one stream of one quality, and
    // counting it twelve times would rank a provider by how broadly its names
    // happen to match rather than by how good its streams are. Rank-1 below is
    // the deliberate exception: there, one channel is genuinely one contest.
    const streamIds = new Map<string, Set<number>>();
    const channelIds = new Map<string, Set<number>>();
    for (const row of rows) {
      let streams = streamIds.get(row.providerName);
      if (!streams) {
        streams = new Set();
        streamIds.set(row.providerName, streams);
        channelIds.set(row.providerName, new Set());
      }
      streams.add(row.streamId);
      channelIds.get(row.providerName)?.add(row.channelId);
    }

    // One channel is one contest for slot 0, so this one counts channels.
    const rank1 = new Map<string, { total: number; healthy: number }>();
    for (const row of rows) {
      if (row.slot !== 0) continue;
      const entry = rank1.get(row.providerName) ?? { total: 0, healthy: 0 };
      entry.total += 1;
      const verdict = verdicts.get(row.streamId)?.result;
      if (verdict && isUsable(verdict)) entry.healthy += 1;
      rank1.set(row.providerName, entry);
    }

    for (const [provider, providerStreams] of streamIds) {
      const labels = { provider };
      const states = new Map<ProviderStreamState, number>(STATES.map((s) => [s, 0]));
      const resolutions = new Map<ProviderResolution, number>(RESOLUTIONS.map((r) => [r, 0]));
      const deadReasons = new Map<DeadReason, number>(DEAD_REASONS.map((r) => [r, 0]));
      // Keyed by bucket so a provider can be compared at a like resolution:
      // 4500 kbps is generous at 720p and thin at 1080p, and one median across
      // a mixed line-up scores a provider on its channel mix, not its quality.
      const bitrates = new Map<ProviderResolution | 'all', number[]>();
      const ages: number[] = [];
      const scores: number[] = [];

      for (const streamId of providerStreams) {
        const cached = verdicts.get(streamId);
        const verdict = cached?.result;
        const state = stateOf(verdict);
        states.set(state, (states.get(state) ?? 0) + 1);
        const resolution = resolutionOf(verdict, state);
        resolutions.set(resolution, (resolutions.get(resolution) ?? 0) + 1);
        if (cached) ages.push(now - cached.probedAt);
        if (state === 'dead') {
          const reason = deadReason(verdict?.error ?? '');
          deadReasons.set(reason, (deadReasons.get(reason) ?? 0) + 1);
        }
        // Only the streams that would actually rank contribute a score: `score`
        // returns 0 for everything else, and a median dragged toward 0 by dead
        // streams would double-count what the state family already says.
        if (verdict && isUsable(verdict)) scores.push(score(verdict));
        // Only a bitrate the probe actually read counts toward the stats: a
        // declared one is exactly the number this section exists not to trust.
        if (verdict?.bitrateMeasured && verdict.bitrateKbps > 0) {
          for (const bucket of ['all', resolution] as const) {
            const list = bitrates.get(bucket) ?? [];
            list.push(verdict.bitrateKbps);
            bitrates.set(bucket, list);
          }
        }
      }

      for (const state of STATES) {
        out.add(
          'podium_provider_streams',
          'Distinct managed streams by last known verdict state. Precedence: dead > black > low_bitrate > alive; unmeasured means no verdict yet.',
          'gauge',
          states.get(state) ?? 0,
          { ...labels, state },
        );
      }
      for (const reason of DEAD_REASONS) {
        out.add(
          'podium_provider_dead_streams',
          "Dead streams by why they died. probe_error is ours (no ffprobe, bad payload), not the provider's.",
          'gauge',
          deadReasons.get(reason) ?? 0,
          { ...labels, reason },
        );
      }
      for (const resolution of RESOLUTIONS) {
        out.add(
          'podium_provider_resolution_streams',
          'Distinct managed streams by measured resolution, whether or not they are usable: a black 1080p slate still counts as fhd, and the state family is what says it is broken.',
          'gauge',
          resolutions.get(resolution) ?? 0,
          { ...labels, resolution },
        );
      }
      // Zero-filled so the same provider appears even with nothing measured:
      // a provider whose every stream declares its bitrate is precisely the
      // one this metric exists to flag, and an absent series cannot do that.
      out.add(
        'podium_provider_bitrate_measured',
        'Streams whose bitrate was measured rather than declared.',
        'gauge',
        bitrates.get('all')?.length ?? 0,
        labels,
      );
      for (const [bucket, samples] of bitrates) {
        out.add(
          'podium_provider_bitrate_kbps',
          "Median measured bitrate across this provider's managed streams, overall and within one resolution bucket.",
          'gauge',
          median(samples),
          { ...labels, resolution: bucket, stat: 'median' },
        );
      }
      if (scores.length > 0) {
        out.add(
          'podium_provider_score',
          "Median podium score across this provider's usable streams -- the same 0..1 number that decides ranking. Quality of what works; the state family carries how much of it works.",
          'gauge',
          Math.round(median(scores) * 1000) / 1000,
          { ...labels, stat: 'median' },
        );
      }
      // Without this, a provider compared on the families above is compared on
      // verdicts of unknown age -- and age is not evenly spread, because a lane
      // pinned at its provider's `max_streams` gets round-tripped least often.
      // "Provider B looks excellent" and "Provider B has not been checked since
      // Tuesday" produce identical numbers up there, and differ only here.
      if (ages.length > 0) {
        out.add(
          'podium_provider_verdict_age_seconds',
          'Age of the verdicts this provider is being judged on. A provider whose lane runs at its limit is probed least often, so its numbers are the stalest.',
          'gauge',
          Math.round(median(ages) / 1000),
          { ...labels, stat: 'median' },
        );
        out.add(
          'podium_provider_verdict_age_seconds',
          'Age of the verdicts this provider is being judged on. A provider whose lane runs at its limit is probed least often, so its numbers are the stalest.',
          'gauge',
          Math.round(Math.max(...ages) / 1000),
          { ...labels, stat: 'max' },
        );
      }
      // The denominator rank-1 needs. Wins over *all* channels measures how big
      // a provider's catalogue is; wins over the channels it actually contested
      // measures whether its streams are better, which is the question. Lives at
      // provider level on purpose -- deriving it from the per-channel series
      // would break for anyone who turned those off over cardinality.
      out.add(
        'podium_provider_channels',
        'Distinct channels carrying at least one of this provider streams, at any slot -- the denominator for rank-1 wins.',
        'gauge',
        channelIds.get(provider)?.size ?? 0,
        labels,
      );
      const top = rank1.get(provider);
      out.add(
        'podium_provider_rank1_channels',
        'Channels whose slot-0 stream belongs to this provider.',
        'gauge',
        top?.total ?? 0,
        labels,
      );
      out.add(
        'podium_provider_rank1_healthy',
        'Slot-0 channels whose verdict ranks as usable.',
        'gauge',
        top?.healthy ?? 0,
        labels,
      );
    }

    if (options.channelMetrics) {
      for (const row of rows) {
        // `channel_name` rides the info series alone. Repeating it on the value
        // series below would double their bytes to say what a join already
        // says, and would churn every one of them on a rename in Dispatcharr.
        const channel = { channel_id: String(row.channelId), slot: String(row.slot) };
        const verdict = verdicts.get(row.streamId)?.result;
        out.add(
          'podium_channel_source_info',
          "One series per (channel, slot): which provider's stream sits there. Carries the channel name for joining onto the series below.",
          'gauge',
          1,
          {
            channel_id: channel.channel_id,
            channel_name: row.channelName,
            slot: channel.slot,
            provider: row.providerName,
          },
        );
        out.add(
          'podium_channel_source_state',
          'Verdict state of the stream in this slot.',
          'gauge',
          1,
          { ...channel, state: stateOf(verdict) },
        );
        out.add(
          'podium_channel_source_height_pixels',
          "Measured video height of this slot's best verdict.",
          'gauge',
          verdict?.height ?? 0,
          channel,
        );
        out.add(
          'podium_channel_source_bitrate_kbps',
          "Bitrate of this slot's best verdict; 0 when unknown.",
          'gauge',
          verdict?.bitrateKbps ?? 0,
          channel,
        );
      }
    }
  }

  return out.toString();
}
