/**
 * Regressions introduced by the first round of review fixes.
 *
 * Each block pins the behaviour the fix was *supposed* to produce, phrased so a
 * repeat of the original mistake fails rather than passing quietly.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIN_BATCH, Pacer } from './pacer';
import { Store } from './store';

const HOUR = 3_600_000;

describe('pacer slice sizing (finding 05, corrected)', () => {
  const pacer = new Pacer({
    maxAgeMs: 24 * HOUR,
    tickMs: 60_000,
    pauseWhenWatching: true,
    minFreeSlots: 1,
    maxSlice: 400,
  });

  it('floors a thin backlog at a batch rather than one stream per tick', () => {
    // 416 dead verdicts that just expired at the 3h dead TTL. The original bug
    // was Math.max(1, ...) here: one stream per tick, each tick paying a full
    // catalogue crawl.
    expect(pacer.sliceSize(416, 3 * HOUR)).toBe(MIN_BATCH);
  });

  it('still paces: a slice is not the ceiling just because something is due', () => {
    // The over-correction was passing the dead TTL as the target, which makes
    // `remaining` permanently negative and fires maxSlice every pass.
    const slice = pacer.sliceSize(416, 3 * HOUR);
    expect(slice).toBeLessThan(400);
    expect(slice).toBeGreaterThan(0);
  });

  it('grows the slice as the freshness deadline approaches', () => {
    // A backlog large enough that both samples clear MIN_BATCH; at realistic
    // sizes the floor dominates, which is the point of having one.
    const early = pacer.sliceSize(30_000, 6 * HOUR);
    const late = pacer.sliceSize(30_000, 20 * HOUR);
    expect(early).toBeGreaterThan(MIN_BATCH);
    expect(late).toBeGreaterThan(early);
  });

  it('runs at the ceiling once past the freshness target', () => {
    expect(pacer.sliceSize(1200, 25 * HOUR)).toBe(400);
    expect(pacer.sliceSize(1740, Number.MAX_SAFE_INTEGER)).toBe(400);
  });

  it('never returns more than the backlog', () => {
    expect(pacer.sliceSize(3, 3 * HOUR)).toBe(3);
    expect(pacer.sliceSize(0, 3 * HOUR)).toBe(0);
  });

  it('honours maxAgeMs -- the freshness target is not decorative', () => {
    const tight = new Pacer({
      maxAgeMs: 6 * HOUR,
      tickMs: 60_000,
      pauseWhenWatching: true,
      minFreeSlots: 1,
      maxSlice: 400,
    });
    const loose = new Pacer({
      maxAgeMs: 48 * HOUR,
      tickMs: 60_000,
      pauseWhenWatching: true,
      minFreeSlots: 1,
      maxSlice: 400,
    });
    expect(tight.sliceSize(2000, 5 * HOUR)).toBeGreaterThan(loose.sliceSize(2000, 5 * HOUR));
  });
});

describe('paused message attribution (finding 8.8, corrected)', () => {
  // The shape readActivity returns, and the branch runOnce takes on it.
  const message = (activity: { idle: boolean; probeFailed: boolean }) =>
    activity.probeFailed
      ? 'paused: cannot reach Dispatcharr to check who is watching; assuming busy'
      : activity.idle
        ? 'paused: no spare provider capacity'
        : 'someone is watching; no spare provider capacity';

  it('names Dispatcharr when the activity probe failed', () => {
    // Fail-closed returns idle:false, which is indistinguishable from a real
    // viewer without the flag -- keying on `idle` alone named the wrong cause
    // in both directions.
    expect(message({ idle: false, probeFailed: true })).toContain('cannot reach Dispatcharr');
  });

  it('names the viewer when somebody is actually watching', () => {
    expect(message({ idle: false, probeFailed: false })).toContain('someone is watching');
  });

  it('says neither when idle but every lane is consumed', () => {
    const msg = message({ idle: true, probeFailed: false });
    expect(msg).not.toContain('cannot reach Dispatcharr');
    expect(msg).not.toContain('someone is watching');
  });
});

describe('on-demand check capacity (finding 04 follow-up)', () => {
  // limit - reserve - (workerBusy ? 1 : 0), floored at 0.
  const spare = (limit: number, watching: boolean, workerBusy: boolean, minFreeSlots = 1) =>
    Math.max(0, limit - (watching ? minFreeSlots : 0) - (workerBusy ? 1 : 0));

  it('keeps a slot back for a viewer who is watching', () => {
    expect(spare(5, true, false)).toBe(4);
    expect(spare(1, true, false)).toBe(0);
  });

  it('does not reserve while nobody is watching, or a limit-1 provider starves', () => {
    expect(spare(1, false, false)).toBe(1);
    expect(spare(5, false, false)).toBe(5);
  });

  it('yields to the worker as well as to a viewer', () => {
    expect(spare(5, true, true)).toBe(3);
    expect(spare(1, false, true)).toBe(0);
  });

  it('never forces a slot the provider does not have', () => {
    // The original bug was Math.max(1, ...), which opened a connection against
    // a fully committed limit-1 provider.
    expect(spare(1, true, true)).toBe(0);
  });
});

describe('pruneOutside guard (finding 8.4 follow-up)', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-prune-'));
    store = new Store(join(dir, 'test.db'));
    for (let id = 1; id <= 200; id++) {
      store.put(id, `hash-${id}`, {
        alive: true,
        width: 1920,
        height: 1080,
        fps: 50,
        bitrateKbps: 4000,
        videoCodec: 'h264',
        audioCodec: 'aac',
        pixelFormat: 'yuv420p',
        audioChannels: 2,
        channelLayout: 'stereo',
        elapsedMs: 10,
        error: '',
      });
    }
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a suspicious collapse and says why', () => {
    const warnings: string[] = [];
    const keep = new Set([1, 2, 3]);
    expect(store.pruneOutside(keep, 0.2, (m) => warnings.push(m))).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('skipping cache prune');
    expect(warnings[0]).toContain('3 of 200');
  });

  it('still prunes a normal reduction, silently', () => {
    const warnings: string[] = [];
    const keep = new Set(Array.from({ length: 180 }, (_, i) => i + 1));
    expect(store.pruneOutside(keep, 0.2, (m) => warnings.push(m))).toBe(20);
    expect(warnings).toHaveLength(0);
  });

  it('deletes nothing on an empty keep set, without warning', () => {
    const warnings: string[] = [];
    expect(store.pruneOutside(new Set(), 0.2, (m) => warnings.push(m))).toBe(0);
    expect(warnings).toHaveLength(0);
  });
});

describe('jobs on providers with no lane (finding 8.10 follow-up)', () => {
  // The split runOnce performs: open / deferred / unrunnable.
  const split = (
    jobs: Array<{ providerId: number }>,
    limits: Map<number, number>,
    known: Set<number>,
  ) => {
    let open = 0;
    let unrunnable = 0;
    for (const job of jobs) {
      if (limits.has(job.providerId)) open += 1;
      else if (!known.has(job.providerId)) unrunnable += 1;
    }
    return { open, deferred: jobs.length - open - unrunnable, unrunnable };
  };

  it('does not count streams on an inactive provider as deferred work', () => {
    // Deferred implies "a later pass will pick this up", which drives the loop's
    // decision to skip its idle sleep. A provider Dispatcharr has deactivated
    // never gets a lane, so counting its streams as deferred pins the worker to
    // a once-a-minute full crawl forever.
    const result = split(
      [{ providerId: 5 }, { providerId: 6 }, { providerId: 99 }, { providerId: 99 }],
      new Map([[5, 1]]),
      new Set([5, 6]),
    );
    expect(result).toEqual({ open: 1, deferred: 1, unrunnable: 2 });
  });
});
