/**
 * The probe history: every verdict `put()` writes, appended beside the cache
 * that keeps only the latest.
 *
 * What is worth pinning: a row per verdict, dead ones included, with the
 * cache's own `probed_at`; the two bounds -- a per-stream cap trimmed on write
 * and an age sweep each pass -- and that the history leaves with the stream
 * the way the cache does. Then the read: newest first, per-stream limit,
 * `since`, and a database from before the table existing gaining it on open.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProbeResult } from './probe';
import { PROBE_HISTORY_MS, PROBE_HISTORY_PER_STREAM, Store } from './store';

function verdict(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    alive: true,
    width: 1920,
    height: 1080,
    fps: 50,
    videoCodec: 'h264',
    audioCodec: 'aac',
    pixelFormat: 'yuv420p',
    audioChannels: 2,
    channelLayout: 'stereo',
    audioBitrateKbps: 128,
    audioSampleRate: 48_000,
    bitrateKbps: 6_400,
    elapsedMs: 100,
    error: '',
    ...over,
  };
}

const dead = verdict({ alive: false, width: 0, height: 0, bitrateKbps: 0, error: 'HTTP 404' });

const historyCount = (store: Store, streamId?: number) =>
  [
    ...store
      .probeHistory({ streamIds: streamId === undefined ? undefined : [streamId], limit: 1_000 })
      .values(),
  ].flat().length;

describe('probe history', () => {
  let store: Store;
  let clock: number;

  beforeEach(() => {
    clock = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
    vi.restoreAllMocks();
  });

  it('appends every verdict, dead ones included, while the cache keeps only the latest', () => {
    store.put(1, 'h', verdict());
    clock = 2_000;
    store.put(1, 'h', dead);
    clock = 3_000;
    store.put(1, 'h', verdict({ bitrateKbps: 3_000 }));

    const history = store.probeHistory({ streamIds: [1], limit: 10 }).get(1);
    expect(history?.map((h) => [h.probedAt, h.alive, h.result.bitrateKbps])).toEqual([
      [3_000, true, 3_000],
      [2_000, false, 0],
      [1_000, true, 6_400],
    ]);
    expect(history?.[1]?.result.error).toBe('HTTP 404');

    // The cache still holds one verdict, the same one the history's newest
    // row records, at the same moment.
    const latest = store.verdicts([1]).get(1);
    expect(latest?.probedAt).toBe(3_000);
    expect(latest?.result).toEqual(history?.[0]?.result);
    expect(store.cacheStats().total).toBe(1);
  });

  it('caps each stream at PROBE_HISTORY_PER_STREAM, oldest first, and leaves others alone', () => {
    store.put(2, 'h', verdict());
    for (let i = 0; i < PROBE_HISTORY_PER_STREAM + 5; i++) {
      clock = 10_000 + i;
      store.put(1, 'h', verdict({ bitrateKbps: i }));
    }
    const history = store.probeHistory({ streamIds: [1], limit: 1_000 }).get(1) ?? [];
    expect(history).toHaveLength(PROBE_HISTORY_PER_STREAM);
    expect(history[0]?.result.bitrateKbps).toBe(PROBE_HISTORY_PER_STREAM + 4);
    // The five oldest went.
    expect(history.at(-1)?.result.bitrateKbps).toBe(5);
    expect(historyCount(store, 2)).toBe(1);
  });

  it('holds the cap even when verdicts share a millisecond', () => {
    for (let i = 0; i < PROBE_HISTORY_PER_STREAM + 3; i++) {
      store.put(1, 'h', verdict({ bitrateKbps: i }));
    }
    const history = store.probeHistory({ streamIds: [1], limit: 1_000 }).get(1) ?? [];
    expect(history).toHaveLength(PROBE_HISTORY_PER_STREAM);
    // Newest written first, by insertion order within the tie.
    expect(history[0]?.result.bitrateKbps).toBe(PROBE_HISTORY_PER_STREAM + 2);
  });

  it('sweeps rows older than PROBE_HISTORY_MS as each pass starts', () => {
    store.put(1, 'h', verdict());
    clock = 1_000 + PROBE_HISTORY_MS - 10;
    store.put(2, 'h', verdict());
    clock = 1_000 + PROBE_HISTORY_MS + 1;
    store.startRun('pass');

    expect(store.probeHistory({ limit: 10 })).toEqual(
      new Map([[2, [expect.objectContaining({ probedAt: 1_000 + PROBE_HISTORY_MS - 10 })]]]),
    );
    // The sweep is the history's own: the cache is left to `prune()`.
    expect(store.verdicts([1]).has(1)).toBe(true);
  });

  it('is cleared by resetData, like the cache', () => {
    store.put(1, 'h', verdict());
    store.put(2, 'h', dead);
    store.resetData();
    expect(historyCount(store)).toBe(0);
  });

  it('goes with the stream when pruneOutside drops it from the cache', () => {
    store.put(1, 'h', verdict());
    store.put(1, 'h', dead);
    store.put(2, 'h', verdict());
    // The count is still the cache's rows, which is what the pass logs.
    expect(store.pruneOutside(new Set([2]))).toBe(1);
    expect(historyCount(store, 1)).toBe(0);
    expect(historyCount(store, 2)).toBe(1);
  });

  describe('reading it', () => {
    beforeEach(() => {
      for (const at of [100, 200, 300]) {
        clock = at;
        store.put(1, 'h', verdict({ bitrateKbps: at }));
      }
      clock = 150;
      store.put(2, 'h', dead);
    });

    it('gives each stream newest first, at most `limit` each', () => {
      const all = store.probeHistory({ limit: 2 });
      expect([...all.keys()]).toEqual([1, 2]);
      expect(all.get(1)?.map((h) => h.probedAt)).toEqual([300, 200]);
      expect(all.get(2)?.map((h) => [h.probedAt, h.alive])).toEqual([[150, false]]);
    });

    it('keeps only probes strictly after `since`, dropping streams with none', () => {
      const recent = store.probeHistory({ since: 150, limit: 10 });
      expect([...recent.keys()]).toEqual([1]);
      expect(recent.get(1)?.map((h) => h.probedAt)).toEqual([300, 200]);
    });

    it('reads only the streams asked for, and leaves out those with no history', () => {
      const some = store.probeHistory({ streamIds: [2, 99], limit: 10 });
      expect([...some.keys()]).toEqual([2]);
      expect(store.probeHistory({ streamIds: [], limit: 10 }).size).toBe(0);
    });

    it('merges the answer across chunks when asked for many streams', () => {
      const ids = Array.from({ length: 1_000 }, (_, i) => i + 3);
      ids.push(1);
      expect([...store.probeHistory({ streamIds: ids, limit: 1 }).keys()]).toEqual([1]);
    });
  });
});

describe('probe history on a database from before it', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-history-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('gains the table on open, and starts recording', () => {
    const path = join(dir, 'podium.db');
    const raw = new Database(path);
    // The cache as the release before the history wrote it.
    raw.exec(`
      CREATE TABLE probe_cache (
          stream_id    INTEGER NOT NULL,
          stream_hash  TEXT    NOT NULL,
          variant_id   INTEGER NOT NULL DEFAULT 0,
          probed_at    INTEGER NOT NULL,
          alive        INTEGER NOT NULL,
          black        INTEGER NOT NULL DEFAULT 0,
          result       TEXT    NOT NULL,
          dead_streak  INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (stream_id, stream_hash, variant_id)
      );
    `);
    raw
      .prepare(
        `INSERT INTO probe_cache (stream_id, stream_hash, variant_id, probed_at, alive, black, result)
         VALUES (1, 'h', 0, ?, 1, 0, ?)`,
      )
      .run(Date.now(), JSON.stringify(verdict()));
    raw.close();

    const store = new Store(path);
    try {
      // Nothing is backfilled: the cache's one verdict is not history.
      expect(store.probeHistory({ limit: 10 }).size).toBe(0);
      store.put(1, 'h', dead);
      expect(
        store
          .probeHistory({ limit: 10 })
          .get(1)
          ?.map((h) => h.alive),
      ).toEqual([false]);
      expect(store.verdicts([1]).get(1)?.alive).toBe(false);
    } finally {
      store.close();
    }
  });
});
