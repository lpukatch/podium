/**
 * Telling 50i apart from 50p.
 *
 * A provider's 1080i25 feed can present to ffprobe as 50fps, because an
 * encoder that codes fields separately gives it 50 coded pictures a second.
 * Nothing downstream could see the difference, so the interlaced stream won the
 * fps term outright and -- carrying the better bitrate, which interlacing is
 * cheap enough to afford -- outranked genuine 50p feeds. `field_order` is the
 * discriminator, and it was already in the ffprobe output being thrown away.
 */

import { describe, expect, it } from 'vitest';
import { isInterlaced, type ProbeResult, parseFps, parsePayload } from './probe';
import { DEFAULT_WEIGHTS, frameRate, score } from './scoring';
import { statsPayload } from './stats';

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    alive: true,
    width: 1920,
    height: 1080,
    fps: 50,
    bitrateKbps: 6000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    pixelFormat: 'yuv420p',
    audioChannels: 2,
    channelLayout: 'stereo',
    audioBitrateKbps: 128,
    audioSampleRate: 48_000,
    elapsedMs: 100,
    error: '',
    ...over,
  };
}

describe('isInterlaced', () => {
  it('counts every field order ffprobe reports as interlaced', () => {
    for (const order of ['tt', 'bb', 'tb', 'bt']) {
      expect(isInterlaced({ fieldOrder: order })).toBe(true);
    }
  });

  /**
   * The case that decides whether this is safe to apply by default: a short
   * read of a live TS often cannot resolve the field order, and guessing
   * "interlaced" there would halve the rate of streams nobody established
   * anything about.
   */
  it('treats progressive, unknown and absent as not interlaced', () => {
    expect(isInterlaced({ fieldOrder: 'progressive' })).toBe(false);
    expect(isInterlaced({ fieldOrder: 'unknown' })).toBe(false);
    expect(isInterlaced({ fieldOrder: undefined })).toBe(false);
  });
});

describe('frameRate', () => {
  it('reads a field rate as the frames it actually carries', () => {
    expect(frameRate({ fps: 50, fieldOrder: 'tt' })).toBe(25);
    expect(frameRate({ fps: 59.94, fieldOrder: 'bb' })).toBeCloseTo(29.97, 5);
  });

  it('leaves progressive rates alone', () => {
    expect(frameRate({ fps: 50, fieldOrder: 'progressive' })).toBe(50);
    expect(frameRate({ fps: 60, fieldOrder: 'unknown' })).toBe(60);
    expect(frameRate({ fps: 50 })).toBe(50);
  });

  /**
   * The other way ffprobe reports interlaced content. 25 is already the frame
   * rate, so halving it would report 12.5fps for a normal broadcast feed.
   */
  it('leaves an interlaced stream already quoting coded frames alone', () => {
    expect(frameRate({ fps: 25, fieldOrder: 'tt' })).toBe(25);
    expect(frameRate({ fps: 30, fieldOrder: 'tt' })).toBe(30);
  });

  it('has nothing to say about a stream with no rate at all', () => {
    expect(frameRate({ fps: 0, fieldOrder: 'tt' })).toBe(0);
  });
});

