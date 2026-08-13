import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextWait } from '../worker/loop';
import { loadConfig, requireCredentials } from './config';
import {
  type Channel,
  type DispatcharrClient,
  PAGE_CONCURRENCY,
  PAGE_SIZE,
  type Stream,
} from './dispatcharr';
import {
  AFTER_EPG_START,
  currentProgrammes,
  describeVerdict,
  Eligibility,
  globToRegExp,
  NEVER,
  parseGroupPatterns,
  parsePolicies,
} from './eligibility';
import { type Activity, Pacer, viewersByProvider } from './pacer';
import type { ProbeResult } from './probe';
import { RulesSource } from './rules-source';
import { composeOrder, Runner, type RunSummary, sameOrder } from './runner';
import { DEFAULT_STRATEGY, type RankEntry, type RankStrategy } from './scoring';
import { Store } from './store';

const NOW = new Date('2026-08-03T18:00:00Z');

function epgRows(offsetMinutes: number) {
  const start = new Date(NOW.getTime() + offsetMinutes * 60_000);
  return [
    {
      tvg_id: 'GAME.us',
      start_time: start.toISOString(),
      end_time: new Date(start.getTime() + 3 * 3_600_000).toISOString(),
      title: 'First Pitch',
    },
  ];
}

const idle: Activity = { channelIds: new Set(), idle: true };

const result = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  alive: true,
  width: 1920,
  height: 1080,
  fps: 30,
  bitrateKbps: 5000,
  videoCodec: 'h264',
  audioCodec: 'aac',
  pixelFormat: 'yuv420p',
  audioChannels: 2,
  elapsedMs: 100,
  error: '',
  ...over,
});

