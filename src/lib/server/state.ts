/**
 * Server-side shared state for the UI.
 *
 * Dispatcharr data is cached in module scope and refreshed on demand: the
 * preview endpoint fires on every keystroke and must never hit Dispatcharr, and
 * the match index costs a normalisation pass over ~22,000 streams that has no
 * business being in the typing loop.
 */

import { readFileSync, renameSync, writeFileSync } from 'fs';
import { type Config, loadConfig, requireCredentials } from '../config';
import type { Channel, Group, Provider, Stream } from '../dispatcharr';
import { DispatcharrClient } from '../dispatcharr';
import type { GroupPattern, GroupPolicy } from '../eligibility';
import { parseGroupPatterns } from '../eligibility';
import type { Matcher, StreamIndex } from '../matcher';
import type { OrderingConfig } from '../ordering';
import type { MaxResolution, MinResolution } from '../resolution';
import { readRulesFile } from '../rules';
import { RulesSource } from '../rules-source';
import { resolveEnv } from '../settings';
import { Store } from '../store';

const CACHE_TTL_MS = 300_000;
/**
 * How old a persisted crawl may be and still be served on a cold start. The
 * in-memory TTL is minutes because re-crawling is cheap; surviving a restart
 * is worth a wider band because the alternative is the full crawl on the
 * first page view.
 */
const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

/** Resolution floors set on individual channels (reloaded on mtime). */
export function channelFloors(): Map<number, MinResolution | null> {
  return source().get().channelFloors;
}

/** Resolution ceilings set on individual channels (reloaded on mtime). */
export function channelCeilings(): Map<number, MaxResolution | null> {
  return source().get().channelCeilings;
}

export async function snapshot(force = false): Promise<Snapshot> {
  if (!force && cache.snapshot && Date.now() - cache.snapshot.fetchedAt < CACHE_TTL_MS) {
    return cache.snapshot;
  }

  // An explicit refresh (the Reload button) means "crawl now": the caller is
  // waiting for a genuinely fresh catalogue and a stale answer would be a lie.
  // Everything below this line is only for the implicit paths.
  if (force) {
    if (cache.inflight) return cache.inflight;
    cache.inflight = revalidate();
    try {
      return await cache.inflight;
    } finally {
      cache.inflight = null;
    }
  }

  // An expired-but-present snapshot is served as-is while the crawl runs in
  // the background. The alternative -- blocking every request for the full
  // crawl once the TTL lapses -- is why opening the page after a short absence
  // cost eleven seconds before it drew anything. Stale data here is group
  // structure and channel names, which change rarely; the age is reported in
  // the payload so the UI can say what it is looking at.
  if (cache.snapshot) {
    startRevalidate();
    return cache.snapshot;
  }

  // Cold process. The last crawl is persisted alongside the rest of the state,
  // so a restart serves the UI from disk and lets the background crawl catch
  // up -- the restart itself is not a reason the page should hang.
  const persisted = loadPersistedSnapshot();
  if (persisted) {
    cache.snapshot = persisted;
    if (Date.now() - persisted.fetchedAt >= CACHE_TTL_MS) startRevalidate();
    return persisted;
  }

  // Nothing to serve, so the first request after a truly cold start waits for
  // the crawl. Concurrent callers share it.
  if (cache.inflight) return cache.inflight;
  cache.inflight = revalidate();
  try {
    return await cache.inflight;
  } finally {
    cache.inflight = null;
  }
}

/** Crawl Dispatcharr, cache and persist the result. Never called concurrently. */
async function revalidate(): Promise<Snapshot> {
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
  persistSnapshot(snap);
  // The index contains references to the previous snapshot's streams. Drop it
  // as soon as a replacement arrives, rather than retaining two catalogues
  // until the next route happens to request matching.
  cache.index = null;
  cache.indexToken = '';
  return snap;
}

/**
 * Kick off a crawl in the background, deduplicated the same way the blocking
 * path is: one crawl at a time, whoever needs the result awaits `inflight`.
 */
function startRevalidate(): void {
  if (cache.inflight) return;
  const run: Promise<Snapshot> = revalidate().catch(() => {
    // A failed background crawl leaves the stale snapshot in place, which is
    // still worth serving -- Dispatcharr being down should not turn the page
    // into an error it was drawing fine a minute ago. The next request tries
    // again. (The stale snapshot is always present here: this is only called
    // when there is one to fall back to.)
    return cache.snapshot as Snapshot;
  });
  cache.inflight = run;
  // Not awaited on purpose; see the catch above for failure handling. The
  // inflight slot is cleared when the crawl settles, whoever awaited it or not.
  void run.finally(() => {
    if (cache.inflight === run) cache.inflight = null;
  });
}

/**
 * Write the crawl to `catalogue.json` via a temp file, so a crash mid-write
 * never leaves a half-readable cache behind. Best effort: an unwritable data
 * directory costs a crawl on restart, not a page.
 */
function persistSnapshot(snap: Snapshot): void {
  try {
    const path = config().cataloguePath;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap), 'utf8');
    renameSync(tmp, path);
  } catch {
    // left unpersisted
  }
}

/**
 * Read back what `persistSnapshot` wrote. A week is the trust horizon: past
 * that the catalogue may have been rebuilt wholesale, and silently ranking
 * against channels that no longer exist is worse than the crawl.
 */
function loadPersistedSnapshot(): Snapshot | null {
  try {
    const snap = JSON.parse(readFileSync(config().cataloguePath, 'utf8')) as Snapshot;
    if (!Array.isArray(snap.channels) || !Array.isArray(snap.streams)) return null;
    if (typeof snap.fetchedAt !== 'number') return null;
    if (Date.now() - snap.fetchedAt > PERSIST_MAX_AGE_MS) return null;
    return snap;
  } catch {
    return null;
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
