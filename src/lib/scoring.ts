/**
 * Stream ranking.
 *
 * Weights mirror the configuration this replaces so that a migrated install
 * produces a familiar ordering: resolution and bitrate dominate, fps and codec
 * break ties.
 */

import type { ProbeResult } from './probe';

/** Normalisation ceilings. Anything at or above these scores 1.0 for that term. */
const MAX_HEIGHT = 2160;
const MAX_BITRATE_KBPS = 12_000;
const MAX_FPS = 60;

export interface Weights {
  resolution: number;
  bitrate: number;
  fps: number;
  codec: number;
  preferH265: boolean;
  /**
   * Below this, a stream is treated as dead however healthy its metadata looks.
   *
   * ffprobe happily reports "1080p" for a feed delivering 193kbps, which is
   * unwatchable. Ranking such a stream merely last still leaves it ahead of an
   * honestly-dead one, and it is not a usable fallback -- so it sinks with the
   * dead instead.
   */
  minBitrateKbps: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  resolution: 0.35,
  bitrate: 0.4,
  fps: 0.15,
  codec: 0.1,
  preferH265: true,
  minBitrateKbps: 500,
};

/** True when a stream is alive but too degraded to be worth offering. */
export function isUsable(result: ProbeResult, weights: Weights = DEFAULT_WEIGHTS): boolean {
  if (!result.alive) return false;
  // A slate is not a fallback. Alive, correctly sized, healthy bitrate -- and
  // showing nothing.
  if (result.black) return false;
  // A measured 0 means "unknown", not "no data" -- only judge what we measured.
  if (weights.minBitrateKbps <= 0 || result.bitrateKbps <= 0) return true;
  return result.bitrateKbps >= weights.minBitrateKbps;
}

/**
 * True when the probe came back alive without ever resolving a bitrate.
 *
 * Not the same as a slow stream: live TS/HLS rarely declares `bit_rate`, so the
 * number comes from the ffmpeg sample, and a 0 means that sample never landed
 * (disabled, timed out, or empty). The stream might be the best on its channel
 * or the worst -- we simply did not measure it.
 */
export function bitrateUnknown(result: ProbeResult): boolean {
  return result.bitrateKbps <= 0;
}

/** Score a probe result in [0, 1]. A dead or unusable stream always scores 0. */
export function score(result: ProbeResult, weights: Weights = DEFAULT_WEIGHTS): number {
  if (!isUsable(result, weights)) return 0;

  const resolution = result.height ? Math.min(result.height / MAX_HEIGHT, 1) : 0;
  const bitrate = result.bitrateKbps ? Math.min(result.bitrateKbps / MAX_BITRATE_KBPS, 1) : 0;
  const fps = result.fps ? Math.min(result.fps / MAX_FPS, 1) : 0;

  let codec = 0;
  const name = (result.videoCodec || '').toLowerCase();
  if (name === 'hevc' || name === 'h265') codec = weights.preferH265 ? 1 : 0.5;
  else if (name === 'h264' || name === 'avc') codec = weights.preferH265 ? 0.5 : 1;
  else if (name) codec = 0.25;

  const total =
    resolution * weights.resolution +
    bitrate * weights.bitrate +
    fps * weights.fps +
    codec * weights.codec;

  return Math.round(Math.min(total, 1) * 10_000) / 10_000;
}

export interface RankEntry {
  streamId: number;
  stepOrder: number;
  providerId: number;
  result: ProbeResult;
}

/** How the comparator chooses between two equally-usable streams. */
export type OrderingMode = 'quality' | 'provider' | 'alias';

/**
 * Resolved ranking strategy. Built once per pass from the rules `ordering`
 * block plus the live provider list by `resolveOrdering` (see ordering.ts).
 */
export interface RankStrategy {
  mode: OrderingMode;
  weights: Weights;
  /**
   * `providerId -> preferred tier` (0 = most preferred). Providers absent from
   * the map sort last, at `MAX_SAFE_INTEGER`. Only consulted in `provider` mode.
   */
  providerRank: Map<number, number>;
}

/** Quality-first, default weights, no provider preference. */
export const DEFAULT_STRATEGY: RankStrategy = {
  mode: 'quality',
  weights: DEFAULT_WEIGHTS,
  providerRank: new Map(),
};

/**
 * Order stream ids best-first.
 *
 * Unusable streams (dead / black / sub-floor) always sink regardless of mode.
 * The mode then picks the primary key, streams whose bitrate was never measured
 * sink within it, quality score breaks ties after that, and a stable stream-id
 * sort is the last resort:
 *
 * - `quality` (default): score, then streamId. The best source wins outright.
 * - `provider`: preferred providers first (by `providerRank`), then score
 *   within each tier.
 * - `alias`: the regex/alias step order leads -- for an operator who curated it
 *   deliberately -- with score breaking ties within a step.
 */
export function rank(entries: RankEntry[], strategy: RankStrategy = DEFAULT_STRATEGY): number[] {
  const { weights, mode, providerRank } = strategy;
  return [...entries]
    .sort((a, b) => {
      const usable = (isUsable(a.result, weights) ? 0 : 1) - (isUsable(b.result, weights) ? 0 : 1);
      if (usable !== 0) return usable;

      if (mode === 'alias' && a.stepOrder !== b.stepOrder) return a.stepOrder - b.stepOrder;
      if (mode === 'provider') {
        const ta = providerRank.get(a.providerId) ?? Number.MAX_SAFE_INTEGER;
        const tb = providerRank.get(b.providerId) ?? Number.MAX_SAFE_INTEGER;
        if (ta !== tb) return ta - tb;
      }

      // An unmeasured stream is not a better stream. `score` gives its bitrate
      // term a zero, which costs it only `weights.bitrate` -- enough to leave a
      // 1080p50 feed we never measured ahead of a 720p25 one we did, on the
      // strength of resolution and fps alone. Rank it behind everything we have
      // real data for and let the short unknown-bitrate TTL re-probe it into its
      // true position.
      //
      // Below the mode key, not above it: provider and alias order are the
      // operator's explicit curation, and a missing measurement is not grounds
      // to overrule them. Within a tier, and in quality mode throughout, known
      // beats unknown outright.
      const measured = (bitrateUnknown(a.result) ? 1 : 0) - (bitrateUnknown(b.result) ? 1 : 0);
      if (measured !== 0) return measured;

      const scoreDelta = score(b.result, weights) - score(a.result, weights);
      if (scoreDelta !== 0) return scoreDelta;
      return a.streamId - b.streamId;
    })
    .map((entry) => entry.streamId);
}
