/**
 * The stability ledger on disk: what the poller writes, what the ranking reads
 * back, and what ages out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Leg } from './stability';
import { STABILITY_HISTORY_MS, Store } from './store';

const HOUR = 3_600_000;
/** Fixed so every `endedAt` below can be written as an offset from it. */
const NOW = new Date('2026-09-15T12:00:00Z').getTime();

function leg(over: Partial<Leg> = {}): Leg {
  return {
    channelKey: 'ch-wjla',
    channelId: 35200,
    streamId: 77013,
    startedAt: NOW - HOUR,
    endedAt: NOW,
    watchedMs: HOUR,
    stalledMs: 0,
    stalls: 0,
    ended: 'gone',
    ...over,
  };
}

describe('the stability ledger', () => {
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  it('has nothing to say about a stream nobody has watched', () => {
    expect(store.stabilityRecords().get(77013)).toBeUndefined();
  });

  it('folds legs into one record per stream', () => {
    store.recordLegs([
      leg({ ended: 'failover' }),
      leg({ ended: 'gone', watchedMs: 2 * HOUR }),
      leg({ streamId: 77177 }),
    ]);
    expect(store.stabilityRecords().get(77013)).toMatchObject({
      legs: 2,
      breaks: 1,
      watchedMs: 3 * HOUR,
    });
    expect(store.stabilityRecords().get(77177)).toMatchObject({ legs: 1, breaks: 0 });
  });

  it('counts only breaks as failures, not sessions that merely ended', () => {
    store.recordLegs([leg({ ended: 'gone' }), leg({ ended: 'retune' }), leg({ ended: 'drain' })]);
    expect(store.stabilityRecords().get(77013)?.breaks).toBe(0);
  });

  it('sums stalls across legs', () => {
    store.recordLegs([leg({ stalls: 2, stalledMs: 5_000 }), leg({ stalls: 1, stalledMs: 1_000 })]);
    expect(store.stabilityRecords().get(77013)).toMatchObject({ stalls: 3, stalledMs: 6_000 });
  });

  it('drops zero-length legs rather than letting them divide by nothing', () => {
    store.recordLegs([leg({ watchedMs: 0, ended: 'failover' })]);
    expect(store.stabilityRecords().get(77013)).toBeUndefined();
  });

  it('keeps the newest observation time', () => {
    store.recordLegs([
      leg({ endedAt: NOW - 3 * HOUR }),
      leg({ endedAt: NOW - HOUR }),
      leg({ endedAt: NOW - 2 * HOUR }),
    ]);
    expect(store.stabilityRecords().get(77013)?.lastSeenAt).toBe(NOW - HOUR);
  });

  it('reads back the legs themselves, newest first', () => {
    store.recordLegs([
      leg({ endedAt: NOW - 3 * HOUR }),
      leg({ endedAt: NOW - HOUR }),
      leg({ streamId: 77177 }),
    ]);
    expect(store.stabilityLegs().map((l) => l.endedAt)).toEqual([NOW, NOW - HOUR, NOW - 3 * HOUR]);
    expect(store.stabilityLegs(77177)).toHaveLength(1);
  });

  it('ignores legs outside the window', () => {
    store.recordLegs([
      leg({ endedAt: NOW - 1_000 }),
      leg({ endedAt: NOW - STABILITY_HISTORY_MS - 1_000 }),
    ]);
    expect(store.stabilityRecords().get(77013)?.legs).toBe(1);
    // Still on disk -- the window is a read filter, and the sweep is a pass's job.
    expect(store.stabilityLegs(77013, STABILITY_HISTORY_MS * 4)).toHaveLength(2);
  });

  it('sweeps legs past the window when a pass starts', () => {
    store.recordLegs([
      leg({ endedAt: NOW - 1_000 }),
      leg({ endedAt: NOW - STABILITY_HISTORY_MS - 1_000 }),
    ]);
    store.startRun('run-1');
    expect(store.stabilityLegs(77013, STABILITY_HISTORY_MS * 4)).toHaveLength(1);
  });

  it('writes nothing for an empty batch', () => {
    store.recordLegs([]);
    expect(store.stabilityLegs()).toEqual([]);
  });

  it('keeps the latest completed soak summary per stream', () => {
    store.recordSoakResult(77013, {
      legs: [],
      heldMs: 60_000,
      drops: 1,
      failedDials: 2,
      unreachable: true,
      stopped: false,
    });
    vi.setSystemTime(NOW + HOUR);
    store.recordSoakResult(77013, {
      legs: [],
      heldMs: 180_000,
      drops: 0,
      failedDials: 0,
      unreachable: false,
      stopped: false,
    });

    expect(store.soakResults([77013, 77177]).get(77013)).toEqual({
      streamId: 77013,
      completedAt: NOW + HOUR,
      heldMs: 180_000,
      drops: 0,
      failedDials: 0,
      unreachable: false,
    });
    expect(store.soakResults([77177])).toEqual(new Map());
  });
});
