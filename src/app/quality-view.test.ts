import { describe, expect, it } from 'vitest';
import { rate, signed, tone } from './quality-view';

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
