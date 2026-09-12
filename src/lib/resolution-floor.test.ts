/**
 * Minimum resolution: what a channel should lead with.
 *
 * Ranking alone hands slot 0 to whatever scores best, and a generous bitrate at
 * a lower resolution wins that outright -- a 720p50 feed at 12Mbps beats a
 * 1080p25 one at 3Mbps. The floor is the operator saying which of those they
 * actually want first.
 *
 * The distinction these pin is that below the floor is not the same as broken.
 * A sub-floor stream sinks and is never assigned, but it still plays, so it
 * ranks ahead of the dead and keeps its order against other sub-floor streams --
 * which is what stops a floor from flattening a channel where nothing clears it.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import type { Channel, DispatcharrClient, Stream } from './dispatcharr';
import { ALWAYS, parseGroupPatterns, parsePolicies } from './eligibility';
import { withResolutionFloor } from './ordering';
import type { ProbeResult } from './probe';
import { parseMinResolution, resolveResolutionFloor } from './resolution';
import { loadRules } from './rules';
import { RulesSource } from './rules-source';
import { type PlannedChannel, Runner } from './runner';
import {
  DEFAULT_STRATEGY,
  DEFAULT_WEIGHTS,
  isHealthy,
  isUsable,
  meetsResolutionFloor,
  type RankEntry,
  rank,
  score,
} from './scoring';
import { Store } from './store';
import { pickBestVariant } from './variants';

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    alive: true,
    width: 1920,
    height: 1080,
    fps: 50,
    bitrateKbps: 8000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    pixelFormat: 'yuv420p',
    audioChannels: 2,
    channelLayout: 'stereo',
    audioBitrateKbps: 128,
    audioSampleRate: 48_000,
    elapsedMs: 100,
    error: '',
    ...over,
  };
}

function entry(streamId: number, result: ProbeResult, over: Partial<RankEntry> = {}): RankEntry {
  return { streamId, stepOrder: 0, providerId: 1, result, ...over };
}

const FHD = { weights: { ...DEFAULT_WEIGHTS, minResolution: '1080p' as const } };

/** The pair that motivates the feature: the better-scoring stream is the smaller one. */
const hd720 = probe({ width: 1280, height: 720, fps: 50, bitrateKbps: 12_000 });
const fhd1080 = probe({ width: 1920, height: 1080, fps: 25, bitrateKbps: 3000 });

describe('reading a floor', () => {
  it('takes the resolutions it offers, however they are written', () => {
    expect(parseMinResolution('1080p')).toBe('1080p');
    expect(parseMinResolution('1080')).toBe('1080p');
    expect(parseMinResolution(' 720P ')).toBe('720p');
    expect(parseMinResolution('4k')).toBe('2160p');
  });

  it('tells "no floor" apart from "not set here"', () => {
    // The whole reason a channel can override its group: `none` has to mean
    // something different from saying nothing at all.
    expect(parseMinResolution('none')).toBeNull();
    expect(parseMinResolution('inherit')).toBeUndefined();
    expect(parseMinResolution(undefined)).toBeUndefined();
    expect(parseMinResolution(null)).toBeUndefined();
    expect(parseMinResolution('')).toBeUndefined();
  });

  it('ignores a value nobody could have meant, rather than failing the load', () => {
    expect(parseMinResolution('1440p')).toBeUndefined();
    expect(parseMinResolution('yes')).toBeUndefined();
  });

  it('lets a channel raise, lower or clear its group floor', () => {
    expect(resolveResolutionFloor(undefined, '1080p')).toBe('1080p');
    expect(resolveResolutionFloor('2160p', '1080p')).toBe('2160p');
    expect(resolveResolutionFloor('720p', '1080p')).toBe('720p');
    expect(resolveResolutionFloor(null, '1080p')).toBeUndefined();
    expect(resolveResolutionFloor(undefined, undefined)).toBeUndefined();
  });

  it('reads a group policy and a name pattern', () => {
    const groups = parsePolicies({
      '7': { mode: ALWAYS, min_resolution: '1080p' },
      '8': { mode: ALWAYS, min_resolution: 'none' },
      '9': { mode: ALWAYS },
    });
    expect(groups.get(7)?.minResolution).toBe('1080p');
    // A group has no wider floor to opt out of, so `none` is just no floor.
    expect(groups.get(8)?.minResolution).toBeUndefined();
    expect(groups.get(9)?.minResolution).toBeUndefined();

    const patterns = parseGroupPatterns([
      { pattern: 'Auto | *', mode: ALWAYS, min_resolution: '720p' },
    ]);
    expect(patterns[0]?.minResolution).toBe('720p');
  });

  it('keeps a channel floor even when the channel has no rule to match on', () => {
    // An `assigned` group's channels carry no alias at all, and they are the
    // ones most likely to want a floor -- so it cannot live on the rule.
    const report = loadRules({
      schema: 2,
      channels: [
        { channel_id: 1, aliases: ['A'], min_resolution: '720p' },
        { channel_id: 2, min_resolution: 'none' },
        { channel_id: 3, aliases: ['C'] },
        { channel_id: 4, enabled: false, min_resolution: '1080p' },
      ],
    });
    expect(report.channelFloors.get(1)).toBe('720p');
    expect(report.channelFloors.get(2)).toBeNull();
    expect(report.channelFloors.has(3)).toBe(false);
    expect(report.channelFloors.has(4)).toBe(false);
  });
});

