import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProbeResult } from './probe';
import { Store } from './store';

describe('batched planner cache', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-variants-'));
    store = new Store(join(dir, 'cache.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('matches per-stream reads, including hashes, variants and malformed rows', () => {
    const alive = { alive: true, error: '' } as ProbeResult;
    const dead = { alive: false, error: 'timeout' } as ProbeResult;
    store.put(1, 'current', alive);
    store.put(1, 'current', dead, 7);
    store.put(2, 'old', alive);
    const batch = store.variantsForStreams([
      { id: 1, streamHash: 'current' },
      { id: 2, streamHash: 'new' },
      { id: 3, streamHash: '' },
    ]);
    expect(batch.get(1)).toEqual(store.variants(1, 'current'));
    expect(batch.has(2)).toBe(false);
    expect(batch.has(3)).toBe(false);
    expect(store.variantsForStreams([]).size).toBe(0);
    expect(store.variantsForStreams([{ id: 2, streamHash: 'old' }]).get(2)).toEqual(
      store.variants(2, 'old'),
    );
  });

  it('supports more candidates than the SQLite bind-variable limit', () => {
    store.put(1, 'same', { alive: true } as ProbeResult);
    const streams = Array.from({ length: 33_000 }, (_, i) => ({ id: i + 1, streamHash: 'same' }));
    expect(store.variantsForStreams(streams).get(1)?.get(0)?.result?.alive).toBe(true);
  });
});
