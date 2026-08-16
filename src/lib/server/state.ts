/**
 * Server-side shared state for the UI.
 *
 * Dispatcharr data is cached in module scope and refreshed on demand: the
 * preview endpoint fires on every keystroke and must never hit Dispatcharr, and
 * the match index costs a normalisation pass over ~22,000 streams that has no
 * business being in the typing loop.
 */

import { renameSync, writeFileSync } from 'fs';
import { type Config, loadConfig, requireCredentials } from '../config';
import type { Channel, Group, Provider, Stream } from '../dispatcharr';
import { DispatcharrClient } from '../dispatcharr';
import type { GroupPattern, GroupPolicy } from '../eligibility';
import { parseGroupPatterns } from '../eligibility';
import type { Matcher, StreamIndex } from '../matcher';
import type { OrderingConfig } from '../ordering';
import { readRulesFile } from '../rules';
import { RulesSource } from '../rules-source';
import { resolveEnv } from '../settings';
import { Store } from '../store';

const CACHE_TTL_MS = 300_000;

export interface Snapshot {
  channels: Channel[];
  streams: Stream[];
  providers: Provider[];
  groups: Group[];
  fetchedAt: number;
}

interface Cache {
  snapshot: Snapshot | null;
  inflight: Promise<Snapshot> | null;
  matcher: Matcher | null;
  policies: Map<number, GroupPolicy>;
  patterns: GroupPattern[];
  index: StreamIndex | null;
  indexToken: string;
  config: Config | null;
  settingsVersion: number;
}

const cache: Cache = {
  snapshot: null,
  inflight: null,
  matcher: null,
  policies: new Map(),
  patterns: [],
  index: null,
  indexToken: '',
  config: null,
  settingsVersion: -1,
};

/**
 * Config as the app is actually running it: environment, then the settings
 * table on top.
 *
 * The worker has resolved settings this way since they were addable from the
 * UI; the web half never did, so a credential entered on the settings page took
 * effect for probing but left every page here still reading the environment --
 * which, for anyone who cleared the environment variables in order to use the
 * UI, meant the UI never worked at all.
 *
 * Paths come from the environment only, so opening the store to read the rest
 * is not circular. `settingsVersion` is a cheap integer read, which keeps this
 * honest on every request without reopening the database each time.
 */
export function config(): Config {
  const base = loadConfig();
  try {
    // Held open rather than reopened: every `new Store` re-runs the schema DDL
    // and pragmas, and this is called several times per request -- including
    // from the preview endpoint, which fires on every keystroke.
    if (!settingsStore) settingsStore = new Store(base.dbPath);
    const version = settingsStore.settingsVersion();
    if (!cache.config || cache.settingsVersion !== version) {
      cache.config = loadConfig(resolveEnv(process.env, settingsStore.settings()));
      cache.settingsVersion = version;
    }
    return cache.config;
  } catch {
    // No database yet, or it is unreadable. The environment is the best we
    // have, and it must not take the page down.
    settingsStore = null;
    return base;
  }
}

/** Long-lived handle for reading the settings table. See `config`. */
let settingsStore: Store | null = null;

function client(): DispatcharrClient {
  const c = config();
  // Fail here with the actionable message rather than letting Dispatcharr
  // return an opaque 401 for an empty credential.
  requireCredentials(c);
  return new DispatcharrClient(c.DISPATCHARR_URL, {
    apiKey: c.DISPATCHARR_API_KEY,
    username: c.DISPATCHARR_USERNAME,
    password: c.DISPATCHARR_PASSWORD,
  });
}

export function readRulesDoc(): Record<string, unknown> {
  return readRulesFile(config().rulesPath).doc as Record<string, unknown>;
}

/** Write via a temp file: a crash mid-write must not leave rules unparseable. */
export function writeRulesDoc(doc: unknown): void {
  const path = config().rulesPath;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 1), 'utf8');
  renameSync(tmp, path);
  // The mtime check would catch this anyway; being explicit avoids depending on
  // filesystem timestamp resolution for a write we know just happened.
  source().invalidate();
  cache.matcher = null;
  cache.index = null;
  cache.indexToken = '';
}

// Shared with the worker's view of the same file: keyed on mtime, so an edit
// made anywhere is picked up everywhere without a restart.
let rulesSource: RulesSource | null = null;

function source(): RulesSource {
  if (!rulesSource) rulesSource = new RulesSource(config().rulesPath);
  return rulesSource;
}

