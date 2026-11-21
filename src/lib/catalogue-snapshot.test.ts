import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergePersistedChannelOrders, updatePersistedChannelOrders } from './catalogue-snapshot';

describe('catalogue snapshot channel orders', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('patches several channel orders in one atomic snapshot update', () => {
    dir = mkdtempSync(join(tmpdir(), 'podium-catalogue-'));
    const path = join(dir, 'catalogue.json');
    const original = {
      fetchedAt: 123,
      channels: [
        { id: 1, name: 'ESPN', streams: [1, 2] },
        { id: 2, name: 'TNT', streams: [3, 4] },
      ],
      streams: [{ id: 1 }],
    };
    writeFileSync(path, JSON.stringify(original));

    expect(
      updatePersistedChannelOrders(path, [
        [1, [2, 1]],
        [2, [4, 3]],
        [3, [9]],
      ]),
    ).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      ...original,
      channels: [
        { id: 1, name: 'ESPN', streams: [2, 1] },
        { id: 2, name: 'TNT', streams: [4, 3] },
      ],
    });
  });

  it('merges external orders only when both snapshots share the same crawl', () => {
    const current = {
      fetchedAt: 123,
      channels: [{ id: 1, streams: [1, 2] }],
    };
    const persisted = {
      fetchedAt: 123,
      channels: [{ id: 1, streams: [2, 1] }],
    };

    expect(mergePersistedChannelOrders(current, persisted)).toBe(true);
    expect(current.channels[0]?.streams).toEqual([2, 1]);

    const newerCrawl = {
      fetchedAt: 456,
      channels: [{ id: 1, streams: [1, 2] }],
    };
    expect(mergePersistedChannelOrders(newerCrawl, persisted)).toBe(false);
    expect(newerCrawl.channels[0]?.streams).toEqual([1, 2]);
  });
});
