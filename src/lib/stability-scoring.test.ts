/**
 * The stability term inside the ranking.
 *
 * The case it was written for is a real one, and the fixtures below are its
 * numbers. A local ABC affiliate carried six streams; the best-measuring one --
 * 1080p, 5.3 Mbps, H.264 -- probed clean every pass and took slot 0, then
 * failed over twice inside two minutes every time anybody actually watched it.
 * Nothing a five-second probe reads can separate it from a stream that holds.
 */

import { describe, expect, it } from 'vitest';
import type { ProbeResult } from './probe';
import {
  DEFAULT_WEIGHTS,
  NEW_INSTALL_STABILITY,
  type RankEntry,
  rank,
  score,
  type Weights,
} from './scoring';
import type { StabilityRecord } from './stability';

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    alive: true,
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 5300,
    bitrateMeasured: true,
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

function record(over: Partial<StabilityRecord> = {}): StabilityRecord {
  return {
    streamId: 77013,
    legs: 3,
    breaks: 0,
    stalls: 0,
    watchedMs: 3_600_000,
    stalledMs: 0,
    lastSeenAt: 0,
    ...over,
  };
}

function weights(over: Partial<Weights> = {}): Weights {
  return { ...DEFAULT_WEIGHTS, ...over };
}

const seeded = weights({ stability: NEW_INSTALL_STABILITY });

/** The WJLA feed: two breaks in 110 seconds of watching. */
const FLAPPING = record({ breaks: 2, watchedMs: 110_000 });
/** Its Luray sibling: an hour watched, nothing against it. */
const SOLID = record({ streamId: 77177, watchedMs: 3_600_000 });

function entries(...rows: Array<[ProbeResult, StabilityRecord | undefined]>): RankEntry[] {
  return rows.map(([result, stability], i) => ({
    streamId: i + 1,
    stepOrder: 0,
    providerId: 1,
    result,
    stability,
  }));
}

describe('the stability term', () => {
  it('changes nothing at the default weight, which is zero', () => {
    expect(score(probe(), DEFAULT_WEIGHTS, false, FLAPPING)).toBe(
      score(probe(), DEFAULT_WEIGHTS, false, undefined),
    );
  });

  it('marks down a stream with a record of failing over', () => {
    expect(score(probe(), seeded, false, FLAPPING)).toBeLessThan(
      score(probe(), seeded, false, undefined),
    );
  });

  it('does not mark up a stream merely for having been watched', () => {
    // The asymmetry the whole design rests on: proven-good and never-observed
    // score identically, so a popular channel's feed gains nothing over an
    // identical one nobody has tuned.
    expect(score(probe(), seeded, false, SOLID)).toBe(score(probe(), seeded, false, undefined));
  });

  it('is calibrated where NEW_INSTALL_STABILITY says it is', () => {
    // The numbers the weight was chosen from, pinned so a change to any other
    // term cannot quietly move them. See NEW_INSTALL_STABILITY.
    expect(score(probe(), seeded, false, undefined)).toBeCloseTo(0.5449, 4);
    expect(score(probe(), seeded, false, FLAPPING)).toBeCloseTo(0.4165, 4);
    expect(
      score(probe(), seeded, false, record({ breaks: 2, watchedMs: 6 * 3_600_000 })),
    ).toBeCloseTo(0.5123, 4);
  });

  it('loses slot 0 to any comparable stream that holds, but not to a poor one', () => {
    const flapping = score(probe(), seeded, false, FLAPPING);
    // A third of the bitrate, same picture -- and it plays.
    expect(score(probe({ bitrateKbps: 2000 }), seeded, false, undefined)).toBeGreaterThan(flapping);
    expect(
      score(probe({ height: 720, width: 1280, bitrateKbps: 3000 }), seeded, false, undefined),
    ).toBeGreaterThan(flapping);
    // But a flapping 1080p feed is still better than 480p between the drops.
    expect(
      score(probe({ height: 480, width: 640, bitrateKbps: 1200 }), seeded, false, undefined),
    ).toBeLessThan(flapping);
  });

  it('leaves a stream that dropped twice across a long evening where it was', () => {
    const occasional = record({ breaks: 2, watchedMs: 6 * 3_600_000 });
    const before = score(probe(), seeded, false, undefined);
    expect(score(probe(), seeded, false, occasional)).toBeGreaterThan(before - 0.05);
  });
});

