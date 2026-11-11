import type { ProbeResult } from './probe';
import { belowBitrateFloor, frameRate, hdrFormat, type Weights } from './scoring';

/** A folded cached verdict, as `Store.verdicts()` returns one. */
export interface CachedVerdict {
  probedAt: number;
  alive: boolean;
  result: ProbeResult;
}

/**
 * The `last*` fields a reader is told about a stream's cached verdict, without
 * probing again. Every one is `null` for a stream nothing has probed yet, so a
 * reader can tell "unknown" from a value.
 *
 * Shared by `/api/preview` and `/api/verdicts` so the two can never describe
 * the same stream differently. Two fields are derived rather than copied, and
 * each from the code it has to agree with: `lastFps` is what `statsPayload`
 * publishes as `source_fps`, and `lastLowBitrate` is the floor `isHealthy`
 * applies, judged against `weights` -- the floor the ranking resolved.
 */
export function lastProbeFields(
  verdict: CachedVerdict | undefined,
  weights: Weights,
  audioOnly = false,
) {
  const last = verdict?.result;
  return {
    lastProbedAt: verdict?.probedAt ?? null,
    lastAlive: verdict?.alive ?? null,
    lastWidth: last?.width ?? null,
    lastHeight: last?.height ?? null,
    // The rate a viewer gets, as `source_fps` publishes it -- see `frameRate`.
    lastFps: last ? frameRate(last) : null,
    lastVideoCodec: last?.videoCodec ?? null,
    // `null` both when unprobed and when ffprobe declared no transfer.
    lastHdrFormat: last ? hdrFormat(last) : null,
    lastBitrateKbps: last?.bitrateKbps ?? null,
    lastLowBitrate: last ? belowBitrateFloor(last, weights, audioOnly) : null,
    lastAudioCodec: last?.audioCodec ?? null,
    lastAudioChannels: last?.audioChannels ?? null,
    lastChannelLayout: last?.channelLayout ?? null,
    lastAudioBitrateKbps: last?.audioBitrateKbps ?? null,
    lastAudioSampleRate: last?.audioSampleRate ?? null,
    lastBlack: last?.black ?? null,
  };
}
