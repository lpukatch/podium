import { describe, expect, it } from 'vitest';
import { orderToApply, pendingChange } from './check-panel';

/**
 * A channel whose rule claims three of its five streams, with the ranking
 * already correct -- the state a channel lands in after an alias is fixed and
 * the worker has reordered it, which is exactly when the drop is wanted.
 *
 * `workerOrder` here is what the check returns on a default install, where the
 * global remove-unmatched setting is off: the ranked streams with the two
 * unclaimed ones appended.
 */
const settled = {
  identical: true,
  proposed: [1, 2, 3],
  kept: [1, 2, 3, 4, 5],
  workerOrder: [1, 2, 3, 4, 5],
  unclaimed: [{ id: 4 }, { id: 5 }] as { id: number }[],
};

describe('which order an apply sends', () => {
  it('sends the ranked list alone when the drop is ticked', () => {
    // The bug: written as `workerOrder ?? (drop ? proposed : kept)` this
    // returned all five, and `removeUnmatched: true` could not remove a stream
    // the order it was given still contained.
    expect(orderToApply(settled, true)).toEqual([1, 2, 3]);
  });

  it('sends what the worker would write when the drop is not ticked', () => {
    expect(orderToApply(settled, false)).toEqual([1, 2, 3, 4, 5]);
  });

  it('falls back to kept when the check predates workerOrder', () => {
    expect(orderToApply({ ...settled, workerOrder: undefined }, false)).toEqual([1, 2, 3, 4, 5]);
  });

  it('still drops when the global setting already pruned workerOrder', () => {
    // Nothing to remove, but the answer must not depend on which install it is.
    const pruned = { ...settled, workerOrder: [1, 2, 3] };
    expect(orderToApply(pruned, true)).toEqual([1, 2, 3]);
  });
});

describe('whether an apply would change anything', () => {
  it('counts a ticked drop as a change even when the ranking matches', () => {
    // Otherwise the panel says "nothing to change" and hides the apply button,
    // so the tick has no way to take effect at all.
    expect(pendingChange(settled, true)).toEqual({ dropPending: true, nothingToChange: false });
  });

  it('says nothing to change when the ranking matches and the drop is not ticked', () => {
    expect(pendingChange(settled, false)).toEqual({ dropPending: false, nothingToChange: true });
  });

  it('does not invent a drop when there is nothing unclaimed', () => {
    const clean = { ...settled, unclaimed: [] };
    expect(pendingChange(clean, true)).toEqual({ dropPending: false, nothingToChange: true });
  });

  it('is always a change when the order differs, tick or not', () => {
    const differs = { ...settled, identical: false };
    expect(pendingChange(differs, false).nothingToChange).toBe(false);
    expect(pendingChange(differs, true).nothingToChange).toBe(false);
  });
});
