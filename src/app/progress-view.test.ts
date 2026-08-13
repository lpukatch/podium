import { describe, expect, it } from 'vitest';
import { collapseRuns, laneCompleted } from './progress-view';

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

describe('provider lanes', () => {
  it('does not count a dead stream twice', () => {
    // The lane that produced "64/44 · limit 5 · 20 dead": every dead stream had
    // already advanced `done` before it was broken out into `dead`.
    expect(laneCompleted({ done: 44, dead: 20, failed: 0 })).toBe(44);
  });

  it('counts a failed probe, which never reached done', () => {
    expect(laneCompleted({ done: 40, dead: 5, failed: 4 })).toBe(44);
  });

  it('handles a lane row from a worker that predates the dead counter', () => {
    expect(laneCompleted({ done: 7, failed: 0 })).toBe(7);
  });

  it('never reports more settled than were queued', () => {
    const lane = { done: 44, dead: 20, failed: 0, queued: 44 };
    expect(laneCompleted(lane)).toBeLessThanOrEqual(lane.queued);
  });
});
