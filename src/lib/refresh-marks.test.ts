/**
 * On-demand re-checks.
 *
 * A mark is one timestamp, and everything else about the feature is a
 * consequence of that choice, so the tests are mostly about the consequences:
 * that a mark retires a verdict without deleting it, that cancelling puts the
 * verdict straight back in service, that the planner and the progress page's
 * SQL agree on what a mark makes due, and that a marked stream is paced as
 * work to do now rather than at its usual turn.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorker } from '../worker/loop';
import { loadConfig } from './config';
import type { Channel, Stream } from './dispatcharr';
import type { ProbeResult } from './probe';
import { RulesSource } from './rules-source';
import { type OutstandingMark, Runner } from './runner';
import { ALL_GROUPS, forcedAtFor, NO_MARKS, Store } from './store';

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

describe('refresh marks in the store', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => store.close());

  it('separates the catalogue-wide mark from the per-group ones', () => {
    store.setRefreshMark(ALL_GROUPS, 1000);
    store.setRefreshMark(42, 2000);

    const marks = store.refreshMarks();
    expect(marks.all).toBe(1000);
    expect(marks.byGroup.get(42)).toBe(2000);
    // The sentinel is an implementation detail of the table, not a group.
    expect(marks.byGroup.has(ALL_GROUPS)).toBe(false);
  });

  it('moves an existing mark forward rather than stacking', () => {
    store.setRefreshMark(42, 1000);
    store.setRefreshMark(42, 5000);
    expect(store.refreshMarks().byGroup.get(42)).toBe(5000);
  });

  it('takes the later of the two marks that can cover a channel', () => {
    const marks = { all: 1000, byGroup: new Map([[42, 3000]]), byChannel: new Map() };
    expect(forcedAtFor(marks, 42)).toBe(3000);
    // The group mark is older here, so the catalogue-wide one is what applies.
    expect(
      forcedAtFor({ all: 9000, byGroup: new Map([[42, 3000]]), byChannel: new Map() }, 42),
    ).toBe(9000);
    // A group nobody marked, and a channel in no group at all: both are still
    // in the catalogue, so both are covered by a catalogue-wide request.
    expect(forcedAtFor(marks, 7)).toBe(1000);
    expect(forcedAtFor(marks, null)).toBe(1000);
    // Nothing marked reads as 0, so callers compare unconditionally.
    expect(forcedAtFor(NO_MARKS, 42)).toBe(0);
  });

  it('cancels one scope without touching the others', () => {
    store.setRefreshMark(ALL_GROUPS, 1000);
    store.setRefreshMark(42, 2000);

    expect(store.clearRefreshMark(42)).toBe(1);
    expect(store.clearRefreshMark(42)).toBe(0);
    expect(store.refreshMarks().all).toBe(1000);
  });

  it('retires a request by its instant, leaving a re-armed one alone', () => {
    store.setRefreshMark(42, 1000);
    // A pass that planned against the old request must not drop a newer one
    // queued while it ran: the verdicts that one retired were never counted.
    store.setRefreshMark(42, 2000);
    expect(store.clearRefreshMark(42, 1000)).toBe(0);
    expect(store.refreshMarks().byGroup.get(42)).toBe(2000);
    expect(store.clearRefreshMark(42, 2000)).toBe(1);
    expect(store.refreshMarks().byGroup.has(42)).toBe(false);
  });

  it('drops the group marks a catalogue-wide request subsumes', () => {
    // Otherwise cancelling the big request quietly leaves the small ones
    // behind, still re-checking.
    store.setRefreshMark(42, 1000);
    store.setRefreshMark(43, 1000);
    store.setRefreshMark(ALL_GROUPS, 2000);

    expect(store.clearGroupRefreshMarks()).toBe(2);
    expect(store.refreshMarks().all).toBe(2000);
    expect(store.refreshMarks().byGroup.size).toBe(0);
  });

  it('raises the version on a new request, so the worker can watch one number', () => {
    expect(store.refreshMarksVersion()).toBe(0);
    store.setRefreshMark(42, 1000);
    expect(store.refreshMarksVersion()).toBe(1000);
    store.setRefreshMark(ALL_GROUPS, 4000);
    expect(store.refreshMarksVersion()).toBe(4000);
  });

  it('clears marks with the data they were about', () => {
    store.setRefreshMark(ALL_GROUPS, 1000);
    store.resetData();
    // A mark against verdicts that no longer exist has already been granted,
    // and would otherwise keep waking the worker forever.
    expect(store.refreshMarks().all).toBeNull();
    expect(store.refreshMarksVersion()).toBe(0);
  });

  it('keeps channel marks apart from group marks with the same id', () => {
    store.setRefreshMark(7, 1000);
    store.setChannelRefreshMark(7, 2000);

    const marks = store.refreshMarks();
    expect(marks.byGroup.get(7)).toBe(1000);
    expect(marks.byChannel.get(7)).toBe(2000);
    expect(store.clearChannelRefreshMark(7)).toBe(1);
    expect(store.clearChannelRefreshMark(7)).toBe(0);
    expect(store.refreshMarks().byGroup.get(7)).toBe(1000);
  });

  it('retires a channel request by its instant, leaving a re-armed one alone', () => {
    store.setChannelRefreshMark(5, 1000);
    store.setChannelRefreshMark(5, 2000);
    expect(store.clearChannelRefreshMark(5, 1000)).toBe(0);
    expect(store.refreshMarks().byChannel.get(5)).toBe(2000);
    expect(store.clearChannelRefreshMark(5, 2000)).toBe(1);
    expect(store.refreshMarks().byChannel.size).toBe(0);
  });

  it('takes the latest of the catalogue, group and channel marks', () => {
    const marks = {
      all: 1000,
      byGroup: new Map([[42, 3000]]),
      byChannel: new Map([[5, 5000]]),
    };
    expect(forcedAtFor(marks, 42, 5)).toBe(5000);
    // Only the channel that was asked for: its neighbours keep the group's.
    expect(forcedAtFor(marks, 42, 6)).toBe(3000);
    // A channel in no group is still reachable by its own mark.
    expect(forcedAtFor(marks, null, 5)).toBe(5000);
    // A later group mark wins over an older channel one.
    expect(forcedAtFor({ ...marks, byGroup: new Map([[42, 8000]]) }, 42, 5)).toBe(8000);
  });

  it('drops the channel marks a catalogue-wide request subsumes', () => {
    store.setChannelRefreshMark(5, 1000);
    store.setChannelRefreshMark(6, 1000);
    store.setRefreshMark(42, 1000);

    expect(store.clearChannelRefreshMarks()).toBe(2);
    expect(store.refreshMarks().byChannel.size).toBe(0);
    // Group marks are a separate clear.
    expect(store.refreshMarks().byGroup.get(42)).toBe(1000);
  });

  it('raises the version on a new channel request too', () => {
    store.setRefreshMark(42, 1000);
    store.setChannelRefreshMark(5, 3000);
    expect(store.refreshMarksVersion()).toBe(3000);
    // Only new requests move it forward; a cancel lowers it.
    store.clearChannelRefreshMark(5);
    expect(store.refreshMarksVersion()).toBe(1000);
  });

  it('clears channel marks with the data they were about', () => {
    store.setChannelRefreshMark(5, 1000);
    store.resetData();
    expect(store.refreshMarks().byChannel.size).toBe(0);
    expect(store.refreshMarksVersion()).toBe(0);
  });

  it('brings every older verdict due, the way the progress page reads it', () => {
    store.put(10, 'h', result());
    const live = 24 * 3_600_000;
    // Read the verdict's own timestamp rather than a clock sampled before the
    // write. `put` stamps `probed_at` with its own `Date.now()`, so on a slow
    // enough machine the row lands two or more milliseconds after anything
    // captured beforehand -- which put the verdict NEWER than the mark below
    // and inverted the whole assertion. `due` is `probed_at <= forced`, so the
    // margin was exactly one millisecond, and CI eventually spent it.
    const probedAt = store.verdicts([10]).get(10)?.probedAt ?? 0;
    expect(probedAt).toBeGreaterThan(0);

    const before = store.cacheHealth(live, 3_600_000, probedAt);
    expect(before.due).toBe(0);
    expect(before.nextDueAt).toBeGreaterThan(probedAt);

    // Same query, with a catalogue-wide mark stamped after that verdict.
    const after = store.cacheHealth(live, 3_600_000, probedAt, 3_600_000, 0, probedAt + 1);
    expect(after.due).toBe(1);
    expect(after.nextDueAt).toBe(probedAt);
    // The verdict itself is untouched -- this is a view, not a delete.
    expect(after.total).toBe(1);
    expect(after.alive).toBe(1);
  });

  it('leaves a verdict newer than the mark alone', () => {
    // The other side of the boundary, and the case whose absence let the race
    // above look like a passing test: a mark only brings verdicts recorded
    // before it due, so one recorded after it must stay cached.
    store.put(10, 'h', result());
    const probedAt = store.verdicts([10]).get(10)?.probedAt ?? 0;
    const health = store.cacheHealth(
      24 * 3_600_000,
      3_600_000,
      probedAt,
      3_600_000,
      0,
      probedAt - 1,
    );
    expect(health.due).toBe(0);
    expect(health.nextDueAt).toBeGreaterThan(probedAt);
  });
});

describe('the planner against a mark', () => {
  let dir: string;
  let store: Store;
  let rulesPath: string;

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
      name: 'TNT',
      url: 'u2',
      providerId: 5,
      streamHash: 'h',
      currentViewers: 0,
      groupId: 200,
    },
  ];
  const channels: Channel[] = [
    { id: 1, name: 'ESPN', tvgId: 'espn.id', streams: [10], groupId: 100 },
    { id: 2, name: 'TNT', tvgId: 'tnt.id', streams: [20], groupId: 200 },
  ];
  const groupNames = new Map([
    [100, 'sports'],
    [200, 'movies'],
  ]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-refresh-'));
    rulesPath = join(dir, 'rules.json');
    const doc = JSON.stringify({
      schema: 2,
      channels: [
        { channel_id: 1, aliases: ['ESPN'] },
        { channel_id: 2, aliases: ['TNT'] },
      ],
    });
    const tmp = `${rulesPath}.tmp`;
    writeFileSync(tmp, doc, 'utf8');
    renameSync(tmp, rulesPath);
    store = new Store(join(dir, 'podium.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** plan() is private; reach it directly rather than faking Dispatcharr. */
  function plan(runner: Runner, rules: RulesSource) {
    return (
      runner as unknown as {
        plan: (...args: unknown[]) => {
          jobs: Array<{ streamId: number }>;
          ages: number[];
          planned: Array<{ channel: { id: number }; cacheComplete: boolean }>;
          outstandingMarks: OutstandingMark[];
        };
      }
    ).plan.call(
      runner,
      channels,
      streams,
      new Map(),
      rules.get().eligibility,
      { cached: 0 },
      {},
      groupNames,
      { next: new Map(), nextLive: new Map() },
      null,
    );
  }

  /** retireSatisfiedMarks is private for the same reason plan() is. */
  function retire(runner: Runner, marks: OutstandingMark[]): number {
    return (
      runner as unknown as {
        retireSatisfiedMarks: (marks: OutstandingMark[]) => number;
      }
    ).retireSatisfiedMarks.call(runner, marks);
  }

  function build() {
    const rules = new RulesSource(rulesPath);
    const runner = new Runner({
      config: () => loadConfig({ DISPATCHARR_API_KEY: 'k', PODIUM_DATA_DIR: dir }),
      store,
      rules,
    });
    return { rules, runner };
  }

  it('re-queues a fresh verdict in the marked group, and only that group', () => {
    const { rules, runner } = build();
    store.put(10, 'h', result());
    store.put(20, 'h', result());
    // Both verdicts are minutes old, so nothing is due.
    expect(plan(runner, rules).jobs).toHaveLength(0);

    store.setRefreshMark(100, Date.now());
    const jobs = plan(runner, rules).jobs;
    expect(jobs.map((j) => j.streamId)).toEqual([10]);
  });

  it('covers every group with a catalogue-wide mark', () => {
    const { rules, runner } = build();
    store.put(10, 'h', result());
    store.put(20, 'h', result());

    store.setRefreshMark(ALL_GROUPS, Date.now());
    const jobs = plan(runner, rules).jobs;
    expect(jobs.map((j) => j.streamId).sort()).toEqual([10, 20]);
  });

  it('puts the verdict straight back in service when the request is cancelled', () => {
    // The whole reason a mark stamps an instant instead of deleting rows: the
    // measurement is still there, so calling the request off costs nothing.
    const { rules, runner } = build();
    store.put(10, 'h', result());
    store.put(20, 'h', result());
    store.setRefreshMark(100, Date.now());
    expect(plan(runner, rules).jobs).toHaveLength(1);

    store.clearRefreshMark(100);
    const after = plan(runner, rules);
    expect(after.jobs).toHaveLength(0);
    expect(after.planned.find((p) => p.channel.id === 1)?.cacheComplete).toBe(true);
  });

  it('retires a request every verdict has outlived, so a re-check settles', () => {
    const { rules, runner } = build();
    const at = Date.now() - 60_000;
    store.setRefreshMark(100, at);
    store.put(10, 'h', result());
    store.put(20, 'h', result());
    // Probed after the request: it has been satisfied. The planner alone could
    // let the mark sit inert, but every reader of the table -- the banner, the
    // group chips, the cancel offer -- treats its existence as a request still
    // running, so the pass is what clears it.
    const planned = plan(runner, rules);
    expect(planned.jobs).toHaveLength(0);
    expect(planned.outstandingMarks).toEqual([{ groupId: 100, forcedAt: at, remaining: 0 }]);
    expect(retire(runner, planned.outstandingMarks)).toBe(0);
    expect(store.refreshMarks().byGroup.has(100)).toBe(false);
  });

  it('counts a verdict the EPG gate is holding back, and keeps the request open', () => {
    // Group 200 becomes after_epg_start, and with no EPG rows its channel is
    // held back: no job, so the backlog reads zero -- but its retired verdict
    // is as outstanding as any other, and the request cannot finish until the
    // gate opens and a pass replaces it.
    const tmp = `${rulesPath}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        schema: 2,
        channels: [
          { channel_id: 1, aliases: ['ESPN'] },
          { channel_id: 2, aliases: ['TNT'] },
        ],
        groups: { '200': { mode: 'after_epg_start' } },
      }),
      'utf8',
    );
    renameSync(tmp, rulesPath);

    const { rules, runner } = build();
    // Verdicts first, then the request: a millisecond ticking between the two
    // would otherwise leave the puts stamped after the mark, and the count
    // this test asserts would depend on the clock. Same-ms ties count as
    // retired -- the request means "before I asked".
    store.put(10, 'h', result());
    store.put(20, 'h', result());
    const at = Date.now();
    store.setRefreshMark(ALL_GROUPS, at);

    const planned = plan(runner, rules);
    // Stream 10 is on an allowed channel and becomes a job; stream 20 cannot
    // be probed until something airs, yet both verdicts are still retired.
    expect(planned.jobs.map((j) => j.streamId)).toEqual([10]);
    expect(planned.outstandingMarks).toEqual([{ groupId: ALL_GROUPS, forcedAt: at, remaining: 2 }]);
    expect(retire(runner, planned.outstandingMarks)).toBe(2);
    expect(store.refreshMarks().all).toBe(at);
  });

  it('finishes two covering requests independently', () => {
    // A channel covered by both a group mark and a catalogue-wide one keeps
    // each open on its own, and only the satisfied one is retired. The group
    // mark is a clear minute old so both verdicts strictly outlive it; the
    // catalogue-wide one is stamped after the puts so neither does.
    const { rules, runner } = build();
    const groupAt = Date.now() - 60_000;
    store.setRefreshMark(100, groupAt);
    store.put(10, 'h', result()); // group 100: outlives its mark, retired by the all
    store.put(20, 'h', result()); // group 200: only the all-mark covers it
    const allAt = Date.now();
    store.setRefreshMark(ALL_GROUPS, allAt);

    const planned = plan(runner, rules);
    expect(planned.outstandingMarks).toEqual([
      { groupId: ALL_GROUPS, forcedAt: allAt, remaining: 2 },
      { groupId: 100, forcedAt: groupAt, remaining: 0 },
    ]);
    expect(retire(runner, planned.outstandingMarks)).toBe(2);
    expect(store.refreshMarks().byGroup.has(100)).toBe(false);
    expect(store.refreshMarks().all).toBe(allAt);
  });

  it('re-queues a fresh verdict on the marked channel, and only that channel', () => {
    const { rules, runner } = build();
    store.put(10, 'h', result());
    store.put(20, 'h', result());
    expect(plan(runner, rules).jobs).toHaveLength(0);

    // Channel 2 is in group 200; a group-100 mark would not reach it, and this
    // must not reach channel 1 either.
    store.setChannelRefreshMark(2, Date.now());
    expect(plan(runner, rules).jobs.map((j) => j.streamId)).toEqual([20]);
  });

  it('does not read a channel mark as the group with the same id', () => {
    // Channel 100 does not exist; group 100 does. A shared key space would
    // re-check all of group 100 here.
    const { rules, runner } = build();
    store.put(10, 'h', result());
    store.put(20, 'h', result());
    store.setChannelRefreshMark(100, Date.now());
    expect(plan(runner, rules).jobs).toHaveLength(0);
  });

  it('puts a channel verdict back in service when its request is cancelled', () => {
    const { rules, runner } = build();
    store.put(10, 'h', result());
    store.put(20, 'h', result());
    store.setChannelRefreshMark(1, Date.now());
    expect(plan(runner, rules).jobs.map((j) => j.streamId)).toEqual([10]);

    store.clearChannelRefreshMark(1);
    const after = plan(runner, rules);
    expect(after.jobs).toHaveLength(0);
    expect(after.planned.find((p) => p.channel.id === 1)?.cacheComplete).toBe(true);
  });

  it('holds a channel request open until its verdicts are re-probed, then retires it', () => {
    const { rules, runner } = build();
    const lines: string[] = [];
    store.put(10, 'h', result());
    store.put(20, 'h', result());
    const at = Date.now();
    store.setChannelRefreshMark(1, at);

    // Before the re-probe: stream 10 is still to go, so the request stays.
    const before = plan(runner, rules);
    expect(before.outstandingMarks).toEqual([{ channelId: 1, forcedAt: at, remaining: 1 }]);
    expect(retire(runner, before.outstandingMarks)).toBe(1);
    expect(store.refreshMarks().byChannel.get(1)).toBe(at);

    // The re-probe lands strictly after the request; the next pass finds it
    // satisfied and drops it, announcing which channel finished.
    vi.useFakeTimers({ now: at + 60_000, toFake: ['Date'] });
    try {
      store.put(10, 'h', result());
      const logged = new Runner({
        config: () => loadConfig({ DISPATCHARR_API_KEY: 'k', PODIUM_DATA_DIR: dir }),
        store,
        rules,
        log: (line) => lines.push(line),
      });
      const after = plan(logged, rules);
      expect(after.jobs).toHaveLength(0);
      expect(after.outstandingMarks).toEqual([{ channelId: 1, forcedAt: at, remaining: 0 }]);
      expect(retire(logged, after.outstandingMarks)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(store.refreshMarks().byChannel.has(1)).toBe(false);
    expect(lines).toContain('re-check of channel 1 finished');
  });

  it('keeps a channel request and a group request over it open independently', () => {
    // Channel 1 sits in group 100. The channel mark is a minute old, so the
    // verdict outlives it; the group mark is stamped after, so it does not.
    const { rules, runner } = build();
    const channelAt = Date.now() - 60_000;
    store.setChannelRefreshMark(1, channelAt);
    store.put(10, 'h', result());
    store.put(20, 'h', result());
    const groupAt = Date.now();
    store.setRefreshMark(100, groupAt);

    const planned = plan(runner, rules);
    expect(planned.outstandingMarks).toEqual([
      { groupId: 100, forcedAt: groupAt, remaining: 1 },
      { channelId: 1, forcedAt: channelAt, remaining: 0 },
    ]);
    expect(retire(runner, planned.outstandingMarks)).toBe(1);
    expect(store.refreshMarks().byChannel.has(1)).toBe(false);
    expect(store.refreshMarks().byGroup.get(100)).toBe(groupAt);
  });

  it('paces a marked stream as work to do now, not at its usual turn', () => {
    // `sliceSize` sizes the pass off the oldest open age, so reporting the real
    // age of a stream probed a minute ago would trickle a requested re-check at
    // MIN_BATCH a tick against a deadline 24 hours out.
    const { rules, runner } = build();
    store.put(10, 'h', result());
    store.put(20, 'h', result());
    store.setRefreshMark(100, Date.now());

    const planned = plan(runner, rules);
    expect(planned.ages).toEqual([Number.MAX_SAFE_INTEGER]);
  });
});

describe('the worker waking for a request', () => {
  let dir: string;
  let store: Store;
  let stop: (() => void) | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-wake-'));
    writeFileSync(join(dir, 'rules.json'), JSON.stringify({ schema: 2, channels: [] }), 'utf8');
    store = new Store(loadConfig({ PODIUM_DATA_DIR: dir }).dbPath);
  });

  afterEach(() => {
    stop?.();
    stop = null;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('brings the next pass forward instead of sleeping through it', async () => {
    // Without this the button does nothing visible for up to PODIUM_IDLE_MAX_MS
    // on a settled install, which is the one kind of install it is for.
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const config = loadConfig({ PODIUM_DATA_DIR: dir, DISPATCHARR_API_KEY: 'k' });
      stop = await startWorker(config, (m) => lines.push(m));
      await vi.advanceTimersByTimeAsync(100);

      const before = lines.length;
      store.setRefreshMark(ALL_GROUPS, Date.now());
      // The check rides the 30s heartbeat, which is the worst-case latency.
      await vi.advanceTimersByTimeAsync(31_000);

      expect(lines.slice(before).join('\n')).toContain('re-check requested; starting a pass now');
    } finally {
      vi.useRealTimers();
    }
  });

  it('wakes for a request on a single channel too', async () => {
    // Channel marks live in their own table, which the heartbeat's version has
    // to read as well or a channel re-check waits for the idle timer.
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const config = loadConfig({ PODIUM_DATA_DIR: dir, DISPATCHARR_API_KEY: 'k' });
      stop = await startWorker(config, (m) => lines.push(m));
      await vi.advanceTimersByTimeAsync(100);

      const before = lines.length;
      store.setChannelRefreshMark(1, Date.now());
      await vi.advanceTimersByTimeAsync(31_000);

      expect(lines.slice(before).join('\n')).toContain('re-check requested; starting a pass now');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wake for a mark that was already there when it started', async () => {
    // Whatever is on the table is picked up by the first pass, so treating it
    // as an arrival would book a redundant second one on every boot.
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      store.setRefreshMark(ALL_GROUPS, Date.now());
      const config = loadConfig({ PODIUM_DATA_DIR: dir, DISPATCHARR_API_KEY: 'k' });
      stop = await startWorker(config, (m) => lines.push(m));
      await vi.advanceTimersByTimeAsync(31_000);

      expect(lines.join('\n')).not.toContain('re-check requested');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wake for a cancellation', async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      store.setRefreshMark(ALL_GROUPS, Date.now());
      const config = loadConfig({ PODIUM_DATA_DIR: dir, DISPATCHARR_API_KEY: 'k' });
      stop = await startWorker(config, (m) => lines.push(m));
      await vi.advanceTimersByTimeAsync(100);

      store.clearRefreshMark(ALL_GROUPS);
      await vi.advanceTimersByTimeAsync(31_000);

      expect(lines.join('\n')).not.toContain('re-check requested');
    } finally {
      vi.useRealTimers();
    }
  });
});