describe('ranking 50i against 50p', () => {
  /** The complaint: 50i wins on bitrate and is not paying for its half rate. */
  it('no longer scores 50i as if it were 50p', () => {
    const interlaced = probe({ fps: 50, fieldOrder: 'tt' });
    const progressive = probe({ fps: 50, fieldOrder: 'progressive' });
    expect(score(interlaced, DEFAULT_WEIGHTS)).toBeLessThan(score(progressive, DEFAULT_WEIGHTS));
  });

  it('scores 50i exactly as the 25p feed it is', () => {
    const interlaced = probe({ fps: 50, fieldOrder: 'tt' });
    const truly25 = probe({ fps: 25, fieldOrder: 'progressive' });
    expect(score(interlaced, DEFAULT_WEIGHTS)).toBe(score(truly25, DEFAULT_WEIGHTS));
  });

  /**
   * The penalty is the fps term and nothing else: a 50i stream with a real
   * bitrate advantage may still deserve to win, and this must not be a veto.
   */
  it('still lets a much better 50i stream beat a poor 50p one', () => {
    const interlaced = probe({ fps: 50, fieldOrder: 'tt', bitrateKbps: 12_000 });
    const progressive = probe({ fps: 50, fieldOrder: 'progressive', bitrateKbps: 1200 });
    expect(score(interlaced, DEFAULT_WEIGHTS)).toBeGreaterThan(score(progressive, DEFAULT_WEIGHTS));
  });

  /** Verdicts cached before `fieldOrder` existed must rank exactly as before. */
  it('leaves a verdict with no field order scoring what it always did', () => {
    expect(score(probe({ fps: 50 }), DEFAULT_WEIGHTS)).toBe(
      score(probe({ fps: 50, fieldOrder: 'progressive' }), DEFAULT_WEIGHTS),
    );
  });
});

describe('parseFps falls back past an undeterminable rate', () => {
  /**
   * ffprobe returns the string `0/0`, it does not omit the key, so the old
   * `avg_frame_rate ?? r_frame_rate` never reached the fallback and the stream
   * scored zero on fps.
   */
  it('reads r_frame_rate when avg_frame_rate is 0/0', () => {
    const parsed = parsePayload({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          avg_frame_rate: '0/0',
          r_frame_rate: '25/1',
        },
      ],
    });
    expect(parsed.fps).toBe(25);
  });

  it('still prefers avg_frame_rate when it is usable', () => {
    const parsed = parsePayload({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          avg_frame_rate: '25/1',
          r_frame_rate: '50/1',
          field_order: 'tt',
        },
      ],
    });
    expect(parsed.fps).toBe(25);
    expect(parsed.fieldOrder).toBe('tt');
  });

  it('reports 0 when neither rate resolves', () => {
    expect(parseFps('0/0')).toBe(0);
    const parsed = parsePayload({
      streams: [{ codec_type: 'video', codec_name: 'h264', avg_frame_rate: '0/0' }],
    });
    expect(parsed.fps).toBe(0);
  });

  /** No video track means no field order to carry. */
  it('omits fieldOrder when ffprobe did not report one', () => {
    const parsed = parsePayload({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          avg_frame_rate: '50/1',
        },
      ],
    });
    expect(parsed.fieldOrder).toBeUndefined();
  });
});

describe('what gets published to Dispatcharr', () => {
  /**
   * `source_fps` is what Dispatcharr's channel table renders and what Teamarr's
   * `stats_metric` rules threshold against, so it is the number that has to be
   * true. Both read it through this one function -- see the note on the module
   * -- so they cannot end up disagreeing about it.
   */
  it('publishes the frames a viewer gets, not the field rate', () => {
    const stats = statsPayload(probe({ fps: 50, fieldOrder: 'tt' }));
    expect(stats.source_fps).toBe(25);
    expect(stats.reported_fps).toBe(50);
    expect(stats.scan_type).toBe('interlaced');
    expect(stats.field_order).toBe('tt');
  });

  it('leaves a progressive stream reading exactly as it always did', () => {
    const stats = statsPayload(probe({ fps: 50, fieldOrder: 'progressive' }));
    expect(stats.source_fps).toBe(50);
    expect(stats.reported_fps).toBe(50);
    expect(stats.scan_type).toBe('progressive');
  });

  /** A verdict cached before `fieldOrder` existed must publish what it used to. */
  it('publishes the raw reading when the scan type is unknown', () => {
    const stats = statsPayload(probe({ fps: 50 }));
    expect(stats.source_fps).toBe(50);
    expect(stats.scan_type).toBe('unknown');
    expect(stats.field_order).toBe('');
  });
});
