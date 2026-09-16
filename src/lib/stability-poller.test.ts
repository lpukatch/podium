/**
 * The worker's half of the passive ledger.
 *
 * What is worth testing here is not the arithmetic -- `stability.test.ts` has
 * that -- but the wiring around it: that the poller only runs while the lock is
 * held, that legs in flight are written rather than lost when the worker stops,
 * and that a Dispatcharr which cannot be reached costs one sample rather than
 * the loop.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorker } from '../worker/loop';
import { loadConfig } from './config';
import { Store } from './store';

/** One live channel, shaped as `/proxy/ts/status` reports it. */
function live(over: Record<string, unknown> = {}) {
  return {
    channel_id: '09bbd059-1a49-47ee-a525-c1444e1c6bd7',
    state: 'active',
    client_count: 1,
    started_at: 1_789_529_704.443,
    m3u_profile_id: 6,
    stream_id: 77013,
    total_bytes: 1_000_000,
    healthy: true,
    ...over,
  };
}

describe('the session poller', () => {
  let dir: string;
  let stop: (() => void) | null = null;
  let status: unknown[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-poller-'));
    // A rules file has to exist or the worker logs about its absence; it never
    // needs to match anything, since no pass is allowed to complete here.
    writeFileSync(join(dir, 'rules.json'), JSON.stringify({ schema: 2, channels: [] }));
    status = [live()];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/proxy/ts/status')) {
          return new Response(JSON.stringify({ channels: status, count: status.length }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // Everything else the worker might reach for during a pass. Empty
        // pages keep it from doing anything while the poller is observed.
        return new Response(JSON.stringify({ count: 0, results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => {
    stop?.();
    stop = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The environment-only config the entrypoint builds.
   *
   * Only the paths are read from it: the worker resolves everything else live,
   * from `process.env` plus the settings table, so anything this test wants the
   * loop to see has to be stored rather than passed here. That is the same
   * reason the dry-run tests store their value.
   */
  const config = () => loadConfig({ PODIUM_DATA_DIR: dir, DISPATCHARR_API_KEY: 'k' });

  const storeSettings = (cfg: ReturnType<typeof loadConfig>, values: Record<string, string>) => {
    const s = new Store(cfg.dbPath);
    s.setSettings(values);
    s.close();
  };

  it('writes a leg when a stream stops serving a session', async () => {
    vi.useFakeTimers();
    const cfg = config();
    storeSettings(cfg, { PODIUM_STABILITY: 'true', PODIUM_STABILITY_POLL_MS: '10000' });
    stop = await startWorker(cfg, () => {});

    // Two polls on one stream, then a third that has failed over to another.
    await vi.advanceTimersByTimeAsync(10_000);
    status = [live({ total_bytes: 5_000_000 })];
    await vi.advanceTimersByTimeAsync(10_000);
    status = [live({ stream_id: 77177, total_bytes: 100 })];
    await vi.advanceTimersByTimeAsync(10_000);

    const store = new Store(cfg.dbPath);
    try {
      const record = store.stabilityRecords().get(77013);
      expect(record?.breaks).toBe(1);
      expect(record?.watchedMs).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('writes the leg still open when the worker stops', async () => {
    vi.useFakeTimers();
    const cfg = config();
    storeSettings(cfg, { PODIUM_STABILITY: 'true', PODIUM_STABILITY_POLL_MS: '10000' });
    stop = await startWorker(cfg, () => {});
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    stop();
    stop = null;

    const store = new Store(cfg.dbPath);
    try {
      // Drained rather than lost. On an install that redeploys often this is
      // most of what the ledger would ever see.
      const legs = store.stabilityLegs(77013);
      expect(legs).toHaveLength(1);
      expect(legs[0]?.ended).toBe('drain');
    } finally {
      store.close();
    }
  });

  it('records nothing at all when the feature is off', async () => {
    vi.useFakeTimers();
    const cfg = config();
    storeSettings(cfg, { PODIUM_STABILITY: 'false', PODIUM_STABILITY_POLL_MS: '10000' });
    stop = await startWorker(cfg, () => {});
    await vi.advanceTimersByTimeAsync(30_000);
    status = [live({ stream_id: 77177 })];
    await vi.advanceTimersByTimeAsync(10_000);

    const store = new Store(cfg.dbPath);
    try {
      expect(store.stabilityLegs()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('mints a token before polling on a username/password install', async () => {
    // The regression: `headers()` sends an empty API key until a token exists,
    // and `request` only *refreshes* a token -- it never mints the first one.
    // A poller that skipped the login would 401 every ten seconds forever on
    // exactly the installs that do not use an API key.
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('/api/accounts/token/')) {
          return new Response(JSON.stringify({ access: 'jwt', refresh: 'r' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/proxy/ts/status')) {
          const auth = new Headers(init?.headers).get('Authorization');
          if (auth !== 'Bearer jwt') return new Response('nope', { status: 401 });
          return new Response(JSON.stringify({ channels: status, count: status.length }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ count: 0, results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    vi.useFakeTimers();
    const cfg = config();
    storeSettings(cfg, {
      PODIUM_STABILITY: 'true',
      PODIUM_STABILITY_POLL_MS: '10000',
      DISPATCHARR_API_KEY: '',
      DISPATCHARR_USERNAME: 'u',
      DISPATCHARR_PASSWORD: 'p',
    });
    stop = await startWorker(cfg, () => {});

    await vi.advanceTimersByTimeAsync(10_000);
    status = [live({ stream_id: 77177 })];
    await vi.advanceTimersByTimeAsync(10_000);

    const store = new Store(cfg.dbPath);
    try {
      // A leg at all means the polls were authorised.
      expect(store.stabilityLegs(77013)).toHaveLength(1);
    } finally {
      store.close();
    }
    // Once per client, not once per poll: a JWT minted every ten seconds
    // forever is its own problem. Counted as "does not grow with the polls"
    // rather than as an absolute, because the pass builds its own client and
    // logs that in too.
    const tokensSoFar = calls.filter((u) => u.includes('/api/accounts/token/')).length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.filter((u) => u.includes('/api/accounts/token/'))).toHaveLength(tokensSoFar);
  });

  it('survives a status endpoint that will not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        if (String(input).includes('/proxy/ts/status')) throw new Error('connection refused');
        return new Response(JSON.stringify({ count: 0, results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    vi.useFakeTimers();
    const cfg = config();
    storeSettings(cfg, { PODIUM_STABILITY: 'true', PODIUM_STABILITY_POLL_MS: '10000' });
    const lines: string[] = [];
    stop = await startWorker(cfg, (m) => lines.push(m));
    await vi.advanceTimersByTimeAsync(30_000);

    // Logged and carried on: a poll that cannot be read costs one sample out
    // of a fortnight, and there is nothing here worth stopping a worker for.
    expect(lines.join('\n')).toContain('session poll failed');
  });
});
