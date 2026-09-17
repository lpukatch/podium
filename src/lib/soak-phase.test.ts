/**
 * The soak phase, end to end through a real pass.
 *
 * Every bug the soak has shipped so far lived here, in the wiring between the
 * queue, the lanes and the ledger, where the pure helpers could not see it.
 * This drives `Runner.runOnce` against a stubbed Dispatcharr and a scripted
 * `soakStream`, so what is asserted is what a pass actually does: how many
 * soaks it runs at once, how long it rests between them, and what it writes
 * when an account starts closing connections as fast as it opens them.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import type { SoakResult } from './probe';
import { RulesSource } from './rules-source';
import { Runner } from './runner';
import { Store } from './store';

type SoakOptions = {
  seconds?: number;
  minGapMs?: number;
  onConnect?: (at: number) => void;
  stop?: () => boolean;
};

/** What the scripted soak does, set per test. */
const script = vi.hoisted(() => ({
  run: async (_url: string, _options: SoakOptions): Promise<SoakResult> => ({
    legs: [],
    heldMs: 0,
    drops: 0,
    failedDials: 0,
    unreachable: false,
    stopped: false,
  }),
}));

vi.mock('./probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./probe')>();
  return {
    ...actual,
    soakStream: (url: string, options: SoakOptions) => script.run(url, options),
  };
});

const ACCOUNT = 7;
const STREAMS = [101, 102, 103, 104, 105, 106];

