import { describe, expect, it } from 'vitest';
import { regression, type SyncScore } from './teamarr-sync';

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
