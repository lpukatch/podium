import { describe, expect, it } from 'vitest';
import { describeScope, rate, scopeDrops, signed, tone } from './quality-view';

describe('rate', () => {
  it('switches to Mbps once kbps stops being a small number', () => {
    expect(rate(304)).toBe('304 kbps');
    expect(rate(7073)).toBe('7.1 Mbps');
  });

  it('does not render a bitrate nobody measured as a precise one', () => {
    expect(rate(0)).toBe('0 kbps');
  });
});

describe('signed', () => {
  it('marks the direction of an effect', () => {
    expect(signed(2823)).toBe('+2.8 Mbps');
    expect(signed(-3921)).toBe('−3.9 Mbps');
  });

  it('leaves a zero effect unsigned', () => {
    // A bucket that landed exactly on the baseline has no direction, and a
    // "+0 kbps" reads as a finding where there is none.
    expect(signed(0)).toBe('0 kbps');
  });
});

describe('tone', () => {
  it('leaves an effect too small to act on unhighlighted', () => {
    // Nearly every effect is non-zero by a few kbps. Colouring a +85kbps
    // account the same green as a +3000kbps group says the two are the same
    // kind of finding, which is the misreading this whole view has to avoid.
    expect(tone(85)).toBe('text-[var(--color-muted)]');
    expect(tone(-143)).toBe('text-[var(--color-muted)]');
  });

  it('highlights one worth acting on, in its direction', () => {
    expect(tone(3204)).toBe('text-[var(--color-accent)]');
    expect(tone(-3811)).toBe('text-[var(--color-bad)]');
  });
});

const summary = {
  eventOnly: false,
  include: [] as string[],
  exclude: [] as string[],
  inScope: 0,
  excluded: 0,
  notIncluded: 0,
  notEvent: 0,
  unrecorded: 0,
};

describe('describeScope', () => {
  it('says an unconfigured scope learns from everything', () => {
    expect(describeScope(summary)).toBe('Learning from every probe.');
  });

  it('reads the policy gate and the patterns as alternatives', () => {
    expect(describeScope({ ...summary, eventOnly: true, include: ['*PPV*'] })).toBe(
      'Learning from channels in groups set to after EPG start or assigned, or groups matching ' +
        '*PPV*.',
    );
  });

  it('puts the excludes where they read as the veto they are', () => {
    // Written out rather than listed as three fields because the rules compose:
    // "events" beside "*VOD*" does not say which of the two wins.
    expect(describeScope({ ...summary, eventOnly: true, exclude: ['*VOD*', '*24/7*'] })).toBe(
      'Learning from channels in groups set to after EPG start or assigned — except groups ' +
        'matching *VOD*, *24/7*.',
    );
  });
});

describe('scopeDrops', () => {
  it('reports only the reasons that actually dropped something', () => {
    expect(scopeDrops({ ...summary, excluded: 12, unrecorded: 400 })).toEqual([
      { label: 'excluded by pattern', count: 12 },
      { label: 'probed before the scope was recorded', count: 400 },
    ]);
  });

  it('says nothing when the scope dropped nothing', () => {
    expect(scopeDrops(summary)).toEqual([]);
  });
});
