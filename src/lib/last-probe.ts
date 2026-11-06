import type { Eligibility } from './eligibility';
import type { ProbeResult } from './probe';
import { belowBitrateFloor, frameRate, hdrFormat, type Weights } from './scoring';

/** A folded cached verdict, as `Store.verdicts()` returns one. */
export interface CachedVerdict {
  probedAt: number;
  alive: boolean;
  result: ProbeResult;
}

/**
 * What a reader is told about one probe: the measured fields as they are, and
 * the derived ones as the rest of Podium derives them. `fps` is what
 * `statsPayload` publishes as `source_fps`, and `lowBitrate` is the floor
 * `isHealthy` applies, judged against `weights` -- the floor the ranking
 * resolved, not one of its own.
 *
 * The single mapping behind both `lastProbeFields` and `/api/probe-history`,
 * so the cached verdict and the history can never describe the same probe
 * differently.
 */
export function probeFields(result: ProbeResult, weights: Weights, audioOnly = false) {
  return {
    black: result.black ?? null,
    lowBitrate: belowBitrateFloor(result, weights, audioOnly),
    width: result.width,
    height: result.height,
    // The rate a viewer gets, as `source_fps` publishes it -- see `frameRate`.
    fps: frameRate(result),
    videoCodec: result.videoCodec,
    // `null` when ffprobe declared no transfer.
    hdrFormat: hdrFormat(result),
    bitrateKbps: result.bitrateKbps,
    audioCodec: result.audioCodec,
    audioChannels: result.audioChannels,
    channelLayout: result.channelLayout,
    audioBitrateKbps: result.audioBitrateKbps,
    audioSampleRate: result.audioSampleRate,
  };
}

/**
 * The `last*` fields a reader is told about a stream's cached verdict, without
 * probing again: `probeFields` of the verdict, prefixed. Every one is `null`
 * for a stream nothing has probed yet, so a reader can tell "unknown" from a
 * value.
 *
 * Shared by `/api/preview` and `/api/verdicts` so the two can never describe
 * the same stream differently.
 */
export function lastProbeFields(
  verdict: CachedVerdict | undefined,
  weights: Weights,
  audioOnly = false,
) {
  const last = verdict ? probeFields(verdict.result, weights, audioOnly) : undefined;
  return {
    lastProbedAt: verdict?.probedAt ?? null,
    lastAlive: verdict?.alive ?? null,
    lastWidth: last?.width ?? null,
    lastHeight: last?.height ?? null,
    lastFps: last?.fps ?? null,
    lastVideoCodec: last?.videoCodec ?? null,
    lastHdrFormat: last?.hdrFormat ?? null,
    lastBitrateKbps: last?.bitrateKbps ?? null,
    lastLowBitrate: last?.lowBitrate ?? null,
    lastAudioCodec: last?.audioCodec ?? null,
    lastAudioChannels: last?.audioChannels ?? null,
    lastChannelLayout: last?.channelLayout ?? null,
    lastAudioBitrateKbps: last?.audioBitrateKbps ?? null,
    lastAudioSampleRate: last?.audioSampleRate ?? null,
    lastBlack: last?.black ?? null,
  };
}

/**
 * Whether each catalogued stream is exempt from the video floor, for readers
 * that list a stream once however many channels carry it.
 *
 * The floor is a per-channel judgement: an audio-only channel does not apply
 * it. A stream reads as low when any channel carrying it would call it low, so
 * it is exempt only when every carrier is audio-only. A channel's group comes
 * from the live snapshot, as the other readers resolve it; one the snapshot no
 * longer has falls back to the default policy.
 */
export function audioOnlyByStream(
  rows: ReadonlyArray<{ channelId: number; streamId: number }>,
  snap: {
    channels: ReadonlyArray<{ id: number; groupId: number | null }>;
    groups: ReadonlyArray<{ id: number; name: string }>;
  },
  eligibility: Eligibility,
): Map<number, boolean> {
  const groupOf = new Map(snap.channels.map((c) => [c.id, c.groupId]));
  const groupNames = new Map(snap.groups.map((g) => [g.id, g.name]));
  const out = new Map<number, boolean>();
  for (const row of rows) {
    const groupId = groupOf.get(row.channelId) ?? null;
    const audioOnly = Boolean(
      eligibility.policyFor(groupId, groupId == null ? undefined : groupNames.get(groupId))
        .audioOnly,
    );
    out.set(row.streamId, (out.get(row.streamId) ?? true) && audioOnly);
  }
  return out;
}
