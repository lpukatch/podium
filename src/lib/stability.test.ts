/**
 * The passive stability ledger: turning status polls into legs, and legs into
 * a verdict about a stream.
 */

import { describe, expect, it } from 'vitest';
import {
  channelStability,
  describeStability,
  dropsPerHour,
  type Leg,
  MIN_FAILURES,
  makeStabilityTracker,
  type SessionSample,
  type StabilityRecord,
  type StreamEvent,
  stabilityScore,
  summarise,
  tooUnstable,
} from './stability';

const TICK = 10_000;

function sample(over: Partial<SessionSample> = {}): SessionSample {
  return {
    at: 0,
    channelKey: 'ch-wjla',
    channelId: 35200,
    sessionKey: 1_000_000,
    streamId: 77013,
    state: 'active',
    healthy: true,
    totalBytes: 0,
    clientCount: 1,
    ...over,
  };
}

function record(over: Partial<StabilityRecord> = {}): StabilityRecord {
  return {
    streamId: 77013,
    legs: 1,
    breaks: 0,
    stalls: 0,
    watchedMs: 0,
    stalledMs: 0,
    lastSeenAt: 0,
    ...over,
  };
}

/**
 * Drive the tracker over a series of polls, one `TICK` apart.
 *
 * Each entry is the payload for one poll, so `[[a], [], [a]]` is a channel
 * that appeared, went away, and came back.
 */
function run(polls: SessionSample[][], startAt = 0): Leg[] {
  const tracker = makeStabilityTracker();
  const out: Leg[] = [];
  polls.forEach((payload, i) => {
    out.push(...tracker.observe(payload, startAt + i * TICK));
  });
  return out;
}

