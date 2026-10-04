/**
 * Maximum resolution: what a channel should stop at.
 *
 * Everything here prefers a bigger picture -- more lines score higher, and a
 * generous bitrate rides along -- so a provider carrying the same channel in
 * 1080p and 4K has its 4K feed win slot 0 outright. The ceiling is the
 * operator saying their client, their bandwidth or their eyes stop at 1080p,
 * and until this existed that instruction had to be expressed as an alias
 * maintained purely to keep the bigger feed out.
 *
 * The distinction these pin is the floor's, inverted: over the ceiling is not
 * the same as broken. A 4K stream over a 1080p cap sinks and is never
 * assigned, but it still plays, so it ranks ahead of the dead and keeps its
 * order against the other over-cap streams.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import type { Channel, DispatcharrClient, Stream } from './dispatcharr';
import { ALWAYS, Eligibility, parseGroupPatterns, parsePolicies } from './eligibility';
import { withResolutionCeiling } from './ordering';
import type { ProbeResult } from './probe';
import { parseMaxResolution, resolveResolutionCeiling } from './resolution';
import { loadRules } from './rules';
import { RulesSource } from './rules-source';
import { type PlannedChannel, Runner } from './runner';
import {
  DEFAULT_STRATEGY,
  DEFAULT_WEIGHTS,
  isHealthy,
  isUsable,
  meetsResolutionCeiling,
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

const CAP = { weights: { ...DEFAULT_WEIGHTS, maxResolution: '1080p' as const } };

/** The pair that motivates the feature: the bigger stream is the one to refuse. */
const uhd4k = probe({ width: 3840, height: 2160, fps: 50, bitrateKbps: 20_000 });
const fhd1080 = probe({ width: 1920, height: 1080, fps: 25, bitrateKbps: 3000 });

describe('reading a ceiling', () => {
  it('takes the resolutions it offers, however they are written', () => {
    expect(parseMaxResolution('1080p')).toBe('1080p');
    expect(parseMaxResolution('1080')).toBe('1080p');
    expect(parseMaxResolution(' 720P ')).toBe('720p');
    expect(parseMaxResolution('4k')).toBe('2160p');
  });

  it('tells "no cap" apart from "not set here"', () => {
    expect(parseMaxResolution('none')).toBeNull();
    expect(parseMaxResolution('inherit')).toBeUndefined();
    expect(parseMaxResolution(undefined)).toBeUndefined();
    expect(parseMaxResolution(null)).toBeUndefined();
    expect(parseMaxResolution('')).toBeUndefined();
  });

  it('ignores a value nobody could have meant, rather than failing the load', () => {
    expect(parseMaxResolution('1440p')).toBeUndefined();
    expect(parseMaxResolution('yes')).toBeUndefined();
  });

  it('reads an interlaced label as the line count it names', () => {
    expect(parseMaxResolution('1080i')).toBe('1080p');
    expect(parseMaxResolution('720i')).toBe('720p');
  });

  it('says so when a ceiling could not be read, rather than dropping it in silence', () => {
    const report = loadRules({
      schema: 2,
      groups: { '7': { mode: ALWAYS, max_resolution: '1o80p' } },
      channels: [
        { channel_id: 1, aliases: ['A'], max_resolution: '1440p' },
        { channel_id: 2, aliases: ['B'], max_resolution: '1080i' },
        { channel_id: 3, aliases: ['C'] },
      ],
    });
    expect(report.channelCeilings.has(1)).toBe(false);
    expect(report.channelCeilings.get(2)).toBe('1080p');
    expect(report.invalidFloors).toEqual([
      'group 7: max_resolution "1o80p"',
      'channel 1: max_resolution "1440p"',
    ]);
  });

  it('lets a channel lower, raise or clear its group ceiling', () => {
    expect(resolveResolutionCeiling(undefined, '1080p')).toBe('1080p');
    expect(resolveResolutionCeiling('720p', '1080p')).toBe('720p');
    expect(resolveResolutionCeiling('2160p', '1080p')).toBe('2160p');
    expect(resolveResolutionCeiling(null, '1080p')).toBeUndefined();
    expect(resolveResolutionCeiling(undefined, undefined)).toBeUndefined();
  });

  it('reads a group policy and a name pattern', () => {
    const groups = parsePolicies({
      '7': { mode: ALWAYS, max_resolution: '1080p' },
      '8': { mode: ALWAYS, max_resolution: 'none' },
      '9': { mode: ALWAYS },
    });
    expect(groups.get(7)?.maxResolution).toBe('1080p');
    // `none` reads as no cap -- but the entry still exists, and that is what
    // overrides a name pattern's cap, exactly as with a floor.
    expect(groups.get(8)?.maxResolution).toBeUndefined();
    expect(groups.has(8)).toBe(true);
    expect(groups.get(9)?.maxResolution).toBeUndefined();

    const patterns = parseGroupPatterns([
      { pattern: 'Auto | *', mode: ALWAYS, max_resolution: '1080p' },
    ]);
    expect(patterns[0]?.maxResolution).toBe('1080p');
  });

  it('keeps a channel ceiling even when the channel has no rule to match on', () => {
    const report = loadRules({
      schema: 2,
      channels: [
        { channel_id: 1, aliases: ['A'], max_resolution: '1080p' },
        { channel_id: 2, max_resolution: 'none' },
        { channel_id: 3, aliases: ['C'] },
        { channel_id: 4, enabled: false, max_resolution: '1080p' },
      ],
    });
    expect(report.channelCeilings.get(1)).toBe('1080p');
    expect(report.channelCeilings.get(2)).toBeNull();
    expect(report.channelCeilings.has(3)).toBe(false);
    expect(report.channelCeilings.has(4)).toBe(false);
  });
});

