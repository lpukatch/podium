/**
 * What the editor is told about a stream's last probe, without probing again.
 *
 * Every field is read from the cached verdict, and every one is `null` for a
 * stream nothing has probed yet, so the UI can tell "unknown" from a value.
 * Two of them are derived rather than copied, and those must give the same
 * answer as the code they were derived from: `lastFps` is what statsPayload
 * publishes as `source_fps`, and `lastLowBitrate` uses the same floor as the
 * health check, which is the floor the channel is actually ranked under.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@/lib/config';
import { DEFAULT_POLICY } from '@/lib/eligibility';
import type { ProbeResult } from '@/lib/probe';
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

import { POST } from '@/app/api/preview/route';

const PROBED = 101;
const UNPROBED = 102;
const UNMEASURED = 103;

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

type Row = Record<string, unknown>;

const currentOrder = async (): Promise<Row[]> => {
  const response = await POST(
    new Request('http://podium:3456/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: 12 }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()).currentOrder;
};

describe('preview currentOrder exposes the last probe', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-preview-probe-'));
    process.env.PODIUM_DATA_DIR = dir;
    state.snapshot.mockResolvedValue({
      providers: [{ id: 1, name: 'P' }],
      channels: [{ id: 12, name: 'C', groupId: 7, streams: [PROBED, UNPROBED, UNMEASURED] }],
      groups: [],
      streams: [PROBED, UNPROBED, UNMEASURED].map((id) => ({
        id,
        name: `S${id}`,
        providerId: 1,
        groupId: null,
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

    const store = new Store(loadConfig().dbPath);
    try {
      store.put(PROBED, 'h', probe());
      store.put(UNMEASURED, 'h', probe({ bitrateKbps: 0, colorTransfer: undefined }));
    } finally {
      store.close();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PODIUM_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('carries the rest of the stored result for a probed stream', async () => {
    const [row] = await currentOrder();
    expect(row).toMatchObject({
      id: PROBED,
      lastWidth: 1920,
      lastHeight: 1080,
      // The honest rate, as source_fps publishes it -- not the raw 50.
      lastFps: 25,
      lastVideoCodec: 'hevc',
      lastHdrFormat: 2,
      lastAudioCodec: 'eac3',
      lastAudioChannels: 6,
      lastChannelLayout: '5.1(side)',
      lastAudioBitrateKbps: 384,
      lastAudioSampleRate: 48_000,
      lastBitrateKbps: 300,
      lastLowBitrate: true,
    });
  });

  it('is null across the board for a stream nothing has probed', async () => {
    const row = (await currentOrder()).find((r) => r.id === UNPROBED);
    for (const key of [
      'lastWidth',
      'lastFps',
      'lastVideoCodec',
      'lastHdrFormat',
      'lastAudioCodec',
      'lastAudioChannels',
      'lastChannelLayout',
      'lastAudioBitrateKbps',
      'lastAudioSampleRate',
      'lastLowBitrate',
    ]) {
      expect(row?.[key], key).toBeNull();
    }
  });

  it('does not call an unmeasured bitrate low, nor an undeclared transfer SDR', async () => {
    const row = (await currentOrder()).find((r) => r.id === UNMEASURED);
    expect(row?.lastLowBitrate).toBe(false);
    expect(row?.lastHdrFormat).toBeNull();
  });

  it('judges the bitrate against the floor the ranking uses, rules-file override included', async () => {
    // The env knob says 500 and 300 is under it; a rules-file floor of 200 wins.
    state.ordering.mockReturnValue({
      mode: 'quality',
      providerPreference: [],
      weights: { minBitrateKbps: 200 },
    });
    const [row] = await currentOrder();
    expect(row?.lastLowBitrate).toBe(false);
  });

  it('does not apply a video floor on an audio-only channel, as the health check does not', async () => {
    state.policies.mockReturnValue(new Map([[7, { ...DEFAULT_POLICY, audioOnly: true }]]));
    const [row] = await currentOrder();
    expect(row?.lastBitrateKbps).toBe(300);
    expect(row?.lastLowBitrate).toBe(false);
  });
});
