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
/**
 * Where `weights.uhdBitrateKbps` takes over from `MAX_BITRATE_KBPS`.
 *
 * The same boundary `tierOfHeight` in quality.ts calls `uhd`, and generous for
 * the same reason: 2160 and 1920-tall letterboxed feeds are both UHD in
 * practice.
 */
const UHD_HEIGHT = 1800;
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
   *
   * Deliberately *not* scaled by `hevcBitrateFactor`. This is a health check,
   * not a quality comparison: at 1080p a 300kbps feed is unwatchable whatever
   * encoded it, and letting the factor lower the floor would admit streams the
   * floor exists to reject.
   */
  minBitrateKbps: number;
  /**
   * What one kbps of HEVC is worth in H.264 kbps, for the bitrate term only.
   *
   * The term this fixes: `bitrate` and `codec` are added independently, so the
   * codec bonus is a flat `weights.codec * 0.5` -- 0.05 at the default weights
   * -- while HEVC's advantage is *multiplicative on the bitrate*. Against a
   * perceptually equal pair (h264 9000kbps vs hevc 4500kbps) the bitrate term
   * costs HEVC 0.150 and the codec bonus repays 0.050, so the better-encoded
   * stream loses by 0.100. Measured on a live install: an HEVC 1080p feed at
   * 7038kbps scored 0.6621 against 0.6874 for an H.264 one at 9371kbps, and
   * would have needed 7871kbps merely to tie -- when 5000 should already win.
   *
   * A flat bonus cannot represent a multiplicative gain, so the correction
   * belongs on the bitrate, not beside it -- and once it is there, the `codec`
   * term stops paying for efficiency too. See `score`: above 1.0 the two codecs
   * are level on that term, or the same advantage is counted twice.
   *
   * Defaults to 1.0 -- no correction -- for the same reason `audio` defaults
   * to 0. An existing rules file cannot mention a term that did not exist when
   * it was written, and this one reorders channels: on the install it was
   * measured against, the full seeded configuration moves slot 0 on 10 of 413
   * multi-stream channels, every one of them among the 85 that rank the two
   * codecs against each other. New installs are seeded with
   * `NEW_INSTALL_HEVC_FACTOR`, which is the value we would pick freely.
   */
  hevcBitrateFactor: number;
  /**
   * The bitrate that scores full marks above `UHD_HEIGHT`.
   *
   * `MAX_BITRATE_KBPS` is calibrated for 1080p, and a ceiling that suits 1080p
   * starves four times the pixels: on a live install 18 of 25 2160p streams sat
   * at or above it, so every one scored a flat 1.0 and the bitrate term could
   * not tell a 13Mbps UHD feed from a 20Mbps one. Six channels had two or more
   * streams tied that way, leaving their order to fps and codec alone.
   *
   * Applying `hevcBitrateFactor` makes that worse, since UHD is where HEVC is
   * most common -- which is why the two ship together rather than separately.
   *
   * Defaults to `MAX_BITRATE_KBPS`, which is exactly today's flat behaviour;
   * new installs are seeded with `NEW_INSTALL_UHD_BITRATE_KBPS`.
   */
  uhdBitrateKbps: number;
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
  // Both inert: 1.0 applies no codec correction, and a UHD ceiling equal to
  // MAX_BITRATE_KBPS is the flat ceiling every install has had until now.
  hevcBitrateFactor: 1,
  uhdBitrateKbps: MAX_BITRATE_KBPS,
};

/**
 * The audio weight a fresh install starts with, written into its rules file
 * rather than defaulted here so that upgrading never changes an existing order.
 * Also what "Reset to defaults" restores, since it is what podium ships today.
 */
export const NEW_INSTALL_AUDIO = 0.1;

/**
 * HEVC's bitrate equivalence for a fresh install.
 *
 * 1.6 rather than the 2.0 the codec's headline BD-rate figure would suggest.
 * That figure is measured on encoder comparisons at fixed quality; what these
 * providers actually ship is a transcode whose HEVC ladder is not tuned as hard
 * as the marketing case, and overstating the factor promotes thin HEVC feeds
 * over healthy H.264 ones. Swept against a live install, over the 85 channels
 * that carry both codecs: HEVC takes slot 0 on 24 of them at 1.0, 25 at 1.3, 32
 * at 1.6 and 47 at 2.0 -- and the jump to 2.0 is where feeds start winning at
 * half the effective bitrate of what they displace. Seeded rather than
 * defaulted for the reason in `Weights`.
 */
export const NEW_INSTALL_HEVC_FACTOR = 1.6;

/**
 * The UHD bitrate ceiling for a fresh install: twice `MAX_BITRATE_KBPS`.
 *
 * Chosen to stop the saturation rather than to model UHD exactly -- at 24000
 * the live install's saturated streams fall from 23 to 20 and its 2160p score
 * ties from 11 to 9, while the 1080p population, which is 60% of every stream
 * measured, is untouched. A per-resolution reference table was tried first and
 * was worse in both directions: it saturated 606 of 2405 streams and tripled
 * the ties, because a 1080p reference low enough to matter clamps every healthy
 * 1080p feed to 1.0 and stops discriminating exactly where the streams are.
 */
