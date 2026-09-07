/**
 * The dead list: what `deadStreams()` knows, joined to what Dispatcharr has,
 * shaped for the page that answers "what is dead right now?".
 *
 * Pure on purpose. The join needs the live catalogue (names, providers, which
 * channel serves which stream where), the route needs to degrade gracefully
 * when the cache will not open, and the tests need to exercise the folding
 * without a Dispatcharr -- so the aggregation lives here as a function of two
 * plain inputs, and `src/app/api/dead/route.ts` is nothing but plumbing.
 */

import type { DeadStreamRow } from './store';
import { verdictStatus } from './variants';

/**
 * Structural stand-in for the snapshot, so the real thing satisfies it
 * without this file importing the server-only state module (and tests can
 * hand-build one). `streams` on a channel is ordered: position 0 is what a
 * viewer is served first.
 */
export interface DeadCatalog {
  streams: Array<{ id: number; name: string; providerId: number }>;
  channels: Array<{ id: number; name: string; groupId: number | null; streams: number[] }>;
  providers: Array<{ id: number; name: string }>;
}

/**
 * The list is capped for the same reason the all-channels page is: a render
 * with tens of thousands of rows helps nobody. Totals and aggregates are
 * computed before the cap so the numbers stay exact.
 */
export const DEAD_ENTRIES_CAP = 500;

export interface DeadEntry {
  streamId: number;
  name: string;
  providerId: number;
  provider: string;
  status: 'dead' | 'black';
  probedAt: number;
  /** Consecutive dead verdicts; 0 on a black-screen row (alive resets it). */
  deadStreak: number;
  error: string;
  /** 0 when unknown. A black slate usually carries real figures. */
  bitrateKbps: number;
  height: number;
  /** Where the stream sits on a channel: rank 1 is what viewers get first. */
  channels: Array<{ id: number; name: string; groupId: number | null; rank: number }>;
}

export interface DeadResponse {
  /** When the catalogue this was joined against was fetched. */
  fetchedAt: number;
  /** The cache would not open: the list is empty because it is unknown. */
  cacheUnavailable?: boolean;
  totals: {
    dead: number;
    black: number;
    /** Verdicts for streams no longer in the catalogue, waiting for the sweep. */
    orphans: number;
    /** Channels whose first-served stream is dead or black. */
    channelsServedFirst: number;
    /** Channels with at least one dead or black stream assigned. */
    channelsAffected: number;
    worstStreak: number;
    oldestProbedAt: number | null;
  };
  /** Only providers with something dead or black; worst first. */
  providers: Array<{
    id: number;
    name: string;
    dead: number;
    black: number;
    /** The provider's streams in the catalogue -- the denominator. */
    streams: number;
  }>;
  /** Only channels with at least one dead or black stream assigned. */
  channels: Array<{
    id: number;
    name: string;
    groupId: number | null;
    deadCount: number;
    assigned: number;
    servedFirstDead: boolean;
  }>;
  /** Worst first: longest dead streak, then longest-standing verdict. */
  entries: DeadEntry[];
  /** Before the cap. */
  entryTotal: number;
  truncated: boolean;
}

export function summarizeDead(
  rows: DeadStreamRow[],
  catalog: DeadCatalog,
  fetchedAt: number,
): DeadResponse {
  const streamById = new Map(catalog.streams.map((s) => [s.id, s]));
  const providerNames = new Map(catalog.providers.map((p) => [p.id, p.name]));

  // A dead verdict on a stream the catalogue no longer carries is not
  // something a channel is serving -- it is a row waiting for `pruneOutside`.
  // Counted, so the number reconciles against the Progress page's cache dead
  // figure, but never listed.
  const deadSet = new Map<number, DeadStreamRow>();
  let orphans = 0;
  for (const row of rows) {
    if (verdictStatus(row.result) === 'live') continue;
    if (!streamById.has(row.streamId)) {
      orphans += 1;
      continue;
    }
    deadSet.set(row.streamId, row);
  }

  const entries: DeadEntry[] = [];
  const byProvider = new Map<number, { dead: number; black: number }>();
  for (const [streamId, row] of deadSet) {
    const stream = streamById.get(streamId);
    if (!stream) continue; // unreachable: deadSet only holds catalogued ids
    const status = verdictStatus(row.result);
    if (status === 'live') continue; // unreachable for the same reason
    entries.push({
      streamId,
      name: stream.name,
      providerId: stream.providerId,
      provider: providerNames.get(stream.providerId) ?? String(stream.providerId),
      status,
      probedAt: row.probedAt,
      deadStreak: row.deadStreak,
      error: row.result.error ?? '',
      bitrateKbps: row.result.bitrateKbps ?? 0,
      height: row.result.height ?? 0,
      channels: [],
    });
    const tally = byProvider.get(stream.providerId) ?? { dead: 0, black: 0 };
    if (status === 'dead') tally.dead += 1;
    else tally.black += 1;
    byProvider.set(stream.providerId, tally);
  }

  // One pass over every channel's ordered stream array answers everything
  // channel-shaped: where each dead stream sits, which channels are affected,
  // and -- the question that motivated the Dead chip -- which ones are
  // serving a dead stream first.
  const entryById = new Map(entries.map((e) => [e.streamId, e]));
  const channels: DeadResponse['channels'] = [];
  for (const channel of catalog.channels) {
    let deadCount = 0;
    let servedFirstDead = false;
    for (const [i, id] of channel.streams.entries()) {
      if (!deadSet.has(id)) continue;
      deadCount += 1;
      if (i === 0) servedFirstDead = true;
      entryById.get(id)?.channels.push({
        id: channel.id,
        name: channel.name,
        groupId: channel.groupId,
        rank: i + 1,
      });
    }
    if (deadCount > 0) {
      channels.push({
        id: channel.id,
        name: channel.name,
        groupId: channel.groupId,
        deadCount,
        assigned: channel.streams.length,
        servedFirstDead,
      });
    }
  }

  const providerStreams = new Map<number, number>();
  for (const stream of catalog.streams) {
    providerStreams.set(stream.providerId, (providerStreams.get(stream.providerId) ?? 0) + 1);
  }
  const providers = [...byProvider.entries()]
    .filter(([, tally]) => tally.dead > 0 || tally.black > 0)
    .map(([id, tally]) => ({
      id,
      name: providerNames.get(id) ?? String(id),
      dead: tally.dead,
      black: tally.black,
      streams: providerStreams.get(id) ?? 0,
    }))
    .sort((a, b) => b.dead - a.dead || b.black - a.black || a.name.localeCompare(b.name));

  const deadEntries = entries.filter((e) => e.status === 'dead');
  const totals = {
    dead: deadEntries.length,
    black: entries.length - deadEntries.length,
    orphans,
    channelsServedFirst: channels.filter((c) => c.servedFirstDead).length,
    channelsAffected: channels.length,
    worstStreak: deadEntries.reduce((worst, e) => Math.max(worst, e.deadStreak), 0),
    oldestProbedAt: entries.length > 0 ? Math.min(...entries.map((e) => e.probedAt)) : null,
  };

  entries.sort((a, b) => b.deadStreak - a.deadStreak || a.probedAt - b.probedAt);

  return {
    fetchedAt,
    totals,
    providers,
    channels,
    entries: entries.slice(0, DEAD_ENTRIES_CAP),
    entryTotal: entries.length,
    truncated: entries.length > DEAD_ENTRIES_CAP,
  };
}