describe('clearing the floor', () => {
  it('counts height or width, so a letterboxed feed is not demoted for its bars', () => {
    expect(meetsResolutionFloor(probe({ width: 1920, height: 800 }), FHD.weights)).toBe(true);
    expect(meetsResolutionFloor(probe({ width: 1440, height: 1080 }), FHD.weights)).toBe(true);
    expect(meetsResolutionFloor(probe({ width: 1916, height: 1076 }), FHD.weights)).toBe(true);
  });

  it('does not round a smaller picture up to the floor', () => {
    expect(meetsResolutionFloor(hd720, FHD.weights)).toBe(false);
    expect(meetsResolutionFloor(probe({ width: 1600, height: 900 }), FHD.weights)).toBe(false);
  });

  it('judges nothing it did not measure', () => {
    // No floor at all, a video-less feed, and a verdict with no dimensions:
    // none of those is a resolution this can have an opinion about.
    expect(meetsResolutionFloor(hd720, DEFAULT_WEIGHTS)).toBe(true);
    expect(meetsResolutionFloor(probe({ width: 0, height: 0 }), FHD.weights)).toBe(true);
    expect(meetsResolutionFloor(probe({ width: 0, height: 0 }), FHD.weights, true)).toBe(true);
  });

  it('separates being below the floor from being broken', () => {
    expect(isHealthy(hd720, FHD.weights)).toBe(true);
    expect(isUsable(hd720, FHD.weights)).toBe(false);
    // And the score survives, which is what keeps the sunk streams ordered.
    expect(score(hd720, FHD.weights)).toBeGreaterThan(0);
    expect(score(probe({ alive: false }), FHD.weights)).toBe(0);
  });
});

describe('ranking under a floor', () => {
  it('puts the smaller stream first when it scores best, without one', () => {
    // The control: this is the behaviour a floor exists to override, and if it
    // ever stops being true the test below proves nothing.
    expect(score(hd720)).toBeGreaterThan(score(fhd1080));
    expect(rank([entry(1, hd720), entry(2, fhd1080)])).toEqual([1, 2]);
  });

  it('leads with the stream that meets the floor', () => {
    const ranked = rank(
      [entry(1, hd720), entry(2, fhd1080)],
      withResolutionFloor(DEFAULT_STRATEGY, '1080p'),
    );
    expect(ranked).toEqual([2, 1]);
  });

  it('keeps the sunk streams in quality order rather than flattening them', () => {
    // Every stream below the floor scores 0 if the floor is charged to `score`,
    // and the ranking then falls back to stream id -- so a channel where
    // nothing clears the floor would lose its ordering entirely. Ids are
    // deliberately the reverse of the quality order here.
    const worse = probe({ width: 1280, height: 720, fps: 25, bitrateKbps: 2000 });
    const ranked = rank(
      [entry(1, worse), entry(2, hd720)],
      withResolutionFloor(DEFAULT_STRATEGY, '1080p'),
    );
    expect(ranked).toEqual([2, 1]);
  });

  it('still ranks a sub-floor stream above everything that does not play', () => {
    const dead = probe({ alive: false, width: 0, height: 0, bitrateKbps: 0 });
    const black = probe({ black: true });
    const thin = probe({ bitrateKbps: 100 });
    const ranked = rank(
      [entry(1, dead), entry(2, black), entry(3, thin), entry(4, hd720)],
      withResolutionFloor(DEFAULT_STRATEGY, '1080p'),
    );
    expect(ranked[0]).toBe(4);
  });

  it('picks the login that clears the floor', () => {
    const best = pickBestVariant(
      [
        { variantId: 0, result: hd720 },
        { variantId: 1, result: fhd1080 },
      ],
      FHD.weights,
    );
    expect(best?.height).toBe(1080);
  });
});

