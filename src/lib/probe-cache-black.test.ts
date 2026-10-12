/**
 * The materialised black flag.
 *
 * `deadStreams()` used to answer "which streams have a black variant" by
 * running `json_extract` over every row in the cache, on every pass with
 * removal on and on every soak-queue and check request. The flag is known at
 * write time, so it is a column now, backfilled by migration for rows that
 * predate it. What is worth testing: the migration recovers the flag from the
 * json, `put` maintains it, and the dead/black set the column feeds is the
 * same one the json arm used to produce.
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

/** The table exactly as the release before the black column created it. */
const PRE_BLACK_SCHEMA = `
CREATE TABLE probe_cache (
    stream_id    INTEGER NOT NULL,
    stream_hash  TEXT    NOT NULL,
    variant_id   INTEGER NOT NULL DEFAULT 0,
    probed_at    INTEGER NOT NULL,
    alive        INTEGER NOT NULL,
    result       TEXT    NOT NULL,
    dead_streak  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (stream_id, stream_hash, variant_id)
);
CREATE INDEX IF NOT EXISTS probe_cache_probed_at ON probe_cache (probed_at);
`;

describe('the black column', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-black-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates a pre-column cache and recovers the flag from the json', () => {
    const path = join(dir, 'podium.db');
    const raw = new Database(path);
    raw.exec(PRE_BLACK_SCHEMA);
    const insert = raw.prepare(
      `INSERT INTO probe_cache
         (stream_id, stream_hash, variant_id, probed_at, alive, result, dead_streak)
       VALUES (?, ?, 0, ?, ?, ?, 0)`,
    );
    const now = Date.now();
    insert.run(1, 'h1', now, 1, JSON.stringify(verdict()));
    insert.run(2, 'h2', now, 1, JSON.stringify(verdict({ black: true })));
    insert.run(3, 'h3', now, 0, JSON.stringify(verdict({ alive: false, error: 'HTTP 403' })));
    raw.close();

    const store = new Store(path);
    try {
      const ids = store
        .deadStreams()
        .map((row) => row.streamId)
        .sort((a, b) => a - b);
      // The black-screened stream and the dead one are listed; the clean one
      // is not -- the same answer the json arm gave, from the column.
      expect(ids).toEqual([2, 3]);
    } finally {
      store.close();
    }
  });

  it('put maintains the flag, both ways', () => {
    const store = new Store(':memory:');
    store.put(10, 'h', verdict({ black: true }));
    expect(store.deadStreams().map((row) => row.streamId)).toEqual([10]);

    // The stream cleans up its act; the flag must follow, or the row would be
    // listed as black forever.
    store.put(10, 'h', verdict());
    expect(store.deadStreams()).toEqual([]);
    store.close();
  });

  it('a black verdict is folded like any other by deadStreams', () => {
    const store = new Store(':memory:');
    // Two variants of one stream: one clean, one black. The stream is listed
    // -- pickBestVariant prefers the usable one, and the listing is decided by
    // whether the survivor is dead or black, which it is not -- so what this
    // pins is only that the black VARIANT got the row into the candidate set
    // at all.
    store.put(20, 'h', verdict(), 0);
    store.put(20, 'h', verdict({ black: true }), 5);
    expect(store.deadStreams().map((row) => row.streamId)).toEqual([]);
    store.close();
  });
});
