/**
 * The per-variant cache: one verdict per (stream, login), upgraded in place
 * from the one-verdict-per-stream table it replaces.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProbeResult } from './probe';
import { Store } from './store';

function verdict(alive: boolean, over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    alive,
    width: alive ? 1920 : 0,
    height: alive ? 1080 : 0,
    fps: alive ? 60 : 0,
    videoCodec: alive ? 'h264' : '',
    audioCodec: alive ? 'aac' : '',
    pixelFormat: alive ? 'yuv420p' : '',
    audioChannels: alive ? 2 : 0,
    channelLayout: alive ? 'stereo' : '',
    audioBitrateKbps: alive ? 128 : 0,
    audioSampleRate: alive ? 48_000 : 0,
    bitrateKbps: alive ? 5000 : 0,
    bitrateMeasured: alive,
    elapsedMs: 100,
    error: alive ? '' : 'HTTP 4XX',
    ...over,
  };
}

/** The table exactly as the release before per-variant probing created it. */
const PRE_VARIANT_SCHEMA = `
CREATE TABLE probe_cache (
    stream_id    INTEGER NOT NULL,
    stream_hash  TEXT    NOT NULL,
    probed_at    INTEGER NOT NULL,
    alive        INTEGER NOT NULL,
    result       TEXT    NOT NULL,
    dead_streak  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (stream_id, stream_hash)
);
CREATE INDEX IF NOT EXISTS probe_cache_probed_at ON probe_cache (probed_at);
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-variants-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the variant migration', () => {
  it('carries every pre-existing row across as the default login, streaks intact', () => {
    const path = join(dir, 'podium.db');
    const raw = new Database(path);
    raw.exec(PRE_VARIANT_SCHEMA);
    const insert = raw.prepare(
      `INSERT INTO probe_cache (stream_id, stream_hash, probed_at, alive, result, dead_streak)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const old = Date.now() - 3_600_000;
    insert.run(1, 'h1', old, 1, JSON.stringify(verdict(true)), 0);
    insert.run(2, 'h2', old, 0, JSON.stringify(verdict(false)), 4);
    raw.close();

    const store = new Store(path);
    const live = store.entry(1, 'h1');
    expect(live?.alive).toBe(true);
    expect(live?.probedAt).toBe(old);

    const dead = store.entry(2, 'h2');
    // A streak a previous install spent weeks earning is not reset by an
    // upgrade: the backoff it drives continues rather than restarts.
    expect(dead?.deadStreak).toBe(4);
    store.close();

    // The successful reads above already prove the column exists -- `entry`
    // would throw preparing its SQL against the old shape -- but the key is
    // the point of the migration, so pin it directly.
    const check = new Database(path, { readonly: true });
    const sql = (
      check.prepare("SELECT sql FROM sqlite_master WHERE name = 'probe_cache'").get() as {
        sql: string;
      }
    ).sql;
    check.close();
    expect(sql).toContain('PRIMARY KEY (stream_id, stream_hash, variant_id)');
  });

  it('is a no-op on a database that already has the column', () => {
    const path = join(dir, 'podium.db');
    const first = new Store(path);
    first.put(7, 'h', verdict(true), 3);
    first.close();

    // A second open (the web process alongside the worker) must neither
    // re-migrate nor disturb the row.
    const second = new Store(path);
    expect(second.entry(7, 'h', 3)?.alive).toBe(true);
    second.close();
  });
});

