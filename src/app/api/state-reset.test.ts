/**
 * The reset route's route-level gate.
 *
 * This was the strongest action on the box behind the weakest protection:
 * a one-channel reorder is refused twice (credentials, then the dry run),
 * while the reset -- nineteen tables in one transaction, no undo -- ran on a
 * bare POST. It now answers to the same dry-run gate as every other write:
 * on an install that is only evaluating, the measured history *is* the
 * evaluation, and a stray click must not be able to throw it away.
 *
 * One directory for the whole file, deliberately: the server-state module
 * holds its settings handle open against the first database path it sees, so
 * a per-test directory would have the second test reading the first test's
 * settings table. The settings *version* is what invalidates its cache, and
 * writing settings between tests changes exactly that.
 */

import type { Database } from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@/lib/store';

describe('POST /api/state/reset', () => {
  let dir: string;
  let store: Store;
  const savedEnv = {
    dataDir: process.env.PODIUM_DATA_DIR,
    rules: process.env.PODIUM_RULES,
    dryRun: process.env.PODIUM_DRY_RUN,
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-reset-route-'));
    writeFileSync(join(dir, 'rules.json'), JSON.stringify({ schema: 2, channels: [] }), 'utf8');
    process.env.PODIUM_DATA_DIR = dir;
    process.env.PODIUM_RULES = join(dir, 'rules.json');
    // `liveConfig` resolves against the real environment; an exported value
    // out here would decide the assertion instead of the stored one.
    delete process.env.PODIUM_DRY_RUN;
  });

  afterAll(() => {
    if (savedEnv.dataDir === undefined) delete process.env.PODIUM_DATA_DIR;
    else process.env.PODIUM_DATA_DIR = savedEnv.dataDir;
    if (savedEnv.rules === undefined) delete process.env.PODIUM_RULES;
    else process.env.PODIUM_RULES = savedEnv.rules;
    if (savedEnv.dryRun === undefined) delete process.env.PODIUM_DRY_RUN;
    else process.env.PODIUM_DRY_RUN = savedEnv.dryRun;
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    store = new Store(join(dir, 'podium.db'));
    // Exactly one piece of pending work, whatever the previous test left.
    (store as unknown as { db: Database }).db.prepare('DELETE FROM soak_requests').run();
    store.queueSoaks([{ streamId: 1, channelId: 11 }], 'manual');
  });

  afterEach(() => {
    store.close();
  });

  const db = (): Database => (store as unknown as { db: Database }).db;
  const soakCount = (): number =>
    (db().prepare('SELECT COUNT(*) AS c FROM soak_requests').get() as { c: number }).c;

  it('is refused while the dry run is on, which is the default', async () => {
    const { POST } = await import('./state/reset/route');
    const response = await POST();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'PODIUM_DRY_RUN is set; refusing to write' });
    // Nothing was deleted: the queue survives the refusal.
    expect(soakCount()).toBe(1);
  });

  it('runs once the dry run is off', async () => {
    // Stored, not exported: the route reads the settings table like every
    // other reader of a settable value.
    store.setSettings({ PODIUM_DRY_RUN: 'false', DISPATCHARR_API_KEY: 'k' });

    const { POST } = await import('./state/reset/route');
    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    // The pending work is gone; the settings are not -- resetData's line.
    expect(soakCount()).toBe(0);
    expect(store.settings().PODIUM_DRY_RUN).toBe('false');
  });
});
