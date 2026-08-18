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
/** 5.1. Anything wider (7.1) is still a full score rather than a bonus. */
const MAX_AUDIO_CHANNELS = 6;
/** What a good E-AC-3 5.1 track on these providers runs at. */
const MAX_AUDIO_KBPS = 256;

export interface Weights {
  resolution: number;
  bitrate: number;
  fps: number;
  codec: number;
  /**
   * How much surround audio is worth.
   *
   * Small on purpose: at 0.1 against the other four, audio can only decide
   * between streams whose video is already close, which is the case it exists
   * for -- the same channel carried twice, once with 5.1 and once without. It
   * cannot promote a 720p feed over a 1080p one on the strength of a
   * soundtrack.
   *
   * Note that a channel whose 5.1 track only appears during live coverage will
   * score differently either side of the event, and so can change position
   * between passes. That is the measurement being honest about a stream that
   * genuinely changed, and is accepted rather than damped.
   */
  audio: number;
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
  // Zero here is not an opinion about audio -- it is what a rules file that
  // predates the term means. Ranking is the one thing an operator notices
  // changing under them, so an upgrade must not reshuffle channels that were
  // never asked to change. New installs are seeded with `NEW_INSTALL_AUDIO`
  // instead (see EMPTY_RULES_DOC), which is the value we would pick freely.
  audio: 0,
  preferH265: true,
  minBitrateKbps: 500,
};

/**
 * The audio weight a fresh install starts with, written into its rules file
 * rather than defaulted here so that upgrading never changes an existing order.
 * Also what "Reset to defaults" restores, since it is what podium ships today.
 */
export const NEW_INSTALL_AUDIO = 0.1;

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

/**
 * How good the audio is, in [0, 1].
 *
 * Channel count leads because it is the difference a listener actually hears,
 * and the track's declared bitrate separates streams that tie on it -- a 5.1
 * feed at 128kbps is not the equal of one at 256. A stream carrying no audio
 * at all scores 0: ffprobe lists every track a stream has, so nothing found
 * means nothing there.
 */
export function audioScore(result: ProbeResult): number {
  const channels = Math.min((result.audioChannels || 0) / MAX_AUDIO_CHANNELS, 1);
  if (channels <= 0) return 0;
  const bitrate = Math.min((result.audioBitrateKbps || 0) / MAX_AUDIO_KBPS, 1);
  return channels * 0.75 + bitrate * 0.25;
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

  // Divided by the weights rather than assumed to sum to 1.
  //
  // The four original weights do sum to 1, so this changes nothing for a
  // default install -- but adding a fifth term to a set that already totals 1
  // would otherwise push every score up and clamp the good ones together at
  // 1.0, which is where a ranking loses the ability to tell them apart. An
  // install that had already tuned its weights to some other total keeps its
  // order too: dividing by a constant cannot reorder anything.
  const sum = weights.resolution + weights.bitrate + weights.fps + weights.codec + weights.audio;
  if (sum <= 0) return 0;

  const total =
    (resolution * weights.resolution +
      bitrate * weights.bitrate +
      fps * weights.fps +
      codec * weights.codec +
      audioScore(result) * weights.audio) /
    sum;

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
