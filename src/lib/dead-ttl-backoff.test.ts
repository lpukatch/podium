/**
 * Backoff on repeatedly-dead streams.
 *
 * The rule is expressed twice -- once in TypeScript for the planner, once in
 * SQL for the progress page's "what is due" -- so the tests that matter most
 * here are the ones pinning those two to each other.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProbeResult } from './probe';
import { deadTtlFor, Store, ttlFor } from './store';

/**
 * Whether a pass would still serve this row from cache.
 *
 * The planner's rule, spelled out: one read, measured against the lifetime the
 * row has earned. `Store` deliberately has no method for it -- the planner
 * needs the age and the streak from the same read anyway, so a helper that
 * returned only the verdict would be a second query for what it already holds.
 */
function servable(
  store: Store,
  streamId: number,
  liveTtlMs: number,
  deadTtlMs: number,
  deadTtlMaxMs: number,
): boolean {
  const entry = store.entry(streamId, 'h');
  if (!entry?.result) return false;
  return Date.now() - entry.probedAt < ttlFor(entry, liveTtlMs, deadTtlMs, deadTtlMaxMs);
}

const HOUR = 3_600_000;
const BASE = 3 * HOUR;
const CAP = 24 * HOUR;

function verdict(alive: boolean): ProbeResult {
  return {
    alive,
    width: alive ? 1920 : 0,
    height: alive ? 1080 : 0,
    fps: alive ? 60 : 0,
    videoCodec: alive ? 'h264' : '',
    audioCodec: alive ? 'aac' : '',
    pixelFormat: alive ? 'yuv420p' : '',
    audioChannels: alive ? 2 : 0,
    bitrateKbps: alive ? 5000 : 0,
    bitrateMeasured: alive,
    elapsedMs: 100,
    error: alive ? '' : 'Server returned 4XX Client Error',
  };
}

describe('deadTtlFor', () => {
  it('doubles per consecutive dead verdict and stops at the cap', () => {
    // Streak 1 is the verdict that has only just died: still the base TTL, so
    // a stream that drops out is noticed as quickly as it ever was.
    expect(deadTtlFor(1, BASE, CAP)).toBe(3 * HOUR);
    expect(deadTtlFor(2, BASE, CAP)).toBe(6 * HOUR);
    expect(deadTtlFor(3, BASE, CAP)).toBe(12 * HOUR);
    expect(deadTtlFor(4, BASE, CAP)).toBe(24 * HOUR);
    expect(deadTtlFor(5, BASE, CAP)).toBe(24 * HOUR);
    expect(deadTtlFor(50, BASE, CAP)).toBe(24 * HOUR);
  });

  it('treats a streak of 0 as the base TTL', () => {
    // What every row migrated from before this existed carries.
    expect(deadTtlFor(0, BASE, CAP)).toBe(BASE);
  });

  it('is a no-op when no cap is given, so old callers keep the flat behaviour', () => {
    for (const streak of [0, 1, 2, 9, 40]) expect(deadTtlFor(streak, BASE)).toBe(BASE);
  });

  it('raises a cap below the base rather than expiring dead verdicts sooner', () => {
    expect(deadTtlFor(4, BASE, HOUR)).toBe(BASE);
  });

  it('never overflows to Infinity on an absurd streak', () => {
    // 2 ** 1024 is Infinity, which would make the verdict permanent.
    const ttl = deadTtlFor(5000, BASE, Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(ttl)).toBe(true);
  });

  it('leaves live verdicts on the live TTL whatever the streak says', () => {
    const live = { alive: true, deadStreak: 9, result: verdict(true) };
    const dead = { alive: false, deadStreak: 9, result: verdict(false) };
    expect(ttlFor(live, 24 * HOUR, BASE, CAP)).toBe(24 * HOUR);
    expect(ttlFor(dead, 24 * HOUR, BASE, CAP)).toBe(CAP);
  });
});

