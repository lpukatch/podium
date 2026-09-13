/**
 * `deadStreams()`: the fold is the whole point. A cache written by per-login
 * probing holds a row per login, and the list must read those as one stream
 * -- dead only when every login is, black only when the verdict that survives
 * the fold is. Every case below is one way that fold can go wrong.
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

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-dead-streams-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('deadStreams', () => {
  it('lists a pooled dead stream once, with the streak its verdict has held', () => {
    const store = new Store(join(dir, 'dead.db'));
    const dead = verdict(false);
    store.put(1, 'h1', dead);
    store.put(1, 'h1', dead);

    const rows = store.deadStreams();
    store.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ streamId: 1, deadStreak: 2, result: dead });
  });

  it('does not list a stream one of whose logins is alive', () => {
    const store = new Store(join(dir, 'mixed.db'));
    store.put(1, 'h1', verdict(true), 1);
    store.put(1, 'h1', verdict(false), 2);

    const rows = store.deadStreams();
    store.close();

    expect(rows).toHaveLength(0);
  });

  it('lists an all-dead stream once, as recently as its newest verdict', () => {
    const path = join(dir, 'all-dead.db');
    const store = new Store(path);
    store.put(1, 'h1', verdict(false), 1);
    store.put(1, 'h1', verdict(false), 2);
    // `put` stamps Date.now(); pin the two rows apart so "max" is checkable.
    const later = Date.now() + 5000;
    new Database(path)
      .prepare('UPDATE probe_cache SET probed_at = ? WHERE variant_id = 2')
      .run(later);

    const rows = store.deadStreams();
    store.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.probedAt).toBe(later);
  });

  it('lists an alive black screen as black, with no dead streak', () => {
    const store = new Store(join(dir, 'black.db'));
    store.put(1, 'h1', verdict(true, { black: true }));

    const rows = store.deadStreams();
    store.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.result.alive).toBe(true);
    expect(rows[0]?.result.black).toBe(true);
    expect(rows[0]?.deadStreak).toBe(0);
  });

  it('does not list a stream whose black login lost the fold to a live one', () => {
    const store = new Store(join(dir, 'black-and-live.db'));
    store.put(1, 'h1', verdict(true, { black: true }), 1);
    store.put(1, 'h1', verdict(true), 2);

    const rows = store.deadStreams();
    store.close();

    expect(rows).toHaveLength(0);
  });

  it('does not list a clean live stream', () => {
    const store = new Store(join(dir, 'live.db'));
    store.put(1, 'h1', verdict(true));

    const rows = store.deadStreams();
    store.close();

    expect(rows).toHaveLength(0);
  });

  it('does not list a stream whose only verdict is unreadable', () => {
    const path = join(dir, 'corrupt.db');
    const store = new Store(path);
    store.put(1, 'h1', verdict(false));
    new Database(path)
      .prepare('UPDATE probe_cache SET result = ? WHERE stream_id = 1')
      .run('not json {');

    const rows = store.deadStreams();
    store.close();

    expect(rows).toHaveLength(0);
  });

  it('reads the streak of the URL the stream has now, not one it lost', () => {
    // `put()` keys on stream_hash so a re-issued URL does not inherit the old
    // verdict, but the old rows stay until `prune()` sweeps them a month
    // later. This fold is asked about a stream, not a URL, so it has to pick.
    // Getting it wrong is not cosmetic: between two equally dead verdicts the
    // tie-break is primary-key order, which is lexicographic on the hash, so
    // roughly half the time a stream that has failed once under its new
    // address reports the streak of the address it no longer has -- and with
    // removal on, that unassigns it immediately and for good.
    const store = new Store(join(dir, 'rotated.db'));
    for (let i = 0; i < 10; i += 1) store.put(1, 'a1b2old', verdict(false));
    store.put(1, 'f9e8new', verdict(false));

    const row = store.deadStreams().find((r) => r.streamId === 1);
    const streak = store.deadStreaks([1]).get(1);
    store.close();

    expect(row?.deadStreak).toBe(1);
    expect(streak).toBe(1);
  });

  it('reports no streak for a stream that is alive, black, or unprobed', () => {
    // `deadStreaks` is what decides a removal, so only *dead* may appear in
    // it. A black screen and a thin stream are alive: they sink, they reset
    // the count in `put()`, and they are never removed.
    const store = new Store(join(dir, 'streaks.db'));
    for (let i = 0; i < 4; i += 1) store.put(1, 'h1', verdict(false));
    store.put(2, 'h1', verdict(true, { black: true }));
    store.put(3, 'h1', verdict(true));

    const streaks = store.deadStreaks([1, 2, 3, 99]);
    store.close();

    expect(streaks.get(1)).toBe(4);
    expect(streaks.has(2)).toBe(false);
    expect(streaks.has(3)).toBe(false);
    expect(streaks.has(99)).toBe(false);
  });

  it('counts only the streams it actually holds a verdict for', () => {
    // The population a provider's dead share is measured against.
    const store = new Store(join(dir, 'probed.db'));
    store.put(1, 'h1', verdict(false));
    store.put(2, 'h1', verdict(true));

    const probed = store.probedStreamIds();
    store.close();

    expect(probed).toEqual(new Set([1, 2]));
  });
});