describe('makeStabilityTracker', () => {
  it('opens a leg on the first poll that names a stream', () => {
    const tracker = makeStabilityTracker();
    expect(tracker.observe([sample()], 0)).toEqual([]);
    expect(tracker.openLegs()).toBe(1);
  });

  it('does not open a leg for a session with no stream id yet', () => {
    const tracker = makeStabilityTracker();
    tracker.observe([sample({ streamId: null })], 0);
    expect(tracker.openLegs()).toBe(0);
  });

  it('closes a leg as a failover when the stream changes under one session', () => {
    const legs = run([
      [sample({ totalBytes: 0 })],
      [sample({ totalBytes: 5_000_000 })],
      [sample({ streamId: 77177, totalBytes: 0 })],
    ]);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ streamId: 77013, ended: 'failover', watchedMs: 2 * TICK });
  });

  it('closes a leg as a retune when the session key changes', () => {
    const legs = run([
      [sample()],
      [sample({ sessionKey: 2_000_000, streamId: 77013, totalBytes: 0 })],
    ]);
    expect(legs).toHaveLength(1);
    expect(legs[0]?.ended).toBe('retune');
  });

  it('closes a leg as gone when the channel leaves the payload', () => {
    const legs = run([[sample()], [sample({ totalBytes: 9_000 })], []]);
    expect(legs).toHaveLength(1);
    // Ends at the last poll that saw it, not the one that noticed it had gone:
    // the session stopped somewhere in that gap and crediting the whole gap
    // would inflate watched time on every channel anyone ever turns off.
    expect(legs[0]).toMatchObject({ ended: 'gone', watchedMs: TICK, endedAt: TICK });
  });

  it('treats an absent stream id as no information rather than a failover', () => {
    const legs = run([[sample()], [sample({ streamId: null })], [sample()]]);
    expect(legs).toEqual([]);
  });

  it('treats an absent session key as matching whatever is open', () => {
    const legs = run([[sample()], [sample({ sessionKey: null })], [sample()]]);
    expect(legs).toEqual([]);
  });

  it('counts a flat byte counter as a stall while a client is attached', () => {
    const legs = run([
      [sample({ totalBytes: 1_000 })],
      [sample({ totalBytes: 1_000 })],
      [sample({ totalBytes: 1_000 })],
      [sample({ totalBytes: 8_000 })],
      [sample({ streamId: 77177 })],
    ]);
    expect(legs).toHaveLength(1);
    // One episode spanning two flat gaps, not two episodes.
    expect(legs[0]).toMatchObject({ stalls: 1, stalledMs: 2 * TICK });
  });

  it('counts a second stall episode after the bytes start moving again', () => {
    const legs = run([
      [sample({ totalBytes: 1_000 })],
      [sample({ totalBytes: 1_000 })],
      [sample({ totalBytes: 8_000 })],
      [sample({ totalBytes: 8_000 })],
      [sample({ streamId: 77177 })],
    ]);
    expect(legs[0]).toMatchObject({ stalls: 2, stalledMs: 2 * TICK });
  });

  it('does not call a flat counter a stall when nobody is watching', () => {
    const legs = run([
      [sample({ totalBytes: 1_000, clientCount: 0 })],
      [sample({ totalBytes: 1_000, clientCount: 0 })],
      [sample({ streamId: 77177 })],
    ]);
    expect(legs[0]).toMatchObject({ stalls: 0, stalledMs: 0 });
  });

  it('does not read a missing byte counter as a stall', () => {
    const legs = run([
      [sample({ totalBytes: null })],
      [sample({ totalBytes: null })],
      [sample({ streamId: 77177 })],
    ]);
    expect(legs[0]).toMatchObject({ stalls: 0, stalledMs: 0 });
  });

  it('keeps the last known byte count across a sample that omits it', () => {
    // The gap either side of the null is unjudgeable, but the counter that
    // comes back must be compared with the last real one rather than with
    // nothing -- otherwise one absent field blinds the detector for the leg.
    const legs = run([
      [sample({ totalBytes: 1_000 })],
      [sample({ totalBytes: null })],
      [sample({ totalBytes: 1_000 })],
      [sample({ streamId: 77177 })],
    ]);
    expect(legs[0]?.stalls).toBe(1);
  });

  it('tracks channels independently', () => {
    const other = { channelKey: 'ch-wmar', channelId: 59643, sessionKey: 7, streamId: 90250 };
    const legs = run([
      [sample(), sample(other)],
      [sample({ streamId: 77177 }), sample(other)],
    ]);
    expect(legs).toHaveLength(1);
    expect(legs[0]?.channelKey).toBe('ch-wjla');
  });

  it('drains open legs so a restart does not lose them', () => {
    const tracker = makeStabilityTracker();
    tracker.observe([sample()], 0);
    tracker.observe([sample({ totalBytes: 5_000 })], TICK);
    const legs = tracker.drain(2 * TICK);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ ended: 'drain', watchedMs: 2 * TICK });
    expect(tracker.openLegs()).toBe(0);
  });

  it('reopens a leg when a channel comes back after going away', () => {
    const legs = run([[sample()], [], [sample({ sessionKey: 3 })], [sample({ sessionKey: 3 })]]);
    expect(legs).toHaveLength(1);
    expect(legs[0]?.ended).toBe('gone');
  });
});

describe('summarise', () => {
  it('folds legs into one record per stream', () => {
    const legs = run([
      [sample({ totalBytes: 0 })],
      [sample({ totalBytes: 5_000 })],
      [sample({ streamId: 77177, totalBytes: 0 })],
      [sample({ streamId: 77177, totalBytes: 5_000 })],
      [],
    ]);
    const records = summarise(legs);
    expect(records.get(77013)).toMatchObject({ legs: 1, breaks: 1, watchedMs: 2 * TICK });
    expect(records.get(77177)).toMatchObject({ legs: 1, breaks: 0, watchedMs: TICK });
  });
});

