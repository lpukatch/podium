import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProbeResult } from './probe';
import { Store } from './store';

afterEach(() => vi.useRealTimers());

describe('store maintenance cadence', () => {
  it('prunes with more retained IDs than the SQLite variable limit', () => {
    const store = new Store(':memory:');
    try {
      store.put(1, 'hash', { alive: true } as ProbeResult);
      store.put(33_001, 'hash', { alive: true } as ProbeResult);
      const keep = new Set(Array.from({ length: 33_000 }, (_, i) => i + 1));
      expect(store.pruneOutside(keep)).toBe(1);
      expect(store.variants(1, 'hash').size).toBe(1);
      expect(store.variants(33_001, 'hash').size).toBe(0);
    } finally {
      store.close();
    }
  });

  it('trims at boot and every 15 minutes while still counting every run', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const store = new Store(':memory:');
    try {
      const trim = vi.spyOn(store, 'trimQuality');
      store.startRun('first');
      vi.advanceTimersByTime(60_000);
      store.startRun('second');
      expect(trim).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(14 * 60_000);
      store.startRun('third');
      expect(trim).toHaveBeenCalledTimes(2);
      expect(store.recentRuns(10)).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it('retries maintenance after a failed transaction', () => {
    const store = new Store(':memory:');
    try {
      const trim = vi.spyOn(store, 'trimQuality').mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      expect(() => store.startRun('failed')).toThrow('disk full');
      store.startRun('retry');
      expect(trim).toHaveBeenCalledTimes(2);
      expect(store.recentRuns(10)).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
