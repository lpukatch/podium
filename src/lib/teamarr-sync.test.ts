import { describe, expect, it } from 'vitest';
import { regression, type SyncScore, underpowered } from './teamarr-sync';

const score = (over: Partial<SyncScore> = {}): SyncScore => ({
  channels: 100,
  agreed: 60,
  deadFirst: 5,
  gapKbps: 40_000,
  ...over,
});

describe('regression — what refuses an unattended push', () => {
  it('allows a set that agrees more', () => {
    expect(regression(score(), score({ agreed: 80, deadFirst: 0 }))).toBeNull();
  });

  it('allows a set that changes nothing measurable', () => {
    // A tie still carries fresher numbers, and refusing it would mean an
    // install with a stable catalogue never updates at all.
    expect(regression(score(), score())).toBeNull();
  });

  it('refuses a set that agrees less and gives up more bitrate', () => {
    const worse = regression(score(), score({ agreed: 59, gapKbps: 41_000 }));
    expect(worse).toContain('down from 60');
    expect(worse).toContain('1000 kbps more');
  });

  it('refuses more dead-first channels even when agreement improves', () => {
    // The two tests are deliberately not the same one. A channel led by a dead
    // stream is not a rounding error in a percentage; it is a black screen, and
    // it must be able to veto a set that looks better on the headline.
    const worse = regression(score(), score({ agreed: 95, deadFirst: 6 }));
    expect(worse).toContain('dead or black');
    expect(worse).toContain('up from 5');
  });

  it('allows fewer dead-first channels at identical agreement', () => {
    expect(regression(score(), score({ deadFirst: 0 }))).toBeNull();
  });

  it('does not veto on bitrate alone', () => {
    // gapKbps gates nothing by itself: a set that gives up more bitrate while
    // agreeing at least as often has moved streams the measurements do not
    // rank, which is the operator's call rather than a refusal.
    expect(regression(score(), score({ gapKbps: 999_999 }))).toBeNull();
  });

  it('allows an agreement drop that costs no measured bitrate', () => {
    // The case that made the second test a conjunction. These are the numbers a
    // live install actually produced: four fewer channels agreeing, on channels
    // whose two candidates were the same broadcast from two providers -- three
    // of them picking a stream of equal or *higher* bitrate. The set gave up
    // 220 kbps less overall. Refusing it would have been refusing an
    // improvement, forever, on an install whose catalogue is stable.
    const before = score({ channels: 113, agreed: 81, deadFirst: 0, gapKbps: 19_336 });
    const after = score({ channels: 113, agreed: 77, deadFirst: 0, gapKbps: 19_116 });
    expect(regression(before, after)).toBeNull();
  });

  it('still refuses a real drop, where the lost channels cost bitrate', () => {
    // The converse of the above, so the loosening cannot pass everything: same
    // four-channel drop, but this time the ordering gives up 6 Mbps for it.
    const before = score({ channels: 113, agreed: 81, deadFirst: 0, gapKbps: 19_336 });
    const after = score({ channels: 113, agreed: 77, deadFirst: 0, gapKbps: 25_336 });
    expect(regression(before, after)).toContain('down from 81');
  });

  it('refuses a dead-first rise even where the gap improves', () => {
    // deadFirst is not conjoined with anything -- a black screen is not offset
    // by bitrate recovered somewhere else.
    const worse = regression(score(), score({ agreed: 90, deadFirst: 6, gapKbps: 0 }));
    expect(worse).toContain('dead or black');
  });
});

describe('underpowered — when the guard cannot see enough to be trusted', () => {
  // The live numbers this exists for: one install's orderable population ran
  // between 0 and 236 channels over a week, median 96 in the evening against 24
  // before breakfast, because an event channel's streams do not outlast the
  // fixture. `regression` compares two counts and never says how many there
  // were, so the 2-channel reading and the 236-channel one are indistinguishable
  // once it has spoken.
  it('defers a push it could only check on a handful of channels', () => {
    const thin = underpowered(2, 20, 96);
    expect(thin).toContain('only be checked on 2');
    expect(thin).toContain('96 channels');
  });

  it('allows a push checked on enough channels', () => {
    expect(underpowered(96, 20, 236)).toBeNull();
  });

  it('allows a population exactly at the floor', () => {
    expect(underpowered(20, 20, 200)).toBeNull();
  });

  it('does not block a small install at its own normal size', () => {
    // The failure an absolute floor would cause, and the reason the bar is
    // `min(floor, peak)`. An install that never has twenty orderable channels
    // is not having a quiet hour -- that is its size. Blocking it would defer
    // every attempt, retry hourly forever and never push again.
    expect(underpowered(8, 20, 8)).toBeNull();
  });

  it('still catches a small install at a genuinely thin moment', () => {
    // The converse, so the concession above cannot pass everything: an install
    // whose peak is 8 is still deferred at 1, because 1 < min(20, 8).
    expect(underpowered(1, 20, 8)).toContain('only be checked on 1');
  });

  it('lets a first push through, with no history to judge it against', () => {
    // A peak of zero is the absence of evidence, not evidence of thinness, and
    // the history that would unblock this only exists once a push has happened.
    expect(underpowered(0, 20, 0)).toBeNull();
  });
});