describe('eligibility', () => {
  it('always blocks a never group', () => {
    const e = new Eligibility(new Map([[7, { mode: NEVER, graceMinutes: 5, windowMinutes: 180 }]]));
    const verdict = e.allows(7, 'GAME.us', new Map(), NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('excluded');
  });

  it('needs no EPG for an always group', () => {
    expect(new Eligibility(new Map()).allows(1, '', new Map(), NOW).allowed).toBe(true);
  });

  it('blocks an event channel before kickoff', () => {
    const e = new Eligibility(
      new Map([[9, { mode: AFTER_EPG_START, graceMinutes: 5, windowMinutes: 180 }]]),
    );
    const verdict = e.allows(9, 'GAME.us', currentProgrammes(epgRows(0), NOW), NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('kickoff');
  });

  it('allows an event channel after the grace period', () => {
    const e = new Eligibility(
      new Map([[9, { mode: AFTER_EPG_START, graceMinutes: 5, windowMinutes: 180 }]]),
    );
    expect(e.allows(9, 'GAME.us', currentProgrammes(epgRows(-30), NOW), NOW).allowed).toBe(true);
  });

  it('blocks once the event window has passed', () => {
    const e = new Eligibility(
      new Map([[9, { mode: AFTER_EPG_START, graceMinutes: 5, windowMinutes: 60 }]]),
    );
    const verdict = e.allows(9, 'GAME.us', currentProgrammes(epgRows(-90), NOW), NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('window');
  });

  it('holds off when an event channel has no EPG', () => {
    // "Probe it anyway" would defeat the whole point of the policy.
    const e = new Eligibility(
      new Map([[9, { mode: AFTER_EPG_START, graceMinutes: 5, windowMinutes: 180 }]]),
    );
    const verdict = e.allows(9, 'UNKNOWN', new Map(), NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('EPG');
  });

  it('keeps the programme out of the reason and in the detail', () => {
    // The reason is a tally key, so it has to be the same string for every
    // channel in the same situation; the fixture belongs in `detail`, which is
    // what a single-channel view shows.
    const e = new Eligibility(
      new Map([[9, { mode: AFTER_EPG_START, graceMinutes: 5, windowMinutes: 60 }]]),
    );
    const passed = e.allows(9, 'GAME.us', currentProgrammes(epgRows(-90), NOW), NOW);
    expect(passed.reason).toBe('event window passed');
    expect(passed.detail).toBe('"First Pitch"');
    expect(describeVerdict(passed)).toBe('event window passed — "First Pitch"');

    const early = e.allows(9, 'GAME.us', currentProgrammes(epgRows(0), NOW), NOW);
    expect(early.reason).toBe('before kickoff');
    expect(early.detail).toBe('18:00Z "First Pitch"');
  });

  it('indexes only the programme airing now', () => {
    expect(currentProgrammes(epgRows(120), NOW).size).toBe(0);
    expect(currentProgrammes(epgRows(-10), NOW).has('GAME.us')).toBe(true);
  });

  it('parses both policy shapes and rejects junk', () => {
    const parsed = parsePolicies({
      '1': 'never',
      '2': { mode: 'after_epg_start', grace_minutes: 9 },
      x: 'never',
      '3': 'nonsense',
    });
    expect(parsed.get(1)?.mode).toBe(NEVER);
    expect(parsed.get(2)?.graceMinutes).toBe(9);
    expect(parsed.has(Number.NaN)).toBe(false);
    expect(parsed.get(3)?.mode).toBe('always');
  });
});

describe('pacing', () => {
  const pacer = (over = {}) =>
    new Pacer({
      maxAgeMs: 3_600_000,
      tickMs: 60_000,
      pauseWhenWatching: true,
      minFreeSlots: 1,
      maxSlice: 400,
      ...over,
    });

  it('closes every lane while someone is watching', () => {
    const busy: Activity = { channelIds: new Set([5]), idle: false };
    expect(
      pacer().laneLimits(
        new Map([
          [1, 3],
          [2, 5],
        ]),
        busy,
        new Map(),
      ).size,
    ).toBe(0);
  });

  it('shrinks lanes by live viewers and reserves a slot for them', () => {
    // Someone is watching, so the courtesy reserve applies:
    // provider 1: 3 slots - 1 in use - 1 held free = 1 usable
    // provider 2: 5 slots - 0 in use - 1 held free = 4 usable
    const busy: Activity = { channelIds: new Set([9]), idle: false };
    const limits = pacer({ pauseWhenWatching: false }).laneLimits(
      new Map([
        [1, 3],
        [2, 5],
      ]),
      busy,
      new Map([[1, 1]]),
    );
    expect([...limits]).toEqual([
      [1, 1],
      [2, 4],
    ]);
  });

  it('uses every slot when nobody is watching', () => {
    // A provider with max_streams=1 must still be checkable. Reserving a slot
    // while fully idle would give 1 - 0 - 1 = 0 and starve it forever.
    const limits = pacer({ pauseWhenWatching: false }).laneLimits(
      new Map([
        [5, 1],
        [6, 3],
      ]),
      idle,
      new Map(),
    );
    expect(limits.get(5)).toBe(1);
    expect(limits.get(6)).toBe(3);
  });

  it('drops a lane with no spare capacity while busy', () => {
    const busy: Activity = { channelIds: new Set([9]), idle: false };
    expect(
      pacer({ pauseWhenWatching: false }).laneLimits(new Map([[5, 1]]), busy, new Map([[5, 1]]))
        .size,
    ).toBe(0);
  });

  it('grows the slice as the deadline approaches', () => {
    const p = pacer();
    expect(p.sliceSize(600, 3_000_000)).toBeGreaterThan(p.sliceSize(600, 0));
  });

  it('runs flat out once breaching', () => {
    expect(pacer({ maxSlice: 100 }).sliceSize(500, 7_200_000)).toBe(100);
  });

  it('does no work with no backlog', () => {
    expect(pacer().sliceSize(0, 99_999_999)).toBe(0);
  });

  it('sizes slice against dead TTL target when dead items are due', () => {
    const deadTtlMs = 3 * 3600 * 1000; // 3h
    const deadBacklog = 416;
    const oldestDeadAgeMs = 3 * 3600 * 1000; // 3h (expired)
    const slice = pacer().sliceSize(deadBacklog, oldestDeadAgeMs, deadTtlMs);
    expect(slice).toBe(400);
  });

  it('enforces a minimum batch floor when backlog > 0', () => {
    const slice = pacer().sliceSize(5, 100);
    expect(slice).toBe(5);
  });

  it('reports compliance against the target', () => {
    const status = pacer().status(10, 7_200_000, 100);
    expect(status.compliance).toBe(90);
    expect(status.breaching).toBe(true);
  });

  it('counts viewers per provider', () => {
    const counts = viewersByProvider(
      [
        { providerId: 6, currentViewers: 2 },
        { providerId: 6, currentViewers: 0 },
        { providerId: 5, currentViewers: 1 },
      ],
      idle,
    );
    expect(counts.get(6)).toBe(2);
    expect(counts.get(5)).toBe(1);
  });
});

describe('store', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-'));
    store = new Store(join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a probe result', () => {
    store.put(1, 'hash-a', result());
    expect(store.get(1, 'hash-a', 60_000, 60_000)?.height).toBe(1080);
  });

  it('misses when the stream hash changes', () => {
    // The provider swapped the stream behind this id; the old verdict is void.
    store.put(1, 'hash-a', result());
    expect(store.get(1, 'hash-b', 60_000, 60_000)).toBeNull();
  });

  it('expires live and dead entries on separate TTLs', () => {
    store.put(1, 'h', result());
    store.put(2, 'h', result({ alive: false }));
    // Live TTL generous, dead TTL zero: the live one survives, the dead does not.
    expect(store.get(1, 'h', 60_000, 0)).not.toBeNull();
    expect(store.get(2, 'h', 60_000, 0)).toBeNull();
  });

  it('reports age and null for unknown streams', () => {
    store.put(1, 'h', result());
    expect(store.age(1, 'h')).toBeLessThan(1000);
    expect(store.age(99, 'h')).toBeNull();
  });

  it('records run history newest first', () => {
    store.startRun('a');
    store.finishRun('a', { probed: 3, dead: 1 });
    store.startRun('b');
    const runs = store.recentRuns(5);
    expect(runs[0]?.run_id).toBe('b');
    expect(runs[1]?.probed).toBe(3);
    expect(runs[1]?.finished_at).not.toBeNull();
  });

  it('prunes only rows older than the cutoff', () => {
    store.put(1, 'h', result());
    expect(store.prune(60_000)).toBe(0);
    expect(store.prune(-1)).toBe(1);
  });

  it('prunes only rows outside the managed stream set', () => {
    // 1 and 2 are still managed; 3 was excluded/disabled and 4 left every lineup.
    store.put(1, 'h', result());
    store.put(2, 'h', result());
    store.put(3, 'h', result());
    store.put(4, 'h', result());

    expect(store.pruneOutside(new Set([1, 2]))).toBe(2);
    // The managed streams survive; the orphans are gone.
    expect(store.get(1, 'h', 60_000, 60_000)).not.toBeNull();
    expect(store.get(2, 'h', 60_000, 60_000)).not.toBeNull();
    expect(store.cacheStats().total).toBe(2);
  });

  it('leaves the cache alone when nothing is managed', () => {
    // No rules, or every group excluded: an empty keep set is a state to leave
    // alone, not a request to wipe the cache.
    store.put(1, 'h', result());
    store.put(2, 'h', result());
    expect(store.pruneOutside(new Set())).toBe(0);
    expect(store.cacheStats().total).toBe(2);
  });

  it('summarises cache health and ages', () => {
    store.put(1, 'h', result());
    store.put(2, 'h', result());
    store.put(3, 'h', result({ alive: false }));
    const now = Date.now();

    const fresh = store.cacheHealth(24 * 3_600_000, 3 * 3_600_000, now);
    expect(fresh.total).toBe(3);
    expect(fresh.alive).toBe(2);
    expect(fresh.dead).toBe(1);
    expect(fresh.due).toBe(0);
    expect(fresh.ages.hour).toBe(3);

    // Seven hours on: the dead verdict has expired, the live ones have not,
    // and everything has moved into the six-to-24-hour bucket.
    const later = store.cacheHealth(24 * 3_600_000, 3 * 3_600_000, now + 7 * 3_600_000);
    expect(later.due).toBe(1);
    expect(later.ages.hour).toBe(0);
    expect(later.ages.day).toBe(3);
  });

  it('counts only the passes that did something as work', () => {
    store.startRun('a');
    store.finishRun('a', { probed: 4, dead: 1, reordered: 2 });
    store.startRun('b');
    store.finishRun('b', {}); // a quiet pass: nothing was due
    store.startRun('c');
    store.finishRun('c', { error: 'boom' });

    const stats = store.runStats(Date.now() - 3_600_000);
    expect(stats.passes).toBe(3);
    expect(stats.working).toBe(1);
    expect(stats.probed).toBe(4);
    expect(stats.reordered).toBe(2);
    expect(stats.failed).toBe(1);
    // Outside the window, nothing counts.
    expect(store.runStats(Date.now() + 1000).passes).toBe(0);
  });

  it('fills empty hours in the activity series', () => {
    store.startRun('a');
    store.finishRun('a', { probed: 9 });
    const series = store.activity(6);
    expect(series).toHaveLength(6);
    // The run just happened, so it lands in the last bucket and the rest are
    // present-but-zero rather than missing.
    expect(series[5]?.probed).toBe(9);
    expect(series.slice(0, 5).every((b) => b.probed === 0)).toBe(true);
  });
});

describe('idle back-off', () => {
  const NOW = Date.now();
  const config = loadConfig({
    DISPATCHARR_API_KEY: 'k',
    PODIUM_TICK_MS: String(60_000),
    PODIUM_IDLE_MAX_MS: String(900_000),
  });

  const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
    runId: 'r',
    elapsedMs: 10,
    channels: 0,
    probed: 0,
    cached: 100,
    dead: 0,
    reordered: 0,
    unchanged: 100,
    skipped: 0,
    deferred: 0,
    backlog: 0,
    nextDueAt: null,
    oldestProbedAt: null,
    eligibleChannels: 0,
    heldBack: {},
    lanes: {},
    paused: false,
    ...over,
  });

  it('sleeps until the next verdict expires when a pass did nothing', () => {
    // The whole point: a pass fetches every channel and stream, so repeating
    // one a minute later when nothing has expired is load with no answer in it.
    const { waitMs, idle } = nextWait(config, summary(), NOW + 400_000, NOW);
    expect(waitMs).toBe(400_000);
    expect(idle).toBe(true);
  });

  it('never sleeps past the idle cap, so new streams are still noticed', () => {
    expect(nextWait(config, summary(), NOW + 20 * 3_600_000, NOW).waitMs).toBe(900_000);
  });

  it('keeps the normal cadence when the pass did work', () => {
    expect(nextWait(config, summary({ probed: 3 }), NOW + 3_600_000, NOW).waitMs).toBe(60_000);
    expect(nextWait(config, summary({ reordered: 1 }), NOW + 3_600_000, NOW).waitMs).toBe(60_000);
    // Deferred streams are work a saturated provider pushed to a later pass.
    expect(nextWait(config, summary({ deferred: 9 }), NOW + 3_600_000, NOW).waitMs).toBe(60_000);
  });

  it('comes back promptly when someone is watching', () => {
    expect(nextWait(config, summary({ paused: true }), NOW + 3_600_000, NOW).waitMs).toBe(60_000);
    expect(nextWait(config, null, NOW + 3_600_000, NOW).waitMs).toBe(60_000);
  });

  it('does not sleep through a kickoff', () => {
    // An excluded group stays excluded, so it is no reason to wake early; a
    // channel waiting for its programme to start turns eligible on the clock.
    expect(
      nextWait(config, summary({ heldBack: { 'group excluded': 12 } }), NOW + 3_600_000, NOW).idle,
    ).toBe(true);
    expect(
      nextWait(
        config,
        summary({ heldBack: { 'before kickoff (19:30Z)': 2 } }),
        NOW + 3_600_000,
        NOW,
      ).waitMs,
    ).toBe(60_000);
  });

  it('runs at the normal interval when something is already overdue', () => {
    expect(nextWait(config, summary(), NOW - 5_000, NOW).waitMs).toBe(60_000);
    expect(nextWait(config, summary(), null, NOW).waitMs).toBe(60_000);
  });
});

