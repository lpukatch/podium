/**
 * The whole catalogue's cached verdicts in one GET.
 *
 * What it says about a stream has to be what `/api/preview` says about the
 * same stream on one channel -- both read `lastProbeFields` over
 * `Store.verdicts()`, and the comparison below holds them to it across
 * variants and a stale hash. Only `lastLowBitrate` may differ, for a stream on
 * several channels, and that has a test of its own. The rest
 * is the shape: slot order per channel, each stream once however many channels
 * carry it, nulls for what is not known, and a catalogue that still answers
 * when the probe cache cannot be read.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@/lib/config';
import { DEFAULT_POLICY } from '@/lib/eligibility';
import type { ProbeResult, SoakResult } from '@/lib/probe';
import { Store } from '@/lib/store';

const state = vi.hoisted(() => ({
  snapshot: vi.fn(),
  index: vi.fn(),
  matcher: vi.fn(),
  ordering: vi.fn(),
  config: vi.fn(),
  policies: vi.fn(),
  groupPatterns: () => [],
}));
vi.mock('@/lib/server/state', () => state);

import { POST as preview } from '@/app/api/preview/route';
import * as route from '@/app/api/verdicts/route';

const SPORTS = 10;
const RADIO = 11;
const A = 201;
const B = 202;
const SHARED = 203;
const UNPROBED = 204;
const GONE = 205;

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    alive: true,
    width: 1920,
    height: 1080,
    fps: 50,
    bitrateKbps: 300,
    videoCodec: 'hevc',
    audioCodec: 'eac3',
    pixelFormat: 'yuv420p10le',
    audioChannels: 6,
    channelLayout: '5.1(side)',
    audioBitrateKbps: 384,
    audioSampleRate: 48_000,
    elapsedMs: 100,
    error: '',
    black: false,
    // Interlaced, coded as fields: ffprobe says 50, a viewer gets 25.
    fieldOrder: 'tt',
    colorTransfer: 'smpte2084',
    ...over,
  };
}

const soak = (over: Partial<SoakResult> = {}): SoakResult => ({
  legs: [],
  heldMs: 180_000,
  drops: 0,
  failedDials: 1,
  unreachable: false,
  stopped: false,
  ...over,
});

const dead = probe({ alive: false, width: 0, height: 0, bitrateKbps: 0, error: 'timeout' });

type Row = Record<string, unknown>;
interface Body {
  fetchedAt: number;
  catalogueWrittenAt: number | null;
  cacheUnavailable: boolean;
  groups: Array<{ id: number; name: string }>;
  channels: Array<{ id: number; name: string; groupId: number | null; streams: number[] }>;
  streams: Row[];
}

const get = async (query = ''): Promise<{ status: number; body: Body }> => {
  const response = await route.GET(new Request(`http://podium:3456/api/verdicts${query}`));
  return { status: response.status, body: await response.json() };
};

const byId = (body: Body, id: number) => body.streams.find((s) => s.id === id);

function withStore<T>(fn: (store: Store) => T): T {
  const store = new Store(loadConfig().dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

describe('GET /api/verdicts', () => {
  let dir: string;
  // Every verdict lands at 100 and the soak at 200, so `?since` has fixed
  // moments to cut between rather than whatever millisecond the test ran in.
  let clock: number;

  beforeEach(() => {
    clock = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    dir = mkdtempSync(join(tmpdir(), 'podium-verdicts-'));
    process.env.PODIUM_DATA_DIR = dir;
    state.snapshot.mockResolvedValue({
      fetchedAt: 1_000,
      providers: [{ id: 1, name: 'P' }],
      channels: [
        { id: SPORTS, name: 'Sports One', groupId: 7, streams: [A, SHARED, UNPROBED, GONE] },
        { id: RADIO, name: 'Radio One', groupId: 8, streams: [SHARED, B] },
      ],
      groups: [
        { id: 7, name: 'Sports' },
        { id: 8, name: 'Radio' },
        { id: 99, name: 'UK | Sport' },
      ],
      // GONE has left the provider since the catalogue was written.
      streams: [A, B, SHARED, UNPROBED].map((id) => ({
        id,
        name: `S${id}`,
        providerId: 1,
        groupId: id === A ? 99 : null,
      })),
    });
    state.index.mockResolvedValue({ normalized: new Map() });
    state.matcher.mockReturnValue({
      rules: new Map(),
      normalize: (name: string) => ({ name, prefixes: [], quality: null }),
      match: () => [],
    });
    state.ordering.mockReturnValue({ mode: 'quality', providerPreference: [], weights: {} });
    state.config.mockReturnValue({ PODIUM_MIN_BITRATE_KBPS: 500 });
    state.policies.mockReturnValue(new Map());

    withStore((store) => {
      const row = (channelId: number, slot: number, streamId: number) => ({
        channelId,
        channelName: channelId === SPORTS ? 'Sports One' : 'Radio One',
        slot,
        streamId,
        providerId: 1,
        providerName: 'P (catalogue)',
      });
      // Written out of order: the response's order must come from the slots.
      store.replaceCatalogue(
        [
          row(RADIO, 1, B),
          row(SPORTS, 3, GONE),
          row(SPORTS, 2, UNPROBED),
          row(SPORTS, 1, SHARED),
          row(RADIO, 0, SHARED),
          row(SPORTS, 0, A),
        ],
        'run-1',
      );
      // A: two logins that disagree, plus a row under a hash the stream has
      // since moved on from.
      store.put(A, 'old', probe({ bitrateKbps: 9_000, height: 2160, width: 3840 }), 0);
      store.put(A, 'new', dead, 0);
      store.put(A, 'new', probe({ bitrateKbps: 6_400, colorTransfer: undefined }), 1);
      store.put(SHARED, 'h', probe());
      store.put(B, 'h', dead);
      store.put(B, 'h', dead);
      store.put(GONE, 'h', probe({ bitrateKbps: 0 }));
      clock = 200;
      store.recordSoakResult(SHARED, soak());
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PODIUM_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists each channel in slot order, and each stream once however many channels carry it', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.cacheUnavailable).toBe(false);
    expect(body.fetchedAt).toBe(1_000);
    expect(body.catalogueWrittenAt).toEqual(expect.any(Number));
    expect(body.channels).toEqual([
      { id: SPORTS, name: 'Sports One', groupId: 7, streams: [A, SHARED, UNPROBED, GONE] },
      { id: RADIO, name: 'Radio One', groupId: 8, streams: [SHARED, B] },
    ]);
    expect(body.streams.map((s) => s.id).sort()).toEqual([A, B, SHARED, UNPROBED, GONE].sort());
    // Only the groups the channels sit in, not every provider group.
    expect(body.groups).toEqual([
      { id: 7, name: 'Sports' },
      { id: 8, name: 'Radio' },
    ]);
  });

  it('only lists the catalogue, not every stream the snapshot holds', async () => {
    const snap = await state.snapshot();
    state.snapshot.mockResolvedValue({
      ...snap,
      streams: [...snap.streams, { id: 999, name: 'unmanaged', providerId: 1, groupId: null }],
    });
    const { body } = await get();
    expect(byId(body, 999)).toBeUndefined();
  });

  it('describes a stream exactly as /api/preview does, across logins and a stale hash', async () => {
    const response = await preview(
      new Request('http://podium:3456/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: SPORTS }),
      }),
    );
    const previewRows = (await response.json()).currentOrder as Row[];
    const { body } = await get();
    // Everything the snapshot still has: A, SHARED and UNPROBED.
    expect(previewRows.map((row) => row.id)).toEqual([A, SHARED, UNPROBED]);

    const shared = Object.keys(previewRows[0] ?? {}).filter(
      (key) => key.startsWith('last') || key === 'provider' || key === 'providerGroup',
    );
    expect(shared).toContain('lastLowBitrate');
    expect(shared).toContain('lastSoak');
    for (const row of previewRows) {
      const mine = byId(body, row.id as number);
      for (const key of shared) expect(mine?.[key], `${row.id}.${key}`).toEqual(row[key]);
    }
    // And the fold is the one that prefers the working login to the dead one.
    expect(byId(body, A)).toMatchObject({ lastAlive: true });
  });

  it('carries the probe, the dead streak and the soak', async () => {
    const { body } = await get();
    // `verdicts()` folds every row it holds for a stream, a hash the stream
    // has moved on from included, so the stale 4K row wins here -- as it does
    // on /api/preview, which the comparison above holds this to.
    expect(byId(body, A)).toMatchObject({
      name: `S${A}`,
      provider: 'P',
      providerGroup: 'UK | Sport',
      lastAlive: true,
      lastHeight: 2160,
      lastBitrateKbps: 9_000,
      lastFps: 25,
      lastHdrFormat: 2,
      lastLowBitrate: false,
      deadStreak: 0,
      lastSoak: null,
    });
    expect(byId(body, B)).toMatchObject({ lastAlive: false, deadStreak: 2 });
    expect(byId(body, SHARED)).toMatchObject({
      lastBitrateKbps: 300,
      lastLowBitrate: true,
      lastSoak: { completedAt: 200, heldMs: 180_000, drops: 0, failedDials: 1, unreachable: false },
    });
  });

  it('reads a streak of 0 beside an alive verdict, whichever hash supplied it', async () => {
    // B is dead twice under its current hash; an older hash's alive row wins
    // the fold `verdicts()` makes, while `deadStreaks` reads the current hash.
    clock = 50;
    withStore((store) => store.put(B, 'older', probe()));
    const { body } = await get();
    expect(byId(body, B)).toMatchObject({ lastAlive: true, deadStreak: 0 });
  });

  it('is null for what is not known', async () => {
    const { body } = await get();
    const unprobed = byId(body, UNPROBED);
    for (const key of Object.keys(unprobed ?? {}).filter((k) => k.startsWith('last'))) {
      expect(unprobed?.[key], key).toBeNull();
    }
    expect(unprobed?.deadStreak).toBeNull();
    // Gone from the snapshot: no name or group to give, but the catalogue
    // still knows which provider it came from.
    expect(byId(body, GONE)).toMatchObject({
      name: null,
      providerGroup: null,
      provider: 'P (catalogue)',
      lastAlive: true,
    });
  });

  it('calls a shared stream low when any channel carrying it would', async () => {
    state.policies.mockReturnValue(new Map([[8, { ...DEFAULT_POLICY, audioOnly: true }]]));
    const { body } = await get();
    // Under the floor on Sports; Radio, audio-only, would not judge it.
    expect(byId(body, SHARED)?.lastLowBitrate).toBe(true);

    state.policies.mockReturnValue(
      new Map([
        [7, { ...DEFAULT_POLICY, audioOnly: true }],
        [8, { ...DEFAULT_POLICY, audioOnly: true }],
      ]),
    );
    expect(byId((await get()).body, SHARED)?.lastLowBitrate).toBe(false);
  });

  it('still answers when the store cannot be opened, and says so', async () => {
    rmSync(dir, { recursive: true, force: true });
    // A directory where the database should be: the open itself fails.
    mkdirSync(loadConfig().dbPath, { recursive: true });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      fetchedAt: 1_000,
      catalogueWrittenAt: null,
      cacheUnavailable: true,
      channels: [],
      streams: [],
    });
  });

  it('keeps the catalogue when only the verdict read fails', async () => {
    vi.spyOn(Store.prototype, 'verdicts').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.cacheUnavailable).toBe(true);
    expect(body.channels).toHaveLength(2);
    expect(byId(body, A)).toMatchObject({ lastAlive: null, deadStreak: null, lastSoak: null });
  });

  it('answers a 500 when the snapshot cannot be read', async () => {
    state.snapshot.mockRejectedValue(new Error('Dispatcharr is down'));
    const response = await route.GET(new Request('http://podium:3456/api/verdicts'));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe('Cannot read verdicts');
  });

  describe('?since', () => {
    it('keeps only streams probed or soaked after it, and every channel', async () => {
      const ids = async (since: number) =>
        (await get(`?since=${since}`)).body.streams.map((s) => s.id).sort();

      // Probed at 100: everything probed, nothing unprobed.
      expect(await ids(99)).toEqual([A, B, SHARED, GONE].sort());
      // Only SHARED's soak, at 200, is later than 150.
      expect(await ids(150)).toEqual([SHARED]);
      // Strictly after: nothing changed after 200.
      const { body } = await get('?since=200');
      expect(body.streams).toEqual([]);
      expect(body.channels).toHaveLength(2);

      clock = 300;
      withStore((store) => store.put(B, 'h', probe()));
      expect(await ids(250)).toEqual([B]);
    });

    it('refuses anything that is not epoch milliseconds', async () => {
      for (const bad of ['', 'yesterday', '-1', '1.5', '1e3', '99999999999999999999']) {
        expect((await get(`?since=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
      }
    });
  });

  it('answers GET only', () => {
    expect(route.dynamic).toBe('force-dynamic');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(method in route, method).toBe(false);
    }
  });
});