describe('a pass writing a channel that has a floor', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;

  const stream = (id: number): Stream => ({
    id,
    name: `Feed ${id}`,
    url: `u${id}`,
    providerId: 5,
    streamHash: 'h',
    currentViewers: 0,
    groupId: 100,
  });

  const byId = new Map([1, 2, 3].map((id) => [id, stream(id)]));

  const planned = (over: Partial<PlannedChannel>): PlannedChannel => {
    const channel: Channel = {
      id: 1,
      name: 'Channel One',
      tvgId: 'one',
      streams: [1, 2],
      groupId: 100,
    };
    return {
      channel,
      hits: [
        [1, 0],
        [2, 1],
      ],
      fresh: new Map([
        [1, new Map([[0, hd720]])],
        [2, new Map([[0, fhd1080]])],
      ]),
      settled: new Set([1, 2]),
      cacheComplete: true,
      ...over,
    };
  };

  /** Captures the order written, and re-reads the channel as the reorder does. */
  const spyClient = (writes: number[][]) =>
    ({
      channel: async () => null,
      setStreamOrder: async (_channelId: number, order: number[]) => {
        writes.push(order);
      },
    }) as unknown as DispatcharrClient;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-floor-'));
    const rulesPath = join(dir, 'rules.json');
    const tmp = `${rulesPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ schema: 2, channels: [] }), 'utf8');
    renameSync(tmp, rulesPath);
    store = new Store(join(dir, 'podium.db'));
    runner = new Runner({
      config: () => loadConfig({ DISPATCHARR_API_KEY: 'k', PODIUM_DRY_RUN: 'false' }),
      store,
      rules: new RulesSource(rulesPath),
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** reorderCachedOnly is private; reach it rather than faking a whole pass. */
  async function writeBack(entries: PlannedChannel[], client: DispatcharrClient) {
    const counters = { reordered: 0, unchanged: 0, assigned: 0, measured: 0 };
    await (
      runner as unknown as { reorderCachedOnly: (...args: unknown[]) => Promise<void> }
    ).reorderCachedOnly.call(
      runner,
      client,
      entries,
      counters,
      DEFAULT_STRATEGY,
      byId,
      new Map([[5, 'Provider A']]),
    );
    return counters;
  }

  it('reorders the channel to lead with the stream that meets the floor', async () => {
    const writes: number[][] = [];
    const counters = await writeBack([planned({ minResolution: '1080p' })], spyClient(writes));

    expect(writes).toEqual([[2, 1]]);
    expect(counters.reordered).toBe(1);
  });

  it('leaves the same channel alone without a floor', async () => {
    // The control again, at pass level: the 720p stream scores best, is already
    // first, and nothing needs writing.
    const writes: number[][] = [];
    const counters = await writeBack([planned({})], spyClient(writes));

    expect(writes).toEqual([]);
    expect(counters.unchanged).toBe(1);
  });

  it('never auto-assigns a stream below the floor', async () => {
    // Stream 3 is matched, healthy and not on the channel -- everything
    // auto-assign looks for, except the resolution.
    const withCandidate = planned({
      minResolution: '1080p',
      channel: {
        id: 1,
        name: 'Channel One',
        tvgId: 'one',
        streams: [2],
        groupId: 100,
      },
      hits: [
        [2, 0],
        [3, 1],
      ],
      fresh: new Map([
        [2, new Map([[0, fhd1080]])],
        [3, new Map([[0, hd720]])],
      ]),
      settled: new Set([2, 3]),
    });
    const writes: number[][] = [];
    const counters = await writeBack([withCandidate], spyClient(writes));

    expect(writes).toEqual([]);
    expect(counters.assigned).toBe(0);
  });
});
