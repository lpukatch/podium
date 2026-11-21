import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishCatalogueSnapshot, replayCatalogueOrders } from './catalogue-snapshot';
import { DispatcharrClient } from './dispatcharr';
import { noteStreamOrder, snapshot } from './server/state';
import { Store } from './store';

describe('catalogue snapshot channel orders', () => {
  let dir: string;
  let path: string;
  let worker: Store;
  let web: Store;

  const channels = () => [
    { id: 1, name: 'ESPN', tvgId: '', isRadio: false, groupId: null, streams: [1, 2] },
    { id: 2, name: 'TNT', tvgId: '', isRadio: false, groupId: null, streams: [3, 4] },
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-catalogue-'));
    path = join(dir, 'catalogue.json');
    const dbPath = join(dir, 'podium.db');
    worker = new Store(dbPath);
    web = new Store(dbPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    worker.close();
    web.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serializes file publication and keeps the latest order per channel across writers', () => {
    const original = { fetchedAt: 123, channels: channels(), streams: [{ id: 1 }] };
    writeFileSync(path, JSON.stringify(original));

    // A second process cannot start its read-modify-write while the first
    // owns publication, even before the first issues any SQL writes.
    const other = new Database(join(dir, 'podium.db'), { timeout: 0 });
    try {
      worker.withCatalogueSnapshotWrite(() => {
        expect(() => other.transaction(() => {}).immediate()).toThrow(/database is locked/);
      });
    } finally {
      other.close();
    }

    worker.recordCatalogueOrder(1, [1, 2, 5]);
    worker.recordCatalogueOrder(2, [4, 3]);
    web.recordCatalogueOrder(1, []);
    publishCatalogueSnapshot(path, web);
    publishCatalogueSnapshot(path, worker); // A delayed worker flush must not undo the UI.

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      ...original,
      orderRevision: 3,
      channels: [
        { ...original.channels[0], streams: [] },
        { ...original.channels[1], streams: [4, 3] },
      ],
    });
  });

  it('keeps a crawl’s fresh orders over changes recorded before it started', () => {
    web.recordCatalogueOrder(1, [2, 1]);
    const current = {
      fetchedAt: 456,
      orderRevision: web.catalogueOrderRevision(),
      channels: channels(),
    };
    expect(replayCatalogueOrders(current, web)).toBe(false);
    expect(current.channels[0]?.streams).toEqual([1, 2]);
  });

  it('preserves worker and web writes across an in-flight refresh', async () => {
    vi.stubEnv('PODIUM_DATA_DIR', dir);
    vi.stubEnv('DISPATCHARR_API_KEY', 'test');
    const initial = {
      fetchedAt: Date.now() - 1,
      channels: channels(),
      streams: [],
      providers: [],
      groups: [],
    };
    writeFileSync(path, JSON.stringify(initial));
    await snapshot();

    vi.spyOn(DispatcharrClient.prototype, 'login').mockResolvedValue(undefined);
    vi.spyOn(DispatcharrClient.prototype, 'providers').mockResolvedValue([]);
    vi.spyOn(DispatcharrClient.prototype, 'groups').mockResolvedValue([]);
    vi.spyOn(DispatcharrClient.prototype, 'channels').mockImplementation(async () => {
      const staleOrders = channels();
      worker.recordCatalogueOrder(1, [2, 1]); // Still waiting for its pass-end flush.
      noteStreamOrder(2, [4, 3], path);
      return staleOrders;
    });
    vi.spyOn(DispatcharrClient.prototype, 'streams').mockResolvedValue([]);

    const refreshed = await snapshot(true);
    expect(refreshed.channels.map((channel) => channel.streams)).toEqual([
      [2, 1],
      [4, 3],
    ]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(refreshed);

    worker.recordCatalogueOrder(1, [1, 2]);
    expect((await snapshot()).channels[0]?.streams).toEqual([1, 2]);
  });
});