export function matcher(): Matcher {
  const loaded = source().get();
  if (cache.matcher !== loaded.matcher) {
    cache.matcher = loaded.matcher;
    cache.policies = loaded.policies;
    cache.patterns = parseGroupPatterns(readRulesDoc().group_patterns);
    // The index is built against the old matcher; drop it.
    cache.index = null;
    cache.indexToken = '';
  }
  return loaded.matcher;
}

export function policies(): Map<number, GroupPolicy> {
  matcher(); // ensures policies are loaded alongside the rules
  return cache.policies;
}

export function groupPatterns(): GroupPattern[] {
  matcher();
  return cache.patterns;
}

/** The ranking strategy from the rules `ordering` block (reloaded on mtime). */
export function ordering(): OrderingConfig {
  return source().get().ordering;
}

export async function snapshot(force = false): Promise<Snapshot> {
  if (!force && cache.snapshot && Date.now() - cache.snapshot.fetchedAt < CACHE_TTL_MS) {
    return cache.snapshot;
  }
  // Concurrent callers share one fetch; otherwise every request in a burst
  // triggers its own full crawl of Dispatcharr.
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    const api = client();
    await api.login();
    const [channels, streams, providers, groups] = await Promise.all([
      api.channels(),
      api.streams(),
      api.providers(),
      api.groups(),
    ]);
    const snap: Snapshot = { channels, streams, providers, groups, fetchedAt: Date.now() };
    cache.snapshot = snap;
    return snap;
  })();

  try {
    return await cache.inflight;
  } finally {
    cache.inflight = null;
  }
}

/**
 * Fold a stream-order write we just made into the cached snapshot.
 *
 * Every page here reads the five-minute snapshot, so a write made from the UI
 * is invisible to the very view that made it: applying an order, or dropping a
 * stray, left the channel editor listing the old lineup until the cache expired
 * or the user hit Refresh -- and Refresh costs a full crawl of Dispatcharr to
 * learn one thing we already know. Patching the one channel we wrote keeps the
 * cached copy true without the crawl.
 *
 * Only the stream array moves; nothing else about the channel changed, and the
 * match index is built from the stream catalogue, not from assignments.
 */
export function noteStreamOrder(channelId: number, streams: number[]): void {
  const channel = cache.snapshot?.channels.find((c) => c.id === channelId);
  if (channel) channel.streams = [...streams];
}

export async function index(): Promise<StreamIndex> {
  const snap = await snapshot();
  const m = matcher();
  // The group globs are part of the index's identity: editing the excluded
  // groups has to rebuild it, and nothing else about the snapshot changed.
  const token = `${snap.fetchedAt}:${snap.streams.length}:${m.guards.excludeGroups.join('|')}`;
  if (!cache.index || cache.indexToken !== token) {
    cache.index = m.buildIndex(snap.streams, new Map(snap.groups.map((g) => [g.id, g.name])));
    cache.indexToken = token;
  }
  return cache.index;
}

/**
 * Groups that hold provider *streams*, with how many and how many are claimed.
 *
 * The counterpart to `userGroups`, which counts channels: a provider group like
 * "PPV EVENTS" or "MLB" contains no channels at all, so it never appeared in
 * the UI even though its streams were live candidates for every rule.
 *
 * `claimed` is the number that some channel currently matches, which is the
 * only figure that says whether excluding the group would change anything.
 */
export function streamGroups(
  snap: Snapshot,
  claimedIds: Set<number>,
): Array<Group & { streams: number; claimed: number }> {
  const counts = new Map<number, { streams: number; claimed: number }>();
  for (const stream of snap.streams) {
    if (stream.groupId === null) continue;
    const row = counts.get(stream.groupId) ?? { streams: 0, claimed: 0 };
    row.streams += 1;
    if (claimedIds.has(stream.id)) row.claimed += 1;
    counts.set(stream.groupId, row);
  }
  const names = new Map(snap.groups.map((g) => [g.id, g.name]));
  return [...counts.entries()]
    .map(([id, row]) => ({ id, name: names.get(id) ?? String(id), ...row }))
    .sort((a, b) => b.claimed - a.claimed || b.streams - a.streams || a.name.localeCompare(b.name));
}

/** Only groups that actually contain channels -- not all 2,782 provider groups. */
export function userGroups(snap: Snapshot): Array<Group & { channels: number }> {
  const counts = new Map<number, number>();
  for (const channel of snap.channels) {
    if (channel.groupId === null) continue;
    counts.set(channel.groupId, (counts.get(channel.groupId) ?? 0) + 1);
  }
  const names = new Map(snap.groups.map((g) => [g.id, g.name]));
  return [...counts.entries()]
    .map(([id, channels]) => ({ id, name: names.get(id) ?? String(id), channels }))
    .sort((a, b) => b.channels - a.channels);
}
