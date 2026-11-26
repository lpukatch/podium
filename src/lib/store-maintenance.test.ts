import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProbeResult } from './probe';
import { Store } from './store';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('store maintenance cadence', () => {
  const soak = {
    heldMs: 1000,
    drops: 0,
    failedDials: 0,
    unreachable: false,
    legs: [],
    stopped: false,
  };

  it('prunes orphaned soak summaries, including streams with no cached probe', () => {
    const store = new Store(':memory:');
    try {
      for (const id of [1, 2, 3]) store.recordSoakResult(id, soak);
      expect(store.pruneOutside(new Set())).toBe(0);
      expect(store.soakResults([1, 2, 3]).size).toBe(3);
      store.put(2, 'h', { alive: true } as ProbeResult);
      expect(store.pruneOutside(new Set([1]))).toBe(1);
      expect([...store.soakResults([1, 2, 3]).keys()]).toEqual([1]);
    } finally {
      store.close();
    }
  });

  it('expires old soak summaries on the maintenance cadence', () => {
    vi.useFakeTimers();
    const now = 1_800_000_000_000;
    vi.setSystemTime(now - 30 * 86_400_000);
    const store = new Store(':memory:');
    try {
      store.recordSoakResult(1, soak);
      vi.setSystemTime(now);
      store.recordSoakResult(2, soak);
      store.startRun('first');
      expect(store.soakResults([1, 2]).size).toBe(2);
      vi.advanceTimersByTime(60_000);
      store.startRun('second');
      expect(store.soakResults([1, 2]).size).toBe(2);
      vi.advanceTimersByTime(14 * 60_000);
      store.startRun('third');
      expect([...store.soakResults([1, 2]).keys()]).toEqual([2]);
    } finally {
      store.close();
    }
  });

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

  it('optimizes and passively checkpoints SQLite on the maintenance cadence', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const store = new Store(':memory:');
    const pragma = vi.spyOn(Database.prototype, 'pragma');
    try {
      store.startRun('first');
      expect(pragma.mock.calls.slice(-2).map(([statement]) => statement)).toEqual([
        'optimize',
        'wal_checkpoint(PASSIVE)',
      ]);

      const firstMaintenanceCalls = pragma.mock.calls.length;
      vi.advanceTimersByTime(60_000);
      store.startRun('second');
      expect(pragma).toHaveBeenCalledTimes(firstMaintenanceCalls);

      vi.advanceTimersByTime(14 * 60_000);
      store.startRun('third');
      expect(pragma.mock.calls.slice(-2).map(([statement]) => statement)).toEqual([
        'optimize',
        'wal_checkpoint(PASSIVE)',
      ]);
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
