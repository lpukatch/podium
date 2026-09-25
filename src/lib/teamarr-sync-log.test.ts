import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderMetrics } from './metrics';
import { Store } from './store';

/**
 * The sync log exists so a safety-gated writer leaves a trail: "deferred" and
 * "refused" are normal, frequent outcomes that leave Teamarr byte-identical,
 * so without history the difference between "healthy but never pushes" and
 * "scheduled sync died on Tuesday" is invisible once the latest-attempt row is
 * overwritten.
 */
describe('teamarr sync log', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-synclog-'));
    store = new Store(join(dir, 'm.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('classifies each attempt and keeps the latest row in step', () => {
    store.saveTeamarrSync({ at: 1, pushed: true, rules: { total: 5 } });
    store.saveTeamarrSync({ at: 2, pushed: false, deferred: true, reason: 'deferred: thin' });
    store.saveTeamarrSync({ at: 3, pushed: false, reason: 'refused: regression' });
    store.saveTeamarrSync({ at: 4, pushed: false, error: 'TypeError: fetch failed' });

    expect(store.teamarrSyncLog()).toEqual([
      { ranAt: 4, pushed: false, deferred: false, failed: true },
      { ranAt: 3, pushed: false, deferred: false, failed: false },
      { ranAt: 2, pushed: false, deferred: true, failed: false },
      { ranAt: 1, pushed: true, deferred: false, failed: false },
    ]);
    // The single-row view still reports only the newest attempt.
    expect(store.teamarrSync()?.ranAt).toBe(4);
  });

  it('rolls the oldest rows out at the cap', () => {
    // A deferral retries hourly, so 200 rows is a bit over a week of never
    // pushing; a smaller cap proves the same trim without writing 200 rows.
    for (let i = 0; i < 200; i++) {
      store.saveTeamarrSync({ at: i, pushed: i === 0, deferred: i > 0 });
    }
    // One more past the cap evicts the first (and only) push.
    store.saveTeamarrSync({ at: 200, pushed: false, deferred: true });

    const log = store.teamarrSyncLog();
    expect(log).toHaveLength(200);
    expect(log[0]?.ranAt).toBe(200);
    expect(log.some((row) => row.pushed)).toBe(false);
  });

  it('renders the outcome counters and the last push time', () => {
    store.saveTeamarrSync({ at: 1_700_000_000_000, pushed: true });
    store.saveTeamarrSync({ at: 1_700_000_100_000, pushed: false, deferred: true });
    store.saveTeamarrSync({ at: 1_700_000_200_000, pushed: false, deferred: true });
    store.saveTeamarrSync({ at: 1_700_000_300_000, pushed: false, reason: 'refused: worse' });
    store.saveTeamarrSync({ at: 1_700_000_400_000, pushed: false, error: 'boom' });

    const text = renderMetrics(store, { maxAgeMs: 3600_000 });
    expect(text).toContain('podium_teamarr_sync_total{outcome="pushed"} 1');
    expect(text).toContain('podium_teamarr_sync_total{outcome="deferred"} 2');
    expect(text).toContain('podium_teamarr_sync_total{outcome="refused"} 1');
    expect(text).toContain('podium_teamarr_sync_total{outcome="failed"} 1');
    expect(text).toContain('podium_teamarr_last_push_timestamp_seconds 1700000000');
  });

  it('emits no teamarr series before the first attempt', () => {
    const text = renderMetrics(store, { maxAgeMs: 3600_000 });
    expect(text).not.toContain('podium_teamarr_');
  });
});
