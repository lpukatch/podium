/**
 * Each stream's recent verdicts in one GET.
 *
 * What an entry says about a probe has to be what `/api/verdicts` says about
 * the same probe when it is the latest -- both read `probeFields`, and the
 * comparison below holds them to it, the audio-only exemption included. The
 * rest is the query: which streams, since when, how many each, newest first,
 * and a 400 for anything that is not a whole number.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@/lib/config';
import { DEFAULT_POLICY } from '@/lib/eligibility';
import type { ProbeResult } from '@/lib/probe';
import { PROBE_HISTORY_MS, PROBE_HISTORY_PER_STREAM, Store } from '@/lib/store';

const state = vi.hoisted(() => ({
  snapshot: vi.fn(),
  ordering: vi.fn(),
  config: vi.fn(),
  policies: vi.fn(),
  groupPatterns: () => [],
}));
vi.mock('@/lib/server/state', () => state);

import * as route from '@/app/api/probe-history/route';
import { GET as verdicts } from '@/app/api/verdicts/route';

const SPORTS = 10;
const RADIO = 11;
const A = 201;
const B = 202;
const SHARED = 203;
/** Probed, but on no managed channel: judged against the plain floor. */
const LOOSE = 150;

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

const dead = probe({ alive: false, width: 0, height: 0, bitrateKbps: 0, error: 'timeout' });

type Entry = Record<string, unknown>;
interface Body {
  fetchedAt: number;
  cacheUnavailable: boolean;
  retention: { maxAgeMs: number; perStream: number };
  streams: Array<{ id: number; probes: Entry[] }>;
}

const get = async (query = ''): Promise<{ status: number; body: Body }> => {
  const response = await route.GET(new Request(`http://podium:3456/api/probe-history${query}`));
  return { status: response.status, body: await response.json() };
};

const probesOf = (body: Body, id: number) => body.streams.find((s) => s.id === id)?.probes;

