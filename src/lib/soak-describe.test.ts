/**
 * The progress line a finished soak leaves behind.
 */

import { describe, expect, it } from 'vitest';
import type { SoakResult } from './probe';
import { describeSoak } from './runner';

function result(over: Partial<SoakResult> = {}): SoakResult {
  return {
    legs: [],
    heldMs: 180_000,
    drops: 0,
    failedDials: 0,
    unreachable: false,
    stopped: false,
    ...over,
  };
}

describe('describeSoak', () => {
  it('reports a clean hold', () => {
    expect(describeSoak(result())).toBe('held 180s clean');
  });

  it('reports drops against the time held', () => {
    expect(describeSoak(result({ drops: 2, heldMs: 110_000 }))).toBe('2 drops in 110s');
  });

  it('names refused reconnects apart from drops', () => {
    // The first real run's HBO Comedy: one real drop, then the provider would
    // not let it back.
    expect(
      describeSoak(result({ drops: 1, heldMs: 100_700, failedDials: 3, unreachable: true })),
    ).toBe('1 drop in 101s, 3 reconnects refused, gave up');
  });

  it('reports a stream that never connected at all', () => {
    expect(describeSoak(result({ heldMs: 0, failedDials: 3, unreachable: true }))).toBe(
      'would not connect (3 reconnects refused)',
    );
  });
});