describe('ttlFor on an unmeasured bitrate', () => {
  const unmeasured = {
    alive: true,
    deadStreak: 0,
    result: { ...verdict(true), bitrateKbps: 0, bitrateMeasured: false },
  };
  const measured = { alive: true, deadStreak: 0, result: verdict(true) };

  it('books a live verdict with no bitrate reading in for a re-probe', () => {
    expect(ttlFor(unmeasured, 24 * HOUR, BASE, CAP, 30 * 60_000)).toBe(30 * 60_000);
  });

  it('leaves a measured live verdict alone', () => {
    expect(ttlFor(measured, 24 * HOUR, BASE, CAP, 30 * 60_000)).toBe(24 * HOUR);
  });

  it('is off at 0, so the rule reduces to live-or-dead', () => {
    expect(ttlFor(unmeasured, 24 * HOUR, BASE, CAP)).toBe(24 * HOUR);
  });

  it('can only shorten -- never outlives the live TTL', () => {
    expect(ttlFor(unmeasured, HOUR, BASE, CAP, 24 * HOUR)).toBe(HOUR);
  });

  it('gives an unreadable result the plain live TTL rather than re-probing it', () => {
    // `entry()` nulls a result it cannot parse. That is an unknown verdict, not
    // a measured-nothing one, and it must not fall into the short TTL.
    const corrupt = { alive: true, deadStreak: 0, result: null };
    expect(ttlFor(corrupt, 24 * HOUR, BASE, CAP, 30 * 60_000)).toBe(24 * HOUR);
  });

  it('does not shorten a dead verdict, whose bitrate is 0 by definition', () => {
    const dead = { alive: false, deadStreak: 1, result: verdict(false) };
    expect(ttlFor(dead, 24 * HOUR, BASE, CAP, 30 * 60_000)).toBe(BASE);
  });
});

describe('Store dead-streak bookkeeping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts consecutive dead verdicts and resets on an alive one', () => {
    const store = new Store(':memory:');
    expect(store.entry(1, 'h')).toBeNull();

    store.put(1, 'h', verdict(false));
    expect(store.entry(1, 'h')?.deadStreak).toBe(1);
    store.put(1, 'h', verdict(false));
    store.put(1, 'h', verdict(false));
    expect(store.entry(1, 'h')?.deadStreak).toBe(3);

    store.put(1, 'h', verdict(true));
    expect(store.entry(1, 'h')?.deadStreak).toBe(0);

    // And starts again from 1, not from where it left off.
    store.put(1, 'h', verdict(false));
    expect(store.entry(1, 'h')?.deadStreak).toBe(1);
    store.close();
  });

  it('keeps a streak per (stream, hash), so a re-published stream starts clean', () => {
    const store = new Store(':memory:');
    store.put(1, 'old', verdict(false));
    store.put(1, 'old', verdict(false));
    store.put(1, 'new', verdict(false));
    expect(store.entry(1, 'old')?.deadStreak).toBe(2);
    expect(store.entry(1, 'new')?.deadStreak).toBe(1);
    store.close();
  });

  it('serves a long-dead verdict from cache past the base TTL, and a fresh one not', () => {
    const store = new Store(':memory:');
    store.put(1, 'h', verdict(false)); // streak 1 -> 3h
    store.put(2, 'h', verdict(false));
    store.put(2, 'h', verdict(false));
    store.put(2, 'h', verdict(false));
    store.put(2, 'h', verdict(false)); // streak 4 -> 24h

    vi.advanceTimersByTime(4 * HOUR);
    // The just-died stream is due again; the four-times-dead one is not.
    expect(servable(store, 1, 24 * HOUR, BASE, CAP)).toBe(false);
    expect(servable(store, 2, 24 * HOUR, BASE, CAP)).toBe(true);

    vi.advanceTimersByTime(21 * HOUR);
    expect(servable(store, 2, 24 * HOUR, BASE, CAP)).toBe(false);
    store.close();
  });

  it('ignores the backoff when the cap is left at the base', () => {
    const store = new Store(':memory:');
    for (let i = 0; i < 6; i++) store.put(1, 'h', verdict(false));
    vi.advanceTimersByTime(4 * HOUR);
    expect(servable(store, 1, 24 * HOUR, BASE, BASE)).toBe(false);
    store.close();
  });
});

