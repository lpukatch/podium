import { describe, expect, it } from 'vitest';
import { lastProbeFields, probeFields } from './last-probe';
import { DEAD, type ProbeResult, parsePayload } from './probe';
import { DEFAULT_WEIGHTS } from './scoring';
import { statsPayload } from './stats';

const multiTrack = (): ProbeResult => ({
  ...parsePayload({
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
      {
        index: 1,
        codec_type: 'audio',
        codec_name: 'aac',
        channels: 2,
        channel_layout: 'stereo',
        bit_rate: '96000',
        sample_rate: '48000',
        tags: { language: 'SPA' },
      },
      {
        index: 3,
        codec_type: 'audio',
        codec_name: 'ac3',
        channels: 6,
        channel_layout: '5.1(side)',
        bit_rate: '384000',
        sample_rate: '48000',
        tags: { language: 'eng' },
      },
      { index: 4, codec_type: 'subtitle', tags: { language: 'fra' } },
      { index: 5, codec_type: 'audio', codec_name: 'aac', tags: { language: 'und' } },
      { codec_type: 'audio', codec_name: 'mp2' },
    ],
  }),
  elapsedMs: 10,
  error: '',
});

describe('multi-track audio publication', () => {
  it('preserves source order and actual indices while keeping the richest-track summary', () => {
    const result = multiTrack();
    expect(result.audioTracks).toHaveLength(4);
    expect(result.audioTracks?.map((track) => track.index)).toEqual([1, 3, 5, undefined]);
    expect(result.audioLanguage).toBe('eng');
    expect(result.audioCodec).toBe('ac3');
    expect(result.audioChannels).toBe(6);
    expect(result.channelLayout).toBe('5.1(side)');
    expect(result.audioTracks?.[0]?.language).toBe('spa');
    expect(result.audioTracks?.[2]?.language).toBeUndefined();
    expect(result.audioTracks?.[3]?.language).toBeUndefined();
  });

  it('publishes Dispatcharr track layouts, languages and kbps after a cache round trip', () => {
    const result = JSON.parse(JSON.stringify(multiTrack())) as ProbeResult;
    const stats = statsPayload(result);
    expect(stats.audio_streams).toEqual([
      {
        index: 1,
        audio_language: 'spa',
        audio_codec: 'aac',
        audio_channels: 'stereo',
        audio_bitrate: 96,
        sample_rate: 48000,
      },
      {
        index: 3,
        audio_language: 'eng',
        audio_codec: 'ac3',
        audio_channels: '5.1',
        audio_bitrate: 384,
        sample_rate: 48000,
      },
      { index: 5, audio_codec: 'aac', audio_channels: '' },
      { audio_codec: 'mp2', audio_channels: '' },
    ]);
    expect(stats.audio_language).toBe('eng');
    expect(stats.audio_channels).toBe(6);
    expect(probeFields(result, DEFAULT_WEIGHTS).audioTracks).toEqual(result.audioTracks);
    expect(
      lastProbeFields({ result, alive: true, probedAt: 1 }, DEFAULT_WEIGHTS).lastAudioTracks,
    ).toEqual(result.audioTracks);
  });

  it('distinguishes older cached results from a measured absence of audio', () => {
    const old = { ...DEAD, alive: true, elapsedMs: 1, error: '' };
    expect(statsPayload(old)).not.toHaveProperty('audio_streams');
    expect(probeFields(old, DEFAULT_WEIGHTS).audioTracks).toBeNull();
    const silent = {
      ...parsePayload({ streams: [{ codec_type: 'video' }] }),
      elapsedMs: 1,
      error: '',
    };
    expect(statsPayload(silent).audio_streams).toEqual([]);
  });

  it('retains tracks for audio-only feeds and does not invent a language', () => {
    const result = parsePayload(
      { streams: [{ index: 0, codec_type: 'audio', codec_name: 'aac', channels: 2 }] },
      true,
    );
    expect(result.alive).toBe(true);
    expect(result.audioLanguage).toBeUndefined();
    expect(statsPayload({ ...result, elapsedMs: 1, error: '' }).audio_streams).toEqual([
      { index: 0, audio_codec: 'aac', audio_channels: 'stereo' },
    ]);
  });
});
