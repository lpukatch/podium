import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ProbeResult } from '@/lib/probe';
import { Store } from '@/lib/store';
import { GET } from './stats/route';

let dir: string;
let previousDataDir: string | undefined;
beforeEach(() => {
  previousDataDir = process.env.PODIUM_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'podium-stats-'));
  process.env.PODIUM_DATA_DIR = dir;
});
afterEach(() => {
  if (previousDataDir === undefined) delete process.env.PODIUM_DATA_DIR;
  else process.env.PODIUM_DATA_DIR = previousDataDir;
  rmSync(dir, { recursive: true, force: true });
});

it('counts radio as healthy while retaining low-bitrate, dead, black, and unknown states', async () => {
  const store = new Store(join(dir, 'podium.db'));
  try {
    store.setSettings({ PODIUM_MIN_BITRATE_KBPS: '500' });
    store.replaceCatalogue(
      [1, 2, 3, 4, 5, 6].map((id) => ({
        channelId: id,
        channelName: `Channel ${id}`,
        slot: 0,
        streamId: id,
        providerId: 1,
        providerName: 'Provider',
      })),
      null,
    );
    const result = {
      alive: true,
      black: false,
      videoCodec: 'h264',
      height: 1080,
      bitrateKbps: 128,
      audioCodec: 'aac',
    } as ProbeResult;
    store.put(1, 'h', result, 0, true);
    store.put(2, 'h', result);
    store.put(3, 'h', { ...result, videoCodec: '', height: 0 });
    store.put(4, 'h', { ...result, alive: false }, 0, true);
    store.put(5, 'h', { ...result, black: true }, 0, true);
  } finally {
    store.close();
  }
  const response = GET();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.streams.states).toEqual({
    alive: 2,
    low_bitrate: 1,
    dead: 1,
    black: 1,
    unmeasured: 1,
  });
  expect(body.primary).toEqual({ total: 6, healthy: 2 });
  expect(body.providers).toEqual([{ name: 'Provider', primary: 6, healthy: 2 }]);
});
