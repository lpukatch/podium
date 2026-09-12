/**
 * Telling HLG apart from HDR10.
 *
 * Both present to ffprobe as hevc / yuv420p10le / 3840x2160, so nothing in the
 * published stats separated a provider's HLG variant of a channel from its PQ
 * one. `color_transfer` is the discriminator (`arib-std-b67` vs `smpte2084`),
 * with `color_primaries` beside it, and both were already in the ffprobe
 * output being thrown away.
 */

import { describe, expect, it } from 'vitest';
import { type ProbeResult, parsePayload } from './probe';
import { statsPayload } from './stats';

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    alive: true,
    width: 3840,
    height: 2160,
    fps: 50,
    bitrateKbps: 12_000,
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

function hdr(color_transfer?: string, color_primaries?: string) {
  return parsePayload({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'hevc',
        width: 3840,
        height: 2160,
        avg_frame_rate: '50/1',
        pix_fmt: 'yuv420p10le',
        ...(color_transfer ? { color_transfer } : {}),
        ...(color_primaries ? { color_primaries } : {}),
      },
    ],
  });
}

describe('reading colour metadata from ffprobe', () => {
  it('carries the HLG transfer function through', () => {
    const parsed = hdr('arib-std-b67', 'bt2020');
    expect(parsed.colorTransfer).toBe('arib-std-b67');
    expect(parsed.colorPrimaries).toBe('bt2020');
  });

  it('carries the PQ transfer function through', () => {
    const parsed = hdr('smpte2084', 'bt2020');
    expect(parsed.colorTransfer).toBe('smpte2084');
    expect(parsed.colorPrimaries).toBe('bt2020');
  });

  /** Live TS streams routinely omit both; absence must not read as a value. */
  it('omits both when ffprobe did not report them', () => {
    const parsed = hdr();
    expect(parsed.colorTransfer).toBeUndefined();
    expect(parsed.colorPrimaries).toBeUndefined();
  });

  it('carries one without the other', () => {
    const parsed = hdr('bt709');
    expect(parsed.colorTransfer).toBe('bt709');
    expect(parsed.colorPrimaries).toBeUndefined();
  });
});

describe('what gets published to Dispatcharr', () => {
  /**
   * Same channel, two provider variants -- indistinguishable in every field
   * published before this. A Teamarr ordering rule can now prefer one.
   */
  it('separates an HLG stream from a PQ one', () => {
    const a = statsPayload(probe({ colorTransfer: 'arib-std-b67', colorPrimaries: 'bt2020' }));
    const b = statsPayload(probe({ colorTransfer: 'smpte2084', colorPrimaries: 'bt2020' }));
    expect(a.color_transfer).toBe('arib-std-b67');
    expect(b.color_transfer).toBe('smpte2084');
    expect(a.color_primaries).toBe('bt2020');
    expect(b.color_primaries).toBe('bt2020');
    expect(a.pixel_format).toBe(b.pixel_format);
  });

  it('publishes an SDR stream as bt709', () => {
    const stats = statsPayload(probe({ colorTransfer: 'bt709', colorPrimaries: 'bt709' }));
    expect(stats.color_transfer).toBe('bt709');
    expect(stats.color_primaries).toBe('bt709');
  });

  /** Null, not an empty string: a consumer must be able to tell "unknown" from a value. */
  it('publishes null when ffprobe did not say', () => {
    const stats = statsPayload(probe());
    expect(stats.color_transfer).toBeNull();
    expect(stats.color_primaries).toBeNull();
  });

  it('leaves every existing key as it was', () => {
    const before = statsPayload(probe());
    const after = statsPayload(probe({ colorTransfer: 'smpte2084', colorPrimaries: 'bt2020' }));
    const { color_transfer: _t, color_primaries: _p, probed_at: _a, ...restBefore } = before;
    const { color_transfer: _t2, color_primaries: _p2, probed_at: _a2, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);
  });
});