describe('sitting under the ceiling', () => {
  it('is over only when both dimensions are, so letterboxing is not punished', () => {
    // The anamorphic tolerance runs both ways: a 2.39:1 film at 1920x800 is a
    // 1080p feed by width, and an over-eager height check would cap it.
    expect(meetsResolutionCeiling(probe({ width: 1920, height: 800 }), CAP.weights)).toBe(true);
    expect(meetsResolutionCeiling(probe({ width: 1440, height: 1080 }), CAP.weights)).toBe(true);
    expect(meetsResolutionCeiling(probe({ width: 1936, height: 1088 }), CAP.weights)).toBe(true);
  });

  it('is over when the picture is genuinely bigger', () => {
    expect(meetsResolutionCeiling(uhd4k, CAP.weights)).toBe(false);
    expect(meetsResolutionCeiling(probe({ width: 2560, height: 1440 }), CAP.weights)).toBe(false);
    // Wide even when short: 3840 wide is a 4K letterbox, not a 1080p feed.
    expect(meetsResolutionCeiling(probe({ width: 3840, height: 1608 }), CAP.weights)).toBe(false);
  });

  it('has no opinion without a cap, or on a channel with no picture to judge', () => {
    expect(meetsResolutionCeiling(uhd4k, DEFAULT_WEIGHTS)).toBe(true);
    expect(meetsResolutionCeiling(probe({ width: 0, height: 0 }), CAP.weights, true)).toBe(true);
  });

  it('lets a stream with no picture sit under any cap', () => {
    // The floor fails an absent picture on purpose -- "at least 1080p" is an
    // instruction about what to serve. "At most 1080p" cannot be breached by
    // nothing, and the radio feed keeps its floor-style exemption from the
    // other direction.
    expect(meetsResolutionCeiling(probe({ width: 0, height: 0 }), CAP.weights)).toBe(true);
  });

  it('separates being over the cap from being broken', () => {
    expect(isHealthy(uhd4k, CAP.weights)).toBe(true);
    expect(isUsable(uhd4k, CAP.weights)).toBe(false);
    // And the score survives, which is what keeps the sunk streams ordered.
    expect(score(uhd4k, CAP.weights)).toBeGreaterThan(0);
    expect(score(probe({ alive: false }), CAP.weights)).toBe(0);
  });

  it('composes with a floor: both bounds narrow independently', () => {
    const both = {
      ...DEFAULT_WEIGHTS,
      minResolution: '1080p' as const,
      maxResolution: '1080p' as const,
    };
    const hd720 = probe({ width: 1280, height: 720, fps: 50, bitrateKbps: 12_000 });
    expect(isUsable(hd720, both)).toBe(false); // under the floor
    expect(isUsable(uhd4k, both)).toBe(false); // over the ceiling
    expect(isUsable(fhd1080, both)).toBe(true); // inside
  });
});