describe('stabilityScore', () => {
  it('gives full marks to a stream nothing has been observed about', () => {
    expect(stabilityScore(undefined)).toBe(1);
    expect(stabilityScore(record())).toBe(1);
  });

  it('gives full marks to a stream watched for hours with no drops', () => {
    expect(stabilityScore(record({ watchedMs: 6 * 3_600_000 }))).toBe(1);
  });

  it('does not bite on a single incident', () => {
    expect(stabilityScore(record({ breaks: 1, watchedMs: 60_000 }))).toBe(1);
    expect(MIN_FAILURES).toBe(2);
  });

  it('sinks a stream that failed twice in two minutes', () => {
    // The WJLA feed this was written for: 55s and 36s legs, then a third.
    const score = stabilityScore(record({ breaks: 2, watchedMs: 110_000 }));
    expect(score).toBeLessThan(0.05);
  });

  it('barely marks down a stream that dropped twice across a long evening', () => {
    // A third of a drop an hour against a tolerance of one: 0.75.
    const score = stabilityScore(record({ breaks: 2, watchedMs: 6 * 3_600_000 }));
    expect(score).toBeCloseTo(0.75, 6);
  });

  it('scores half marks at exactly the tolerated rate', () => {
    expect(stabilityScore(record({ breaks: 2, watchedMs: 2 * 3_600_000 }))).toBeCloseTo(0.5, 6);
  });

  it('counts stalls alongside breaks', () => {
    const stalled = stabilityScore(record({ stalls: 2, watchedMs: 2 * 3_600_000 }));
    expect(stalled).toBeCloseTo(0.5, 6);
  });

  it('stays above zero however bad the stream is', () => {
    const score = stabilityScore(record({ breaks: 50, watchedMs: 60_000 }));
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.001);
  });

  it('honours a caller-supplied tolerance', () => {
    const r = record({ breaks: 2, watchedMs: 2 * 3_600_000 });
    expect(stabilityScore(r, 4)).toBeGreaterThan(stabilityScore(r, 1));
  });
});

describe('dropsPerHour', () => {
  it('is zero when nothing has been watched', () => {
    expect(dropsPerHour(record({ breaks: 3 }))).toBe(0);
  });

  it('rates failures against observed watch time', () => {
    expect(dropsPerHour(record({ breaks: 3, watchedMs: 3_600_000 }))).toBe(3);
  });
});

describe('tooUnstable', () => {
  it('is off at zero, which is the default', () => {
    expect(tooUnstable(record({ breaks: 9, watchedMs: 60_000 }), 0)).toBe(false);
  });

  it('needs the same evidence floor the weight does', () => {
    expect(tooUnstable(record({ breaks: 1, watchedMs: 1_000 }), 1)).toBe(false);
  });

  it('fires on a stream over the threshold', () => {
    expect(tooUnstable(record({ breaks: 2, watchedMs: 110_000 }), 6)).toBe(true);
  });

  it('spares a stream under it', () => {
    expect(tooUnstable(record({ breaks: 2, watchedMs: 6 * 3_600_000 }), 6)).toBe(false);
  });

  it('says nothing about a stream never observed', () => {
    expect(tooUnstable(undefined, 1)).toBe(false);
  });
});

describe('describeStability', () => {
  it('names the absence rather than inventing a number', () => {
    expect(describeStability(undefined)).toBe('never observed playing');
    expect(describeStability(record({ legs: 0 }))).toBe('never observed playing');
  });

  it('reports clean watching in minutes and hours', () => {
    expect(describeStability(record({ watchedMs: 20 * 60_000 }))).toBe('20m watched, no drops');
    expect(describeStability(record({ watchedMs: 3 * 3_600_000 }))).toBe('3.0h watched, no drops');
  });

  it('reports the drop rate when there is one', () => {
    expect(describeStability(record({ breaks: 2, watchedMs: 110_000 }))).toBe(
      '2m watched, 2 drops (65/h)',
    );
  });
});

