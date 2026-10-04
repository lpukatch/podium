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

  it('scores a measured-clean stream above an identical unmeasured one', () => {
    // The reversal of the old asymmetry, and deliberate: a feed that has
    // played and held has evidence an unwatched one lacks, and the unwatched
    // one gets no term rather than a matching one. Being watched longer
    // earns nothing further -- SOLID here is one hour, and a twenty-hour
    // clean record scores identically.
    expect(score(probe(), seeded, false, SOLID)).toBeGreaterThan(
      score(probe(), seeded, false, undefined),
    );
  });

  it('is calibrated where NEW_INSTALL_STABILITY says it is', () => {
    // The numbers the weight was chosen from, pinned so a change to any other
    // term cannot quietly move them. See NEW_INSTALL_STABILITY. The
    // never-observed row is the term excluded, not the term at full marks.
    expect(score(probe(), seeded, false, undefined)).toBeCloseTo(0.4767, 4);
    expect(score(probe(), seeded, false, FLAPPING)).toBeCloseTo(0.4165, 4);
    expect(
      score(probe(), seeded, false, record({ breaks: 2, watchedMs: 6 * 3_600_000 })),
    ).toBeCloseTo(0.5123, 4);
  });

  it('loses slot 0 to any comparable stream that holds, but not to a poor one', () => {
    const flapping = score(probe(), seeded, false, FLAPPING);
    // The ones that hold are *measured* clean -- an unmeasured stream is not
    // a stream that holds, it is a stream nobody knows about, and the sink
    // below places it on that side of the line.
    expect(score(probe({ bitrateKbps: 2000 }), seeded, false, SOLID)).toBeGreaterThan(flapping);
    expect(
      score(probe({ height: 720, width: 1280, bitrateKbps: 3000 }), seeded, false, SOLID),
    ).toBeGreaterThan(flapping);
    // But a flapping 1080p feed is still better than 480p between the drops.
    expect(
      score(probe({ height: 480, width: 640, bitrateKbps: 1200 }), seeded, false, SOLID),
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
    // evening should not change hands. (The 720p challenger being unmeasured
    // only reinforces this now -- the sink below puts it last regardless.)
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

describe('the unmeasured sink', () => {
  it('sinks a never-observed stream below a measured one that drops', () => {
    // The reported case, exactly: an unwatched 4K feed against a flapping
    // 1080p one that has at least proved it serves video. On score alone the
    // 4K feed wins; the ledger has no verdict on it, and no verdict is not a
    // clean one.
    const order = rank(
      entries(
        [probe({ height: 2160, width: 3840, bitrateKbps: 12_000 }), undefined],
        [probe(), FLAPPING],
      ),
      { mode: 'quality', weights: seeded, providerRank: new Map() },
    );
    expect(order).toEqual([2, 1]);
  });

  it('is inert while the stability weight is zero', () => {
    // The upgrade guarantee: an install that has not asked for the term keeps
    // the order it had, however unwatched its streams.
    const order = rank(
      entries(
        [probe({ height: 2160, width: 3840, bitrateKbps: 12_000 }), undefined],
        [probe(), FLAPPING],
      ),
      { mode: 'quality', weights: DEFAULT_WEIGHTS, providerRank: new Map() },
    );
    expect(order).toEqual([1, 2]);
  });

  it('keeps score order among the never-observed themselves', () => {
    const order = rank(
      entries(
        [probe({ height: 480, width: 640, bitrateKbps: 1200 }), undefined],
        [probe(), undefined],
      ),
      { mode: 'quality', weights: seeded, providerRank: new Map() },
    );
    expect(order).toEqual([2, 1]);
  });

  it('does not overrule a curated provider order, like a missing bitrate', () => {
    // Provider preference is the operator's explicit curation; a missing
    // measurement is not grounds to overrule it.
    const order = rank(
      [
        { streamId: 1, stepOrder: 0, providerId: 1, result: probe(), stability: undefined },
        { streamId: 2, stepOrder: 0, providerId: 2, result: probe(), stability: SOLID },
      ],
      {
        mode: 'provider',
        weights: seeded,
        providerRank: new Map([
          [1, 0],
          [2, 1],
        ]),
      },
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

  it('scores a measured-clean radio feed above an unmeasured one', () => {
    // The same reversal as the video branch: the term excludes rather than
    // credits the unmeasured, so a feed that has held earns its place.
    expect(score(radio, seeded, true, SOLID)).toBeGreaterThan(
      score(radio, seeded, true, undefined),
    );
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
