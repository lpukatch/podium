/**
 * The published payload, against the contract the module doc states: whatever
 * `statsPayload` writes is both what Dispatcharr's Advanced Stats shows and
 * what a Teamarr `stats_metric` rule is simulated against, so the stability
 * keys and the score have to say the same thing about the same stream.
 */

import { describe, expect, it } from 'vitest';
import type { ProbeResult } from './probe';
import { DEFAULT_WEIGHTS, type Weights } from './scoring';
import type { StabilityRecord } from './stability';
import { statsPayload } from './stats';

const result = (over: Partial<ProbeResult> = {}): ProbeResult => ({
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
  bitrateMeasured: true,
  black: false,
  blackSeconds: 0,
  elapsedMs: 1000,
  error: '',
  ...over,
});

const record = (over: Partial<StabilityRecord> = {}): StabilityRecord => ({
  streamId: 77013,
  legs: 1,
  breaks: 0,
  stalls: 0,
  watchedMs: 0,
  stalledMs: 0,
  lastSeenAt: 0,
  ...over,
});

describe('statsPayload stability keys', () => {
  it('publishes an unmeasured stream as unmeasured, not as a measured zero', () => {
    const stats = statsPayload(result());
    expect(stats.stability).toBe('never observed playing');
    // Null, not 1: an unwatched stream has no stability verdict to report,
    // and quality_score below carries no stability term for it either.
    expect(stats.stability_score).toBeNull();
    expect(stats.drops_per_hour).toBeNull();
    expect(stats.unstable).toBe(false);
  });

  it('derives the keys from the ledger record', () => {
    // Two breaks over two hours: the tolerated rate, so half marks.
    const stats = statsPayload(
      result(),
      DEFAULT_WEIGHTS,
      record({ breaks: 2, legs: 2, watchedMs: 2 * 3_600_000 }),
    );
    expect(stats.stability).toBe('2.0h watched, 2 drops (1.0/h)');
    expect(stats.stability_score).toBe(0.5);
    expect(stats.drops_per_hour).toBe(1);
  });

  it('flags a stream the maxDropsPerHour health check would sink', () => {
    const over = { ...DEFAULT_WEIGHTS, maxDropsPerHour: 0.5 } satisfies Weights;
    const flapping = record({ breaks: 3, legs: 3, watchedMs: 3_600_000 });
    expect(statsPayload(result(), over, flapping).unstable).toBe(true);
    // The evidence floor applies: one failure is not a verdict.
    expect(statsPayload(result(), over, record({ breaks: 1, watchedMs: 60_000 })).unstable).toBe(
      false,
    );
  });

  it('leaves quality_score untouched while the stability weight is zero', () => {
    const flapping = record({ breaks: 2, legs: 2, watchedMs: 2 * 3_600_000 });
    const withRecord = statsPayload(result(), DEFAULT_WEIGHTS, flapping).quality_score as number;
    const without = statsPayload(result(), DEFAULT_WEIGHTS).quality_score as number;
    expect(withRecord).toBe(without);
  });

  it('excludes the term for an unmeasured stream, whatever the weight', () => {
    const weighted = { ...DEFAULT_WEIGHTS, stability: 1 } satisfies Weights;
    // However high the weight, a stream nobody has watched scores on its
    // measured terms alone -- numerically the score it had at weight 0.
    expect(statsPayload(result(), weighted).quality_score).toBe(
      statsPayload(result(), DEFAULT_WEIGHTS).quality_score,
    );
  });

  it('moves quality_score with the term once the weight is raised', () => {
    const weighted = { ...DEFAULT_WEIGHTS, stability: 1 } satisfies Weights;
    const flapping = record({ breaks: 2, legs: 2, watchedMs: 2 * 3_600_000 });
    const withRecord = statsPayload(result(), weighted, flapping).quality_score as number;
    const without = statsPayload(result(), weighted).quality_score as number;
    // The flapping one carries a half-marks term; the unmeasured one carries
    // none. So it scores below the unmeasured stream on numbers alone --
    // which is why `rank` sinks the unmeasured below the measured outright
    // rather than leaving the comparison to the score.
    expect(withRecord).toBeLessThan(without);
  });
});

describe('statsPayload dead keys', () => {
  it('publishes the failure without the stream it came from', () => {
    // The shape of a real stored error, credential placeholdered: the URL was
    // the part that made every dead stream unique and carried the provider
    // login into Dispatcharr's database. The message is the part that says why.
    const stats = statsPayload(
      result({
        alive: false,
        width: 0,
        height: 0,
        error: 'http://prov.tv/live/user/pass/48935.ts: Server returned 400 Bad Request',
      }),
    );
    expect(stats.quality_reason).toBe('Server returned 400 Bad Request');
    expect(stats.dead_reason).toBe('client_error');
    // Nothing the probe had to say was lost to the reader who wants it all.
    expect(stats.alive).toBe(false);
  });

  it('keeps a bounded word when the probe had nothing to say', () => {
    const stats = statsPayload(result({ alive: false, error: '' }));
    expect(stats.quality_reason).toBe('dead');
    expect(stats.dead_reason).toBe('other');
  });

  it('is a bucket and null rather than a string for the living', () => {
    const ok = statsPayload(result());
    expect(ok.quality_reason).toBe('ok');
    expect(ok.dead_reason).toBeNull();
    const black = statsPayload(result({ black: true, blackSeconds: 4 }));
    expect(black.quality_reason).toBe('black screen');
    expect(black.dead_reason).toBeNull();
  });
});