describe('channelStability', () => {
  const records = (entries: Array<[number, Partial<StabilityRecord>]>) =>
    new Map(entries.map(([id, over]) => [id, record({ streamId: id, ...over })]));

  it('says nothing about a channel nobody has watched', () => {
    const verdict = channelStability([1, 2, 3], new Map(), 1);
    expect(verdict).toEqual({ total: 3, measured: 0, unstable: 0, allBad: false });
  });

  it('counts a stream watched cleanly as measured and not unstable', () => {
    const verdict = channelStability([1], records([[1, { watchedMs: 3_600_000, breaks: 0 }]]), 1);
    expect(verdict).toMatchObject({ measured: 1, unstable: 0, allBad: false });
  });

  it('does not call a channel bad on partial evidence', () => {
    // Three of six measured and all three dreadful is a strong hint, but the
    // three nobody has watched might be fine.
    const verdict = channelStability(
      [1, 2, 3, 4, 5, 6],
      records([
        [1, { breaks: 3, watchedMs: 110_000 }],
        [2, { breaks: 3, watchedMs: 110_000 }],
        [3, { breaks: 3, watchedMs: 110_000 }],
      ]),
      1,
    );
    expect(verdict).toMatchObject({ total: 6, measured: 3, unstable: 3, allBad: false });
  });

  it('calls a channel bad only when every stream on it has been measured and drops', () => {
    const verdict = channelStability(
      [1, 2],
      records([
        [1, { breaks: 3, watchedMs: 110_000 }],
        [2, { breaks: 3, watchedMs: 110_000 }],
      ]),
      1,
    );
    expect(verdict.allBad).toBe(true);
  });

  it('spares a channel with one stream that holds', () => {
    const verdict = channelStability(
      [1, 2],
      records([
        [1, { breaks: 3, watchedMs: 110_000 }],
        [2, { breaks: 0, watchedMs: 3_600_000 }],
      ]),
      1,
    );
    expect(verdict).toMatchObject({ measured: 2, unstable: 1, allBad: false });
  });

  it('is empty for a channel with no streams', () => {
    expect(channelStability([], new Map(), 1).allBad).toBe(false);
  });
});

