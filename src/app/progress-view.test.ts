import { describe, expect, it } from 'vitest';
import { collapseRuns } from './progress-view';

const run = (over: Partial<Parameters<typeof collapseRuns>[0][number]> = {}) => ({
  run_id: Math.random().toString(36).slice(2),
  started_at: 1_700_000_000_000,
  finished_at: 1_700_000_010_000,
  channels: 0,
  probed: 0,
  cached: 100,
  dead: 0,
  reordered: 0,
  skipped: 0,
  error: null as string | null,
  ...over,
});

describe('recent passes', () => {
  it('folds consecutive passes that changed nothing into one row', () => {
    // A settled install produces one of these a minute. Fifteen identical
    // "0 probed · 0 dead" lines say less than one line saying there were 15.
    const entries = collapseRuns([
      run({ started_at: 300 }),
      run({ started_at: 200 }),
      run({ started_at: 100 }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'quiet', count: 3, from: 300, to: 100 });
  });

  it('keeps every pass that did something on its own row', () => {
    const entries = collapseRuns([
      run({ started_at: 400, probed: 6 }),
      run({ started_at: 300 }),
      run({ started_at: 200, reordered: 1 }),
      run({ started_at: 100, error: 'boom' }),
    ]);
    expect(entries.map((e) => e.kind)).toEqual(['run', 'quiet', 'run', 'run']);
  });

  it('says one when there was only one', () => {
    expect(collapseRuns([run({ started_at: 100 })])).toEqual([
      { kind: 'quiet', count: 1, from: 100, to: 100 },
    ]);
  });
});