describe('the soak phase', () => {
  let dir: string;
  let store: Store;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-soak-phase-'));
    store = new Store(join(dir, 'podium.db'));
    const tmp = join(dir, 'rules.json.tmp');
    writeFileSync(tmp, JSON.stringify({ schema: 2, defaults: {}, channels: [] }), 'utf8');
    renameSync(tmp, join(dir, 'rules.json'));

    // One account selling five connections, nobody watching, six streams.
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/accounts/token/')
        ? { access: 'a', refresh: 'r' }
        : url.includes('/proxy/ts/status')
          ? { channels: [], count: 0 }
          : url.includes('/m3u/accounts/')
            ? {
                count: 1,
                next: null,
                results: [
                  {
                    id: ACCOUNT,
                    name: 'Provider B',
                    max_streams: 5,
                    profiles: [{ id: 70, name: 'Default', is_default: true, is_active: true }],
                  },
                ],
              }
            : url.includes('/channels/streams/')
              ? {
                  count: STREAMS.length,
                  next: null,
                  results: STREAMS.map((id) => ({
                    id,
                    name: `Stream ${id}`,
                    url: `http://provider.example/live/${id}.ts`,
                    m3u_account: ACCOUNT,
                    stream_hash: `h${id}`,
                  })),
                }
              : { count: 0, next: null, results: [] };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as unknown as typeof fetch;

    store.queueSoaks(STREAMS.map((streamId) => ({ streamId })));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const runner = (env: Record<string, string>, log: (m: string) => void = () => {}) =>
    new Runner({
      log,
      config: () =>
        loadConfig({
          PODIUM_DATA_DIR: dir,
          DISPATCHARR_API_KEY: 'k',
          PODIUM_SOAK_SECONDS: '10',
          PODIUM_MIN_FREE_SLOTS: '0',
          ...env,
        }),
      store,
      rules: new RulesSource(join(dir, 'rules.json')),
    });

  const clean = (heldMs = 10_000): SoakResult => ({
    legs: [{ startedAt: Date.now(), heldMs, dropped: false, failedDial: false, error: '' }],
    heldMs,
    drops: 0,
    failedDials: 0,
    unreachable: false,
    stopped: false,
  });

  it('leaves a connection spare on the account', async () => {
    // Five connections, so four soaks at once. The account used to be run at
    // exactly its limit, which is where a provider's lingering count tips over.
    let running = 0;
    let peak = 0;
    script.run = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 30));
      running--;
      return clean();
    };
    await runner({ PODIUM_SOAK_COOLDOWN_MS: '0' }).runOnce();
    expect(peak).toBe(4);
  });

  it('runs at the full limit when told to leave nothing spare', async () => {
    let running = 0;
    let peak = 0;
    script.run = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 30));
      running--;
      return clean();
    };
    await runner({ PODIUM_SOAK_COOLDOWN_MS: '0', PODIUM_SOAK_SPARE_SLOTS: '0' }).runOnce();
    expect(peak).toBe(5);
  });

  it('rests before connecting, and hands the soak its cooldown', async () => {
    // Resting before rather than after also covers the first soak of a phase,
    // whose slot the probe lanes were using a moment earlier.
    const startedAt = Date.now();
    const gaps: number[] = [];
    const firstAt: number[] = [];
    script.run = async (_url, options) => {
      firstAt.push(Date.now() - startedAt);
      gaps.push(options.minGapMs ?? -1);
      return clean();
    };
    await runner({ PODIUM_SOAK_COOLDOWN_MS: '200' }).runOnce();
    expect(Math.min(...firstAt)).toBeGreaterThanOrEqual(200);
    expect(gaps.every((gap) => gap === 200)).toBe(true);
  });

  it('records genuine drops and spends the requests', async () => {
    // One soak at a time on this account, so no drop can coincide with another
    // soak connecting.
    script.run = async (_url, options) => {
      const at = Date.now();
      options.onConnect?.(at);
      return {
        legs: [{ startedAt: at, heldMs: 5_000, dropped: true, failedDial: false, error: 'eof' }],
        heldMs: 5_000,
        drops: 1,
        failedDials: 0,
        unreachable: false,
        stopped: false,
      };
    };
    await runner({ PODIUM_SOAK_COOLDOWN_MS: '0', PODIUM_SOAK_SPARE_SLOTS: '4' }).runOnce();
    const records = store.stabilityRecords();
    expect([...records.values()].reduce((sum, r) => sum + r.breaks, 0)).toBeGreaterThan(0);
    expect(store.pendingSoakCount().total).toBeLessThan(STREAMS.length);
    expect(store.soakResults(STREAMS).get(STREAMS[0]!)).toMatchObject({
      heldMs: 5_000,
      drops: 1,
      failedDials: 0,
      unreachable: false,
    });
  });

  it('keeps a soak queued when even one of its drops was the account making room', async () => {
    // Two soaks at once; only the second is cut off, just after the first
    // connects. Not enough to trip the account -- but that soak still was not
    // a measurement of its stream, so it must not be spent.
    let calls = 0;
    script.run = async (_url, options) => {
      const mine = ++calls;
      const at = Date.now();
      options.onConnect?.(at);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const dropped = mine === 2;
      return {
        legs: [{ startedAt: at, heldMs: Date.now() - at, dropped, failedDial: false, error: '' }],
        heldMs: Date.now() - at,
        drops: dropped ? 1 : 0,
        failedDials: 0,
        unreachable: false,
        stopped: false,
      };
    };
    await runner({ PODIUM_SOAK_COOLDOWN_MS: '0', PODIUM_SOAK_SPARE_SLOTS: '3' }).runOnce();
    // The cut-off soak's stream is still waiting; nothing was charged to it.
    expect(store.pendingSoaks().map((row) => row.streamId)).toContain(STREAMS[1]);
    expect([...store.stabilityRecords().values()].every((r) => r.breaks === 0)).toBe(true);
  });

  it('stops soaking an account that closes soaks as fast as they open', async () => {
    // The Provider B signature: each soak is dropped moments after another
    // soak on the same account connects. None of it is evidence about the
    // streams, so nothing is written, the requests stay queued, and the
    // operator is told.
    const lines: string[] = [];
    script.run = async (_url, options) => {
      const at = Date.now();
      options.onConnect?.(at);
      // Long enough for the other soaks in flight to have connected too.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        legs: [
          { startedAt: at, heldMs: Date.now() - at, dropped: true, failedDial: false, error: '' },
        ],
        heldMs: Date.now() - at,
        drops: 1,
        failedDials: 0,
        unreachable: false,
        stopped: options.stop?.() ?? false,
      };
    };
    await runner({ PODIUM_SOAK_COOLDOWN_MS: '0' }, (m) => lines.push(m)).runOnce();

    expect(store.stabilityLegs()).toEqual([]);
    expect(store.pendingSoakCount().total).toBe(STREAMS.length);
    expect(store.soakResults(STREAMS)).toEqual(new Map());
    expect(lines.join('\n')).toContain('soaks are being closed as fast as new ones open');
  });
});
