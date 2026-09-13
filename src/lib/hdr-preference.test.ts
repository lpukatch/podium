/**
 * Preferring one HDR flavour over the other.
 *
 * A provider carrying both HLG and HDR10/PQ variants of the same channel
 * presents them identically in every term the score reads -- hevc,
 * yuv420p10le, 3840x2160 -- so which one took slot 0 was down to a few kbps of
 * bitrate. `colorTransfer` is the discriminator, and this is the knob that
 * lets an operator say which they want. Small on purpose, like `audio`: it
 * separates two HDR variants of one channel and cannot promote a thinner
 * stream or a lower resolution.
 */

import { describe, expect, it } from 'vitest';
import type { ProbeResult } from './probe';
import { EMPTY_RULES_DOC, loadRules } from './rules';
import {
  DEFAULT_WEIGHTS,
  hdrScore,
  NEW_INSTALL_AUDIO,
  NEW_INSTALL_HDR,
  NEW_INSTALL_HEVC_FACTOR,
  NEW_INSTALL_UHD_BITRATE_KBPS,
  type RankEntry,
  rank,
  score,
  type Weights,
} from './scoring';

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    alive: true,
    width: 3840,
    height: 2160,
    fps: 50,
    bitrateKbps: 15_000,
    bitrateMeasured: true,
    videoCodec: 'hevc',
    audioCodec: 'eac3',
    pixelFormat: 'yuv420p10le',
    audioChannels: 6,
    channelLayout: '5.1(side)',
    audioBitrateKbps: 384,
    audioSampleRate: 48_000,
    elapsedMs: 100,
    error: '',
    ...over,
  };
}

const HLG = probe({ colorTransfer: 'arib-std-b67', colorPrimaries: 'bt2020' });
const PQ = probe({ colorTransfer: 'smpte2084', colorPrimaries: 'bt2020' });
const SDR = probe({ pixelFormat: 'yuv420p', colorTransfer: 'bt709', colorPrimaries: 'bt709' });
const UNKNOWN = probe();

function weights(over: Partial<Weights>): Weights {
  return { ...DEFAULT_WEIGHTS, ...over };
}

const preferHlg = weights({ hdr: 0.05, hdrPreference: 'hlg' });
const preferPq = weights({ hdr: 0.05, hdrPreference: 'pq' });

/** What a new install actually runs, where the UHD bitrate term is not saturated. */
const seededHlg = weights({
  audio: NEW_INSTALL_AUDIO,
  hdr: NEW_INSTALL_HDR,
  hdrPreference: 'hlg',
  hevcBitrateFactor: NEW_INSTALL_HEVC_FACTOR,
  uhdBitrateKbps: NEW_INSTALL_UHD_BITRATE_KBPS,
});

function entries(...results: ProbeResult[]): RankEntry[] {
  return results.map((result, i) => ({ streamId: i + 1, stepOrder: 0, providerId: 1, result }));
}

describe('the HDR term', () => {
  it('is neutral for every stream when there is no preference', () => {
    const none = weights({ hdr: 1, hdrPreference: 'none' });
    for (const r of [HLG, PQ, SDR, UNKNOWN]) expect(hdrScore(r, none)).toBe(0.5);
  });

  it('scores the preferred flavour 1, the other 0, and everything else in between', () => {
    expect(hdrScore(HLG, preferHlg)).toBe(1);
    expect(hdrScore(PQ, preferHlg)).toBe(0);
    expect(hdrScore(SDR, preferHlg)).toBe(0.5);
    expect(hdrScore(UNKNOWN, preferHlg)).toBe(0.5);

    expect(hdrScore(PQ, preferPq)).toBe(1);
    expect(hdrScore(HLG, preferPq)).toBe(0);
  });

  it('reads the transfer name case-insensitively', () => {
    expect(hdrScore(probe({ colorTransfer: 'SMPTE2084' }), preferPq)).toBe(1);
  });
});