describe('reordering', () => {
  it('treats an unchanged ordering as nothing to write', () => {
    // Dispatcharr already serves this exact list; PATCHing it again was 420
    // writes a minute on a settled install, and buried the passes that did
    // change something under a constant "420 reordered".
    expect(sameOrder([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(sameOrder([1, 2, 3], [1, 3, 2])).toBe(false);
    expect(sameOrder([1, 2], [1, 2, 3])).toBe(false);
    expect(sameOrder([], [])).toBe(true);
  });
});

describe('composeOrder', () => {
  it('keeps only the ranked streams that are already on the channel', () => {
    // Stream 999 matched the rule but Dispatcharr never assigned it; writing it
    // would add it to the channel. Only 10 and 20 (ranked, on the channel) move.
    expect(composeOrder([999, 10, 20], [10, 20, 30])).toEqual([10, 20, 30]);
  });

  it('appends streams the rule did not match after the ranked ones', () => {
    expect(composeOrder([10, 20], [20, 10, 30])).toEqual([10, 20, 30]);
  });

  it('drops unclaimed streams when removeUnmatched is set', () => {
    expect(composeOrder([10, 20], [20, 10, 30], true)).toEqual([10, 20]);
  });

  it('changes nothing when no ranked stream is on the channel', () => {
    // The rule matched only streams the channel does not carry. There is nothing
    // to reorder, so the channel is left exactly as it is.
    expect(composeOrder([999], [10, 20])).toEqual([10, 20]);
  });
});

describe('config', () => {
  const base = { DISPATCHARR_API_KEY: 'k' };

  it('reports whether there are credentials, without refusing to load', () => {
    // Loading must succeed with none: the settings page is how they get
    // entered, and it cannot be served by a process that exited at boot.
    expect(loadConfig({}).hasCredentials).toBe(false);
    expect(loadConfig({ DISPATCHARR_API_KEY: 'k' }).hasCredentials).toBe(true);
    expect(
      loadConfig({ DISPATCHARR_USERNAME: 'u', DISPATCHARR_PASSWORD: 'p' }).hasCredentials,
    ).toBe(true);
    // A half-filled username/password pair is not a credential.
    expect(loadConfig({ DISPATCHARR_USERNAME: 'u' }).hasCredentials).toBe(false);
  });

  it('still has paths without credentials, so the store stays reachable', () => {
    // Every route that only needs the database used to fail here too.
    const config = loadConfig({ PODIUM_DATA_DIR: '/data' });
    expect(config.dbPath).toBe('/data/podium.db');
    expect(config.rulesPath).toBe('/data/rules.json');
  });

  it('fails at the point of use instead', () => {
    expect(() => requireCredentials(loadConfig({}))).toThrow(/DISPATCHARR_API_KEY/);
    expect(() => requireCredentials(loadConfig({ DISPATCHARR_API_KEY: 'k' }))).not.toThrow();
  });

  it('falls back rather than failing on an unparseable number', () => {
    expect(loadConfig({ ...base, PODIUM_ANALYZE_SECONDS: 'abc' }).PODIUM_ANALYZE_SECONDS).toBe(6);
  });

  it('reads booleans in the usual spellings', () => {
    expect(loadConfig({ ...base, PODIUM_DRY_RUN: 'yes' }).PODIUM_DRY_RUN).toBe(true);
    expect(loadConfig({ ...base, PODIUM_DRY_RUN: 'off' }).PODIUM_DRY_RUN).toBe(false);
    expect(loadConfig(base).PODIUM_PAUSE_WHEN_WATCHING).toBe(true);
  });

  it('derives data paths from the data dir', () => {
    const config = loadConfig({ ...base, PODIUM_DATA_DIR: '/d' });
    expect(config.dbPath).toBe('/d/podium.db');
    expect(config.rulesPath).toBe('/d/rules.json');
  });
});

describe('paging constants', () => {
  it('keeps page concurrency bounded', () => {
    // Unbounded concurrency measured ~10x slower against Dispatcharr's Django
    // worker pool; this guards the fix from being "optimised" back.
    expect(PAGE_CONCURRENCY).toBeGreaterThan(1);
    expect(PAGE_CONCURRENCY).toBeLessThanOrEqual(8);
    expect(PAGE_SIZE).toBeGreaterThanOrEqual(100);
  });
});

describe('lane capacity contract', () => {
  it('a closed lane must be dropped, not left to the default limit', () => {
    // Provider 5 has 1 slot and minFreeSlots=1, so the pacer leaves it out.
    // The scheduler falls back to DEFAULT_LANE_LIMIT (1) for an unknown
    // provider, so jobs on a closed lane must be filtered by the caller or
    // they would still be probed -- exactly the bug a live dry-run exposed.
    const p = new Pacer({
      maxAgeMs: 3_600_000,
      tickMs: 60_000,
      pauseWhenWatching: false,
      minFreeSlots: 1,
      maxSlice: 400,
    });
    const busy: Activity = { channelIds: new Set([9]), idle: false };
    const limits = p.laneLimits(
      new Map([
        [5, 1],
        [6, 3],
        [7, 5],
      ]),
      busy,
      new Map(),
    );
    expect(limits.has(5)).toBe(false);
    expect(limits.get(6)).toBe(2);
    expect(limits.get(7)).toBe(4);

    const jobs = [{ providerId: 5 }, { providerId: 6 }, { providerId: 7 }];
    expect(jobs.filter((j) => limits.has(j.providerId))).toHaveLength(2);
  });
});

describe('group name patterns', () => {
  it('applies a glob to matching group names', () => {
    const e = new Eligibility(new Map(), undefined, [
      { pattern: 'Auto | *', mode: NEVER, graceMinutes: 5, windowMinutes: 180 },
    ]);
    expect(e.policyFor(1, 'Auto | Baseball | MLB').mode).toBe(NEVER);
    expect(e.policyFor(2, 'Auto | Soccer | Carabao Cup').mode).toBe(NEVER);
    expect(e.policyFor(3, 'Sports | US').mode).toBe('always');
  });

  it('lets an explicit group id override a pattern', () => {
    const e = new Eligibility(
      new Map([[1, { mode: 'always' as const, graceMinutes: 5, windowMinutes: 180 }]]),
      undefined,
      [{ pattern: 'Auto | *', mode: NEVER, graceMinutes: 5, windowMinutes: 180 }],
    );
    expect(e.policyFor(1, 'Auto | Baseball | MLB').mode).toBe('always');
  });

  it('escapes regex metacharacters in the glob', () => {
    // "|" and "." are literal in a group name, not alternation and any-char.
    expect(globToRegExp('Auto | *').test('Auto | Baseball')).toBe(true);
    expect(globToRegExp('Auto | *').test('Autox Baseball')).toBe(false);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });

  it('parses and validates pattern rules', () => {
    const parsed = parseGroupPatterns([
      { pattern: 'Auto | *', mode: 'never' },
      { pattern: '  ', mode: 'never' },
      { pattern: 'X', mode: 'bogus' },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.mode).toBe(NEVER);
    expect(parsed[1]?.mode).toBe('always');
    expect(parseGroupPatterns(null)).toEqual([]);
  });
});

describe('worker lock', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-lock-'));
    store = new Store(join(dir, 'lock.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets one worker in and keeps the next out', () => {
    // Two workers would double-probe every stream and race each other's
    // reorders into Dispatcharr.
    expect(store.acquireLock('a').ok).toBe(true);
    const second = store.acquireLock('b');
    expect(second.ok).toBe(false);
    expect(second.heldBy).toBe('a');
  });

  it('is reentrant for the same owner', () => {
    expect(store.acquireLock('a').ok).toBe(true);
    expect(store.acquireLock('a').ok).toBe(true);
  });

  it('takes over a lock whose heartbeat went stale', () => {
    // A SIGKILLed worker never releases; without takeover the deployment stays
    // dead until someone clears a row by hand.
    store.acquireLock('a');
    expect(store.acquireLock('b', -1).ok).toBe(true);
  });

  it('frees the lock on release', () => {
    store.acquireLock('a');
    store.releaseLock('a');
    expect(store.acquireLock('b').ok).toBe(true);
  });

  it('ignores a release from someone who does not hold it', () => {
    store.acquireLock('a');
    store.releaseLock('b');
    expect(store.acquireLock('c').ok).toBe(false);
  });
});

describe('Runner.plan (managed set + oldest check)', () => {
  let dir: string;
  let store: Store;
  let rulesPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-plan-'));
    store = new Store(join(dir, 'plan.db'));
    rulesPath = join(dir, 'rules.json');
    // An always group (the default), a never group, and a time-gated group.
    const doc = JSON.stringify({
      schema: 2,
      defaults: {},
      channels: [
        { channel_id: 1, aliases: ['ESPN'] }, // group 100 "sports"  -> always
        { channel_id: 2, aliases: ['HBO'] }, // group 200 "excluded" -> never
        { channel_id: 3, aliases: ['TNT'] }, // group 300 "gated"    -> after_epg_start
      ],
      group_patterns: [
        { pattern: 'excluded', mode: 'never' },
        { pattern: 'gated', mode: 'after_epg_start' },
      ],
    });
    // Write atomically, the way the app does, so the reload sees a whole doc.
    const tmp = `${rulesPath}.tmp`;
    writeFileSync(tmp, doc, 'utf8');
    renameSync(tmp, rulesPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const streams: Stream[] = [
    {
      id: 10,
      name: 'ESPN',
      url: 'u1',
      providerId: 5,
      streamHash: 'h',
      currentViewers: 0,
      groupId: 100,
    },
    {
      id: 20,
      name: 'HBO',
      url: 'u2',
      providerId: 5,
      streamHash: 'h',
      currentViewers: 0,
      groupId: 200,
    },
    {
      id: 30,
      name: 'TNT',
      url: 'u3',
      providerId: 5,
      streamHash: 'h',
      currentViewers: 0,
      groupId: 300,
    },
  ];
  const channels: Channel[] = [
    { id: 1, name: 'ESPN', tvgId: 'espn.id', streams: [10], groupId: 100 },
    { id: 2, name: 'HBO', tvgId: 'hbo.id', streams: [20], groupId: 200 },
    { id: 3, name: 'TNT', tvgId: 'tnt.id', streams: [30], groupId: 300 },
  ];
  const groupNames = new Map([
    [100, 'sports'],
    [200, 'excluded'],
    [300, 'gated'],
  ]);

  /** plan() is private; reach it directly so the keep/oldest logic is exercised
   *  without faking the whole Dispatcharr client. */
  function plan(runner: Runner, eligibility: unknown) {
    return (
      runner as unknown as {
        plan: (
          channels: Channel[],
          streams: Stream[],
          programmes: Map<string, unknown>,
          eligibility: unknown,
          counters: { cached: number },
          heldBack: Record<string, number>,
          groupNames: Map<number, string>,
        ) => { oldestProbedAt: number | null; keepStreamIds: Set<number> };
      }
    ).plan.call(runner, channels, streams, new Map(), eligibility, { cached: 0 }, {}, groupNames);
  }

  it('keeps eligible and time-gated streams, drops never, and ages only the eligible', () => {
    const rules = new RulesSource(rulesPath);
    const eligibility = rules.get().eligibility;
    const runner = new Runner({
      config: () => loadConfig({ DISPATCHARR_API_KEY: 'k' }),
      store,
      rules,
    });

    // Verdicts exist only on the channels a pass would NOT probe: a never
    // verdict (HBO) and a held-back verdict (TNT, no EPG). The eligible ESPN
    // stream starts without one.
    store.put(20, 'h', result()); // never
    store.put(30, 'h', result()); // after_epg_start, no EPG this pass

    const first = plan(runner, eligibility);
    // The never stream is dropped so it gets pruned; the time-gated stream stays
    // managed even though it is not probeable yet; the eligible stream is
    // managed whether or not it has a verdict.
    expect(first.keepStreamIds.has(10)).toBe(true); // eligible
    expect(first.keepStreamIds.has(30)).toBe(true); // after_epg_start: held back, still kept
    expect(first.keepStreamIds.has(20)).toBe(false); // never: dropped -> pruned
    // Nothing *eligible* has been probed, so the honest "Oldest check" is
    // unknown -- it must not borrow the verdicts sitting on HBO/TNT.
    expect(first.oldestProbedAt).toBeNull();

    // Once the eligible stream is probed, the oldest check picks it up -- and
    // still ignores the verdicts on the never/gated channels.
    store.put(10, 'h', result());
    const second = plan(runner, eligibility);
    expect(second.oldestProbedAt).not.toBeNull();
    expect(Date.now() - (second.oldestProbedAt as number)).toBeLessThan(5_000);
  });
});

describe('Runner.plan (rule-less channels in an after-kickoff group)', () => {
  // Another app creates "Auto | SPORT" channels per fixture and assigns their
  // streams. Nothing names them in the rules file, so they have no rule at all.
  let dir: string;
  let store: Store;
  let rulesPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-assigned-'));
    store = new Store(join(dir, 'assigned.db'));
    rulesPath = join(dir, 'rules.json');
    const doc = JSON.stringify({
      schema: 2,
      defaults: { exclude_groups: ['PPV JUNK'] },
      channels: [],
      group_patterns: [{ pattern: 'Auto | *', mode: 'after_epg_start' }],
    });
    const tmp = `${rulesPath}.tmp`;
    writeFileSync(tmp, doc, 'utf8');
    renameSync(tmp, rulesPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const stream = (id: number, groupId: number): Stream => ({
    id,
    name: `stream ${id}`,
    url: `u${id}`,
    providerId: 5,
    streamHash: 'h',
    currentViewers: 0,
    groupId,
  });
  // 42 sits in the provider group the operator switched off entirely.
  const streams: Stream[] = [stream(40, 900), stream(41, 900), stream(42, 901)];
  const groupNames = new Map([
    [700, 'Auto | SPORT'],
    [800, 'Movies'],
    [900, 'PROVIDER SPORT'],
    [901, 'PPV JUNK'],
  ]);
  const gated: Channel = {
    id: 1,
    name: 'Auto | Cubs v Cards',
    tvgId: 'GAME.us',
    streams: [40, 41, 42],
    groupId: 700,
  };
  const plain: Channel = {
    id: 2,
    name: 'Some Movie Channel',
    tvgId: 'movie.us',
    streams: [40, 41],
    groupId: 800,
  };

  // `plan` reads the wall clock itself, so every programme here is built
  // relative to the same real "now" the call will use.
  function plan(channels: Channel[], programmes: Map<string, unknown>) {
    const rules = new RulesSource(rulesPath);
    const runner = new Runner({
      config: () => loadConfig({ DISPATCHARR_API_KEY: 'k' }),
      store,
      rules,
    });
    const heldBack: Record<string, number> = {};
    const planned = (
      runner as unknown as {
        plan: (
          channels: Channel[],
          streams: Stream[],
          programmes: Map<string, unknown>,
          eligibility: unknown,
          counters: { cached: number },
          heldBack: Record<string, number>,
          groupNames: Map<number, string>,
        ) => { jobs: Array<{ streamId: number; stepOrder: number }>; keepStreamIds: Set<number> };
      }
    ).plan.call(
      runner,
      channels,
      streams,
      programmes,
      rules.get().eligibility,
      { cached: 0 },
      heldBack,
      groupNames,
    );
    return { ...planned, heldBack };
  }

  const started = (at: Date) =>
    currentProgrammes(
      [
        {
          tvg_id: 'GAME.us',
          start_time: new Date(at.getTime() - 30 * 60_000).toISOString(),
          end_time: new Date(at.getTime() + 90 * 60_000).toISOString(),
          title: 'First Pitch',
        },
      ],
      at,
    );

  it('probes the streams the channel already carries once the programme has started', () => {
    const now = new Date();
    const { jobs } = plan([gated], started(now) as Map<string, unknown>);
    // 40 and 41 are candidates off the assignment alone; 42 is in an excluded
    // provider group, which no channel may claim by any route.
    expect(jobs.map((j) => j.streamId).sort()).toEqual([40, 41]);
    // No alias said anything about preference, so nothing may outrank quality.
    expect(jobs.every((j) => j.stepOrder === 0)).toBe(true);
  });

  it('leaves a rule-less channel alone when its group is not after kickoff', () => {
    const now = new Date();
    const { jobs } = plan([plain], started(now) as Map<string, unknown>);
    expect(jobs).toEqual([]);
  });

  it('holds the channel back before kickoff but keeps its streams managed', () => {
    const now = new Date();
    const soon = currentProgrammes(
      [
        {
          tvg_id: 'GAME.us',
          // Started a minute ago: inside the 5-minute default grace.
          start_time: new Date(now.getTime() - 60_000).toISOString(),
          end_time: new Date(now.getTime() + 90 * 60_000).toISOString(),
          title: 'First Pitch',
        },
      ],
      now,
    );
    const { jobs, keepStreamIds, heldBack } = plan([gated], soon as Map<string, unknown>);
    expect(jobs).toEqual([]);
    expect(Object.keys(heldBack).some((r) => r.startsWith('before kickoff'))).toBe(true);
    // Managed, just not probeable yet -- their cache rows must survive the prune.
    expect(keepStreamIds.has(40)).toBe(true);
    expect(keepStreamIds.has(41)).toBe(true);
    expect(keepStreamIds.has(42)).toBe(false);
  });

  it('holds the channel back when the group has no EPG for it', () => {
    const { jobs, heldBack } = plan([gated], new Map());
    expect(jobs).toEqual([]);
    expect(heldBack['no EPG data']).toBe(1);
  });

  it('tallies channels between events as one row, not one row per fixture', () => {
    // The programme title used to be part of the reason string, so a pass with
    // a group of per-fixture channels reported a dozen near-identical rows --
    // 1 "event window passed \"Coming up: NFL Football at 7:00 PM EDT\"", 1 for
    // the 7:30 game, and so on -- where it meant to say three channels.
    const now = new Date();
    const long_ago = (title: string, tvg: string) => ({
      tvg_id: tvg,
      start_time: new Date(now.getTime() - 6 * 3_600_000).toISOString(),
      end_time: new Date(now.getTime() + 3_600_000).toISOString(),
      title,
    });
    const programmes = currentProgrammes(
      [
        long_ago('Coming up: NFL Football at 7:00 PM EDT', 'GAME.us'),
        long_ago('Coming up: NFL Football at 7:30 PM EDT', 'GAME2.us'),
        long_ago('Minor League Baseball', 'GAME3.us'),
      ],
      now,
    );
    const channels = [
      gated,
      { ...gated, id: 11, tvgId: 'GAME2.us' },
      { ...gated, id: 12, tvgId: 'GAME3.us' },
    ];
    const { heldBack } = plan(channels, programmes as Map<string, unknown>);
    expect(heldBack).toEqual({ 'event window passed': 3 });
  });
});

describe('reorder live re-fetch', () => {
  // reorder() is private; reach it directly with a fake client so the live
  // re-fetch before the write can be exercised without Dispatcharr.
  let dir: string;
  let store: Store;
  let runner: Runner;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-reorder-'));
    store = new Store(join(dir, 'reorder.db'));
    runner = new Runner({
      // Dry-run is the default, and these cases are about the write itself.
      config: () => loadConfig({ DISPATCHARR_API_KEY: 'k', PODIUM_DRY_RUN: 'false' }),
      store,
      rules: new RulesSource(join(dir, 'rules.json')),
    });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Two streams; the 2160p one outscores the 1080p one, so ranked is always [2,1].
  const entries: RankEntry[] = [
    { streamId: 1, stepOrder: 0, providerId: 5, result: result({ height: 1080 }) },
    { streamId: 2, stepOrder: 0, providerId: 5, result: result({ height: 2160 }) },
  ];

  const reorder = (
    liveStreams: number[] | null,
    assigned: number[],
  ): Promise<{ written: number[][]; counters: { reordered: number; unchanged: number } }> => {
    const written: number[][] = [];
    const fake = {
      channel: async () =>
        liveStreams === null
          ? null
          : ({ id: 1, name: '', tvgId: '', streams: liveStreams, groupId: null } as Channel),
      setStreamOrder: async (_id: number, order: number[]) => {
        written.push(order);
      },
    } as unknown as DispatcharrClient;
    const counters = { reordered: 0, unchanged: 0 };
    return (
      runner as unknown as {
        reorder: (
          client: DispatcharrClient,
          channelId: number,
          entries: RankEntry[],
          counters: { reordered: number; unchanged: number },
          log: (m: string) => void,
          assigned: number[],
          strategy: RankStrategy,
        ) => Promise<void>;
      }
    )
      .reorder(fake, 1, entries, counters, () => {}, assigned, DEFAULT_STRATEGY)
      .then(() => ({ written, counters }));
  };

  it('writes the ranked order with strays appended', async () => {
    const { written, counters } = await reorder([1, 2, 3], [1, 2, 3]);
    expect(written).toEqual([[2, 1, 3]]);
    expect(counters.reordered).toBe(1);
  });

  it('recomputes against the live order and preserves a concurrent addition', async () => {
    // During the pass somebody added stream 3 and reordered Dispatcharr to
    // [2,3,1]. The stale pass-start order [1,2] would yield [2,1] and drop 3;
    // the live re-fetch keeps it.
    const { written } = await reorder([2, 3, 1], [1, 2]);
    expect(written).toEqual([[2, 1, 3]]);
  });

  it('skips the write when Dispatcharr already holds the order', async () => {
    const { written, counters } = await reorder([2, 1], [1, 2]);
    expect(written).toEqual([]);
    expect(counters.unchanged).toBe(1);
  });
});
