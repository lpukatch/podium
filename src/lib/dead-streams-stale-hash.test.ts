/**
 * Stale rows must not speak for a stream whose URL has changed.
 *
 * `put()` deletes rows from other hashes, but only since it began doing so --
 * databases written before that keep them -- and a changed URL is not
 * re-probed instantly even now. Across hashes those rows lie both ways: an
 * old alive verdict hid a stream that is dead now, because `MAX(alive) = 0`
 * was computed over every row with the stream's id; an old dead or black one
 * dragged a moved stream into the candidate set on evidence its current URL
 * never earned. What is pinned here is that the gate and the rows both read
 * the current hash only, resolved the way `verdicts()` resolves it.
 *
 * The stale rows go in raw, through SQLite: `put()` would delete them.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProbeResult } from './probe';
import { Store } from './store';

function verdict(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    alive: true,
    width: 1920,
    height: 1080,
    fps: 60,
    videoCodec: 'h264',
    audioCodec: 'aac',
    pixelFormat: 'yuv420p',
    audioChannels: 2,
    channelLayout: 'stereo',
    audioBitrateKbps: 128,
    audioSampleRate: 48_000,
    bitrateKbps: 5000,
    bitrateMeasured: true,
    elapsedMs: 100,
    error: '',
    ...over,
  };
}

/** A verdict from the address the stream no longer has, written directly. */
function putStale(
  db: Database.Database,
  streamId: number,
  hash: string,
  probedAt: number,
  result: ProbeResult,
): void {
  db.prepare(
    `INSERT INTO probe_cache (stream_id, stream_hash, variant_id, probed_at, alive, black, result, dead_streak)
     VALUES (?, ?, 0, ?, ?, ?, ?, 0)`,
  ).run(
    streamId,
    hash,
    probedAt,
    result.alive ? 1 : 0,
    result.black ? 1 : 0,
    JSON.stringify(result),
  );
}

describe('deadStreams and stale hashes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-stale-hash-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a stale alive verdict does not hide a stream that is dead now', () => {
    const path = join(dir, 'podium.db');
    const store = new Store(path);
    // The current address, probed dead -- the only verdict that describes the
    // stream as it is.
    store.put(1, 'new', verdict({ alive: false, error: 'HTTP 403' }));
    // An hour earlier, the old address answered: newer rows under an older
    // hash, the shape a database written before the sweep keeps forever.
    const raw = new Database(path);
    try {
      putStale(raw, 1, 'old', Date.now() - 3_600_000, verdict());
    } finally {
      raw.close();
    }
    store.close();

    const reopened = new Store(path);
    try {
      const rows = reopened.deadStreams();
      expect(rows.map((row) => row.streamId)).toEqual([1]);
      // The streak is the current verdict's, not folded across hashes.
      expect(rows[0]?.deadStreak).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it('a stale black verdict does not list a stream that is alive now', () => {
    const path = join(dir, 'podium.db');
    const store = new Store(path);
    store.put(2, 'new', verdict());
    const raw = new Database(path);
    try {
      putStale(raw, 2, 'old', Date.now() - 3_600_000, verdict({ black: true }));
    } finally {
      raw.close();
    }
    store.close();

    const reopened = new Store(path);
    try {
      expect(reopened.deadStreams()).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it('the newest verdict is the current one even when it is the only row', () => {
    // A stream whose URL changed after its last probe: until the next probe
    // lands there is nothing newer than the old address's verdict, and
    // `verdicts()` reports it the same way. The next probe replaces it.
    const path = join(dir, 'podium.db');
    const raw = new Database(path);
    const store = new Store(path);
    store.put(3, 'gone', verdict({ alive: false, error: 'HTTP 403' }));
    try {
      putStale(
        raw,
        3,
        'older',
        Date.now() - 3_600_000,
        verdict({ alive: false, error: 'timed out' }),
      );
    } finally {
      raw.close();
    }
    store.close();

    const reopened = new Store(path);
    try {
      expect(reopened.deadStreams().map((row) => row.streamId)).toEqual([3]);
    } finally {
      reopened.close();
    }
  });
});
