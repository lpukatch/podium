import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { ProbeResult } from './probe';
import { Store } from './store';

const HOUR = 3_600_000;

describe('materialized cache bitrate', () => {
  it('updates health due times when bitrate becomes known or unknown', () => {
    const store = new Store(':memory:');
    try {
      store.put(1, 'h', { alive: true, bitrateKbps: 0 } as ProbeResult);
      let health = store.cacheHealth(HOUR, HOUR, Date.now(), HOUR, 60_000);
      expect(health.nextDueAt).toBe(health.newestProbedAt! + 60_000);
      store.put(1, 'h', { alive: true, bitrateKbps: 5000 } as ProbeResult);
      health = store.cacheHealth(HOUR, HOUR, Date.now(), HOUR, 60_000);
      expect(health.nextDueAt).toBe(health.newestProbedAt! + HOUR);
      store.put(1, 'h', { alive: true, bitrateKbps: 0 } as ProbeResult);
      health = store.cacheHealth(HOUR, HOUR, Date.now(), HOUR, 60_000);
      expect(health.nextDueAt).toBe(health.newestProbedAt! + 60_000);
    } finally {
      store.close();
    }
  });

  it('backfills old cached verdicts, including missing bitrate and corrupt JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-bitrate-'));
    const path = join(dir, 'podium.db');
    try {
      const raw = new Database(path);
      raw.exec(`CREATE TABLE probe_cache (
        stream_id INTEGER NOT NULL, stream_hash TEXT NOT NULL,
        variant_id INTEGER NOT NULL DEFAULT 0, probed_at INTEGER NOT NULL,
        alive INTEGER NOT NULL, black INTEGER NOT NULL DEFAULT 0,
        result TEXT NOT NULL, dead_streak INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (stream_id, stream_hash, variant_id));`);
      const insert = raw.prepare(
        'INSERT INTO probe_cache (stream_id, stream_hash, probed_at, alive, result) VALUES (?, ?, ?, 1, ?)',
      );
      insert.run(1, 'h', Date.now(), '{"bitrateKbps":5000}');
      insert.run(2, 'h', Date.now(), '{}');
      insert.run(3, 'h', Date.now(), 'not JSON');
      raw.close();
      const store = new Store(path);
      try {
        const inspect = new Database(path, { readonly: true });
        expect(
          inspect.prepare('SELECT bitrate_kbps FROM probe_cache ORDER BY stream_id').all(),
        ).toEqual([{ bitrate_kbps: 5000 }, { bitrate_kbps: 0 }, { bitrate_kbps: null }]);
        inspect.close();
        expect(store.cacheHealth(HOUR, HOUR, Date.now(), HOUR, 60_000).total).toBe(3);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
