/**
 * What removal is allowed to take, and when.
 *
 * The report behind this: a provider went down, and an install with
 * PODIUM_REMOVE_UNMATCHED on lost every one of that provider's streams from
 * every channel it served. Nothing about the rules had changed. The provider
 * stopped answering, its M3U came back empty, Dispatcharr marked the whole
 * catalogue `is_stale`, `plan` dropped stale streams before matching, and
 * `composeOrder` could not tell "the catalogue cannot rank this right now" from
 * "no rule claims this" -- so it unassigned the lot. The provider came back;
 * the assignments did not, because an assignment is something a channel
 * remembers, not something a stream carries.
 *
 * Two defences, and they are deliberately not the same defence. Staleness is
 * protected outright and forever, because it is never evidence about what a
 * rule wants. A genuinely unclaimed stream is protected only for a grace
 * period, because there the delay is the whole point: it has to outlast a
 * transient and still let a deliberate rule change land.
 */

import { describe, expect, it } from 'vitest';
import type { Stream } from './dispatcharr';
import { composeOrder, protectedFromRemoval, unclaimedStreams } from './runner';
import { Store } from './store';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function stream(id: number, over: Partial<Stream> = {}): Stream {
  return {
    id,
    name: `stream ${id}`,
    url: `http://example.invalid/${id}`,
    providerId: 1,
    streamHash: `hash-${id}`,
    currentViewers: 0,
    groupId: null,
    ...over,
  };
}

/** 1 and 2 are ranked, 3 is stale, 4 is simply unclaimed, 5 is gone entirely. */
function catalogue(): Map<number, Stream> {
  return new Map([
    [1, stream(1)],
    [2, stream(2)],
    [3, stream(3, { is_stale: true })],
    [4, stream(4)],
  ]);
}

const assigned = [1, 2, 3, 4, 5];
const ranked = [2, 1];

describe('unclaimedStreams', () => {
  it('is only the streams a rule could have claimed and did not', () => {
    expect(unclaimedStreams(assigned, ranked, catalogue())).toEqual([4]);
  });

  /**
   * The stale stream must never get a row, or its clock would expire into a
   * removal the moment an outage outlasts the grace period -- which is the
   * failure the whole feature exists to stop.
   */
  it('never counts a stale or absent stream as unclaimed', () => {
    const found = unclaimedStreams(assigned, ranked, catalogue());
    expect(found).not.toContain(3);
    expect(found).not.toContain(5);
  });
});

describe('protectedFromRemoval', () => {
  it('holds back a stale stream however long it has been stale', () => {
    const held = protectedFromRemoval(assigned, ranked, catalogue(), new Map(), 0, 0);
    expect(held.has(3)).toBe(true);
  });

  it('holds back a stream the catalogue no longer carries', () => {
    const held = protectedFromRemoval(assigned, ranked, catalogue(), new Map(), 0, 0);
    expect(held.has(5)).toBe(true);
  });

  it('never holds back a stream the ranking already covers', () => {
    const held = protectedFromRemoval(assigned, ranked, catalogue(), new Map(), 0, DAY);
    expect(held.has(1)).toBe(false);
    expect(held.has(2)).toBe(false);
  });

  it('holds back an unclaimed stream until its grace period runs out', () => {
    const since = new Map([[4, 1_000]]);
    const inside = protectedFromRemoval(
      assigned,
      ranked,
      catalogue(),
      since,
      1_000 + 23 * HOUR,
      DAY,
    );
    expect(inside.has(4)).toBe(true);

    const outside = protectedFromRemoval(assigned, ranked, catalogue(), since, 1_000 + DAY, DAY);
    expect(outside.has(4)).toBe(false);
  });

  /** First sighting: the clock has not been written yet, so it starts now. */
  it('gives a stream with no clock yet the whole window', () => {
    const held = protectedFromRemoval(assigned, ranked, catalogue(), new Map(), 5_000, DAY);
    expect(held.has(4)).toBe(true);
  });

  it('protects only staleness when the grace period is off', () => {
    const held = protectedFromRemoval(assigned, ranked, catalogue(), new Map(), 5_000, 0);
    expect([...held].sort()).toEqual([3, 5]);
  });
});

describe('composeOrder honours what is protected', () => {
  it('keeps protected strays after the ranked streams', () => {
    const held = new Set([3, 5]);
    expect(composeOrder(ranked, assigned, true, undefined, held)).toEqual([2, 1, 3, 5]);
  });

  it('still drops an unprotected stray', () => {
    const held = new Set([3]);
    expect(composeOrder(ranked, assigned, true, undefined, held)).toEqual([2, 1, 3]);
  });

  /** The old behaviour, which every existing caller must still get. */
  it('removes everything unmatched when nothing is protected', () => {
    expect(composeOrder(ranked, assigned, true)).toEqual([2, 1]);
    expect(composeOrder(ranked, assigned, true, undefined, new Set())).toEqual([2, 1]);
  });

  it('keeps every stray when removal is off, protected or not', () => {
    expect(composeOrder(ranked, assigned, false, undefined, new Set([3]))).toEqual([2, 1, 3, 4, 5]);
  });

  /** The regression itself, end to end: an outage must cost nothing. */
  it('leaves a channel untouched when a provider goes stale wholesale', () => {
    const down = new Map([
      [1, stream(1, { is_stale: true })],
      [2, stream(2, { is_stale: true })],
      [3, stream(3, { is_stale: true })],
    ]);
    const held = protectedFromRemoval([1, 2, 3], [], down, new Map(), Date.now(), DAY);
    expect(composeOrder([], [1, 2, 3], true, undefined, held)).toEqual([1, 2, 3]);
  });
});

describe('the unclaimed clock', () => {
  it('starts a clock and keeps it across passes', () => {
    const store = new Store(':memory:');
    const first = store.markUnmatched(7, [4], 1_000);
    expect(first.get(4)).toBe(1_000);

    // A later pass finds the same stream unclaimed: the clock must not restart.
    const second = store.markUnmatched(7, [4], 9_000);
    expect(second.get(4)).toBe(1_000);
    store.close();
  });

  it('forgets a stream the rule claims again, and starts it over if it lapses', () => {
    const store = new Store(':memory:');
    store.markUnmatched(7, [4], 1_000);
    expect(store.markUnmatched(7, [], 2_000).size).toBe(0);
    expect(store.markUnmatched(7, [4], 3_000).get(4)).toBe(3_000);
    store.close();
  });

  it('keeps each channel and stream on its own clock', () => {
    const store = new Store(':memory:');
    store.markUnmatched(7, [4], 1_000);
    store.markUnmatched(8, [4], 5_000);
    store.markUnmatched(7, [4, 9], 6_000);
    expect(store.markUnmatched(7, [4, 9], 7_000).get(4)).toBe(1_000);
    expect(store.markUnmatched(7, [4, 9], 7_000).get(9)).toBe(6_000);
    expect(store.unmatchedSince(8).get(4)).toBe(5_000);
    store.close();
  });

  it('reads without advancing, so a preview decides nothing', () => {
    const store = new Store(':memory:');
    expect(store.unmatchedSince(7).size).toBe(0);
    store.markUnmatched(7, [4], 1_000);
    expect(store.unmatchedSince(7).get(4)).toBe(1_000);
    expect(store.unmatchedSince(7).get(4)).toBe(1_000);
    store.close();
  });

  it('clears a channel outright', () => {
    const store = new Store(':memory:');
    store.markUnmatched(7, [4, 9], 1_000);
    store.clearUnmatched(7);
    expect(store.unmatchedSince(7).size).toBe(0);
    store.close();
  });
});
