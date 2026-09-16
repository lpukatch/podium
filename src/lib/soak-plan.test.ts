/**
 * The soak sweep's two pieces of arithmetic: when it may run, and what it
 * should spend the night on.
 */

import { describe, expect, it } from 'vitest';
import {
  minutesLeftInWindow,
  parseSoakWindow,
  planSoaks,
  type SoakCandidate,
  soaksThatFit,
  soakWindowOpen,
} from './soak-plan';
import type { StabilityRecord } from './stability';

const DAY = 86_400_000;
const NOW = new Date('2026-09-16T12:00:00').getTime();

/** Local time on a fixed day, so the window tests do not depend on the clock. */
function at(hhmm: string): Date {
  return new Date(`2026-09-16T${hhmm}:00`);
}

function record(over: Partial<StabilityRecord> = {}): StabilityRecord {
  return {
    streamId: 1,
    legs: 1,
    breaks: 0,
    stalls: 0,
    watchedMs: 60_000,
    stalledMs: 0,
    lastSeenAt: NOW,
    ...over,
  };
}

function candidate(over: Partial<SoakCandidate> = {}): SoakCandidate {
  return { streamId: 1, channelId: 100, slot: 0, ...over };
}

describe('parseSoakWindow', () => {
  it('reads a plain range', () => {
    expect(parseSoakWindow('03:00-06:00')).toEqual({ startMin: 180, endMin: 360 });
  });

  it('reads one that wraps past midnight', () => {
    expect(parseSoakWindow('22:30-04:15')).toEqual({ startMin: 1350, endMin: 255 });
  });

  it('tolerates whitespace and a single-digit hour', () => {
    expect(parseSoakWindow(' 3:05 - 6:00 ')).toEqual({ startMin: 185, endMin: 360 });
  });

  it('is off rather than wrong for anything it cannot read', () => {
    // Null is the "switched off" state: a malformed window must never default
    // to some window nobody chose.
    for (const spec of [
      '',
      '  ',
      '3-6',
      '25:00-04:00',
      '03:60-04:00',
      '03:00',
      '03:00-04:00-05:00',
    ])
      expect(parseSoakWindow(spec)).toBeNull();
  });

  it('treats an empty range as off rather than as all day', () => {
    expect(parseSoakWindow('03:00-03:00')).toBeNull();
  });
});

describe('soakWindowOpen', () => {
  it('is open inside a plain range and shut outside it', () => {
    expect(soakWindowOpen('03:00-06:00', at('03:00'))).toBe(true);
    expect(soakWindowOpen('03:00-06:00', at('05:59'))).toBe(true);
    expect(soakWindowOpen('03:00-06:00', at('06:00'))).toBe(false);
    expect(soakWindowOpen('03:00-06:00', at('02:59'))).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    expect(soakWindowOpen('22:00-04:00', at('23:30'))).toBe(true);
    expect(soakWindowOpen('22:00-04:00', at('01:00'))).toBe(true);
    expect(soakWindowOpen('22:00-04:00', at('04:00'))).toBe(false);
    expect(soakWindowOpen('22:00-04:00', at('12:00'))).toBe(false);
  });

  it('is shut when no window is set', () => {
    expect(soakWindowOpen('', at('03:00'))).toBe(false);
  });
});

describe('minutesLeftInWindow', () => {
  it('counts down to the end of a plain range', () => {
    expect(minutesLeftInWindow('03:00-06:00', at('05:00'))).toBe(60);
  });

  it('counts across midnight from either side of it', () => {
    expect(minutesLeftInWindow('22:00-04:00', at('23:00'))).toBe(300);
    expect(minutesLeftInWindow('22:00-04:00', at('01:00'))).toBe(180);
  });

  it('is zero when the window is shut', () => {
    expect(minutesLeftInWindow('03:00-06:00', at('12:00'))).toBe(0);
    expect(minutesLeftInWindow('', at('03:00'))).toBe(0);
  });
});

