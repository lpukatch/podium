import Database from 'better-sqlite3';
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
  ASSIGNED,
  assignmentIsRule,
  currentProgrammes,
  describeVerdict,
  Eligibility,
  globToRegExp,
  NEVER,
  nextProgrammeStarts,
  parseGroupPatterns,
  parsePolicies,
} from './eligibility';
import { type Activity, Pacer, viewersByProvider } from './pacer';
import type { ProbeResult } from './probe';
import { RulesSource } from './rules-source';
import { composeOrder, Runner, type RunSummary, sameOrder } from './runner';
import { DEFAULT_STRATEGY, type RankEntry, type RankStrategy } from './scoring';
import { type CacheEntry, RUN_HISTORY_MS, Store, ttlFor } from './store';

const NOW = new Date('2026-08-03T18:00:00Z');

function epgRows(offsetMinutes: number, isLive = true) {
  const start = new Date(NOW.getTime() + offsetMinutes * 60_000);
  return [
    {
      tvg_id: 'GAME.us',
      start_time: start.toISOString(),
      end_time: new Date(start.getTime() + 3 * 3_600_000).toISOString(),
      title: 'First Pitch',
      is_live: isLive,
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
  channelLayout: 'stereo',
  audioBitrateKbps: 128,
  audioSampleRate: 48_000,
  elapsedMs: 100,
  error: '',
  ...over,
});

describe('eligibility', () => {
  it('always blocks a never group', () => {
    const e = new Eligibility(
      new Map([[7, { mode: NEVER, graceMinutes: 5, windowMinutes: 180, requireLive: true }]]),
    );
    const verdict = e.allows(7, 'GAME.us', new Map(), NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('excluded');
  });

  it('needs no EPG for an always group', () => {
    expect(new Eligibility(new Map()).allows(1, '', new Map(), NOW).allowed).toBe(true);
  });

  it('blocks an event channel before kickoff', () => {
    const e = new Eligibility(
      new Map([
        [9, { mode: AFTER_EPG_START, graceMinutes: 5, windowMinutes: 180, requireLive: true }],
      ]),
    );
    const verdict = e.allows(9, 'GAME.us', currentProgrammes(epgRows(0), NOW), NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('kickoff');
  });

  it('allows an event channel after the grace period', () => {
    const e = new Eligibility(
      new Map([
        [9, { mode: AFTER_EPG_START, graceMinutes: 5, windowMinutes: 180, requireLive: true }],
      ]),
    );
    expect(e.allows(9, 'GAME.us', currentProgrammes(epgRows(-30), NOW), NOW).allowed).toBe(true);
  });

  it('blocks once the event window has passed', () => {
    const e = new Eligibility(
      new Map([
        [9, { mode: AFTER_EPG_START, graceMinutes: 5, windowMinutes: 60, requireLive: true }],
      ]),
    );
    const verdict = e.allows(9, 'GAME.us', currentProgrammes(epgRows(-90), NOW), NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('window');
  });

  it('holds off when an event channel has no EPG', () => {
    // "Probe it anyway" would defeat the whole point of the policy.
    const e = new Eligibility(
      new Map([
        [9, { mode: AFTER_EPG_START, graceMinutes: 5, windowMinutes: 180, requireLive: true }],
      ]),
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
      new Map([
        [9, { mode: AFTER_EPG_START, graceMinutes: 5, windowMinutes: 60, requireLive: true }],
      ]),
    );
    const passed = e.allows(9, 'GAME.us', currentProgrammes(epgRows(-90), NOW), NOW);
    expect(passed.reason).toBe('event window passed');
    expect(passed.detail).toBe('"First Pitch"');
    expect(describeVerdict(passed)).toBe('event window passed — "First Pitch"');

    const early = e.allows(9, 'GAME.us', currentProgrammes(epgRows(0), NOW), NOW);
    expect(early.reason).toBe('before kickoff');
    expect(early.detail).toBe('18:00Z "First Pitch"');
  });

  it('blocks on a countdown block, whose start is not the event start', () => {
    // The failure this guards: an event EPG fills the hours before kickoff with
    // "Coming up: ... at 1:05 PM", so a programme *is* airing and its start is
    // hours old. Gating on start alone opens every event channel permanently --
    // on the install this was found on, not one channel was ever held back.
    // Through the parser, so this is the policy an operator actually gets from
    // writing `"9": {"mode": "after_epg_start"}` and nothing else.
    const e = new Eligibility(parsePolicies({ 9: { mode: AFTER_EPG_START } }));
    const verdict = e.allows(9, 'GAME.us', currentProgrammes(epgRows(-30, false), NOW), NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('no live programme');
    expect(verdict.detail).toBe('"First Pitch"');
  });

  it('treats a missing live flag as not live', () => {
    // Absent is not "assume it started": that is the reading that produced the
    // bug, and the reason string says plainly which knob to reach for.
    const e = new Eligibility(parsePolicies({ 9: { mode: AFTER_EPG_START } }));
    const rows = [
      {
        tvg_id: 'GAME.us',
        start_time: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
        end_time: new Date(NOW.getTime() + 150 * 60_000).toISOString(),
        title: 'First Pitch',
      },
    ];
    expect(e.allows(9, 'GAME.us', currentProgrammes(rows, NOW), NOW).reason).toBe(
      'no live programme',
    );
  });

  it('lets a group opt out of the live requirement', () => {
    // For an EPG that never marks anything live, start-only is all there is.
    const e = new Eligibility(
      new Map([
        [9, { mode: AFTER_EPG_START, graceMinutes: 5, windowMinutes: 180, requireLive: false }],
      ]),
    );
    expect(e.allows(9, 'GAME.us', currentProgrammes(epgRows(-30, false), NOW), NOW).allowed).toBe(
      true,
    );
  });

  it('defaults require_live on, and parses it off from either side', () => {
    expect(parsePolicies({ 9: { mode: AFTER_EPG_START } }).get(9)?.requireLive).toBe(true);
    expect(
      parsePolicies({ 9: { mode: AFTER_EPG_START, require_live: false } }).get(9)?.requireLive,
    ).toBe(false);
    expect(
      parseGroupPatterns([{ pattern: 'Auto | *', mode: AFTER_EPG_START, require_live: 'false' }])[0]
        ?.requireLive,
    ).toBe(false);
    expect(
      parseGroupPatterns([{ pattern: 'Auto | *', mode: AFTER_EPG_START }])[0]?.requireLive,
    ).toBe(true);
  });

  it('indexes only the programme airing now', () => {
    expect(currentProgrammes(epgRows(120), NOW).size).toBe(0);
    expect(currentProgrammes(epgRows(-10), NOW).has('GAME.us')).toBe(true);
  });

  it('indexes the soonest programme still to come, ignoring the one airing', () => {
    // The companion index the loop sleeps on. The programme airing now started
    // in the past, so it must never be its own "next start" -- that would wake
    // the loop immediately and forever.
    const rows = [...epgRows(-30), ...epgRows(120), ...epgRows(45)];
    expect(nextProgrammeStarts(rows, NOW).next.get('GAME.us')).toBe(NOW.getTime() + 45 * 60_000);
    expect(nextProgrammeStarts(epgRows(-30), NOW).next.has('GAME.us')).toBe(false);
  });

  it('indexes the next *live* start apart from the next start of anything', () => {
    // An event channel's grid is mostly countdown and postgame filler. Waking
    // at the next block start is a pass per block to reach the same held-back
    // verdict; waking at the next live start is a pass per event.
    const rows = [...epgRows(20, false), ...epgRows(90, true), ...epgRows(200, true)];
    const upcoming = nextProgrammeStarts(rows, NOW);
    expect(upcoming.next.get('GAME.us')).toBe(NOW.getTime() + 20 * 60_000);
    expect(upcoming.nextLive.get('GAME.us')).toBe(NOW.getTime() + 90 * 60_000);
    // Nothing live listed at all leaves the live index empty rather than
    // falling back to a block that cannot open the gate.
    expect(nextProgrammeStarts([...epgRows(20, false)], NOW).nextLive.has('GAME.us')).toBe(false);
  });

  it('picks the index the policy is actually gated on', () => {
    // require_live on: only a live programme can open this channel, so the
    // filler block starting in 20 minutes is not a reason to wake.
    const rows = [...epgRows(20, false), ...epgRows(90, true)];
    const upcoming = nextProgrammeStarts(rows, NOW);
    const gated = new Eligibility(parsePolicies({ 9: { mode: AFTER_EPG_START } }));
    expect(gated.allows(9, 'GAME.us', new Map(), NOW, undefined, upcoming).eligibleAt).toBe(
      NOW.getTime() + 95 * 60_000,
    );

    // require_live off: start times are all this policy has, so the block counts.
    const loose = new Eligibility(
      parsePolicies({ 9: { mode: AFTER_EPG_START, require_live: false } }),
    );
    expect(loose.allows(9, 'GAME.us', new Map(), NOW, undefined, upcoming).eligibleAt).toBe(
      NOW.getTime() + 25 * 60_000,
    );
  });

  it('says when a channel waiting for kickoff turns eligible', () => {
    const e = new Eligibility(parsePolicies({ 9: { mode: AFTER_EPG_START } }));
    // Airing, and started this instant, so the grace period is what is left.
    const verdict = e.allows(9, 'GAME.us', currentProgrammes(epgRows(0), NOW), NOW);
    expect(verdict.reason).toBe('before kickoff');
    // Kickoff plus the grace the policy waits out anyway: waking at the start
    // itself would only re-hold it for the length of the grace period.
    expect(verdict.eligibleAt).toBe(NOW.getTime() + 5 * 60_000);
  });

  it('waits out a countdown block, then the fixture the grid lists next', () => {
    const e = new Eligibility(parsePolicies({ 9: { mode: AFTER_EPG_START } }));
    const programmes = currentProgrammes(epgRows(-30, false), NOW);

    // Nothing listed after it, so there is no time to give. Emphatically *not*
    // the block's own end: the countdown ending turns this into a channel with
    // no programme listed, which is held back just the same, and a pass sent to
    // find that out crawls the whole catalogue to learn nothing. What opens the
    // gate is a live programme, and only rows we do not have yet carry one.
    const alone = e.allows(9, 'GAME.us', programmes, NOW);
    expect(alone.reason).toBe('no live programme');
    expect(alone.eligibleAt).toBeUndefined();

    // A grid that lists what comes next answers it exactly, which is what
    // `/api/epg/grid/` gives us.
    const nextStarts = nextProgrammeStarts(epgRows(200), NOW);
    const listed = e.allows(9, 'GAME.us', programmes, NOW, undefined, nextStarts);
    expect(listed.eligibleAt).toBe(NOW.getTime() + 205 * 60_000);
  });

  it('reopens a passed window only when the next programme starts', () => {
    const e = new Eligibility(
      new Map([
        [9, { mode: AFTER_EPG_START, graceMinutes: 5, windowMinutes: 60, requireLive: true }],
      ]),
    );
    const verdict = e.allows(
      9,
      'GAME.us',
      currentProgrammes(epgRows(-90), NOW),
      NOW,
      undefined,
      nextProgrammeStarts(epgRows(90), NOW),
    );
    expect(verdict.reason).toBe('event window passed');
    expect(verdict.eligibleAt).toBe(NOW.getTime() + 95 * 60_000);
  });

  it('leaves the time unknown when nothing can answer it', () => {
    // An excluded group needs an operator, and a channel the grid lists nothing
    // for needs a new grid. Neither is a time the loop can sleep on.
    const excluded = new Eligibility(parsePolicies({ 7: 'never' }));
    expect(excluded.allows(7, 'GAME.us', new Map(), NOW).eligibleAt).toBeUndefined();

    const e = new Eligibility(parsePolicies({ 9: { mode: AFTER_EPG_START } }));
    const blank = e.allows(9, 'UNKNOWN', new Map(), NOW);
    expect(blank.reason).toBe('no EPG data');
    expect(blank.eligibleAt).toBeUndefined();

    // Unless the grid does list something later for it, which is exactly the
    // case that used to keep the loop awake for hours.
    const listed = e.allows(
      9,
      'GAME.us',
      new Map(),
      NOW,
      undefined,
      nextProgrammeStarts(epgRows(240), NOW),
    );
    expect(listed.reason).toBe('no EPG data');
    expect(listed.eligibleAt).toBe(NOW.getTime() + 245 * 60_000);
  });

  it('needs no EPG for an assigned group', () => {
    // `assigned` differs from `always` only in where a rule-less channel's
    // candidates come from, so it must not inherit the kickoff gate.
    const e = new Eligibility(
      new Map([[9, { mode: ASSIGNED, graceMinutes: 5, windowMinutes: 180, requireLive: true }]]),
    );
    expect(e.allows(9, 'UNKNOWN', new Map(), NOW).allowed).toBe(true);
  });

  it('takes the assignment as the rule only where the operator said so', () => {
    expect(assignmentIsRule(ASSIGNED)).toBe(true);
    expect(assignmentIsRule(AFTER_EPG_START)).toBe(true);
    // `always` is what every unconfigured group resolves to; the fallback there
    // would probe the whole catalogue on a fresh install.
    expect(assignmentIsRule('always')).toBe(false);
    expect(assignmentIsRule(NEVER)).toBe(false);
  });

  it('parses both policy shapes and rejects junk', () => {
    const parsed = parsePolicies({
      '1': 'never',
      '2': { mode: 'after_epg_start', grace_minutes: 9 },
      '4': 'assigned',
      x: 'never',
      '3': 'nonsense',
    });
    expect(parsed.get(1)?.mode).toBe(NEVER);
    expect(parsed.get(2)?.graceMinutes).toBe(9);
    expect(parsed.get(4)?.mode).toBe(ASSIGNED);
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
          ['1:0', 3],
          ['2:0', 5],
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
        ['1:0', 3],
        ['2:0', 5],
      ]),
      busy,
      new Map([['1:0', 1]]),
    );
    expect([...limits]).toEqual([
      ['1:0', 1],
      ['2:0', 4],
    ]);
  });

  it('uses every slot when nobody is watching', () => {
    // A provider with max_streams=1 must still be checkable. Reserving a slot
    // while fully idle would give 1 - 0 - 1 = 0 and starve it forever.
    const limits = pacer({ pauseWhenWatching: false }).laneLimits(
      new Map([
        ['5:0', 1],
        ['6:0', 3],
      ]),
      idle,
      new Map(),
    );
    expect(limits.get('5:0')).toBe(1);
    expect(limits.get('6:0')).toBe(3);
  });

  it('drops a lane with no spare capacity while busy', () => {
    const busy: Activity = { channelIds: new Set([9]), idle: false };
    expect(
      pacer({ pauseWhenWatching: false }).laneLimits(
        new Map([['5:0', 1]]),
        busy,
        new Map([['5:0', 1]]),
      ).size,
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
    expect(store.entry(1, 'hash-a')?.result?.height).toBe(1080);
  });

  it('misses when the stream hash changes', () => {
    // The provider swapped the stream behind this id; the old verdict is void.
    store.put(1, 'hash-a', result());
    expect(store.entry(1, 'hash-b')).toBeNull();
  });

  it('expires live and dead entries on separate TTLs', () => {
    store.put(1, 'h', result());
    store.put(2, 'h', result({ alive: false }));
    // The planner's own rule: one read, measured against the lifetime that row
    // has earned. Live TTL generous, dead TTL zero -- the live verdict is still
    // servable, the dead one is not.
    const live = store.entry(1, 'h');
    const dead = store.entry(2, 'h');
    expect(Date.now() - (live as CacheEntry).probedAt).toBeLessThan(
      ttlFor(live as CacheEntry, 60_000, 0),
    );
    expect(Date.now() - (dead as CacheEntry).probedAt).toBeGreaterThanOrEqual(
      ttlFor(dead as CacheEntry, 60_000, 0),
    );
  });

  it('reports when a stream was probed, and nothing for one that never was', () => {
    store.put(1, 'h', result());
    expect(Date.now() - (store.entry(1, 'h') as CacheEntry).probedAt).toBeLessThan(1000);
    expect(store.entry(99, 'h')).toBeNull();
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

  it('trims run history as it records, not only when a worker starts', () => {
    // One row per pass and nothing reads past a day, so an install that stays
    // up keeps a table it never trims -- half a million rows a year. `prune()`
    // runs at worker start, which such an install does not do.
    const old = new Database(join(dir, 'test.db'));
    old
      .prepare('INSERT INTO runs (run_id, started_at) VALUES (?, ?)')
      .run('ancient', Date.now() - RUN_HISTORY_MS - 60_000);
    old
      .prepare('INSERT INTO runs (run_id, started_at) VALUES (?, ?)')
      .run('recent', Date.now() - 60_000);
    old.close();

    store.startRun('now');
    const kept = store.recentRuns(10).map((run) => run.run_id);
    expect(kept).toContain('now');
    expect(kept).toContain('recent');
    expect(kept).not.toContain('ancient');
  });

  it('keeps prepared statements to itself, so two handles cannot share one', () => {
    // The cache is per instance because a statement belongs to the connection
    // that compiled it. A second store on the same file must compile its own
    // and still see the first one's writes.
    store.put(7, 'h', result());
    const second = new Store(join(dir, 'test.db'));
    expect(second.entry(7, 'h')?.result?.height).toBe(1080);
    // And a closed store's statements go with it rather than being handed out
    // again by the cache.
    second.close();
    expect(() => second.entry(7, 'h')).toThrow();
  });

  it('prunes only rows outside the managed stream set', () => {
    // 1 and 2 are still managed; 3 was excluded/disabled and 4 left every lineup.
    store.put(1, 'h', result());
    store.put(2, 'h', result());
    store.put(3, 'h', result());
    store.put(4, 'h', result());

    expect(store.pruneOutside(new Set([1, 2]))).toBe(2);
    // Twice on one handle: the keep-set scratch table is reused across calls,
    // and so are the statements that fill it.
    store.put(5, 'h', result());
    expect(store.pruneOutside(new Set([1, 2]))).toBe(1);
    // The managed streams survive; the orphans are gone.
    expect(store.entry(1, 'h')).not.toBeNull();
    expect(store.entry(2, 'h')).not.toBeNull();
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
    assigned: 0,
    skipped: 0,
    deferred: 0,
    backlog: 0,
    nextDueAt: null,
    nextEligibleAt: null,
    runnableBacklog: 0,
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

  it('keeps the normal cadence when probeable work is still outstanding', () => {
    // A pass that probed nothing but *had* something to probe -- every probe
    // failed, or a viewer appeared and aborted the run. No wake-up time
    // describes that: the work is due now, so the answer is the base tick.
    expect(nextWait(config, summary({ runnableBacklog: 4 }), NOW + 3_600_000, NOW).waitMs).toBe(
      60_000,
    );
    // Jobs on an inactive provider are deliberately not counted there -- no lane
    // exists for them, so no pass can ever run them and waking early to look
    // again is the once-a-minute crawl this exists to stop.
    expect(nextWait(config, summary({ backlog: 40 }), NOW + 3_600_000, NOW).idle).toBe(true);
  });

  it('comes back promptly when someone is watching', () => {
    expect(nextWait(config, summary({ paused: true }), NOW + 3_600_000, NOW).waitMs).toBe(60_000);
    expect(nextWait(config, null, NOW + 3_600_000, NOW).waitMs).toBe(60_000);
  });

  it('wakes for a kickoff before it wakes for an expiring verdict', () => {
    // The pass held a channel back until 19:30 and nothing expires for an hour,
    // so 19:30 is the moment the answer could differ. Sleeping to the verdict
    // would probe that channel half an hour late; ticking every minute until
    // then is 30 full crawls of Dispatcharr to learn nothing.
    const { waitMs, idle } = nextWait(
      config,
      summary({ heldBack: { 'before kickoff': 2 }, nextEligibleAt: NOW + 300_000 }),
      NOW + 3_600_000,
      NOW,
    );
    expect(waitMs).toBe(300_000);
    expect(idle).toBe(true);
  });

  it('wakes for an expiring verdict before it wakes for a kickoff', () => {
    expect(
      nextWait(
        config,
        summary({ heldBack: { 'before kickoff': 2 }, nextEligibleAt: NOW + 3_600_000 }),
        NOW + 120_000,
        NOW,
      ).waitMs,
    ).toBe(120_000);
  });

  it('sleeps on a kickoff with nothing cached to expire', () => {
    expect(nextWait(config, summary({ nextEligibleAt: NOW + 400_000 }), null, NOW).waitMs).toBe(
      400_000,
    );
  });

  it('does not stay awake for a channel whose timing nothing can answer', () => {
    // An excluded group stays excluded until an operator says otherwise, and a
    // channel with no programme listed at all has no time to aim at. Neither is
    // a reason to crawl the catalogue every minute; the idle cap is the bound.
    expect(
      nextWait(config, summary({ heldBack: { 'group excluded': 12 } }), NOW + 3_600_000, NOW).idle,
    ).toBe(true);
    expect(
      nextWait(config, summary({ heldBack: { 'no EPG data': 16 } }), NOW + 3_600_000, NOW).waitMs,
    ).toBe(900_000);
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

  describe('auto-assign', () => {
    const assign = (eligible: number[], max = 10) => ({ eligible: new Set(eligible), max });

    it('adds an eligible match the channel does not carry', () => {
      // The whole point: a flat alias matched 999 on a provider nobody wired up,
      // and with auto-assign on the pass puts it where its rank says it goes.
      expect(composeOrder([999, 10, 20], [10, 20], false, assign([999]))).toEqual([999, 10, 20]);
    });

    it('leaves a matched but unusable stream off', () => {
      // 999 ranked (it has to, or it could never sink) but is dead/black/starved,
      // so it is not in `eligible` and adding it would give a viewer a source
      // that does not play.
      expect(composeOrder([10, 999, 20], [10, 20], false, assign([]))).toEqual([10, 20]);
    });

    it('caps how many it adds, best first', () => {
      // Three eligible candidates, room for two: the top two by rank win and the
      // third waits for a pass where something above it has fallen over.
      expect(composeOrder([901, 902, 903, 10], [10], false, assign([901, 902, 903], 3))).toEqual([
        901, 902, 10,
      ]);
    });

    it('counts what the channel already carries against the cap', () => {
      // Two matched streams already on the channel and a cap of 3 leaves room
      // for exactly one more, not three.
      expect(composeOrder([901, 902, 10, 20], [10, 20], false, assign([901, 902], 3))).toEqual([
        901, 10, 20,
      ]);
    });

    it('never removes a stream to get under the cap', () => {
      // The channel already carries four matched streams against a cap of 2.
      // Truncating would unassign two of them -- the one thing this must not do.
      expect(composeOrder([10, 20, 30, 40], [10, 20, 30, 40], false, assign([901], 2))).toEqual([
        10, 20, 30, 40,
      ]);
    });

    it('still appends strays after the ranked ones', () => {
      expect(composeOrder([999, 10], [10, 30], false, assign([999]))).toEqual([999, 10, 30]);
    });

    it('drops strays but keeps the assignment when removeUnmatched is set', () => {
      expect(composeOrder([999, 10], [10, 30], true, assign([999]))).toEqual([999, 10]);
    });

    it('is exactly the old behaviour when no assign options are passed', () => {
      expect(composeOrder([999, 10, 20], [10, 20, 30])).toEqual([10, 20, 30]);
      expect(composeOrder([999], [10, 20])).toEqual([10, 20]);
    });

    it('adds nothing when the cap is zero', () => {
      expect(composeOrder([999, 10], [10], false, assign([999], 0))).toEqual([10]);
    });
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
        ['5:0', 1],
        ['6:0', 3],
        ['7:0', 5],
      ]),
      busy,
      new Map(),
    );
    expect(limits.has('5:0')).toBe(false);
    expect(limits.get('6:0')).toBe(2);
    expect(limits.get('7:0')).toBe(4);

    const jobs = [
      { providerId: 5, profileId: 0 },
      { providerId: 6, profileId: 0 },
      { providerId: 7, profileId: 0 },
    ];
    expect(jobs.filter((j) => limits.has(`${j.providerId}:${j.profileId}`))).toHaveLength(2);
  });
});

describe('group name patterns', () => {
  it('applies a glob to matching group names', () => {
    const e = new Eligibility(new Map(), undefined, [
      { pattern: 'Auto | *', mode: NEVER, graceMinutes: 5, windowMinutes: 180, requireLive: true },
    ]);
    expect(e.policyFor(1, 'Auto | Baseball | MLB').mode).toBe(NEVER);
    expect(e.policyFor(2, 'Auto | Soccer | Carabao Cup').mode).toBe(NEVER);
    expect(e.policyFor(3, 'Sports | US').mode).toBe('always');
  });

  it('lets an explicit group id override a pattern', () => {
    const e = new Eligibility(
      new Map([
        [1, { mode: 'always' as const, graceMinutes: 5, windowMinutes: 180, requireLive: true }],
      ]),
      undefined,
      [
        {
          pattern: 'Auto | *',
          mode: NEVER,
          graceMinutes: 5,
          windowMinutes: 180,
          requireLive: true,
        },
      ],
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
  function plan(
    runner: Runner,
    eligibility: unknown,
    nextLive = new Map<string, number>(),
    gridExpiresAt: number | null = null,
  ) {
    // The gated group in this fixture leaves require_live at its default, so
    // the live index is the one its verdicts are dated from.
    const upcoming = { next: new Map<string, number>(), nextLive };
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
          upcoming: { next: Map<string, number>; nextLive: Map<string, number> },
          gridExpiresAt: number | null,
        ) => {
          oldestProbedAt: number | null;
          nextEligibleAt: number | null;
          keepStreamIds: Set<number>;
          planned: Array<{ channel: { id: number }; cacheComplete: boolean }>;
        };
      }
    ).plan.call(
      runner,
      channels,
      streams,
      new Map(),
      eligibility,
      { cached: 0 },
      {},
      groupNames,
      upcoming,
      gridExpiresAt,
    );
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

  it('reports when the earliest held-back channel turns eligible', () => {
    // The wiring the loop's sleep rests on. TNT is gated and has no programme
    // in this grid; the grid lists its next one in an hour, so that plus the
    // grace period is the moment a pass could reach a different answer -- and
    // the only reason to be awake before then.
    const rules = new RulesSource(rulesPath);
    const runner = new Runner({
      config: () => loadConfig({ DISPATCHARR_API_KEY: 'k' }),
      store,
      rules,
    });
    const startsAt = Date.now() + 3_600_000;
    const gridExpiresAt = Date.now() + 2 * 3_600_000;

    // The excluded channel is deliberately given a start too: an operator has
    // to clear that one, so it must not pull the loop awake.
    const planned = plan(
      runner,
      rules.get().eligibility,
      new Map([
        ['tnt.id', startsAt],
        ['hbo.id', Date.now() + 60_000],
      ]),
      gridExpiresAt,
    );
    expect(planned.nextEligibleAt).toBe(startsAt + 5 * 60_000);
  });

  it("carries each channel's ranking material so nothing matches twice", () => {
    // Everything the reorder needs is settled here: which streams the channel
    // ranks on, and the verdict for each. The cache-only walk and the
    // post-probe walk used to derive all of it again, per pass, per channel.
    const rules = new RulesSource(rulesPath);
    const runner = new Runner({
      config: () => loadConfig({ DISPATCHARR_API_KEY: 'k' }),
      store,
      rules,
    });
    store.put(10, 'h', result());

    const espn = plan(runner, rules.get().eligibility).planned.find((p) => p.channel.id === 1);
    expect(espn?.cacheComplete).toBe(true);
    expect([
      ...(espn as unknown as { fresh: Map<number, Map<number, unknown>> }).fresh.keys(),
    ]).toEqual([10]);
  });

  it('leaves a channel with a probe pending out of the cache-only write', () => {
    // The double-write this closes: the cache-only walk ran over every eligible
    // channel, including ones with probes in flight, so a channel could be
    // PATCHed here and PATCHed again when its probe landed -- twice in one
    // pass, off two readings of the same cache.
    const rules = new RulesSource(rulesPath);
    const runner = new Runner({
      config: () => loadConfig({ DISPATCHARR_API_KEY: 'k' }),
      store,
      rules,
    });
    // ESPN carries stream 10 and nothing has been probed yet.
    const espn = plan(runner, rules.get().eligibility).planned.find((p) => p.channel.id === 1);
    expect(espn?.cacheComplete).toBe(false);
  });

  it('agrees with the probe path about an unmeasured bitrate', () => {
    // "Alive, 0kbps" is a half-measurement, and PODIUM_UNKNOWN_BITRATE_TTL_MS
    // books it in for another attempt within the half hour. The planner has
    // always honoured that; the cache-only reorder did not, so it would rank
    // the channel on a verdict the same pass had already decided to re-probe.
    const rules = new RulesSource(rulesPath);
    const runner = new Runner({
      config: () => loadConfig({ DISPATCHARR_API_KEY: 'k' }),
      store,
      rules,
    });
    store.put(10, 'h', result({ bitrateKbps: 0 }));
    const raw = new Database(join(dir, 'plan.db'));
    raw
      .prepare('UPDATE probe_cache SET probed_at = ? WHERE stream_id = 10')
      .run(Date.now() - 60 * 60_000);
    raw.close();

    const espn = plan(runner, rules.get().eligibility).planned.find((p) => p.channel.id === 1);
    // An hour old and unmeasured: past its lifetime, so it is a probe rather
    // than a hit -- and the channel is not written off the stale reading.
    expect(espn?.cacheComplete).toBe(false);

    // A measured verdict of the same age is still good for the day it was given.
    store.put(10, 'h', result());
    const fresh = new Database(join(dir, 'plan.db'));
    fresh
      .prepare('UPDATE probe_cache SET probed_at = ? WHERE stream_id = 10')
      .run(Date.now() - 60 * 60_000);
    fresh.close();
    expect(
      plan(runner, rules.get().eligibility).planned.find((p) => p.channel.id === 1)?.cacheComplete,
    ).toBe(true);
  });

  it('falls back to the next grid when the rows in hand cannot say', () => {
    // The case that actually runs against Dispatcharr, whose grid endpoint
    // returns only what is airing: nothing here dates TNT's next programme, and
    // re-deriving the same rows a minute later cannot invent one. The next
    // fetch is the earliest thing that can change the answer.
    const rules = new RulesSource(rulesPath);
    const runner = new Runner({
      config: () => loadConfig({ DISPATCHARR_API_KEY: 'k' }),
      store,
      rules,
    });
    const gridExpiresAt = Date.now() + 1_800_000;

    expect(plan(runner, rules.get().eligibility, new Map(), gridExpiresAt).nextEligibleAt).toBe(
      gridExpiresAt,
    );
    // With no grid cached at all there is nothing to aim at, and the loop keeps
    // its normal cadence rather than inventing a time.
    expect(plan(runner, rules.get().eligibility, new Map(), null).nextEligibleAt).toBeNull();
  });
});

describe('Runner.plan (rule-less channels ranked off their assignment)', () => {
  // Another app creates "Auto | SPORT" channels per fixture and assigns their
  // streams. Nothing names them in the rules file, so they have no rule at all.
  // The same fallback serves a hand-built lineup in an `assigned` group.
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
          // Under way, not counting down to it -- see the countdown-block case
          // in the eligibility suite for the other half.
          is_live: true,
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

  it('leaves a rule-less channel alone under the default policy', () => {
    const now = new Date();
    const { jobs } = plan([plain], started(now) as Map<string, unknown>);
    expect(jobs).toEqual([]);
  });

  it('probes a rule-less channel in an assigned group with no EPG at all', () => {
    // The whole point of `assigned`: lineups already set by hand, ranked on the
    // normal schedule, with nothing to wait for.
    writeFileSync(
      rulesPath,
      JSON.stringify({
        schema: 2,
        defaults: { exclude_groups: ['PPV JUNK'] },
        channels: [],
        group_patterns: [{ pattern: 'Movies', mode: 'assigned' }],
      }),
      'utf8',
    );
    // Carries 42 as well, which sits in a switched-off provider group: the
    // fallback is still bounded by `exclude_groups`.
    const { jobs, keepStreamIds, heldBack } = plan(
      [{ ...plain, streams: [40, 41, 42] }],
      new Map(),
    );
    expect(jobs.map((j) => j.streamId).sort()).toEqual([40, 41]);
    expect(heldBack).toEqual({});
    expect(keepStreamIds.has(42)).toBe(false);
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
          is_live: true,
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
    // 1 "event window passed \"NFL Football\"", 1 for the next fixture, and so
    // on -- where it meant to say three channels.
    const now = new Date();
    const long_ago = (title: string, tvg: string) => ({
      tvg_id: tvg,
      start_time: new Date(now.getTime() - 6 * 3_600_000).toISOString(),
      end_time: new Date(now.getTime() + 3_600_000).toISOString(),
      title,
      is_live: true,
    });
    const programmes = currentProgrammes(
      [
        long_ago('NFL Football', 'GAME.us'),
        long_ago('NFL Football: Overtime', 'GAME2.us'),
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

  // Every stream any of these cases can rank, so `catalogueRows` can attribute
  // whatever gets written. Passing a real snapshot matters: without it the
  // catalogue update at the end of `reorder` throws inside the try, the write
  // has already happened, and the assertions below pass over a swallowed error.
  const byId = new Map(
    [1, 2, 3, 30, 901, 902, 903].map((id) => [id, { id, providerId: 5 } as unknown as Stream]),
  );
  type ReorderSnapshot = {
    channelName: string;
    byId: Map<number, Stream>;
    providerNames: Map<number, string>;
  };
  const snapshot: ReorderSnapshot = {
    channelName: 'ESPN',
    byId,
    providerNames: new Map([[5, 'Provider A']]),
  };

  const reorder = (
    liveStreams: number[] | null,
    assigned: number[],
    rankEntries: RankEntry[] = entries,
    runnerOverride: Runner = runner,
    sink?: (m: string) => void,
  ): Promise<{
    written: number[][];
    counters: { reordered: number; unchanged: number; assigned: number };
    failures: string[];
  }> => {
    const written: number[][] = [];
    const failures: string[] = [];
    const fake = {
      channel: async () =>
        liveStreams === null
          ? null
          : ({ id: 1, name: '', tvgId: '', streams: liveStreams, groupId: null } as Channel),
      setStreamOrder: async (_id: number, order: number[]) => {
        written.push(order);
      },
    } as unknown as DispatcharrClient;
    const counters = { reordered: 0, unchanged: 0, assigned: 0 };
    return (
      runnerOverride as unknown as {
        reorder: (
          client: DispatcharrClient,
          channelId: number,
          entries: RankEntry[],
          counters: { reordered: number; unchanged: number; assigned: number },
          log: (m: string) => void,
          assigned: number[],
          strategy: RankStrategy,
          snapshot: ReorderSnapshot,
        ) => Promise<void>;
      }
    )
      .reorder(
        fake,
        1,
        rankEntries,
        counters,
        // reorder swallows its own failures into the log; surface them so a
        // broken write path cannot masquerade as a passing assertion.
        (m: string) => {
          if (m.includes('reorder failed')) failures.push(m);
          sink?.(m);
        },
        assigned,
        DEFAULT_STRATEGY,
        snapshot,
      )
      .then(() => ({ written, counters, failures }));
  };

  it('writes the ranked order with strays appended', async () => {
    const { written, counters, failures } = await reorder([1, 2, 3], [1, 2, 3]);
    expect(failures).toEqual([]);
    expect(written).toEqual([[2, 1, 3]]);
    expect(counters.reordered).toBe(1);
    // Nothing was added, so this stays a reorder and not an assignment.
    expect(counters.assigned).toBe(0);
    // ...and the catalogue snapshot records what was actually written.
    expect(store.catalogue().rows.map((r) => r.streamId)).toEqual([2, 1, 3]);
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

  describe('with PODIUM_AUTO_ASSIGN on', () => {
    const assigning = (over: Record<string, string> = {}) =>
      new Runner({
        config: () =>
          loadConfig({
            DISPATCHARR_API_KEY: 'k',
            PODIUM_DRY_RUN: 'false',
            PODIUM_AUTO_ASSIGN: 'true',
            ...over,
          }),
        store,
        rules: new RulesSource(join(dir, 'rules.json')),
      });

    // A new provider's stream: matched by the alias, probed, healthy, and on no
    // channel. This is the case the whole setting exists for.
    const newProvider = (id: number, height = 2160): RankEntry => ({
      streamId: id,
      stepOrder: 0,
      providerId: 5,
      result: result({ height }),
    });

    it('puts a matched stream onto a channel that never carried it', async () => {
      const { written, counters, failures } = await reorder(
        [1],
        [1],
        [entries[0]!, newProvider(901)],
        assigning(),
      );
      expect(failures).toEqual([]);
      // 901 is 2160p against 1080p, so it takes slot 0 the moment it lands.
      expect(written).toEqual([[901, 1]]);
      expect(counters.assigned).toBe(1);
      expect(counters.reordered).toBe(1);
    });

    it('records the newly assigned stream in the catalogue straight away', async () => {
      await reorder([1], [1], [entries[0]!, newProvider(901)], assigning());
      // So the provider shows up in the metrics on the next scrape rather than
      // after the next full pass -- the gap that made a new provider invisible.
      expect(store.catalogue().rows.map((r) => [r.slot, r.streamId])).toEqual([
        [0, 901],
        [1, 1],
      ]);
    });

    it('refuses to assign a stream whose verdict is not usable', async () => {
      const dead = { ...newProvider(901), result: result({ alive: false }) };
      const { written, counters } = await reorder([1], [1], [entries[0]!, dead], assigning());
      // Nothing to write: 901 is not fit to add and 1 is already where it goes.
      expect(written).toEqual([]);
      expect(counters.assigned).toBe(0);
    });

    it('honours the cap across a pass', async () => {
      const { written, counters } = await reorder(
        [1],
        [1],
        [entries[0]!, newProvider(901), newProvider(902), newProvider(903)],
        assigning({ PODIUM_AUTO_ASSIGN_MAX: '2' }),
      );
      // Cap 2, one slot already held by stream 1, so exactly one is added.
      expect(written).toEqual([[901, 1]]);
      expect(counters.assigned).toBe(1);
    });

    it('assigns nothing when the setting is off', async () => {
      // Explicitly off, not merely defaulted off: this is the reorder-only
      // behaviour an operator opts back into, and it has to keep working.
      const off = new Runner({
        config: () =>
          loadConfig({
            DISPATCHARR_API_KEY: 'k',
            PODIUM_DRY_RUN: 'false',
            PODIUM_AUTO_ASSIGN: 'false',
          }),
        store,
        rules: new RulesSource(join(dir, 'rules.json')),
      });
      const { written, counters } = await reorder([1], [1], [entries[0]!, newProvider(901)], off);
      expect(written).toEqual([]);
      expect(counters.assigned).toBe(0);
    });

    it('writes nothing at all under dry run, but says what it would assign', async () => {
      const lines: string[] = [];
      const runnerDry = new Runner({
        config: () =>
          loadConfig({
            DISPATCHARR_API_KEY: 'k',
            PODIUM_DRY_RUN: 'true',
            PODIUM_AUTO_ASSIGN: 'true',
          }),
        store,
        rules: new RulesSource(join(dir, 'rules.json')),
        log: (m: string) => lines.push(m),
      });
      const { written, counters } = await reorder(
        [1],
        [1],
        [entries[0]!, newProvider(901)],
        runnerDry,
        (m) => lines.push(m),
      );
      expect(written).toEqual([]);
      expect(counters.assigned).toBe(0);
      expect(store.catalogue().rows).toEqual([]);
      // The rehearsal: auto-assign on with dry run still set has to name what
      // it would add, or there is no way to check an alias before trusting it.
      expect(lines.join('\n')).toContain('would assign 1: 901[Provider A]');
    });

    it('assigns against the live order, not the stale pass-start one', async () => {
      // Stream 1 is gone from the channel by the time we write. It is still
      // matched and still healthy, so auto-assign legitimately puts it back --
      // podium has no way to know from the channel alone that its absence was
      // deliberate. The next case is how that is actually said.
      const { written } = await reorder([30], [1], [entries[0]!, newProvider(901)], assigning());
      expect(written).toEqual([[901, 1, 30]]);
    });

    it('never re-assigns a stream someone took off the channel', async () => {
      // What the unassign endpoint records. Without it the button is useless
      // with auto-assign on: remove a stream, and the next pass restores it.
      store.blockAssignment(1, 1);
      const { written } = await reorder([30], [30], [entries[0]!, newProvider(901)], assigning());
      expect(written).toEqual([[901, 30]]);
      expect(written[0]).not.toContain(1);
    });

    it('lets a blocked stream back in once it is unblocked', async () => {
      store.blockAssignment(1, 1);
      store.unblockAssignment(1, 1);
      const { written } = await reorder([30], [30], [entries[0]!, newProvider(901)], assigning());
      expect(written).toEqual([[901, 1, 30]]);
    });

    it('blocks per channel, not globally', async () => {
      // Stream 1 is unwanted on channel 2; channel 1 is unaffected.
      store.blockAssignment(2, 1);
      const { written } = await reorder([30], [30], [entries[0]!, newProvider(901)], assigning());
      expect(written).toEqual([[901, 1, 30]]);
    });
  });
});