export const NEW_INSTALL_UHD_BITRATE_KBPS = 24_000;

/**
 * A stream's bitrate in the units the bitrate term is normalised in.
 *
 * H.264 is the reference codec, so it and everything else pass through
 * unchanged: the factor describes HEVC's efficiency specifically, and applying
 * a guessed one to, say, mpeg2video would invent an advantage nobody measured.
 */
export function effectiveBitrateKbps(result: ProbeResult, weights: Weights): number {
  const codec = (result.videoCodec || '').toLowerCase();
  const hevc = codec === 'hevc' || codec === 'h265';
  return result.bitrateKbps * (hevc ? weights.hevcBitrateFactor : 1);
}

/** True when a stream is alive but too degraded to be worth offering. */
export function isUsable(
  result: ProbeResult,
  weights: Weights = DEFAULT_WEIGHTS,
  audioOnly = false,
): boolean {
  if (!result.alive) return false;
  // A slate is not a fallback. Alive, correctly sized, healthy bitrate -- and
  // showing nothing.
  if (result.black) return false;
  // For audio-only streams (or streams with no video codec/height), video bitrate floor (e.g. 500kbps) does not apply.
  if (audioOnly || (!result.videoCodec && !result.height)) {
    return result.audioBitrateKbps > 0 || result.bitrateKbps > 0 || result.audioChannels > 0;
  }
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
export function score(
  result: ProbeResult,
  weights: Weights = DEFAULT_WEIGHTS,
  audioOnly = false,
): number {
  if (!isUsable(result, weights, audioOnly)) return 0;

  if (audioOnly || (!result.videoCodec && !result.height)) {
    const channels = Math.min((result.audioChannels || 2) / MAX_AUDIO_CHANNELS, 1);
    const rate = Math.min(
      (result.audioBitrateKbps || result.bitrateKbps || 128) / MAX_AUDIO_KBPS,
      1,
    );
    const sampleRate = Math.min((result.audioSampleRate || 44100) / 48000, 1);
    let codec = 0.5;
    const ac = (result.audioCodec || '').toLowerCase();
    if (ac === 'flac' || ac === 'alac') codec = 1.0;
    else if (ac === 'eac3' || ac === 'ac3' || ac === 'aac') codec = 0.8;
    else if (ac === 'mp3') codec = 0.6;
    return (
      Math.round((channels * 0.4 + rate * 0.4 + sampleRate * 0.1 + codec * 0.1) * 10_000) / 10_000
    );
  }

  const resolution = result.height ? Math.min(result.height / MAX_HEIGHT, 1) : 0;
  // The ceiling follows the picture, not the stream: a UHD feed is judged
  // against what UHD costs. See `Weights.uhdBitrateKbps`.
  const ceiling = result.height >= UHD_HEIGHT ? weights.uhdBitrateKbps : MAX_BITRATE_KBPS;
  const bitrate =
    result.bitrateKbps && ceiling > 0
      ? Math.min(effectiveBitrateKbps(result, weights) / ceiling, 1)
      : 0;
  const fps = result.fps ? Math.min(result.fps / MAX_FPS, 1) : 0;

  let codec = 0;
  const name = (result.videoCodec || '').toLowerCase();
  const isHevc = name === 'hevc' || name === 'h265';
  const isH264 = name === 'h264' || name === 'avc';
  if (isHevc || isH264) {
    // Once `hevcBitrateFactor` prices HEVC's efficiency into the bitrate term,
    // paying for it again here counts it twice -- and the second payment is a
    // flat bonus that does not know how big the first one was, so it overturns
    // real bitrate deficits. Measured on a live install at the seeded factor:
    // 20 of the 25 channels that changed hands did so on this bonus *despite*
    // the HEVC stream having the lower effective bitrate, one of them at
    // 4594kbps against 7847. Above 1.0 the two codecs are therefore level here
    // and the bitrate term alone separates them, which is the whole point of
    // moving the correction onto it. `codec` still earns its weight: it is what
    // sinks mpeg2video and anything else that is neither.
    codec = weights.hevcBitrateFactor > 1 ? 1 : isHevc === weights.preferH265 ? 1 : 0.5;
  } else if (name) codec = 0.25;

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
export function rank(
  entries: RankEntry[],
  strategy: RankStrategy = DEFAULT_STRATEGY,
  audioOnly = false,
): number[] {
  const { weights, mode, providerRank } = strategy;
  return [...entries]
    .sort((a, b) => {
      const usable =
        (isUsable(a.result, weights, audioOnly) ? 0 : 1) -
        (isUsable(b.result, weights, audioOnly) ? 0 : 1);
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

      const scoreDelta = score(b.result, weights, audioOnly) - score(a.result, weights, audioOnly);
      if (scoreDelta !== 0) return scoreDelta;
      return a.streamId - b.streamId;
    })
    .map((entry) => entry.streamId);
}