describe('what the preference can and cannot do', () => {
  it('changes nothing at weight 0, whatever the preference says', () => {
    const w = weights({ hdr: 0, hdrPreference: 'hlg' });
    expect(score(HLG, w)).toBe(score(HLG, DEFAULT_WEIGHTS));
    expect(score(PQ, w)).toBe(score(PQ, DEFAULT_WEIGHTS));
    expect(score(HLG, w)).toBe(score(PQ, w));
  });

  it('changes nothing with a weight but no preference', () => {
    const w = weights({ hdr: 0.05, hdrPreference: 'none' });
    expect(score(HLG, w)).toBe(score(PQ, w));
    expect(
      rank(entries(PQ, HLG), { mode: 'quality', weights: w, providerRank: new Map() }),
    ).toEqual([1, 2]);
  });

  it('lifts the preferred flavour over an otherwise identical stream', () => {
    expect(score(HLG, preferHlg)).toBeGreaterThan(score(PQ, preferHlg));
    expect(score(PQ, preferPq)).toBeGreaterThan(score(HLG, preferPq));
    expect(
      rank(entries(PQ, HLG), { mode: 'quality', weights: preferHlg, providerRank: new Map() }),
    ).toEqual([2, 1]);
  });

  /**
   * The case this exists for: two provider variants whose video is close. Run
   * at a new install's weights, not DEFAULT_WEIGHTS -- there the UHD ceiling is
   * 12000 kbps, both streams saturate the bitrate term, and any gap passes.
   * These pin how close "close" is: a tilt of roughly 1.9 Mbps, not a tiebreak.
   */
  it('beats a bitrate gap of up to ~1.9 Mbps between the two HDR flavours, and no more', () => {
    const fatterPq = probe({ ...PQ, bitrateKbps: 15_000 });
    const within = probe({ ...HLG, bitrateKbps: 13_500 });
    const beyond = probe({ ...HLG, bitrateKbps: 12_500 });
    expect(score(within, seededHlg)).toBeGreaterThan(score(fatterPq, seededHlg));
    expect(score(beyond, seededHlg)).toBeLessThan(score(fatterPq, seededHlg));
  });

  it('cannot lift a 1080p stream over a 2160p one', () => {
    const hlg1080 = probe({ ...HLG, width: 1920, height: 1080, bitrateKbps: 8000 });
    expect(score(PQ, seededHlg)).toBeGreaterThan(score(hlg1080, seededHlg));
  });

  it('cannot lift a thin stream over a healthy one', () => {
    const thinHlg = probe({ ...HLG, bitrateKbps: 6000 });
    expect(score(PQ, seededHlg)).toBeGreaterThan(score(thinHlg, seededHlg));
  });

  /** Halfway is not "unmoved": SDR overtakes the unpicked flavour when the two are close. */
  it('lets an SDR stream overtake the flavour that was not picked, by about half as much', () => {
    const pq = probe({ ...PQ, bitrateKbps: 15_000 });
    const within = probe({ ...SDR, bitrateKbps: 14_300 });
    const beyond = probe({ ...SDR, bitrateKbps: 13_800 });
    expect(score(within, seededHlg)).toBeGreaterThan(score(pq, seededHlg));
    expect(score(beyond, seededHlg)).toBeLessThan(score(pq, seededHlg));
  });

  /** Verdicts cached before `colorTransfer` existed sit between the two flavours. */
  it('leaves SDR and unknown between the preferred and the other flavour', () => {
    expect(score(HLG, preferHlg)).toBeGreaterThan(score(UNKNOWN, preferHlg));
    expect(score(UNKNOWN, preferHlg)).toBeGreaterThan(score(PQ, preferHlg));
  });
});

describe('the rules file', () => {
  it('round-trips both fields', () => {
    const loaded = loadRules({
      schema: 2,
      defaults: {},
      channels: [],
      ordering: { weights: { hdr: 0.2, hdr_preference: 'pq' } },
    });
    expect(loaded.ordering.weights.hdr).toBe(0.2);
    expect(loaded.ordering.weights.hdrPreference).toBe('pq');
  });

  it('treats an unrecognised preference as none rather than failing the load', () => {
    const loaded = loadRules({
      schema: 2,
      defaults: {},
      channels: [],
      ordering: { weights: { hdr_preference: 'dolby-vision' } },
    });
    expect(loaded.ordering.weights.hdrPreference).toBe('none');
  });

  /** An install that predates the term keeps its exact ordering. */
  it('leaves both unset for a rules file that predates them', () => {
    const loaded = loadRules({ schema: 2, defaults: {}, channels: [], ordering: { weights: {} } });
    expect(loaded.ordering.weights.hdr).toBeUndefined();
    expect(loaded.ordering.weights.hdrPreference).toBeUndefined();
    expect(DEFAULT_WEIGHTS.hdr).toBe(0);
    expect(DEFAULT_WEIGHTS.hdrPreference).toBe('none');
  });

  /** New installs carry the weight but no preference: inert until an operator picks one. */
  it('seeds a new install with the weight and no preference', () => {
    const loaded = loadRules(EMPTY_RULES_DOC);
    expect(loaded.ordering.weights.hdr).toBe(NEW_INSTALL_HDR);
    expect(loaded.ordering.weights.hdrPreference ?? 'none').toBe('none');
  });
});
