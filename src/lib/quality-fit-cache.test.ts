/**
 * The memoized fit changes database when the database does.
 *
 * `GET /api/quality-profile` memoizes the fit on a stamp of sample count and
 * newest sample time. Two databases can carry the same stamp while holding
 * different samples -- PODIUM_DATA_DIR moving under a long-lived process, a
 * test suite pointing it at one directory after another -- and the stamp
 * alone then served the first database's profile for the second. The path is
 * part of the key, so what is pinned here is a different database with an
 * identical stamp being fitted, not inherited.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/quality-profile/route';
import { Store } from '@/lib/store';

/** Two rows, newest at the same instant in every database: identical stamps. */
function seed(path: string, tier: string): void {
  const store = new Store(path);
  store.close();
  const raw = new Database(path);
  const insert = raw.prepare(
    `INSERT INTO quality_samples
       (provider_id, provider_name, tier, sampled_at, alive, black, bitrate_kbps, measured, height, fps)
     VALUES (1, 'Acme', ?, ?, 0, 1, 8000, 1, 1080, 30)`,
  );
  const newest = 1_700_000_000_000;
  insert.run(tier, newest);
  insert.run(tier, newest - 1_000);
  raw.close();
}

const dirs: string[] = [];

afterEach(() => {
  delete process.env.PODIUM_DATA_DIR;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the quality fit cache', () => {
  it("does not serve one database's fit for another with the same stamp", async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'podium-fit-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'podium-fit-b-'));
    dirs.push(dirA, dirB);
    seed(join(dirA, 'podium.db'), 'sd');
    seed(join(dirB, 'podium.db'), 'hd');

    const get = () => GET(new Request('http://local/api/quality-profile?eventOnly=0&minSamples=1'));

    process.env.PODIUM_DATA_DIR = dirA;
    const first = (await (await get()).json()) as { tiers: Array<{ key: string }> };
    expect(first.tiers.map((tier) => tier.key)).toEqual(['sd']);

    // Same stamp: two samples, newest at the same millisecond. Different file.
    process.env.PODIUM_DATA_DIR = dirB;
    const second = (await (await get()).json()) as { tiers: Array<{ key: string }> };
    expect(second.tiers.map((tier) => tier.key)).toEqual(['hd']);
  });
});
