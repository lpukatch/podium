/**
 * Ranking a stream whose bitrate was never measured.
 *
 * ffprobe declares no `bit_rate` on most live TS/HLS, so the number comes from
 * the ffmpeg sample -- and when that does not land the verdict is "alive,
 * 0kbps". Scoring alone handles that badly: the bitrate term goes to zero,
 * costing the stream only `weights.bitrate`, which leaves an unmeasured 1080p50
 * feed scoring 0.350 and sitting above a 720p25 one we actually measured at
 * 2667kbps (0.318). These pin the demotion that fixes it, and the boundaries it
 * must not cross.
 */

import { describe, expect, it } from 'vitest';
import type { ProbeResult } from './probe';
import {
  bitrateUnknown,
  DEFAULT_STRATEGY,
  DEFAULT_WEIGHTS,
  isUsable,
  type RankEntry,
  rank,
  score,
} from './scoring';

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    alive: true,
    width: 1920,
    height: 1080,
    fps: 50,
    bitrateKbps: 10_000,
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

/** The two rows from the report that prompted this: 1080p50 unmeasured vs 720p25 measured. */
const unmeasured = probe({ height: 1080, fps: 50, bitrateKbps: 0 });
const measured720 = probe({ height: 720, fps: 25, bitrateKbps: 2667 });

describe('bitrateUnknown', () => {
  it('is exactly the alive-but-never-measured case', () => {
    expect(bitrateUnknown(unmeasured)).toBe(true);
    expect(bitrateUnknown(measured720)).toBe(false);
  });
});

describe('score stays honest about what was measured', () => {
  it('still scores the terms that did resolve', () => {
    // 1080/2160 * .35 + 0 * .4 + 50/60 * .15 + h264 .5 * .1
    expect(score(unmeasured)).toBeCloseTo(0.35, 3);
    expect(score(measured720)).toBeCloseTo(0.318, 3);
  });

  it('does not treat an unmeasured bitrate as sub-floor', () => {
    // A 0 means "unknown", not "delivers nothing", so the minimum-bitrate floor
    // must not claim it -- that would sink it in with the dead.
    expect(isUsable(unmeasured)).toBe(true);
    expect(isUsable(probe({ bitrateKbps: 100 }), { ...DEFAULT_WEIGHTS, minBitrateKbps: 500 })).toBe(
      false,
    );
  });
});

describe('rank demotes the unmeasured stream', () => {
  it('puts a measured 720p above an unmeasured 1080p, despite the score', () => {
    const order = rank([entry(1, unmeasured), entry(2, measured720)]);
    expect(order).toEqual([2, 1]);
    // The thing that made this worth fixing: rank disagrees with score here,
    // deliberately.
    expect(score(unmeasured)).toBeGreaterThan(score(measured720));
  });

  it('sinks it behind every measured stream, not just the better ones', () => {
    const measured576 = probe({ height: 576, fps: 25, bitrateKbps: 2011 });
    const order = rank([entry(1, unmeasured), entry(2, measured720), entry(3, measured576)]);
    expect(order).toEqual([2, 3, 1]);
  });

  it('still ranks it above a dead stream', () => {
    // Unmeasured is not unusable. It may well be the best stream on the channel;
    // we just have not proved it.
    const dead = probe({ alive: false, height: 0, fps: 0, bitrateKbps: 0, videoCodec: '' });
    const order = rank([entry(1, dead), entry(2, unmeasured)]);
    expect(order).toEqual([2, 1]);
  });

  it('still ranks it above a stream that measured below the floor', () => {
    const throttled = probe({ height: 1080, bitrateKbps: 193 });
    const order = rank([entry(1, throttled), entry(2, unmeasured)]);
    expect(order).toEqual([2, 1]);
  });

  it('falls back to score when nothing on the channel was measured', () => {
    // A provider that never declares a bitrate and always times out must still
    // get a sensible order out of resolution, fps and codec.
    const low = probe({ height: 576, fps: 25, bitrateKbps: 0 });
    const order = rank([entry(1, low), entry(2, unmeasured)]);
    expect(order).toEqual([2, 1]);
  });
});

describe('the demotion sits below the operator ordering modes', () => {
  it('does not overrule an explicit provider preference', () => {
    const strategy = {
      ...DEFAULT_STRATEGY,
      mode: 'provider' as const,
      providerRank: new Map([
        [7, 0],
        [9, 1],
      ]),
    };
    const order = rank(
      [entry(1, unmeasured, { providerId: 7 }), entry(2, measured720, { providerId: 9 })],
      strategy,
    );
    expect(order).toEqual([1, 2]);
  });

  it('applies within a provider tier', () => {
    const strategy = {
      ...DEFAULT_STRATEGY,
      mode: 'provider' as const,
      providerRank: new Map([[7, 0]]),
    };
    const order = rank(
      [entry(1, unmeasured, { providerId: 7 }), entry(2, measured720, { providerId: 7 })],
      strategy,
    );
    expect(order).toEqual([2, 1]);
  });

  it('does not overrule a curated alias step order', () => {
    const strategy = { ...DEFAULT_STRATEGY, mode: 'alias' as const };
    const order = rank(
      [entry(1, unmeasured, { stepOrder: 0 }), entry(2, measured720, { stepOrder: 1 })],
      strategy,
    );
    expect(order).toEqual([1, 2]);
  });
});
