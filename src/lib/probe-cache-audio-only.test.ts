/**
 * The audio-only assumption a verdict was taken under, as a column.
 *
 * A probe told to expect no video and a probe told to require it can reach
 * opposite verdicts about the same URL, so the cache records which question
 * each row answered and the planner treats a mismatch as stale. Unlike the
 * black and bitrate columns there is no backfill: 0 *is* the recovered value,
 * because audio-only probing was opt-in per group and every row written before
 * this column existed was taken video-strict. What is worth testing: the
 * migration lands the column on a pre-column cache, `put` records the flag
 * both ways, and the read paths surface it.
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

/** The table exactly as the release before the audio-only column created it. */
const PRE_AUDIO_ONLY_SCHEMA = `
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

describe('the audio_only column', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-audio-only-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates a pre-column cache, reading every existing row as video-strict', () => {
    const path = join(dir, 'podium.db');
    const raw = new Database(path);
    raw.exec(PRE_AUDIO_ONLY_SCHEMA);
    const insert = raw.prepare(
      `INSERT INTO probe_cache
         (stream_id, stream_hash, variant_id, probed_at, alive, result, dead_streak)
       VALUES (?, ?, 0, ?, ?, ?, 0)`,
    );
    // Taken under an audio-only group, before the flag existed -- but that
    // assumption is unrecoverable, and 0 (video-strict) is the honest read:
    // the reader that resolves audio-only sees a mismatch and re-probes,
    // which is the catch-up the flag never had.
    insert.run(1, 'h', Date.now(), 1, JSON.stringify(verdict()));
    raw.close();

    const store = new Store(path);
    try {
      const all = [...store.variants(1, 'h').values()];
      expect(all).toHaveLength(1);
      expect(all[0]?.audioOnly).toBe(false);
      expect(all[0]?.alive).toBe(true);
    } finally {
      store.close();
    }
  });

  it('put records the assumption both ways, and reads surface it', () => {
    const store = new Store(':memory:');
    store.put(10, 'h', verdict(), 0, false);
    store.put(11, 'h', verdict({ height: 0, width: 0, videoCodec: '' }), 0, true);

    expect(store.entry(10, 'h')?.audioOnly).toBe(false);
    expect(store.entry(11, 'h')?.audioOnly).toBe(true);

    const pooled = store.variantsForStreams([
      { id: 10, streamHash: 'h' },
      { id: 11, streamHash: 'h' },
    ]);
    expect(pooled.get(10)?.get(0)?.audioOnly).toBe(false);
    expect(pooled.get(11)?.get(0)?.audioOnly).toBe(true);

    // The row's own update, not just fresh inserts: re-taking the same
    // variant under the other assumption rewrites the flag, which is what
    // makes the flip self-healing instead of sticky.
    store.put(10, 'h', verdict(), 0, true);
    expect(store.entry(10, 'h')?.audioOnly).toBe(true);
    store.close();
  });
});