describe('makeStabilityTracker.observeEvents', () => {
  /** An open leg, from one poll. */
  function open(tracker: ReturnType<typeof makeStabilityTracker>, at = 0): void {
    tracker.observe([sample({ at })], at);
  }

  const switch_ = (over: Partial<StreamEvent> = {}): StreamEvent => ({
    at: TICK,
    channelKey: 'ch-wjla',
    kind: 'switch',
    streamId: 77177,
    previousStreamId: 77013,
    manual: false,
    ...over,
  });

  it('closes the leg at the instant of the switch, not at the next poll', () => {
    const tracker = makeStabilityTracker();
    open(tracker);
    const legs = tracker.observeEvents([switch_({ at: 4_000 })]);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ streamId: 77013, ended: 'failover', endedAt: 4_000 });
    expect(tracker.openLegs()).toBe(1);
  });

  it('opens the new leg on the stream the event names, which the next poll extends', () => {
    const tracker = makeStabilityTracker();
    open(tracker);
    tracker.observeEvents([switch_({ at: 4_000 })]);
    // Two further polls of the new stream: one to hand the sample to the leg
    // the event opened, one more to show it is still the same session. Both
    // are pinned: the first poll must absorb into the event-opened leg rather
    // than close it as a retune -- no session key, so nothing reads it as one.
    expect(
      tracker.observe([sample({ at: 2 * TICK, streamId: 77177, totalBytes: 1_000 })], 2 * TICK),
    ).toEqual([]);
    const legs = tracker.observe(
      [sample({ at: 3 * TICK, streamId: 77177, totalBytes: 2_000 })],
      3 * TICK,
    );
    expect(legs).toEqual([]);
    expect(tracker.openLegs()).toBe(1);
    // The channel did not change, only its stream: the new leg keeps the id
    // the closing leg knew rather than waiting for a poll to restore it.
    const closed = tracker.drain(4 * TICK);
    expect(closed[0]).toMatchObject({ streamId: 77177, channelId: 35200 });
  });

  it('bills an operator switch as a retune', () => {
    const tracker = makeStabilityTracker();
    open(tracker);
    const legs = tracker.observeEvents([switch_({ manual: true })]);
    expect(legs[0]?.ended).toBe('retune');
  });

  it('ignores a switch whose new stream is already the open leg', () => {
    const tracker = makeStabilityTracker();
    open(tracker);
    // A poll diff beat the delivery to it, or the delivery is a duplicate:
    // the event names the stream the leg is already on.
    const legs = tracker.observeEvents([switch_({ streamId: 77013 })]);
    expect(legs).toEqual([]);
    expect(tracker.openLegs()).toBe(1);
  });

  it('charges a switch away from a stream the tracker never saw serving', () => {
    const tracker = makeStabilityTracker();
    // The leg says 77013; the event says the switch was 77012 -> 77177. One
    // of the two switches in between was missed, and the leg the tracker can
    // charge is the one it was watching.
    open(tracker);
    const legs = tracker.observeEvents([switch_({ previousStreamId: 77012 })]);
    expect(legs[0]).toMatchObject({ streamId: 77013, ended: 'failover' });
    expect(tracker.openLegs()).toBe(1);
  });

  it('ignores a switch for a channel no leg is open on', () => {
    const tracker = makeStabilityTracker();
    expect(tracker.observeEvents([switch_({ channelKey: 'ch-other' })])).toEqual([]);
  });

  it('charges a give-up error to the stalled stream without ending the leg', () => {
    const tracker = makeStabilityTracker();
    open(tracker);
    const legs = tracker.observeEvents([
      {
        at: 4_000,
        channelKey: 'ch-wjla',
        kind: 'error',
        streamId: 77013,
        previousStreamId: null,
        manual: false,
      },
    ]);
    expect(legs).toEqual([]);
    // The charge lands when the poller eventually closes the leg.
    const closed = tracker.drain(5 * TICK);
    expect(closed[0]).toMatchObject({ streamId: 77013, stalls: 1, ended: 'drain' });
  });

  it('does not recount the episode when the next poll sees the same flat gap', () => {
    const tracker = makeStabilityTracker();
    open(tracker);
    tracker.observeEvents([
      {
        at: 4_000,
        channelKey: 'ch-wjla',
        kind: 'error',
        streamId: 77013,
        previousStreamId: null,
        manual: false,
      },
    ]);
    // The poll after the error, still stalled: same episode.
    tracker.observe([sample({ at: TICK, totalBytes: 0 })], TICK);
    const closed = tracker.drain(2 * TICK);
    expect(closed[0]?.stalls).toBe(1);
  });

  it('leaves the charge off when the error names a stream the channel has left', () => {
    const tracker = makeStabilityTracker();
    open(tracker);
    // A late delivery: the channel failed over before the drain reached it.
    tracker.observeEvents([
      {
        at: 4_000,
        channelKey: 'ch-wjla',
        kind: 'error',
        streamId: 99999,
        previousStreamId: null,
        manual: false,
      },
    ]);
    const closed = tracker.drain(2 * TICK);
    expect(closed[0]?.stalls).toBe(0);
  });

  it('leaves the charge off an error whose stream id was stripped', () => {
    const tracker = makeStabilityTracker();
    open(tracker);
    // Dispatcharr strips the stream fields when the Redis state behind them
    // has cleared: the delivery says a channel errored but not on what. The
    // open leg is only a guess at the stream that died -- and if the error is
    // late, after a switch, it is the wrong guess, so nothing is billed.
    tracker.observeEvents([
      {
        at: 4_000,
        channelKey: 'ch-wjla',
        kind: 'error',
        streamId: null,
        previousStreamId: null,
        manual: false,
      },
    ]);
    const closed = tracker.drain(2 * TICK);
    expect(closed[0]?.stalls).toBe(0);
  });

  it('never runs the gone-sweep: only a poll may close a leg as gone', () => {
    const tracker = makeStabilityTracker();
    open(tracker);
    tracker.observeEvents([
      {
        at: 4_000,
        channelKey: 'ch-somewhere-else',
        kind: 'switch',
        streamId: 1,
        previousStreamId: 2,
        manual: false,
      },
    ]);
    expect(tracker.openLegs()).toBe(1);
  });
});