describe('cacheHealth agrees with deadTtlFor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes the same due time in SQL as the planner does in TypeScript', () => {
    const store = new Store(':memory:');
    const writtenAt = Date.now();
    // Streaks 1..5, so the row with the *shortest* backed-off TTL is the one
    // that should drive nextDueAt.
    for (let streak = 1; streak <= 5; streak++) {
      for (let i = 0; i < streak; i++) store.put(streak, 'h', verdict(false));
    }

    const health = store.cacheHealth(24 * HOUR, BASE, Date.now(), CAP);
    expect(health.nextDueAt).toBe(writtenAt + deadTtlFor(1, BASE, CAP));

    // Nothing is due yet; after the base TTL exactly one row (streak 1) is.
    expect(health.due).toBe(0);
    vi.advanceTimersByTime(3 * HOUR);
    expect(store.cacheHealth(24 * HOUR, BASE, Date.now(), CAP).due).toBe(1);
    // 6h in, streaks 1 and 2. 12h in, streaks 1, 2 and 3.
    vi.advanceTimersByTime(3 * HOUR);
    expect(store.cacheHealth(24 * HOUR, BASE, Date.now(), CAP).due).toBe(2);
    vi.advanceTimersByTime(6 * HOUR);
    expect(store.cacheHealth(24 * HOUR, BASE, Date.now(), CAP).due).toBe(3);
    // At the cap everything is due, including the streaks past it.
    vi.advanceTimersByTime(12 * HOUR);
    expect(store.cacheHealth(24 * HOUR, BASE, Date.now(), CAP).due).toBe(5);
    store.close();
  });

  it('leaves live rows on the live TTL', () => {
    const store = new Store(':memory:');
    store.put(1, 'h', verdict(true));
    const health = store.cacheHealth(24 * HOUR, BASE, Date.now(), CAP);
    expect(health.nextDueAt).toBe(Date.now() + 24 * HOUR);
    store.close();
  });

  it('applies the unmeasured-bitrate TTL in SQL exactly as ttlFor does', () => {
    const store = new Store(':memory:');
    const unmeasured = { ...verdict(true), bitrateKbps: 0, bitrateMeasured: false };
    store.put(1, 'h', verdict(true));
    store.put(2, 'h', unmeasured);
    const writtenAt = Date.now();

    // The unmeasured row, not the live one, drives the next due time.
    const health = store.cacheHealth(24 * HOUR, BASE, Date.now(), CAP, 30 * 60_000);
    expect(health.nextDueAt).toBe(
      writtenAt +
        ttlFor(
          { alive: true, deadStreak: 0, result: unmeasured },
          24 * HOUR,
          BASE,
          CAP,
          30 * 60_000,
        ),
    );

    vi.advanceTimersByTime(30 * 60_000);
    expect(store.cacheHealth(24 * HOUR, BASE, Date.now(), CAP, 30 * 60_000).due).toBe(1);
    // With the rule off, the same row is not due for a full day.
    expect(store.cacheHealth(24 * HOUR, BASE, Date.now(), CAP).due).toBe(0);
    store.close();
  });
});

describe('cacheHealth with an unreadable result column', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-corrupt-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not let a corrupt row take the whole health query down', () => {
    // json_extract raises on malformed JSON, and one bad row would otherwise
    // break the progress page rather than just itself.
    const path = join(dir, 'corrupt.db');
    const store = new Store(path);
    store.put(1, 'h', verdict(true));
    store.close();

    const raw = new Database(path);
    raw.prepare('UPDATE probe_cache SET result = ? WHERE stream_id = 1').run('not json {');
    raw.close();

    const reopened = new Store(path);
    const health = reopened.cacheHealth(24 * HOUR, BASE, Date.now(), CAP, 30 * 60_000);
    // Falls back to the plain live TTL, which is what ttlFor does with a result
    // it could not parse.
    expect(health.total).toBe(1);
    expect(health.nextDueAt).toBe(health.newestProbedAt! + 24 * HOUR);
    reopened.close();
  });
});

describe('migration from a database without dead_streak', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-migrate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds the column and treats existing rows as un-streaked', () => {
    const path = join(dir, 'old.db');
    // The pre-backoff table, exactly as an install upgrading from it will have.
    const raw = new Database(path);
    raw.exec(`CREATE TABLE probe_cache (
        stream_id    INTEGER NOT NULL,
        stream_hash  TEXT    NOT NULL,
        probed_at    INTEGER NOT NULL,
        alive        INTEGER NOT NULL,
        result       TEXT    NOT NULL,
        PRIMARY KEY (stream_id, stream_hash)
      )`);
    raw
      .prepare('INSERT INTO probe_cache VALUES (?, ?, ?, ?, ?)')
      .run(1, 'h', Date.now(), 0, JSON.stringify(verdict(false)));
    raw.close();

    const store = new Store(path);
    const entry = store.entry(1, 'h');
    expect(entry).not.toBeNull();
    expect(entry?.deadStreak).toBe(0);
    // Which means the base TTL: one more probe at the old cadence, then it
    // starts backing off from a streak it actually measured.
    expect(deadTtlFor(entry?.deadStreak ?? 0, BASE, CAP)).toBe(BASE);

    // And the next dead verdict starts the count.
    store.put(1, 'h', verdict(false));
    expect(store.entry(1, 'h')?.deadStreak).toBe(1);
    store.close();
  });
});
