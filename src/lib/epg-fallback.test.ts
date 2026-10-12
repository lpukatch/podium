/**
 * The EPG grid's hiccup path.
 *
 * An empty grid already served last-good rows; a fetch that *threw* used to
 * race straight past that fallback and fail the whole pass, discarding the
 * very cache the code was written to be resilient with. What is worth testing
 * here is that a throw lands in the same place an empty result does -- the
 * stale grid -- and that an install with nothing cached comes out the other
 * side with empty rows rather than an exception.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import type { DispatcharrClient } from './dispatcharr';
import { RulesSource } from './rules-source';
import { Runner } from './runner';
import { Store } from './store';

describe('epgRows when the fetch fails', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;
  const logs: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-epg-'));
    const rulesPath = join(dir, 'rules.json');
    const tmp = `${rulesPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ schema: 2, channels: [] }), 'utf8');
    renameSync(tmp, rulesPath);
    store = new Store(join(dir, 'podium.db'));
    logs.length = 0;
    runner = new Runner({
      log: (m) => logs.push(m),
      config: () => loadConfig({ PODIUM_DATA_DIR: dir, DISPATCHARR_API_KEY: 'k' }),
      store,
      rules: new RulesSource(rulesPath),
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** `epgRows` is private; reach it directly, as the pass would. */
  const call = (client: DispatcharrClient) =>
    (
      runner as unknown as {
        epgRows: (
          c: DispatcharrClient,
          config: ReturnType<typeof loadConfig>,
        ) => Promise<{ rows: unknown[]; expiresAt: number | null }>;
      }
    ).epgRows(
      client,
      loadConfig({
        PODIUM_DATA_DIR: dir,
        DISPATCHARR_API_KEY: 'k',
        // Zero: every call refetches, so the tests drive the failure paths
        // rather than watching a fresh cache answer from memory.
        PODIUM_EPG_TTL_MS: '0',
      }),
    );

  it('serves the last good grid when the fetch throws', async () => {
    const rows = [{ title: 'Live event', start: 1 }];
    const flaky = {
      epgWindow: vi
        .fn<DispatcharrClient['epgWindow']>()
        .mockResolvedValueOnce(rows)
        .mockRejectedValueOnce(new Error('connection refused')),
    } as unknown as DispatcharrClient;

    await call(flaky); // primes the cache with a good grid
    const second = await call(flaky);

    expect(second.rows).toEqual(rows);
    expect(logs.join('\n')).toContain('epg fetch failed');
  });

  it('answers with empty rows, not a throw, when nothing is cached either', async () => {
    const refusing = {
      epgWindow: vi.fn<DispatcharrClient['epgWindow']>().mockRejectedValue(new Error('timeout')),
    } as unknown as DispatcharrClient;

    // A fresh install has no last-good grid to fall back to; the pass must
    // still go on -- channels held back for want of EPG, not a failed pass.
    await expect(call(refusing)).resolves.toEqual({ rows: [], expiresAt: null });
  });

  it('still serves a good grid when the fetch works', async () => {
    const rows = [{ title: 'Now airing' }];
    const healthy = {
      epgWindow: vi.fn<DispatcharrClient['epgWindow']>().mockResolvedValue(rows),
    } as unknown as DispatcharrClient;

    expect((await call(healthy)).rows).toEqual(rows);
  });
});
