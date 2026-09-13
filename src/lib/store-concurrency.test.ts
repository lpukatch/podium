/**
 * Two processes, one database file.
 *
 * The shipped image runs the Next server and the paced worker side by side
 * against one SQLite file, which makes two things load-bearing that a
 * single-process reading of the code never exercises:
 *
 *   - a writer must wait for the other writer rather than throwing on contact
 *   - the worker lock must be decided by one statement, not by a read followed
 *     by a write that assumes the read is still true
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorker } from '../worker/loop';
import { loadConfig } from './config';
import { BUSY_TIMEOUT_MS, STALE_LOCK_MS, Store } from './store';

describe('a second writer', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-busy-'));
    store = new Store(join(dir, 'busy.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('waits for the other one instead of failing on contact', () => {
    // Connection state, with no other way to observe it: a real contention test
    // would need two processes, because better-sqlite3 blocks this one's event
    // loop for the whole wait. The value is what the assertion is about --
    // SQLite's default is 0, which is what turned "the worker is mid-write"
    // into a 500 on the settings page.
    const db = (store as unknown as { db: Database.Database }).db;
    expect(db.pragma('busy_timeout', { simple: true })).toBe(BUSY_TIMEOUT_MS);
  });

  it('sets it on every handle, not just the one that ran the schema', () => {
    // The schema only runs for the first handle on a path. A pragma set inside
    // that branch would leave every later handle -- which is every handle the
    // web process opens per request -- on the default of 0.
    const second = new Store(join(dir, 'busy.db'));
    try {
      const db = (second as unknown as { db: Database.Database }).db;
      expect(db.pragma('busy_timeout', { simple: true })).toBe(BUSY_TIMEOUT_MS);
    } finally {
      second.close();
    }
  });
});

describe('claiming the worker lock', () => {
  let dir: string;
  let path: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-lock-'));
    path = join(dir, 'lock.db');
    store = new Store(path);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const heartbeatOf = (owner: string, at: number) =>
    new Database(path)
      .prepare('UPDATE worker_lock SET heartbeat = ? WHERE owner = ?')
      .run(at, owner);

  it('is one statement, so a lost claim writes nothing at all', () => {
    // The shape that matters. The claim used to be a SELECT that decided and an
    // INSERT that obeyed, with the whole of the other process's claim able to
    // land in between: two workers of a rolling deployment both read an absent
    // row, both wrote, and both believed they had won. Stated here as the
    // invariant that made it possible -- a losing claim must leave the row
    // exactly as it found it, which the old unconditional upsert did not.
    expect(store.acquireLock('first').ok).toBe(true);
    const held = store.lockState();

    const lost = store.acquireLock('second');
    expect(lost.ok).toBe(false);
    expect(lost.heldBy).toBe('first');
    expect(store.lockState()).toEqual(held);
  });

  it('lets the holder renew its own claim', () => {
    // Deliberately reentrant: the worker re-acquires on its own retry path, and
    // a lock it cannot retake is a lock it has to wait two minutes for.
    expect(store.acquireLock('first').ok).toBe(true);
    expect(store.acquireLock('first').ok).toBe(true);
    expect(store.lockState()?.owner).toBe('first');
  });

  it('takes over one whose heartbeat has gone stale', () => {
    expect(store.acquireLock('gone').ok).toBe(true);
    heartbeatOf('gone', Date.now() - STALE_LOCK_MS - 1);

    expect(store.acquireLock('fresh').ok).toBe(true);
    expect(store.lockState()?.owner).toBe('fresh');
  });

  it('reports the holder across connections, not just within one', () => {
    // The case the lock exists for: the two claimants are different processes,
    // so neither has the other's in-memory state to consult.
    const other = new Store(path);
    try {
      expect(other.acquireLock('worker-a').ok).toBe(true);
      expect(store.acquireLock('worker-b')).toEqual({ ok: false, heldBy: 'worker-a' });
    } finally {
      other.close();
    }
  });
});

describe('the heartbeat', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-beat-'));
    store = new Store(join(dir, 'beat.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('says the lock is still ours while it is', () => {
    store.acquireLock('mine');
    expect(store.heartbeat('mine')).toBe(true);
  });

  it('says it is not once somebody else has it', () => {
    // It used to return nothing, so a worker whose beats had stopped landing --
    // a stalled event loop, a suspended container, a clock step -- never found
    // out it had been taken over, and went on probing and reordering alongside
    // the worker that now held the lock.
    store.acquireLock('mine');
    store.releaseLock('mine');
    store.acquireLock('theirs');

    expect(store.heartbeat('mine')).toBe(false);
    expect(store.lockState()?.owner).toBe('theirs');
  });

  it('says it is not when the row has gone entirely', () => {
    store.acquireLock('mine');
    store.releaseLock('mine');
    expect(store.heartbeat('mine')).toBe(false);
  });
});

describe('a worker that loses the lock', () => {
  let dir: string;
  let config: ReturnType<typeof loadConfig>;
  let stop: (() => void) | null = null;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-standdown-'));
    writeFileSync(join(dir, 'rules.json'), JSON.stringify({ schema: 2, channels: [] }), 'utf8');
    config = loadConfig({ PODIUM_DATA_DIR: dir, DISPATCHARR_API_KEY: 'k' });
    // None of this is about the pass, and an unstubbed one reaches for a real
    // Dispatcharr. The loop survives a failing pass, so failing is the cheapest
    // stub -- the same one the dry-run banner tests use.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    stop?.();
    stop = null;
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Somebody else takes it, the way a takeover after a stale window looks. */
  const stealLock = () => {
    const other = new Store(config.dbPath);
    try {
      new Database(config.dbPath).prepare('DELETE FROM worker_lock').run();
      expect(other.acquireLock('the-other-worker').ok).toBe(true);
    } finally {
      other.close();
    }
  };

  it('stands down at the next beat instead of passing alongside the new holder', async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      stop = await startWorker(config, (m) => lines.push(m));
      expect(lines.join('\n')).toContain('paced loop started');

      stealLock();
      await vi.advanceTimersByTimeAsync(31_000);

      expect(lines.join('\n')).toContain('another worker has taken the lock');
      // And it did not write itself back in on the way past.
      const check = new Store(config.dbPath);
      try {
        expect(check.lockState()?.owner).toBe('the-other-worker');
      } finally {
        check.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes back to waiting, and starts again when the lock comes free', async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      stop = await startWorker(config, (m) => lines.push(m));
      stealLock();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(lines.join('\n')).toContain('another worker has taken the lock');

      const other = new Store(config.dbPath);
      try {
        other.releaseLock('the-other-worker');
      } finally {
        other.close();
      }
      await vi.advanceTimersByTimeAsync(31_000);

      const check = new Store(config.dbPath);
      try {
        expect(check.lockState()?.owner).not.toBe('the-other-worker');
        expect(check.lockState()).not.toBeNull();
      } finally {
        check.close();
      }
      // Stood down and came back, rather than exiting: a takeover can itself be
      // the transient event, and a worker that quits needs a human to restart it.
      const starts = lines.filter((line) => line.startsWith('paced loop started'));
      expect(starts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
