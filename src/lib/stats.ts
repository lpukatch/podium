/**
 * Probe results in the shape Dispatcharr's `stream_stats` holds.
 *
 * Its own module because two very different callers depend on it agreeing with
 * itself: the pass that publishes these numbers, and the rule check that scores
 * a Teamarr `stats_metric` rule against them. A second reading of the same
 * `ProbeResult` would be a second opinion, and the check would then be able to
 * agree with the probe while disagreeing with what Teamarr actually reads. The
 * stability record is part of that contract too: the score and the stability
 * keys below read it, so every caller passes the ledger's current view of a
 * stream or nothing at all -- never two different views of the same one.
 */

import { deadDetail, deadReason, isInterlaced, type ProbeResult } from './probe';
import { DEFAULT_WEIGHTS, frameRate, hdrFormat, score, type Weights } from './scoring';
import {
  describeStability,
  dropsPerHour,
  observedPlaying,
  type StabilityRecord,
  stabilityScore,
  tooUnstable,
} from './stability';

/**
 * The shape published to Dispatcharr's `stream_stats`.
 *
 * Key names follow what Dispatcharr's channel table renders: `resolution`,
 * `video_codec`, `audio_codec`, `source_fps` and `video_bitrate`. The bitrate is
 * `video_bitrate` (kbps) and not `bitrate_kbps` -- the frontend reads the former
 * and shows an empty badge for the latter. `audio_bitrate` and `sample_rate`
 * fill Dispatcharr's audio group, and `channel_layout` is the string its own
 * probe writes beside `audio_channels`. The remaining keys are podium-only
 * extras the UI ignores but that round-trip harmlessly.
 */
