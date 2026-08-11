/**
 * Three fixes that share a theme: the worker being honest about what it is
 * doing and what it is holding.
 *
 *   - the lock owner is unique per process, so two workers cannot both hold it
 *   - a worker that finds the lock held waits instead of giving up forever
 *   - a pass that will pause does not fetch the stream catalogue first
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockOwner, startWorker } from '../worker/loop';
import { loadConfig } from './config';
import { type Activity, Pacer } from './pacer';
import { RulesSource } from './rules-source';
import { Runner } from './runner';
import { Store } from './store';

const idle: Activity = { channelIds: new Set(), idle: true };
const watching: Activity = { channelIds: new Set([5]), idle: false };

const pacer = (over = {}) =>
  new Pacer({
    maxAgeMs: 3_600_000,
    tickMs: 60_000,
    pauseWhenWatching: true,
    minFreeSlots: 1,
    maxSlice: 400,
    ...over,
  });

describe('lock ownership', () => {
  it('gives two processes on one host distinct owners', () => {
    const owners = new Set(Array.from({ length: 50 }, () => lockOwner()));
    expect(owners.size).toBe(50);
  });

  it('does not depend on pid or HOSTNAME, which collide across containers', () => {
    // The regression, stated as the old formula. Next's standalone server sets
    // HOSTNAME to the address it binds -- `0.0.0.0` -- so two containers report
    // the same host, and PID 7 is routine inside each. Same pid, same
    // HOSTNAME, same owner string.
    const old = (pid: number, host: string) => `${pid}@${host}`;
    expect(old(7, '0.0.0.0')).toBe(old(7, '0.0.0.0'));

    // The replacement keeps two such processes apart. `HOSTNAME` is not read at
    // all now, so setting it to the colliding value changes nothing.
    const before = process.env.HOSTNAME;
    process.env.HOSTNAME = '0.0.0.0';
    try {
      expect(lockOwner()).not.toBe(lockOwner());
    } finally {
      if (before === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = before;
    }
  });

  it('does not let a second owner walk into a held lock', () => {
    // The collision mattered because `acquireLock` is deliberately reentrant
    // for the same owner: identical strings meant the second worker took a
    // live lock believing it already held it, and then both probed everything.
    const dir = mkdtempSync(join(tmpdir(), 'podium-owner-'));
    const store = new Store(join(dir, 'owner.db'));
    try {
      expect(store.acquireLock(lockOwner()).ok).toBe(true);
      expect(store.acquireLock(lockOwner()).ok).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('startWorker when the lock is held', () => {
  let dir: string;
  let store: Store;
  let config: ReturnType<typeof loadConfig>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-startworker-'));
    writeFileSync(join(dir, 'rules.json'), JSON.stringify({ schema: 2, channels: [] }), 'utf8');
    config = loadConfig({ PODIUM_DATA_DIR: dir, DISPATCHARR_API_KEY: 'k' });
    // Held by somebody else, with a heartbeat fresh enough to keep.
    store = new Store(config.dbPath);
    store.acquireLock('someone-else');
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('waits for it rather than giving up, and never touches it', async () => {
    // It used to return null and never retry. A pod killed rather than shut
    // down leaves a lock less than a minute old, so its replacement declined
    // and then served the UI forever without probing anything.
    const lines: string[] = [];
    const stop = await startWorker(config, (m) => lines.push(m));

    expect(typeof stop).toBe('function');
    expect(lines.join('\n')).toContain('another worker holds the lock (someone-else)');
    expect(lines.join('\n')).not.toContain('paced loop started');

    // Waiting, not holding: the lock is still the other worker's, and stopping
    // a waiter must not delete a lock it never took.
    expect(store.lockState()?.owner).toBe('someone-else');
    stop();
    expect(store.lockState()?.owner).toBe('someone-else');
  });

  it('starts once the lock comes free', async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const stop = await startWorker(config, (m) => lines.push(m));
      expect(lines.join('\n')).not.toContain('paced loop started');

      store.releaseLock('someone-else');
      await vi.advanceTimersByTimeAsync(31_000);

      expect(lines.join('\n')).toContain('paced loop started (lock acquired)');
      expect(store.lockState()?.owner).not.toBe('someone-else');
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a pass that will pause does not fetch the catalogue', () => {
  let dir: string;
  let store: Store;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-paused-'));
    store = new Store(join(dir, 'paused.db'));
    const tmp = join(dir, 'rules.json.tmp');
    writeFileSync(tmp, JSON.stringify({ schema: 2, defaults: {}, channels: [] }), 'utf8');
    renameSync(tmp, join(dir, 'rules.json'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Records every path the client asks for; reports one viewer if `watching`. */
  function stubDispatcharr(busy: boolean) {
    const paths: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      paths.push(new URL(url).pathname);
      const body = url.includes('/accounts/token/')
        ? { access: 'a', refresh: 'r' }
        : url.includes('/proxy/ts/status')
          ? { channels: busy ? [{ channel_id: 1 }] : [], count: busy ? 1 : 0 }
          : url.includes('/m3u/accounts/')
            ? { count: 1, next: null, results: [{ id: 5, name: 'P', max_streams: 3 }] }
            : { count: 0, next: null, results: [] };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as unknown as typeof fetch;
    return paths;
  }

  const runner = () =>
    new Runner({
      config: () => loadConfig({ PODIUM_DATA_DIR: dir, DISPATCHARR_API_KEY: 'k' }),
      store,
      rules: new RulesSource(join(dir, 'rules.json')),
    });

  it('skips the stream catalogue when someone is watching', async () => {
    const paths = stubDispatcharr(true);
    const summary = await runner().runOnce();

    expect(summary.paused).toBe(true);
    // The whole point: 22,000 streams across 44 pages, fetched and then thrown
    // away, at the exact moment Dispatcharr is busy serving the viewer.
    expect(paths).not.toContain('/api/channels/streams/');
    expect(paths).toContain('/api/channels/channels/');
    expect(paths).toContain('/proxy/ts/status');
  });

  it('still fetches it when nobody is watching', async () => {
    const paths = stubDispatcharr(false);
    const summary = await runner().runOnce();

    expect(summary.paused).toBe(false);
    expect(paths).toContain('/api/channels/streams/');
  });
});

describe('Pacer.pausedByActivity', () => {
  it('agrees with laneLimits, which is the point of splitting it out', () => {
    for (const [p, activity] of [
      [pacer(), watching],
      [pacer(), idle],
      [pacer({ pauseWhenWatching: false }), watching],
      [pacer({ pauseWhenWatching: false }), idle],
    ] as Array<[Pacer, Activity]>) {
      // When it says the pass is settled, the lane map is empty whatever the
      // viewer counts -- which is exactly what lets the caller skip fetching
      // the streams those counts come from.
      if (p.pausedByActivity(activity)) {
        expect(p.laneLimits(new Map([[1, 3]]), activity, new Map()).size).toBe(0);
        expect(p.laneLimits(new Map([[1, 3]]), activity, new Map([[1, 99]])).size).toBe(0);
      }
    }
  });

  it('is false when nobody is watching', () => {
    expect(pacer().pausedByActivity(idle)).toBe(false);
  });

  it('is false when the operator turned pausing off', () => {
    expect(pacer({ pauseWhenWatching: false }).pausedByActivity(watching)).toBe(false);
  });

  it('is true when someone is watching', () => {
    expect(pacer().pausedByActivity(watching)).toBe(true);
  });
});