describe('ranking on stability', () => {
  it('leaves the flapping stream first while the weight is zero', () => {
    // The upgrade guarantee: an install that has not asked for this keeps the
    // order it had, ledger or no ledger.
    const order = rank(entries([probe(), FLAPPING], [probe({ bitrateKbps: 4000 }), SOLID]), {
      mode: 'quality',
      weights: DEFAULT_WEIGHTS,
      providerRank: new Map(),
    });
    expect(order).toEqual([1, 2]);
  });

  it('hands slot 0 to the thinner stream that holds once the weight is on', () => {
    const order = rank(entries([probe(), FLAPPING], [probe({ bitrateKbps: 4000 }), SOLID]), {
      mode: 'quality',
      weights: seeded,
      providerRank: new Map(),
    });
    expect(order).toEqual([2, 1]);
  });

  it('still prefers a genuinely better stream over a marginally steadier one', () => {
    // The weight is a tilt, not a veto: 4K against a record of two drops in an
    // evening should not change hands.
    const occasional = record({ breaks: 2, watchedMs: 6 * 3_600_000 });
    const order = rank(
      entries(
        [probe({ height: 2160, width: 3840, bitrateKbps: 12_000 }), occasional],
        [probe({ height: 720, width: 1280, bitrateKbps: 2500 }), undefined],
      ),
      { mode: 'quality', weights: seeded, providerRank: new Map() },
    );
    expect(order).toEqual([1, 2]);
  });
});

describe('the maxDropsPerHour health check', () => {
  const strict = weights({ stability: NEW_INSTALL_STABILITY, maxDropsPerHour: 6 });

  it('is off by default', () => {
    expect(DEFAULT_WEIGHTS.maxDropsPerHour).toBe(0);
    const order = rank(
      entries([probe(), FLAPPING], [probe({ height: 480, width: 640, bitrateKbps: 900 }), SOLID]),
      { mode: 'quality', weights: weights({ stability: 0 }), providerRank: new Map() },
    );
    expect(order).toEqual([1, 2]);
  });

  it('sinks a stream over the line below every stream that is not', () => {
    const order = rank(
      entries([probe(), FLAPPING], [probe({ height: 480, width: 640, bitrateKbps: 900 }), SOLID]),
      { mode: 'quality', weights: strict, providerRank: new Map() },
    );
    expect(order).toEqual([2, 1]);
  });

  it('keeps it ahead of a stream that does not play at all', () => {
    // Sunk, not condemned. It is still the fallback when nothing else works.
    const dead = probe({ alive: false, bitrateKbps: 0, height: 0, width: 0 });
    const order = rank(entries([dead, undefined], [probe(), FLAPPING]), {
      mode: 'quality',
      weights: strict,
      providerRank: new Map(),
    });
    expect(order).toEqual([2, 1]);
  });

  it('overrules a curated provider order, unlike a missing bitrate', () => {
    // A provider preference says which stream an operator would rather serve.
    // This says one of them has been measured failing to serve at all.
    const order = rank(entries([probe(), FLAPPING], [probe(), SOLID]), {
      mode: 'provider',
      weights: strict,
      providerRank: new Map([[1, 0]]),
    });
    expect(order).toEqual([2, 1]);
  });
});

describe('the stability term on an audio-only channel', () => {
  const radio = probe({
    width: 0,
    height: 0,
    fps: 0,
    videoCodec: '',
    pixelFormat: '',
    bitrateKbps: 128,
    audioCodec: 'aac',
    audioChannels: 2,
    audioBitrateKbps: 128,
  });

  it('changes nothing at weight zero', () => {
    expect(score(radio, DEFAULT_WEIGHTS, true, FLAPPING)).toBe(
      score(radio, DEFAULT_WEIGHTS, true, undefined),
    );
  });

  it('marks down a radio feed with a record of dropping', () => {
    // It used to be skipped for audio entirely, so a soaked radio channel's
    // evidence changed nothing.
    expect(score(radio, seeded, true, FLAPPING)).toBeLessThan(
      score(radio, seeded, true, undefined),
    );
  });

  it('does not mark up a radio feed merely for having been measured', () => {
    expect(score(radio, seeded, true, SOLID)).toBe(score(radio, seeded, true, undefined));
  });

  it('lets a steady feed overtake a flapping one of the same quality', () => {
    const order = rank(
      entries([radio, FLAPPING], [radio, SOLID]),
      {
        mode: 'quality',
        weights: seeded,
        providerRank: new Map(),
      },
      true,
    );
    expect(order).toEqual([2, 1]);
  });
});
