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

  it('refuses a set that agrees less', () => {
    expect(regression(score(), score({ agreed: 59 }))).toContain('down from 60');
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
    // gapKbps is reported for the operator, not used as a gate: it moves with
    // the population as much as with the rules, so gating on it would refuse
    // pushes on a night when more streams happened to be measured.
    expect(regression(score(), score({ gapKbps: 999_999 }))).toBeNull();
  });
});