export function statsPayload(
  result: ProbeResult,
  weights: Weights = DEFAULT_WEIGHTS,
  stability?: StabilityRecord,
): Record<string, unknown> {
  return {
    width: result.width,
    height: result.height,
    resolution: result.width && result.height ? `${result.width}x${result.height}` : '0x0',
    /**
     * The frames a second a viewer actually gets, which for an interlaced feed
     * coded as fields is half what ffprobe reported -- see `frameRate`.
     *
     * The honest number rather than the raw reading, because this is the key
     * Dispatcharr's channel table renders and the one Teamarr's `stats_metric`
     * rules threshold against, and both were being told a 1080i25 feed was
     * 50fps. Note what that means for an existing `source_fps >= 50` rule: it
     * stops matching interlaced streams, which is the point -- they never
     * carried 50 frames. The raw reading is still published beside it.
     */
    source_fps: frameRate(result),
    /**
     * What ffprobe actually said, kept for the question this otherwise makes
     * unanswerable: why podium reports 25 where another tool reports 50.
     */
    reported_fps: result.fps,
    /** Why the two differ, when they do. `unknown` when ffprobe would not say. */
    scan_type: result.fieldOrder
      ? isInterlaced(result)
        ? 'interlaced'
        : 'progressive'
      : 'unknown',
    field_order: result.fieldOrder ?? '',
    video_codec: result.videoCodec,
    audio_codec: result.audioCodec,
    pixel_format: result.pixelFormat,
    /**
     * The transfer function, which is what tells HLG (`arib-std-b67`) from
     * HDR10/PQ (`smpte2084`). A provider carrying both flavours of the same
     * channel presents them identically in every other key here -- hevc,
     * yuv420p10le, 3840x2160 -- so this is the only handle a reader of these
     * stats has on which is which. Not one a Teamarr `stats_metric` rule can
     * use: those compare numbers only, and `is_unknown` fires on a string as
     * readily as on `null`. `null`, not `''`, when ffprobe did not say: live TS
     * streams often omit it, and a consumer has to be able to tell "unknown"
     * from a value. Older consumers ignore the unknown key.
     */
    color_transfer: result.colorTransfer ?? null,
    /** `bt2020` for either HDR flavour, `bt709` for SDR; `null` when unknown. */
    color_primaries: result.colorPrimaries ?? null,
    /**
     * The transfer as a number a `stats_metric` rule can threshold: `0` SDR,
     * `1` HLG, `2` HDR10/PQ, `null` when ffprobe did not say. See `hdrFormat`.
     */
    hdr_format: hdrFormat(result),
    audio_channels: result.audioChannels,
    channel_layout: result.channelLayout,
    audio_bitrate: Math.round(result.audioBitrateKbps),
    sample_rate: result.audioSampleRate,
    video_bitrate: Math.round(result.bitrateKbps),
    /**
     * The same number under the key Dispatcharr's own probe writes it to.
     *
     * This PATCH replaces `stream_stats` wholesale, so publishing only
     * `video_bitrate` does not merely fail to fill `ffmpeg_output_bitrate` in
     * -- it deletes whatever was there. Everything downstream reads the
     * Dispatcharr key: its channel table, and Teamarr's Stream Stats rules,
     * which is how a "bitrate >= 4000" rule ends up matching nothing on
     * exactly the streams Podium has measured most carefully. Both are
     * written, because `video_bitrate` is the one Podium's own history and
     * UI already read.
     */
    ffmpeg_output_bitrate: Math.round(result.bitrateKbps),
    bitrate_measured: Boolean(result.bitrateMeasured),
    blank_detected: Boolean(result.black),
    blank_seconds: result.blackSeconds ?? 0,
    /**
     * What the passive ledger has on this stream, in the same sentence the
     * check panel shows. The majority answer is "never observed playing",
     * which is itself the fact worth seeing: it says the stability score
     * beside it is an assumption, not a measurement.
     */
    stability: describeStability(stability),
    /**
     * The [0, 1] value the `stability` weight multiplies -- the one number a
     * reader needs to see how the term moved the score. `null` on a stream
     * the ledger has never seen play: absence is a gap, not full marks, and
     * `quality_score` below carries no stability term there. The sentence
     * above says the same thing in words.
     */
    stability_score: observedPlaying(stability)
      ? Math.round(stabilityScore(stability) * 10_000) / 10_000
      : null,
    /**
     * Failures per hour of observed watching. `null`, not 0, when the ledger
     * holds nothing: a stream nobody has watched must not read as a measured
     * zero, and a Teamarr `stats_metric` rule can tell the difference.
     */
    drops_per_hour: stability ? Math.round(dropsPerHour(stability) * 10) / 10 : null,
    /**
     * The `maxDropsPerHour` health check -- the cliff beside the weight. A
     * stream this flags has been sunk below every usable peer whatever its
     * picture looks like, and a reader wondering why a 4K feed sits under a
     * 720p one finds the answer here rather than in the score.
     */
    unstable: tooUnstable(stability, weights.maxDropsPerHour),
    /**
     * Includes the stability term: the same number `rank` computes, so the
     * score an operator reads is the score the ordering used. On a stream
     * never observed playing the term is excluded rather than counted as full
     * marks; the ordering sinks such a stream below the measured whatever
     * their scores, the way it already sank the bitrate-unmeasured. At the
     * default stability weight of 0 the term is inert and this is unchanged
     * to the last digit.
     */
    quality_score: score(result, weights, false, stability),
    alive: result.alive,
    /**
     * Why a dead verdict is dead, in the ten buckets `deadReason` folds
     * ffmpeg's stderr into -- the same vocabulary the dead-streams metric
     * counts, so a downstream reader can group or filter on it the way the
     * Prometheus labels already do. `null` while the stream is alive: absence
     * is a gap, not a bucket.
     */
    dead_reason: result.alive ? null : deadReason(result.error),
    /**
     * The failure in words, for the reader who wants the sentence rather than
     * the bucket: ffmpeg's message with the stream URL and any credential it
     * carried removed -- see `deadDetail`. The URL is redundant in a row that
     * already names the stream, and publishing it put provider logins in
     * Dispatcharr's database. `'dead'` when the probe had nothing to say, and
     * always a string: `'ok'` and `'black screen'` for the living.
     */
    quality_reason: !result.alive
      ? deadDetail(result.error) || 'dead'
      : result.black
        ? 'black screen'
        : 'ok',
    probed_by: 'podium',
    probed_at: new Date().toISOString(),
  };
}