describe('per-variant rows', () => {
  it('keeps each login verdict under the same stream, independently', () => {
    const store = new Store(':memory:');

    store.put(10, 'hash', verdict(true), 0);
    store.put(10, 'hash', verdict(false, { error: 'login 2 refused' }), 5);
    // The same login twice is an upsert, not a third row.
    store.put(10, 'hash', verdict(true, { height: 720 }), 5);

    const all = store.variants(10, 'hash');
    expect([...all.keys()].sort()).toEqual([0, 5]);
    expect(all.get(0)?.alive).toBe(true);
    expect(all.get(5)?.result?.height).toBe(720);

    // One login dying says nothing about the other's streak.
    store.put(10, 'hash', verdict(false), 0);
    expect(store.entry(10, 'hash', 0)?.deadStreak).toBe(1);
    expect(store.entry(10, 'hash', 5)?.deadStreak).toBe(0);

    // A changed stream_hash still invalidates every login at once: the rows
    // are variants of one stored URL, and a new hash means a new one.
    expect(store.variants(10, 'hash-next').size).toBe(0);
    store.close();
  });

  it('reports one verdict per stream, the best login it has', () => {
    const store = new Store(':memory:');
    store.put(20, 'h', verdict(true, { height: 720 }));
    store.put(20, 'h', verdict(true, { height: 1080 }), 5);

    const [one] = [...store.verdicts([20]).values()];
    expect(one?.result.height).toBe(1080);
    expect(one?.alive).toBe(true);
    store.close();
  });

  it('counts streams, not logins, in cache health', () => {
    const store = new Store(':memory:');
    const now = Date.now();
    // Two streams: one alive on both its logins, one dead on its only one.
    store.put(30, 'h', verdict(true), 0);
    store.put(30, 'h', verdict(true), 5);
    store.put(31, 'h', verdict(false), 0);

    const stats = store.cacheStats();
    expect(stats.total).toBe(2);
    expect(stats.alive).toBe(1);
    expect(stats.dead).toBe(1);

    const health = store.cacheHealth(24 * 3_600_000, 3 * 3_600_000, now);
    expect(health.total).toBe(2);
    expect(health.alive).toBe(1);
    // A stream is as old as its least-recently-checked login, and due as soon
    // as its earliest-due login is -- not twice-counted for having two.
    expect(health.due).toBe(0);
    store.close();
  });

  it('still serves a stream alive on one login when the other is dead', () => {
    const store = new Store(':memory:');
    store.put(40, 'h', verdict(false, { error: 'banned' }), 0);
    store.put(40, 'h', verdict(true), 5);

    const [one] = [...store.verdicts([40]).values()];
    expect(one?.alive).toBe(true);
    expect(store.cacheStats().alive).toBe(1);
    store.close();
  });

  it('drops rows for logins that no longer exist, and keeps the live ones', () => {
    // A profile deleted or deactivated in Dispatcharr leaves rows nothing will
    // refresh -- and the per-stream readers fold every row for a stream
    // together, so an abandoned alive verdict would keep the stream reading
    // alive and its frozen timestamp would pin the freshness numbers.
    const store = new Store(':memory:');
    store.put(40, 'h', verdict(true), 0);
    store.put(40, 'h', verdict(true), 5);
    store.put(41, 'h', verdict(true), 9);

    expect(store.pruneVariants(new Set([0, 5]))).toBe(1);
    expect([...store.variants(40, 'h').keys()].sort()).toEqual([0, 5]);
    expect(store.variants(41, 'h').size).toBe(0);
    store.close();
  });

  it('deletes nothing when the live set is empty', () => {
    // An empty set means the provider fetch came back with nothing to compare
    // against, which is a state to leave alone rather than a wipe.
    const store = new Store(':memory:');
    store.put(40, 'h', verdict(true), 0);
    expect(store.pruneVariants(new Set())).toBe(0);
    expect(store.variants(40, 'h').size).toBe(1);
    store.close();
  });

  it('stops counting a removed login the moment its rows go', () => {
    const store = new Store(':memory:');
    store.put(40, 'h', verdict(false, { error: 'banned' }), 0);
    store.put(40, 'h', verdict(true), 5);
    expect(store.cacheStats().alive).toBe(1);

    store.pruneVariants(new Set([0]));
    const stats = store.cacheStats();
    expect(stats.total).toBe(1);
    expect(stats.alive).toBe(0);
    expect(stats.dead).toBe(1);
    store.close();
  });
});