function withStore<T>(fn: (store: Store) => T): T {
  const store = new Store(loadConfig().dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

describe('GET /api/probe-history', () => {
  let dir: string;
  let clock: number;

  beforeEach(() => {
    clock = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    dir = mkdtempSync(join(tmpdir(), 'podium-history-route-'));
    process.env.PODIUM_DATA_DIR = dir;
    state.snapshot.mockResolvedValue({
      fetchedAt: 1_000,
      providers: [{ id: 1, name: 'P' }],
      channels: [
        { id: SPORTS, name: 'Sports One', groupId: 7, streams: [A, SHARED] },
        { id: RADIO, name: 'Radio One', groupId: 8, streams: [SHARED, B] },
      ],
      groups: [
        { id: 7, name: 'Sports' },
        { id: 8, name: 'Radio' },
      ],
      streams: [A, B, SHARED].map((id) => ({ id, name: `S${id}`, providerId: 1, groupId: null })),
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
        providerName: 'P',
      });
      store.replaceCatalogue(
        [row(SPORTS, 0, A), row(SPORTS, 1, SHARED), row(RADIO, 0, SHARED), row(RADIO, 1, B)],
        'run-1',
      );
      // A: alive at 100, sharper at 200, dead at 300.
      store.put(A, 'h', probe());
      store.put(SHARED, 'h', probe());
      store.put(B, 'h', dead);
      clock = 150;
      store.put(LOOSE, 'h', probe({ colorTransfer: undefined, black: true }));
      clock = 200;
      store.put(A, 'h', probe({ bitrateKbps: 9_000, height: 2160, width: 3840 }));
      clock = 300;
      store.put(A, 'h', dead);
    });
    clock = 400;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PODIUM_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists every stream with history, by id, each newest first', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.cacheUnavailable).toBe(false);
    expect(body.fetchedAt).toBe(400);
    expect(body.retention).toEqual({
      maxAgeMs: PROBE_HISTORY_MS,
      perStream: PROBE_HISTORY_PER_STREAM,
    });
    expect(body.streams.map((s) => s.id)).toEqual([LOOSE, A, B, SHARED]);
    expect(probesOf(body, A)?.map((p) => [p.probedAt, p.alive, p.error])).toEqual([
      [300, false, 'timeout'],
      [200, true, null],
      [100, true, null],
    ]);
  });

  it('strips stream URLs and credentials from errors, keeping the raw text stored', async () => {
    const LEAKY = 204;
    const user = 'alice-acct';
    const pass = 's3cr3t-pw';
    const failures = [
      `http://${user}:${pass}@provider.example:8080/live/1234.ts: Server returned 401 Unauthorized`,
      `http://provider.example/live/${user}/${pass}/1234.ts: Connection timed out`,
      `Failed to open http://provider.example/get.php?username=${user}&password=${pass} for reading`,
      `error: username=${user}&password=${pass}`,
    ];
    withStore((store) => {
      for (const [i, error] of failures.entries()) {
        clock = 500 + i;
        store.put(LEAKY, 'h', probe({ ...dead, error }));
      }
    });
    clock = 600;

    const response = await route.GET(
      new Request(`http://podium:3456/api/probe-history?stream=${LEAKY}`),
    );
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(user);
    expect(text).not.toContain(pass);
    expect(text).not.toContain('provider.example');
    expect(probesOf(JSON.parse(text), LEAKY)?.map((p) => p.error)).toEqual([
      'error: username=...&password=...',
      'Failed to open for reading',
      'Connection timed out',
      'Server returned 401 Unauthorized',
    ]);

    // Only the response is scrubbed: storage keeps ffmpeg's words for debugging.
    const stored = withStore((store) => store.probeHistory({ streamIds: [LEAKY], limit: 10 }));
    expect(stored.get(LEAKY)?.map((v) => v.result.error)).toEqual([...failures].reverse());
  });

  // One hash per stream here, so the newest probe is the verdict /api/verdicts
  // shows. (After a hash change it need not be: that fold can prefer an older
  // hash's alive row, which the docs say.)
  it('describes the newest probe exactly as /api/verdicts describes the latest', async () => {
    // No exemption; one carrier of SHARED audio-only (still low, via Sports);
    // every carrier audio-only (not low). The two endpoints must agree on all.
    const audioOnly = { ...DEFAULT_POLICY, audioOnly: true };
    for (const policy of [
      new Map(),
      new Map([[8, audioOnly]]),
      new Map([
        [7, audioOnly],
        [8, audioOnly],
      ]),
    ]) {
      state.policies.mockReturnValue(policy);
      const latest = (await (await verdicts(new Request('http://podium:3456/api/verdicts'))).json())
        .streams as Entry[];
      const { body } = await get();

      for (const verdict of latest) {
        const newest = probesOf(body, verdict.id as number)?.[0];
        expect(newest, `stream ${verdict.id}`).toBeDefined();
        const lastKeys = Object.keys(verdict).filter(
          (key) => key.startsWith('last') && key !== 'lastSoak',
        );
        expect(lastKeys).toContain('lastLowBitrate');
        for (const key of lastKeys) {
          const plain = key.charAt(4).toLowerCase() + key.slice(5);
          expect(newest?.[plain], `${verdict.id}.${plain}`).toEqual(verdict[key]);
        }
      }
    }
  });

  it('judges the floor per channel, and a stream on no channel against the plain floor', async () => {
    state.policies.mockReturnValue(
      new Map([
        [7, { ...DEFAULT_POLICY, audioOnly: true }],
        [8, { ...DEFAULT_POLICY, audioOnly: true }],
      ]),
    );
    const { body } = await get();
    // Every carrier is audio-only: no video floor applies.
    expect(probesOf(body, SHARED)?.[0]?.lowBitrate).toBe(false);
    // 300 kbps under a 500 floor, with no channel to exempt it.
    expect(probesOf(body, LOOSE)?.[0]).toMatchObject({
      lowBitrate: true,
      black: true,
      hdrFormat: null,
      fps: 25,
    });
  });

  it('reads only the streams asked for, repeated or not, and leaves out those with none', async () => {
    const { body } = await get(`?stream=${B}&stream=${A}&stream=${B}&stream=999`);
    expect(body.streams.map((s) => s.id)).toEqual([A, B]);
  });

  it('keeps only probes strictly after `since`', async () => {
    const { body } = await get('?since=150');
    expect(body.streams.map((s) => s.id)).toEqual([A]);
    expect(probesOf(body, A)?.map((p) => p.probedAt)).toEqual([300, 200]);
    expect((await get('?since=300')).body.streams).toEqual([]);

    // A poller passing back `fetchedAt` gets what landed after it.
    clock = 500;
    withStore((store) => store.put(B, 'h', probe()));
    const next = (await get('?since=400')).body;
    expect(next.streams.map((s) => s.id)).toEqual([B]);
    expect(probesOf(next, B)?.map((p) => p.probedAt)).toEqual([500]);
  });

  it('caps the probes per stream at `limit`, keeping the newest', async () => {
    const { body } = await get(`?stream=${A}&limit=2`);
    expect(probesOf(body, A)?.map((p) => p.probedAt)).toEqual([300, 200]);
    expect((await get(`?limit=${PROBE_HISTORY_PER_STREAM}`)).status).toBe(200);
  });

  it('defaults to 20 probes per stream', async () => {
    withStore((store) => {
      for (let i = 0; i < 25; i++) {
        clock = 1_000 + i;
        store.put(A, 'h', probe());
      }
    });
    const { body } = await get(`?stream=${A}`);
    expect(probesOf(body, A)).toHaveLength(20);
    expect(probesOf(body, A)?.[0]?.probedAt).toBe(1_024);
  });

  it('refuses anything that is not a whole number, and too many streams', async () => {
    const bad = {
      stream: ['', 'x', '1,2', '-1', '1.5', '1e3', '99999999999999999999'],
      since: ['', 'yesterday', '-1', '1.5', '1e3'],
      limit: ['', '0', '-1', `${PROBE_HISTORY_PER_STREAM + 1}`, '2.5'],
    };
    for (const [name, values] of Object.entries(bad)) {
      for (const value of values) {
        const query = new URLSearchParams({ [name]: value }).toString();
        const { status, body } = await get(`?${query}`);
        expect(status, query).toBe(400);
        expect(body, query).toHaveProperty('error');
      }
    }

    const many = (n: number) => Array.from({ length: n }, (_, i) => `stream=${i + 1}`).join('&');
    expect((await get(`?${many(500)}`)).status).toBe(200);
    expect((await get(`?${many(501)}`)).status).toBe(400);
  });

  it('still answers when the store cannot be opened, and says so', async () => {
    rmSync(dir, { recursive: true, force: true });
    // A directory where the database should be: the open itself fails.
    mkdirSync(loadConfig().dbPath, { recursive: true });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({ cacheUnavailable: true, streams: [] });
  });

  it('answers a 500 when the snapshot cannot be read', async () => {
    state.snapshot.mockRejectedValue(new Error('Dispatcharr is down'));
    const response = await route.GET(new Request('http://podium:3456/api/probe-history'));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe('Cannot read probe history');
  });

  it('answers GET only', () => {
    expect(route.dynamic).toBe('force-dynamic');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(method in route, method).toBe(false);
    }
  });
});
