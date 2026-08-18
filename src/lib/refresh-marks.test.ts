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
import { Runner } from './runner';
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
    const marks = { all: 1000, byGroup: new Map([[42, 3000]]) };
    expect(forcedAtFor(marks, 42)).toBe(3000);
    // The group mark is older here, so the catalogue-wide one is what applies.
    expect(forcedAtFor({ all: 9000, byGroup: new Map([[42, 3000]]) }, 42)).toBe(9000);
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

  it('brings every older verdict due, the way the progress page reads it', () => {
    const now = Date.now();
    store.put(10, 'h', result());
    const live = 24 * 3_600_000;

    const before = store.cacheHealth(live, 3_600_000, now);
    expect(before.due).toBe(0);
    expect(before.nextDueAt).toBeGreaterThan(now);

    // Same query, with a catalogue-wide mark stamped after that verdict.
    const after = store.cacheHealth(live, 3_600_000, now, 3_600_000, 0, now + 1);
    expect(after.due).toBe(1);
    expect(after.nextDueAt).toBe(now);
    // The verdict itself is untouched -- this is a view, not a delete.
    expect(after.total).toBe(1);
    expect(after.alive).toBe(1);
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

  it('ignores a mark older than the verdict, so a re-check settles', () => {
    const { rules, runner } = build();
    store.setRefreshMark(100, Date.now() - 60_000);
    store.put(10, 'h', result());
    store.put(20, 'h', result());
    // Probed after the request: the request has been satisfied, and the mark
    // going inert on its own is why nothing has to clean it up.
    expect(plan(runner, rules).jobs).toHaveLength(0);
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
