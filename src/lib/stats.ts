/**
 * Probe results in the shape Dispatcharr's `stream_stats` holds.
 *
 * Its own module because two very different callers depend on it agreeing with
 * itself: the pass that publishes these numbers, and the rule check that scores
 * a Teamarr `stats_metric` rule against them. A second reading of the same
 * `ProbeResult` would be a second opinion, and the check would then be able to
 * agree with the probe while disagreeing with what Teamarr actually reads.
 */

import { isInterlaced, type ProbeResult } from './probe';
import { DEFAULT_WEIGHTS, frameRate, score, type Weights } from './scoring';

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
    quality_score: score(result, weights),
    alive: result.alive,
    quality_reason: !result.alive ? result.error || 'dead' : result.black ? 'black screen' : 'ok',
    probed_by: 'podium',
    probed_at: new Date().toISOString(),
  };
}