describe("a group opting out of a name rule's ceiling", () => {
  it('takes the pattern cap when the group has no entry of its own', () => {
    const elig = new Eligibility(
      parsePolicies({}),
      undefined,
      parseGroupPatterns([{ pattern: 'Sports *', mode: ALWAYS, max_resolution: '1080p' }]),
    );
    expect(elig.policyFor(42, 'Sports UHD').maxResolution).toBe('1080p');
  });

  it('drops it the moment the group has one, cap or no cap', () => {
    const patterns = parseGroupPatterns([
      { pattern: 'Sports *', mode: ALWAYS, max_resolution: '1080p' },
    ]);
    const optedOut = new Eligibility(
      parsePolicies({ '42': { mode: ALWAYS, max_resolution: 'none' } }),
      undefined,
      patterns,
    );
    expect(optedOut.policyFor(42, 'Sports UHD').maxResolution).toBeUndefined();
  });
});

describe('ranking under a ceiling', () => {
  it('puts the bigger stream first when it scores best, without one', () => {
    // The control: this is the behaviour a ceiling exists to override.
    expect(score(uhd4k)).toBeGreaterThan(score(fhd1080));
    expect(rank([entry(1, uhd4k), entry(2, fhd1080)])).toEqual([1, 2]);
  });

  it('leads with the stream under the cap', () => {
    const ranked = rank(
      [entry(1, uhd4k), entry(2, fhd1080)],
      withResolutionCeiling(DEFAULT_STRATEGY, '1080p'),
    );
    expect(ranked).toEqual([2, 1]);
  });

  it('keeps the sunk streams in quality order rather than flattening them', () => {
    const qhd1440 = probe({ width: 2560, height: 1440, fps: 25, bitrateKbps: 4000 });
    const ranked = rank(
      [entry(1, qhd1440), entry(2, uhd4k)],
      withResolutionCeiling(DEFAULT_STRATEGY, '1080p'),
    );
    expect(ranked).toEqual([2, 1]);
  });

  it('still ranks an over-cap stream above everything that does not play', () => {
    const dead = probe({ alive: false, width: 0, height: 0, bitrateKbps: 0 });
    const black = probe({ black: true });
    const ranked = rank(
      [entry(1, dead), entry(2, black), entry(3, uhd4k)],
      withResolutionCeiling(DEFAULT_STRATEGY, '1080p'),
    );
    expect(ranked[0]).toBe(3);
  });

  it('picks the login that sits under the cap', () => {
    const best = pickBestVariant(
      [
        { variantId: 0, result: uhd4k },
        { variantId: 1, result: fhd1080 },
      ],
      CAP.weights,
    );
    expect(best?.height).toBe(1080);
  });
});

describe('a pass writing a channel that has a ceiling', () => {
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
        [1, new Map([[0, uhd4k]])],
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
    dir = mkdtempSync(join(tmpdir(), 'podium-ceiling-'));
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

  it('reorders the channel to lead with the stream under the cap', async () => {
    const writes: number[][] = [];
    const counters = await writeBack([planned({ maxResolution: '1080p' })], spyClient(writes));

    expect(writes).toEqual([[2, 1]]);
    expect(counters.reordered).toBe(1);
  });

  it('leaves the same channel alone without a ceiling', async () => {
    // The control again, at pass level: the 4K stream scores best, is already
    // first, and nothing needs writing.
    const writes: number[][] = [];
    const counters = await writeBack([planned({})], spyClient(writes));

    expect(writes).toEqual([]);
    expect(counters.unchanged).toBe(1);
  });

  it('never auto-assigns a stream over the cap', async () => {
    // Stream 3 is matched, healthy and not on the channel -- everything
    // auto-assign looks for, except the resolution.
    const withCandidate = planned({
      maxResolution: '1080p',
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
        [3, new Map([[0, uhd4k]])],
      ]),
      settled: new Set([2, 3]),
    });
    const writes: number[][] = [];
    const counters = await writeBack([withCandidate], spyClient(writes));

    expect(writes).toEqual([]);
    expect(counters.assigned).toBe(0);
  });
});