describe('soaksThatFit', () => {
  it('fills the lanes for the time available', () => {
    // Three hours, eight lanes, three minutes each.
    expect(soaksThatFit(180, 8, 180)).toBe(480);
  });

  it('never queues one that the window would cut off', () => {
    // Eight minutes leaves two whole three-minute soaks per lane, not two and
    // two thirds. Overrunning holds connections into the morning.
    expect(soaksThatFit(8, 1, 180)).toBe(2);
  });

  it('is zero with no time, no lanes, or no duration', () => {
    expect(soaksThatFit(0, 8, 180)).toBe(0);
    expect(soaksThatFit(180, 0, 180)).toBe(0);
    expect(soaksThatFit(180, 8, 0)).toBe(0);
  });
});

describe('planSoaks', () => {
  const base = { maxPerChannel: 3, maxAgeMs: 14 * DAY, now: NOW, limit: 10 };

  it('prefers a stream nothing is known about', () => {
    const plan = planSoaks({
      ...base,
      candidates: [candidate({ streamId: 1 }), candidate({ streamId: 2, slot: 1 })],
      records: new Map([[1, record({ streamId: 1, lastSeenAt: NOW - 20 * DAY })]]),
    });
    // Stream 2 has never been observed, so its first measurement is worth more
    // than another look at one already on the books.
    expect(plan).toEqual([2, 1]);
  });

  it('takes the oldest record first among streams it has all seen', () => {
    const plan = planSoaks({
      ...base,
      candidates: [
        candidate({ streamId: 1 }),
        candidate({ streamId: 2, slot: 1 }),
        candidate({ streamId: 3, slot: 2 }),
      ],
      records: new Map([
        [1, record({ streamId: 1, lastSeenAt: NOW - 20 * DAY })],
        [2, record({ streamId: 2, lastSeenAt: NOW - 40 * DAY })],
        [3, record({ streamId: 3, lastSeenAt: NOW - 30 * DAY })],
      ]),
    });
    expect(plan).toEqual([2, 3, 1]);
  });

  it('breaks a tie by slot, so slot 0 is measured first', () => {
    const plan = planSoaks({
      ...base,
      candidates: [candidate({ streamId: 9, slot: 2 }), candidate({ streamId: 4, slot: 0 })],
      records: new Map(),
    });
    expect(plan).toEqual([4, 9]);
  });

  it('leaves alone a stream measured recently enough', () => {
    const plan = planSoaks({
      ...base,
      candidates: [candidate({ streamId: 1 })],
      records: new Map([[1, record({ streamId: 1, lastSeenAt: NOW - 1 * DAY })]]),
    });
    expect(plan).toEqual([]);
  });

  it('ignores streams too deep in a channel to ever be served', () => {
    const plan = planSoaks({
      ...base,
      candidates: [
        candidate({ streamId: 1, slot: 0 }),
        candidate({ streamId: 2, slot: 3 }),
        candidate({ streamId: 3, slot: 5 }),
      ],
      records: new Map(),
    });
    expect(plan).toEqual([1]);
  });

  it('measures every stream when the depth limit is off', () => {
    const plan = planSoaks({
      ...base,
      maxPerChannel: 0,
      candidates: [candidate({ streamId: 1, slot: 0 }), candidate({ streamId: 3, slot: 9 })],
      records: new Map(),
    });
    expect(plan).toEqual([1, 3]);
  });

  it("stops at the caller's limit", () => {
    const plan = planSoaks({
      ...base,
      limit: 2,
      candidates: [
        candidate({ streamId: 1, slot: 0 }),
        candidate({ streamId: 2, slot: 1 }),
        candidate({ streamId: 3, slot: 2 }),
      ],
      records: new Map(),
    });
    expect(plan).toHaveLength(2);
  });

  it('plans nothing when there is no room', () => {
    expect(planSoaks({ ...base, limit: 0, candidates: [candidate()], records: new Map() })).toEqual(
      [],
    );
  });

  it("counts each channel's depth separately", () => {
    const plan = planSoaks({
      ...base,
      maxPerChannel: 1,
      candidates: [
        candidate({ streamId: 1, channelId: 100, slot: 0 }),
        candidate({ streamId: 2, channelId: 100, slot: 1 }),
        candidate({ streamId: 3, channelId: 200, slot: 0 }),
      ],
      records: new Map(),
    });
    expect(plan).toEqual([1, 3]);
  });
});
