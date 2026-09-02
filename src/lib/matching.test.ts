import { describe, expect, it } from 'vitest';
import {
  convert,
  decompose,
  hasUnescaped,
  scopeOf,
  splitTopLevel,
  unescapeLiteral,
} from './legacy';
import type { StreamLike } from './matcher';
import { matchKey, normalize } from './normalize';
import { resolveOrdering } from './ordering';
import type { ProbeResult } from './probe';
import { parseFps, parsePayload, pickAudio } from './probe';
import { EMPTY_RULES_DOC, loadRules } from './rules';
import { statsPayload } from './runner';
import {
  audioScore,
  DEFAULT_STRATEGY,
  DEFAULT_WEIGHTS,
  effectiveBitrateKbps,
  isUsable,
  NEW_INSTALL_AUDIO,
  NEW_INSTALL_HEVC_FACTOR,
  NEW_INSTALL_UHD_BITRATE_KBPS,
  type RankStrategy,
  rank,
  score,
} from './scoring';

const alive = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  alive: true,
  width: 1920,
  height: 1080,
  fps: 30,
  bitrateKbps: 5000,
  videoCodec: 'h264',
  audioCodec: 'aac',
  pixelFormat: 'yuv420p',
  audioChannels: 2,
  channelLayout: 'stereo',
  audioBitrateKbps: 128,
  audioSampleRate: 48_000,
  elapsedMs: 0,
  error: '',
  ...over,
});

const dead: ProbeResult = {
  alive: false,
  width: 0,
  height: 0,
  fps: 0,
  bitrateKbps: 0,
  videoCodec: '',
  audioCodec: '',
  pixelFormat: '',
  audioChannels: 0,
  channelLayout: '',
  audioBitrateKbps: 0,
  audioSampleRate: 0,
  elapsedMs: 0,
  error: 'timeout',
};

const stream = (id: number, name: string, providerId = 1): StreamLike => ({ id, name, providerId });

const grouped = (id: number, name: string, groupId: number): StreamLike => ({
  id,
  name,
  providerId: 1,
  groupId,
});

function matcherFor(channel: Record<string, unknown>, defaults: Record<string, unknown> = {}) {
  return loadRules({ schema: 2, defaults, channels: [{ enabled: true, ...channel }] }).matcher;
}

describe('normalize', () => {
  it('strips prefixes and quality suffixes', () => {
    const n = normalize('USA: HBO East FHD H265');
    expect(n.name).toBe('HBO East');
    expect(n.prefixes).toEqual(['USA']);
    expect(n.quality.tier).toBe('fhd');
    expect(n.quality.codec).toBe('hevc');
  });

  it('handles unicode decoration', () => {
    expect(normalize('⁨HBO East⁩ ᴴᴰ').name).toBe('HBO East');
  });

  it('detects timeshift channels', () => {
    expect(normalize('HBO +1').isTimeshift).toBe(true);
    expect(normalize('HBO East').isTimeshift).toBe(false);
  });

  it('reads resolution and fps', () => {
    const n = normalize('Sky Sports Main Event 1080p 60fps');
    expect(n.quality.height).toBe(1080);
    expect(n.quality.fps).toBe(60);
  });

  it('folds case and punctuation in the match key', () => {
    expect(matchKey('The Discovery-Channel')).toBe(matchKey('THE DISCOVERY CHANNEL'));
  });

  it('keeps + significant', () => {
    // 'AMC' and 'AMC+' are different channels and must not collapse.
    expect(matchKey('AMC')).not.toBe(matchKey('AMC+'));
    expect(matchKey('Paramount+')).not.toBe(matchKey('Paramount'));
  });

  it('lifts a bracketed prefix', () => {
    // The opening bar put the separator at offset zero, which broke the segment
    // scan before it started and left the bracket welded to the name.
    const n = normalize('|XX| Movie Network');
    expect(n.name).toBe('Movie Network');
    expect(n.prefixes).toEqual(['XX']);
  });

  it('lifts several bracketed prefixes', () => {
    const n = normalize('|XX| |SPORT| Movie Network HD');
    expect(n.name).toBe('Movie Network');
    expect(n.prefixes).toEqual(['XX', 'SPORT']);
  });

  it('lifts a square-bracketed prefix', () => {
    // "[USA] COMEDY CENTRAL HD" and "US: COMEDY CENTRAL HD" sit side by side in
    // the same catalogue. The bracketed one used to lift nothing, so it was the
    // one copy no `@` qualifier and no region denylist could reach.
    const n = normalize('[USA] COMEDY CENTRAL HD');
    expect(n.name).toBe('COMEDY CENTRAL');
    expect(n.prefixes).toEqual(['USA']);
    expect(n.quality.tier).toBe('hd');
    // Still a bracket too: a `~USA` written before this existed keeps working.
    expect(n.brackets).toEqual(['USA']);
  });

  it('lifts a bracketed prefix ahead of a punctuated one', () => {
    const n = normalize('[USA] SPORTS: ESPN FHD');
    expect(n.name).toBe('ESPN');
    expect(n.prefixes).toEqual(['USA', 'SPORTS']);
  });

  it('leaves a bracket that is not at the front out of the prefixes', () => {
    // Only the leading position reads as a section. A bracket written next to
    // the name is a variant marker and stays reachable by `~` alone.
    const n = normalize('FS1 4K (Event Only)');
    expect(n.prefixes).toEqual([]);
    expect(n.brackets).toEqual(['Event Only']);
  });

  it('strips market tags that trail the quality marker', () => {
    const n = normalize('Sports Alpha 1 HD TH MY');
    expect(n.name).toBe('Sports Alpha 1');
    expect(n.regions).toEqual(['TH', 'MY']);
    // The tags used to halt the right-to-left scan, so the quality marker
    // behind them was never read either.
    expect(n.quality.tier).toBe('hd');
  });

  it('keeps a country code that is part of the name', () => {
    // 'ID' is Indonesia and 'IT' is Italy, but here they are the channel. Only a
    // quality token to their left marks them as tail noise.
    expect(normalize('Discovery ID').name).toBe('Discovery ID');
    expect(normalize('Discovery ID HD').name).toBe('Discovery ID');
    expect(normalize('Sky Atlantic IT').name).toBe('Sky Atlantic IT');
    expect(normalize('Sports Alpha 1 TH MY').name).toBe('Sports Alpha 1 TH MY');
  });

  it('keeps a market tag left of the quality marker', () => {
    const n = normalize('Sports Alpha MY HD');
    expect(n.name).toBe('Sports Alpha MY');
    expect(n.regions).toEqual([]);
  });

  it('preserves hyphens in names without surrounding spaces', () => {
    expect(normalize('Sci-Fi Channel HD').name).toBe('Sci-Fi Channel');
    expect(normalize('UK-FAST: Sports Alpha Main Event').prefixes).toEqual(['UK-FAST']);
  });

  /**
   * A dash is not a separator, and the attempt to make it one is why this test
   * exists. " - " reads as a prefix delimiter in "US - ANIMAL PLANET" and as
   * part of the name in every "TNT - HD" a provider ships, and normalisation
   * cannot tell the two apart from the name alone. Lifting it globally ate the
   * second kind whole: "TNT - HD" lifted "TNT" into `prefixes`, the quality
   * scan consumed "HD", and the name keyed to the empty string -- so the alias
   * that used to claim it matched nothing, silently, across the catalogue.
   *
   * Making this work needs the operator to say which providers name channels
   * that way. Until then the dash stays in the name.
   */
  it('does not lift a dash-separated head into a prefix', () => {
    expect(normalize('TNT - HD').name).toBe('TNT');
    expect(normalize('TNT - HD').prefixes).toEqual([]);
    expect(normalize('BBC One - London HD').name).toBe('BBC One - London');
    expect(normalize('US - ANIMAL PLANET FHD').prefixes).toEqual([]);
  });
});

describe('scoring', () => {
  it('scores a dead stream zero', () => {
    expect(score(dead)).toBe(0);
  });

  it('prefers higher resolution', () => {
    expect(score(alive({ height: 1080 }))).toBeGreaterThan(score(alive({ height: 720 })));
  });

  it('sinks dead streams below live ones regardless of step', () => {
    expect(
      rank([
        { streamId: 1, stepOrder: 0, providerId: 1, result: dead },
        {
          streamId: 2,
          stepOrder: 9,
          providerId: 1,
          result: alive({ height: 480, bitrateKbps: 500 }),
        },
      ]),
    ).toEqual([2, 1]);
  });

  it('ranks by quality regardless of step order (quality is the default)', () => {
    // The 2160p stream outscores the 720p one; step order no longer overrides that.
    expect(
      rank([
        {
          streamId: 1,
          stepOrder: 0,
          providerId: 1,
          result: alive({ height: 720, bitrateKbps: 2000 }),
        },
        {
          streamId: 2,
          stepOrder: 1,
          providerId: 1,
          result: alive({ height: 2160, bitrateKbps: 12000 }),
        },
      ]),
    ).toEqual([2, 1]);
  });

  it('lets step order beat score in alias mode', () => {
    const alias: RankStrategy = {
      mode: 'alias',
      weights: DEFAULT_WEIGHTS,
      providerRank: new Map(),
    };
    expect(
      rank(
        [
          {
            streamId: 1,
            stepOrder: 0,
            providerId: 1,
            result: alive({ height: 720, bitrateKbps: 2000 }),
          },
          {
            streamId: 2,
            stepOrder: 1,
            providerId: 1,
            result: alive({ height: 2160, bitrateKbps: 12000 }),
          },
        ],
        alias,
      ),
    ).toEqual([1, 2]);
  });

  it('ranks preferred providers first, then by quality within them (provider mode)', () => {
    const provider: RankStrategy = {
      mode: 'provider',
      weights: DEFAULT_WEIGHTS,
      providerRank: new Map([[1, 0]]), // provider 1 is preferred
    };
    expect(
      rank(
        [
          // provider 2, highest quality -- but not preferred, so last
          {
            streamId: 1,
            stepOrder: 0,
            providerId: 2,
            result: alive({ height: 2160, bitrateKbps: 12000 }),
          },
          // provider 1, lower quality
          {
            streamId: 2,
            stepOrder: 0,
            providerId: 1,
            result: alive({ height: 720, bitrateKbps: 2000 }),
          },
          // provider 1, higher than stream 2 -- wins within the tier
          {
            streamId: 3,
            stepOrder: 0,
            providerId: 1,
            result: alive({ height: 1080, bitrateKbps: 8000 }),
          },
        ],
        provider,
      ),
    ).toEqual([3, 2, 1]);
  });

  it('breaks ties within a step by score', () => {
    expect(
      rank([
        {
          streamId: 1,
          stepOrder: 0,
          providerId: 1,
          result: alive({ height: 720, bitrateKbps: 2000 }),
        },
        {
          streamId: 2,
          stepOrder: 0,
          providerId: 1,
          result: alive({ height: 1080, bitrateKbps: 8000 }),
        },
      ]),
    ).toEqual([2, 1]);
  });

  it('seeds a new install with an audio weight, and leaves an existing one at zero', () => {
    // The two are indistinguishable once the weights are read, so the opinion
    // has to live in the file a fresh install is created with. An upgrade must
    // not reshuffle channels nobody asked to change.
    expect(loadRules(EMPTY_RULES_DOC).ordering.weights.audio).toBe(NEW_INSTALL_AUDIO);
    expect(loadRules({ schema: 2, defaults: {}, channels: [] }).ordering.weights.audio).toBe(
      undefined,
    );
    expect(DEFAULT_WEIGHTS.audio).toBe(0);
  });

  it('scores audio on channels first, bitrate second', () => {
    const stereo = alive({ audioChannels: 2, audioBitrateKbps: 128 });
    const surround = alive({ audioChannels: 6, audioBitrateKbps: 128 });
    const richer = alive({ audioChannels: 6, audioBitrateKbps: 256 });
    expect(audioScore(surround)).toBeGreaterThan(audioScore(stereo));
    expect(audioScore(richer)).toBeGreaterThan(audioScore(surround));
    // 7.1 is a full score, not a bonus over 5.1.
    expect(audioScore(alive({ audioChannels: 8, audioBitrateKbps: 256 }))).toBe(1);
    // No audio at all, rather than audio we failed to read.
    expect(audioScore(alive({ audioChannels: 0, audioBitrateKbps: 0 }))).toBe(0);
  });

  it('ignores audio until the weight is raised', () => {
    // The same channel carried twice, identical video, one with 5.1. Opting in
    // is what separates them -- by default the ordering is exactly as it was.
    const surround = alive({ audioChannels: 6, audioBitrateKbps: 256 });
    const stereo = alive({ audioChannels: 2, audioBitrateKbps: 128 });
    expect(score(surround)).toBe(score(stereo));

    const weights = { ...DEFAULT_WEIGHTS, audio: 0.1 };
    expect(score(surround, weights)).toBeGreaterThan(score(stereo, weights));
  });

  it('cannot let audio overturn a real difference in video', () => {
    // A small audio weight decides between equals; it does not promote a 720p
    // stream over a 1080p one because the audio is better.
    const weights = { ...DEFAULT_WEIGHTS, audio: 0.1 };
    const sd = alive({ height: 720, bitrateKbps: 2000, audioChannels: 6, audioBitrateKbps: 256 });
    const hd = alive({ height: 1080, bitrateKbps: 8000, audioChannels: 2, audioBitrateKbps: 128 });
    expect(score(hd, weights)).toBeGreaterThan(score(sd, weights));
  });

  it('normalises by the weights, so a heavier set does not saturate', () => {
    // Weights that sum to 2 are the same ranking as weights that sum to 1 --
    // otherwise every decent stream clamps to 1.0 and stops being comparable.
    const doubled = {
      ...DEFAULT_WEIGHTS,
      resolution: 0.7,
      bitrate: 0.8,
      fps: 0.3,
      codec: 0.2,
    };
    const good = alive({ height: 1080, bitrateKbps: 8000 });
    const better = alive({ height: 2160, bitrateKbps: 11_000 });
    expect(score(good, doubled)).toBe(score(good));
    expect(score(better, doubled)).toBeGreaterThan(score(good, doubled));
  });

  it('treats an alive but sub-floor stream as unusable', () => {
    // ffprobe reports "1080p" for feeds delivering 193kbps. Ranking those last
    // still puts them ahead of honestly-dead streams; they belong with the dead.
    const trickle = alive({ height: 1080, bitrateKbps: 193 });
    expect(isUsable(trickle)).toBe(false);
    expect(score(trickle)).toBe(0);
    expect(isUsable(alive({ bitrateKbps: 600 }))).toBe(true);
  });

  it('allows radio / audio-only streams below the video bitrate floor', () => {
    const radio = alive({
      height: 0,
      width: 0,
      fps: 0,
      videoCodec: '',
      audioCodec: 'aac',
      audioChannels: 2,
      audioBitrateKbps: 128,
      bitrateKbps: 128,
    });
    expect(isUsable(radio, DEFAULT_WEIGHTS, true)).toBe(true);
    expect(score(radio, DEFAULT_WEIGHTS, true)).toBeGreaterThan(0);
  });

  it('ranks audio-only streams by channels and bitrate', () => {
    const stereo = alive({
      height: 0,
      width: 0,
      videoCodec: '',
      audioCodec: 'aac',
      audioChannels: 2,
      audioBitrateKbps: 128,
      bitrateKbps: 128,
    });
    const surround = alive({
      height: 0,
      width: 0,
      videoCodec: '',
      audioCodec: 'eac3',
      audioChannels: 6,
      audioBitrateKbps: 256,
      bitrateKbps: 256,
    });
    expect(
      rank(
        [
          { streamId: 1, stepOrder: 0, providerId: 1, result: stereo },
          { streamId: 2, stepOrder: 0, providerId: 1, result: surround },
        ],
        DEFAULT_STRATEGY,
        true,
      ),
    ).toEqual([2, 1]);
  });

  it('treats an unmeasured bitrate as unknown, not as zero', () => {
    // 0 means we could not measure, so it must not be punished as sub-floor.
    expect(isUsable(alive({ bitrateKbps: 0 }))).toBe(true);
  });

  it('sinks sub-floor streams below usable ones regardless of step', () => {
    expect(
      rank([
        {
          streamId: 1,
          stepOrder: 0,
          providerId: 1,
          result: alive({ height: 1080, bitrateKbps: 193 }),
        },
        {
          streamId: 2,
          stepOrder: 9,
          providerId: 1,
          result: alive({ height: 480, bitrateKbps: 900 }),
        },
      ]),
    ).toEqual([2, 1]);
  });

  it('disables the floor when set to zero', () => {
    const off = { ...DEFAULT_WEIGHTS, minBitrateKbps: 0 };
    expect(isUsable(alive({ bitrateKbps: 1 }), off)).toBe(true);
  });

  it('honours preferH265 in both directions', () => {
    const h265 = alive({ videoCodec: 'hevc' });
    const h264 = alive({ videoCodec: 'h264' });
    expect(score(h265)).toBeGreaterThan(score(h264));
    // Spread rather than spelled out: every term added to `Weights` since has
    // an inert default, and restating them here only invites this to drift
    // into testing a weight set nobody runs.
    const flipped = { ...DEFAULT_WEIGHTS, preferH265: false };
    expect(score(h264, flipped)).toBeGreaterThan(score(h265, flipped));
  });

  it('leaves an upgraded install on the flat bitrate scale', () => {
    // Both corrections default to inert, so a rules file that predates them
    // ranks exactly as it did. This is the guarantee, not an implementation
    // detail: the whole point of seeding them in EMPTY_RULES_DOC instead of
    // DEFAULT_WEIGHTS is that an upgrade must not reshuffle anybody's channels.
    expect(DEFAULT_WEIGHTS.hevcBitrateFactor).toBe(1);
    const hevc = alive({ videoCodec: 'hevc', bitrateKbps: 6000 });
    const h264 = alive({ videoCodec: 'h264', bitrateKbps: 6000 });
    // Same effective bitrate: the only gap left is the flat codec bonus.
    const gap = score(hevc) - score(h264);
    const sum =
      DEFAULT_WEIGHTS.resolution +
      DEFAULT_WEIGHTS.bitrate +
      DEFAULT_WEIGHTS.fps +
      DEFAULT_WEIGHTS.codec +
      DEFAULT_WEIGHTS.audio;
    expect(gap).toBeCloseTo((DEFAULT_WEIGHTS.codec * 0.5) / sum, 6);
  });

  it('scores HEVC on its effective bitrate once the factor is set', () => {
    // The defect the factor exists for: at 1.0 a 5625kbps HEVC feed loses to a
    // 9000kbps H.264 one, because the flat codec bonus (0.05) cannot repay what
    // the bitrate gap costs (0.1125).
    const weights = { ...DEFAULT_WEIGHTS, audio: NEW_INSTALL_AUDIO };
    const equivalent = 9000 / NEW_INSTALL_HEVC_FACTOR;
    const hevc = alive({ videoCodec: 'hevc', bitrateKbps: equivalent });
    const h264 = alive({ videoCodec: 'h264', bitrateKbps: 9000 });
    expect(score(hevc, weights)).toBeLessThan(score(h264, weights));

    // With the factor set they are the same stream as far as the model is
    // concerned, and score identically. Not "HEVC now wins": that would be the
    // double-count coming back, since nothing here separates them any more.
    const corrected = { ...weights, hevcBitrateFactor: NEW_INSTALL_HEVC_FACTOR };
    expect(score(hevc, corrected)).toBe(score(h264, corrected));

    // A hair above the equivalence and it wins outright, which is the whole
    // behaviour: the bitrate term, not a bonus beside it, decides.
    const richer = alive({ videoCodec: 'hevc', bitrateKbps: equivalent + 500 });
    expect(score(richer, corrected)).toBeGreaterThan(score(h264, corrected));
  });

  it('applies the factor to hevc and h265 spellings only', () => {
    const corrected = { ...DEFAULT_WEIGHTS, hevcBitrateFactor: 2 };
    for (const codec of ['hevc', 'h265']) {
      expect(effectiveBitrateKbps(alive({ videoCodec: codec, bitrateKbps: 3000 }), corrected)).toBe(
        6000,
      );
    }
    // mpeg2video is *less* efficient than H.264, so inventing a factor for it
    // would hand it an advantage nobody measured.
    for (const codec of ['h264', 'avc', 'mpeg2video', '']) {
      expect(effectiveBitrateKbps(alive({ videoCodec: codec, bitrateKbps: 3000 }), corrected)).toBe(
        3000,
      );
    }
  });

  it('stops the codec term paying for efficiency twice', () => {
    // With the factor on, an HEVC stream that is *behind* on effective bitrate
    // must lose. It used to win anyway: the flat codec bonus is blind to how
    // big the bitrate gap it is overturning was, and on a live install it
    // carried 20 of 25 channels that changed hands, one at 4594kbps effective
    // against 7847.
    const w = {
      ...DEFAULT_WEIGHTS,
      audio: NEW_INSTALL_AUDIO,
      hevcBitrateFactor: NEW_INSTALL_HEVC_FACTOR,
    };
    // 4000 * 1.6 = 6400 effective, against 8000. Same everything else.
    const hevc = alive({ videoCodec: 'hevc', bitrateKbps: 4000 });
    const h264 = alive({ videoCodec: 'h264', bitrateKbps: 8000 });
    expect(effectiveBitrateKbps(hevc, w)).toBeLessThan(effectiveBitrateKbps(h264, w));
    expect(score(hevc, w)).toBeLessThan(score(h264, w));

    // The term still separates a codec that is neither from one that is.
    const mpeg2 = alive({ videoCodec: 'mpeg2video', bitrateKbps: 8000 });
    expect(score(mpeg2, w)).toBeLessThan(score(h264, w));

    // And with the factor off, preferH265 behaves exactly as it always did --
    // that is the upgrade path, and it must not have moved.
    const off = { ...w, hevcBitrateFactor: 1 };
    const same = (codec: string) => alive({ videoCodec: codec, bitrateKbps: 6000 });
    expect(score(same('hevc'), off)).toBeGreaterThan(score(same('h264'), off));
  });

  it('gives UHD its own full-marks bitrate', () => {
    // A ceiling calibrated for 1080p cannot separate two 4K feeds: at 12000
    // both of these score a flat 1.0 on bitrate and the term stops saying
    // anything. The 1080p population must not move when that is fixed.
    const flat = { ...DEFAULT_WEIGHTS, uhdBitrateKbps: 12_000 };
    const good = alive({ height: 2160, bitrateKbps: 13_000 });
    const better = alive({ height: 2160, bitrateKbps: 20_000 });
    expect(score(better, flat)).toBe(score(good, flat));

    const raised = { ...DEFAULT_WEIGHTS, uhdBitrateKbps: NEW_INSTALL_UHD_BITRATE_KBPS };
    expect(score(better, raised)).toBeGreaterThan(score(good, raised));
    // Below the UHD boundary nothing changed.
    const hd = alive({ height: 1080, bitrateKbps: 9000 });
    expect(score(hd, raised)).toBe(score(hd, flat));
  });
});

describe('ordering strategy', () => {
  it('defaults to quality mode with no provider preference', () => {
    const s = resolveOrdering(undefined, new Map(), 500);
    expect(s.mode).toBe('quality');
    expect(s.providerRank.size).toBe(0);
    expect(s.weights.minBitrateKbps).toBe(500);
  });

  it('maps provider preference names to tiers, case-insensitively', () => {
    const names = new Map([
      [1, 'Premium'],
      [2, 'Backup'],
    ]);
    const s = resolveOrdering(
      { mode: 'provider', providerPreference: ['premium', 'BACKUP'], weights: {} },
      names,
      500,
    );
    expect(s.providerRank.get(1)).toBe(0);
    expect(s.providerRank.get(2)).toBe(1);
  });

  it('leaves unlisted providers for the back tier', () => {
    const names = new Map([
      [1, 'Premium'],
      [2, 'Other'],
    ]);
    const s = resolveOrdering(
      { mode: 'provider', providerPreference: ['Premium'], weights: {} },
      names,
      500,
    );
    expect(s.providerRank.has(1)).toBe(true);
    expect(s.providerRank.has(2)).toBe(false);
  });

  it('only resolves the provider map in provider mode', () => {
    const names = new Map([[1, 'Premium']]);
    const s = resolveOrdering(
      { mode: 'quality', providerPreference: ['Premium'], weights: {} },
      names,
      500,
    );
    expect(s.providerRank.size).toBe(0);
  });

  it('lets rules weights override the defaults, and the floor over the env', () => {
    const s = resolveOrdering(
      { mode: 'quality', providerPreference: [], weights: { bitrate: 0.9, minBitrateKbps: 1000 } },
      new Map(),
      500,
    );
    expect(s.weights.bitrate).toBe(0.9);
    expect(s.weights.resolution).toBe(DEFAULT_WEIGHTS.resolution);
    expect(s.weights.minBitrateKbps).toBe(1000);
  });

  it('falls back to the env bitrate floor when rules set none', () => {
    const s = resolveOrdering(
      { mode: 'quality', providerPreference: [], weights: {} },
      new Map(),
      750,
    );
    expect(s.weights.minBitrateKbps).toBe(750);
  });
});

describe('ffprobe parsing', () => {
  it.each([
    ['30000/1001', 29.97],
    ['60/1', 60],
    ['0/0', 0],
    [undefined, 0],
    ['garbage', 0],
  ])('parses fps %s', (raw, expected) => {
    expect(parseFps(raw as string | undefined)).toBe(expected);
  });

  it('rejects an audio-only payload by default', () => {
    expect(parsePayload({ streams: [{ codec_type: 'audio', codec_name: 'aac' }] }).alive).toBe(
      false,
    );
  });

  it('accepts an audio-only payload when audioOnly is true', () => {
    const parsed = parsePayload(
      {
        streams: [
          {
            codec_type: 'audio',
            codec_name: 'aac',
            channels: 2,
            channel_layout: 'stereo',
            bit_rate: '128000',
            sample_rate: '44100',
          },
        ],
      },
      true,
    );
    expect(parsed.alive).toBe(true);
    expect(parsed.audioCodec).toBe('aac');
    expect(parsed.audioChannels).toBe(2);
    expect(parsed.audioBitrateKbps).toBe(128);
    expect(parsed.audioSampleRate).toBe(44_100);
    expect(parsed.width).toBe(0);
    expect(parsed.height).toBe(0);
  });

  it('reads the richest audio track, not the first one listed', () => {
    // A real provider stream: "TNT Sports 1 FHD (5.1 + Stereo)" carries HE-AAC
    // stereo first, then E-AC-3 stereo, then E-AC-3 5.1. Taking the first track
    // published a 5.1 stream to Dispatcharr as 2-channel aac.
    const parsed = parsePayload({
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
        { codec_type: 'audio', codec_name: 'aac', channels: 2, channel_layout: 'stereo' },
        { codec_type: 'audio', codec_name: 'eac3', channels: 2, channel_layout: 'stereo' },
        {
          codec_type: 'audio',
          codec_name: 'eac3',
          channels: 6,
          channel_layout: '5.1(side)',
          bit_rate: '256000',
          sample_rate: '48000',
        },
      ],
    });
    expect(parsed.audioChannels).toBe(6);
    expect(parsed.audioCodec).toBe('eac3');
    expect(parsed.channelLayout).toBe('5.1(side)');
    // Read off the same track that was chosen, not the first one.
    expect(parsed.audioBitrateKbps).toBe(256);
    expect(parsed.audioSampleRate).toBe(48_000);
  });

  it('keeps the earlier track when nothing separates them', () => {
    const best = pickAudio([
      { codec_type: 'video', codec_name: 'h264' },
      { codec_type: 'audio', codec_name: 'eac3', channels: 2 },
      { codec_type: 'audio', codec_name: 'aac', channels: 2 },
    ]);
    expect(best?.codec_name).toBe('eac3');
  });

  it('leaves audio empty when the stream carries none', () => {
    const parsed = parsePayload({
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }],
    });
    expect(parsed.audioChannels).toBe(0);
    expect(parsed.channelLayout).toBe('');
  });

  it('falls back to format bitrate', () => {
    const parsed = parsePayload({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1280,
          height: 720,
          avg_frame_rate: '30/1',
        },
      ],
      format: { bit_rate: '3000000' },
    });
    expect(parsed.bitrateKbps).toBe(3000);
  });
});

describe('matcher', () => {
  it('keeps the earliest alias position for a stream', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['HBO East', 'HBO'] });
    const index = m.buildIndex([stream(10, 'HBO East HD')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('honours per-channel provider scoping', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['HBO East'], providers: [2] });
    const index = m.buildIndex([stream(10, 'HBO East', 1), stream(11, 'HBO East', 2)]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[11, 0]]);
  });

  it('applies the exclude list', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['HBO East'], exclude: ['HBO East'] });
    const index = m.buildIndex([stream(10, 'HBO East')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([]);
  });

  it('excludes a quality variant by its tail token', () => {
    // The token is exactly what `normalize` strips, so before this the only
    // thing separating "US: CNN 4K" from "US: CNN" was unaddressable and an
    // exclude of "4K" quietly did nothing at all.
    const m = matcherFor({ channel_id: 1, aliases: ['CNN'], exclude: ['4K'] });
    const index = m.buildIndex([stream(10, 'US: CNN'), stream(11, 'US: CNN 4K')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('reads a resolution word as its tier, however the provider spelled it', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['CNN'], exclude: ['4K'] });
    const index = m.buildIndex([
      stream(10, 'US: CNN FHD'),
      stream(11, 'US: CNN UHD'),
      stream(12, 'US: CNN 2160p'),
    ]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('excludes codec, fps and flag tokens too', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['CNN'], exclude: ['H265', '60fps', 'RAW'] });
    const index = m.buildIndex([
      stream(10, 'US: CNN HD'),
      stream(11, 'US: CNN HD HEVC'),
      stream(12, 'US: CNN HD 60FPS'),
      stream(13, 'US: CNN HD RAW'),
    ]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('keeps a tag exclude off streams a qualifier does not cover', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['CNN'], exclude: ['@US 4K'] });
    const index = m.buildIndex([stream(10, 'AU: CNN 4K'), stream(11, 'US: CNN 4K')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('excludes a tagged stream a contains claimed', () => {
    const m = matcherFor({ channel_id: 1, contains: ['WRC'], exclude: ['4K'] });
    const index = m.buildIndex([stream(10, 'VA | NBC 4 WRC'), stream(11, 'VA | NBC 4 WRC 4K')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('takes only the tagged variant with a trailing ~', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['CNN ~4K'] });
    const index = m.buildIndex([stream(10, 'US: CNN'), stream(11, 'US: CNN 4K')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[11, 0]]);
  });

  it('rejects a tagged variant with ~!', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['CNN ~!4K'] });
    const index = m.buildIndex([stream(10, 'US: CNN'), stream(11, 'US: CNN 4K')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('combines a section qualifier with a tail qualifier', () => {
    // The case a single exclude line cannot state: keep AU's 4K feed, drop US's.
    const m = matcherFor({ channel_id: 1, aliases: ['@AU CNN ~4K', 'CNN ~!4K'] });
    const index = m.buildIndex([
      stream(10, 'AU: CNN 4K'),
      stream(11, 'AU: CNN FHD'),
      stream(12, 'US: CNN 4K'),
      stream(13, 'US: CNN HD'),
    ]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([
      [10, 0],
      [11, 1],
      [13, 1],
    ]);
  });

  it('prefers the tagged feed but still falls back', () => {
    // Same shape as "@AU beIN Sports" above "beIN Sports": order is preference,
    // and the qualified line is only a preference when an unqualified one
    // follows it.
    const m = matcherFor({ channel_id: 1, aliases: ['CNN ~4K', 'CNN'] });
    const index = m.buildIndex([stream(10, 'US: CNN HD'), stream(11, 'US: CNN 4K')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([
      [11, 0],
      [10, 1],
    ]);
  });

  it('requires every tail qualifier, not any of them', () => {
    // A stream carries tier, codec and fps at once, so stacking them narrows.
    const m = matcherFor({ channel_id: 1, aliases: ['CNN ~4K ~hevc'] });
    const index = m.buildIndex([
      stream(10, 'US: CNN 4K'),
      stream(11, 'US: CNN 4K H265'),
      stream(12, 'US: CNN FHD H265'),
    ]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[11, 0]]);
  });

  it('narrows an exclude to one variant with a tail qualifier', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['CNN'], exclude: ['@US CNN ~4K'] });
    const index = m.buildIndex([
      stream(10, 'AU: CNN 4K'),
      stream(11, 'US: CNN 4K'),
      stream(12, 'US: CNN HD'),
    ]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([
      [10, 0],
      [12, 0],
    ]);
  });

  it('applies tail qualifiers to contains as well', () => {
    const m = matcherFor({ channel_id: 1, contains: ['WRC ~!4K'] });
    const index = m.buildIndex([stream(10, 'VA | NBC 4 WRC'), stream(11, 'VA | NBC 4 WRC 4K')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('excludes a variant marked only by bracketed text', () => {
    // "FS1 4K (Event Only)" and "FS1 4K" are the same name and the same tag
    // once the bracket is stripped, so the bracket is the only thing that can
    // tell them apart.
    const m = matcherFor({ channel_id: 1, aliases: ['FS1 ~!"event only"'] });
    const index = m.buildIndex([
      stream(10, 'US: FS1 HD'),
      stream(11, 'US: FS1 4K'),
      stream(12, 'FS1 4K (Event Only)'),
    ]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([
      [10, 0],
      [11, 0],
    ]);
  });

  it('takes a qualifier-only exclude line', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['FS1'], exclude: ['~"event only"'] });
    const index = m.buildIndex([stream(10, 'US: FS1 HD'), stream(11, 'FS1 4K (Event Only)')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('keys a bracket by word as well as whole', () => {
    // Providers pack several tokens into one bracket, and a key for the whole
    // string would be one nobody could guess.
    const m = matcherFor({ channel_id: 1, aliases: ['ESPN ~!multi'] });
    const index = m.buildIndex([stream(10, 'ESPN'), stream(11, 'ESPN [HEVC Multi]')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('keeps bracketed text out of the bare exclude vocabulary', () => {
    // A quality token cannot collide with a name; bracket text can, so it is
    // reachable only when a rule names it with `~`. Without this a plain-name
    // exclude would quietly start dropping streams that merely mention it.
    const m = matcherFor({ channel_id: 1, aliases: ['FS1'], exclude: ['Event Only'] });
    const index = m.buildIndex([stream(10, 'FS1 4K (Event Only)')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('ignores a blank exclude line', () => {
    // A qualifier-only entry rejects on its qualifiers; an entry with no
    // qualifiers either is a stray newline, and must reject nothing at all.
    const m = matcherFor({ channel_id: 1, aliases: ['FS1'], exclude: ['', '   '] });
    const index = m.buildIndex([stream(10, 'US: FS1 HD')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('leaves a bracket out of the name it is written next to', () => {
    const n = normalize('FS1 4K (Event Only)');
    expect(n.name).toBe('FS1');
    expect(n.brackets).toEqual(['Event Only']);
    expect(n.quality.tier).toBe('uhd');
  });

  it('leaves a tilde inside a name alone', () => {
    // The marker is a trailing word, so a name that merely contains one is
    // still a name -- the same contract that keeps "@Home" an alias.
    const m = matcherFor({ channel_id: 1, aliases: ['Rock~FM'] });
    const index = m.buildIndex([stream(10, 'US: Rock~FM')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('does not let a tag exclude match on the empty name it keys to', () => {
    // "HD" normalises to nothing, and so does a stream whose name is only
    // tokens. Comparing those two empty keys would turn every tag exclude into
    // a blanket one for such streams, whatever tag it actually named.
    const m = matcherFor({
      channel_id: 1,
      exclude: ['HD'],
      patterns: [{ pattern: '(?i)^Sports: 1080p$' }],
    });
    const index = m.buildIndex([stream(10, 'Sports: 1080p')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('compiles Python inline (?i) flags', () => {
    // JS RegExp rejects `(?i)` outright. Every regex carried over from an
    // imported rule set starts with it, and without translation they all fail
    // to compile and their channels silently stop matching.
    const report = loadRules({
      schema: 2,
      channels: [{ channel_id: 1, patterns: [{ pattern: '(?i)^hbo\\s*east$' }] }],
    });
    expect(report.skippedPatterns).toEqual([]);
    const m = report.matcher;
    const index = m.buildIndex([stream(10, 'HBO EAST')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('normalises aliases the same way as stream names', () => {
    // Converted radio aliases carry the prefix ("Radio: Coast FM") while the
    // stream normalises to "Coast FM" with "Radio" lifted out. Keying
    // the raw alias made every one of those channels match nothing.
    const m = matcherFor({ channel_id: 1, aliases: ['Radio: Coast FM'] });
    const index = m.buildIndex([stream(10, 'Radio: Coast FM')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('lets a radio channel claim radio streams', () => {
    // The global radio guard must not fire on a channel that is itself radio.
    const m = matcherFor({ channel_id: 1, aliases: ['Radio: Classic Rewind'] });
    const index = m.buildIndex([stream(10, 'Radio: Classic Rewind')]);
    expect(m.match(m.rules.get(1)!, index)).toHaveLength(1);
  });

  it('still keeps radio streams away from TV channels', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['Classic Rewind'] });
    const index = m.buildIndex([stream(10, 'Radio: Classic Rewind')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([]);
  });

  it('skips an invalid regex without failing the load', () => {
    const report = loadRules({
      schema: 2,
      channels: [{ channel_id: 1, patterns: [{ pattern: 'HBO[' }, { pattern: 'HBO' }] }],
    });
    expect(report.skippedPatterns).toHaveLength(1);
    expect(report.matcher.rules.get(1)!.patterns).toHaveLength(1);
  });

  it('drops disabled channels', () => {
    expect(
      loadRules({ schema: 2, channels: [{ channel_id: 1, enabled: false, aliases: ['x'] }] })
        .loaded,
    ).toBe(0);
  });

  it('coerces string channel ids', () => {
    // Imported rule sets store channel_id as TEXT; Dispatcharr ids are integers.
    const report = loadRules({ schema: 2, channels: [{ channel_id: '15070', aliases: ['x'] }] });
    expect([...report.matcher.rules.keys()]).toEqual([15070]);
  });

  it('respects a per-channel region override', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['HBO East'], exclude_regions: ['UK'] });
    const index = m.buildIndex([stream(10, 'UK: HBO East'), stream(11, 'US: HBO East')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[11, 0]]);
  });

  it('excludes no regions when the override is empty', () => {
    const m = matcherFor(
      { channel_id: 1, aliases: ['HBO East'], exclude_regions: [] },
      { exclude_regions: ['US'] },
    );
    const index = m.buildIndex([stream(10, 'US: HBO East')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('matches call signs via contains', () => {
    // The DC-locals case: the call sign is embedded in a longer provider name.
    const m = matcherFor({ channel_id: 1, contains: ['WRC'] });
    const index = m.buildIndex([
      stream(10, 'VA | Luray | NBC 4 WRC'),
      stream(11, 'DC | Washington | NBC WRC'),
      stream(12, 'HBO East'),
    ]);
    expect(m.match(m.rules.get(1)!, index).map(([id]) => id)).toEqual([10, 11]);
  });

  it('contains matches whole words only', () => {
    // "WRC" must not drag in "WRCB" -- a different station in another city.
    const m = matcherFor({ channel_id: 1, contains: ['WRC'] });
    const index = m.buildIndex([
      stream(10, 'DC | Washington | NBC WRC'),
      stream(11, 'TN | Chattanooga | NBC 3 WRCB'),
      stream(12, 'CITY| NBC WRCB WASHINGTON'),
    ]);
    expect(m.match(m.rules.get(1)!, index).map(([id]) => id)).toEqual([10]);
  });

  it('scopes an alias to a required prefix', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['@AU beIN Sports'] });
    const index = m.buildIndex([stream(10, 'AU: beIN Sports HD'), stream(11, 'US: beIN Sports')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('scopes an alias to a trailing market tag', () => {
    // Stripping the tag off the name is what lets the plain alias match at all;
    // without it being reachable by @, the two feeds would be indistinguishable.
    const m = matcherFor({ channel_id: 1, aliases: ['@MY Sports Alpha 1'] });
    const index = m.buildIndex([
      stream(10, 'Sports Alpha 1 HD TH MY'),
      stream(11, 'Sports Alpha 1 HD SG'),
    ]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('matches a market-tagged name with a plain alias', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['Sports Alpha 1'] });
    const index = m.buildIndex([stream(10, 'Sports Alpha 1 HD TH MY')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('rejects a prefix with @!', () => {
    // The "Prime:" copy of a US network is usually the FAST channel, not the
    // linear feed, and it is worth keeping off the channel entirely.
    const m = matcherFor({ channel_id: 1, aliases: ['@!Prime ESPN'] });
    const index = m.buildIndex([stream(10, 'US: ESPN'), stream(11, 'Prime: ESPN')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('keeps a "<name> - <quality>" stream reachable by its own alias', () => {
    // The regression the dash separator caused: this stream keyed to '' and
    // dropped out of the ruleset entirely, while "TNT HD" beside it matched.
    const m = matcherFor({ channel_id: 1, aliases: ['TNT'] });
    const index = m.buildIndex([stream(10, 'TNT HD'), stream(11, 'TNT - HD')]);
    expect(m.match(m.rules.get(1)!, index).map(([id]) => id)).toEqual([10, 11]);
  });

  it('includes and excludes on a bracketed section', () => {
    // The ask this came from: keep the [USA] copy, drop the [PL] one, with the
    // provider writing both as brackets and the punctuated sections alongside.
    const m = matcherFor({
      channel_id: 1,
      aliases: ['@US @USA Comedy Central', '@!PL Comedy Central'],
    });
    const index = m.buildIndex([
      stream(10, '[USA] COMEDY CENTRAL HD'),
      stream(11, 'US: COMEDY CENTRAL HD'),
      stream(12, '[PL] COMEDY CENTRAL HD'),
      stream(13, 'PL: Comedy Central FHD'),
      stream(14, 'GO: COMEDY CENTRAL'),
    ]);
    expect(m.match(m.rules.get(1)!, index).map(([id]) => id)).toEqual([10, 11, 14]);
  });

  it('applies the region denylist to a bracketed section', () => {
    const m = matcherFor(
      { channel_id: 1, aliases: ['Comedy Central'] },
      { exclude_regions: ['PL'] },
    );
    const index = m.buildIndex([
      stream(10, '[USA] COMEDY CENTRAL HD'),
      stream(11, '[PL] COMEDY CENTRAL HD'),
    ]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('accepts any of several required prefixes', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['@US @USA Fox Sports 1'] });
    const index = m.buildIndex([
      stream(10, 'US: Fox Sports 1'),
      stream(11, 'USA: Fox Sports 1'),
      stream(12, 'CA: Fox Sports 1'),
    ]);
    expect(m.match(m.rules.get(1)!, index).map(([id]) => id)).toEqual([10, 11]);
  });

  it('ranks a prefixed alias above the unqualified fallback', () => {
    // "Prefer the AU feed, take any other if there is none" is two lines,
    // because alias order is already preference order.
    const m = matcherFor({ channel_id: 1, aliases: ['@AU beIN Sports', 'beIN Sports'] });
    const index = m.buildIndex([stream(10, 'US: beIN Sports'), stream(11, 'AU: beIN Sports')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([
      [11, 0],
      [10, 1],
    ]);
  });

  it('lets a required prefix override the region denylist', () => {
    // 389 channels here carry the AU/NZ denylist inherited from the legacy
    // patterns. Without this, "@AU beIN Sports" on one of them matches nothing.
    const m = matcherFor(
      { channel_id: 1, aliases: ['@AU beIN Sports'] },
      { exclude_regions: ['AU', 'NZ'] },
    );
    const index = m.buildIndex([stream(10, 'AU: beIN Sports'), stream(11, 'NZ: beIN Sports')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('matches prefixes regardless of case and punctuation', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['@uk-fast: Sports Alpha Main Event'] });
    const index = m.buildIndex([
      stream(10, 'UK-FAST: Sports Alpha Main Event'),
      stream(11, 'UK: Sports Alpha Main Event'),
    ]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('quotes a multi-word prefix', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['@"US East" ESPN'] });
    const index = m.buildIndex([stream(10, 'US East: ESPN'), stream(11, 'US West: ESPN')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('leaves an alias that is only an @-word alone', () => {
    // "@Home" was a real channel. A qualifier needs a name after it.
    const m = matcherFor({ channel_id: 1, aliases: ['@Home'] });
    const index = m.buildIndex([stream(10, 'US: @Home')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('leaves a literal prefix in an alias meaning what it always did', () => {
    // Converted "Radio: <station>" aliases are unqualified aliases, not prefix
    // requirements: the prefix is still stripped on both sides.
    const m = matcherFor({ channel_id: 1, aliases: ['Radio: Coast FM'] });
    const index = m.buildIndex([stream(10, 'Satellite Radio: Coast FM')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('scopes a contains needle by prefix', () => {
    const m = matcherFor({ channel_id: 1, contains: ['@DC WRC'] });
    const index = m.buildIndex([
      stream(10, 'DC | Washington | NBC WRC'),
      stream(11, 'VA | Luray | NBC 4 WRC'),
    ]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('scopes an exclude by prefix', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['ESPN'], exclude: ['@Prime ESPN'] });
    const index = m.buildIndex([stream(10, 'US: ESPN'), stream(11, 'Prime: ESPN')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('matches a qualifier against the leading word of a longer prefix', () => {
    // The section is "NFL"; the provider happens to write the segment as
    // "NFL Teams". Requiring the whole segment makes every operator guess at
    // the provider's exact wording.
    const m = matcherFor({ channel_id: 1, contains: ['@NFL Bears'] });
    const index = m.buildIndex([
      stream(10, 'NFL Teams: CBS Bears (WBBM) Chicago IL'),
      stream(11, 'NFL TEAMS| FOX BEARS CHICAGO IL'),
      stream(12, 'CAN: HERSHEY BEARS'),
    ]);
    expect(m.match(m.rules.get(1)!, index).map(([id]) => id)).toEqual([10, 11]);
  });

  it('matches a qualifier against a section the provider never punctuated', () => {
    // "NFL WASHINGTON COMMANDERS" carries no separator, so `normalize` lifts no
    // prefix at all -- and before this the only way to reach it was the
    // per-channel regex the alias layer exists to replace.
    const m = matcherFor({ channel_id: 1, contains: ['@NFL Commanders'] });
    const index = m.buildIndex([
      stream(10, 'NFL WASHINGTON COMMANDERS'),
      stream(11, 'NFL Teams: FOX Commanders (WTTG) Washington DC'),
      stream(12, 'Radio: Washington Commanders'),
      stream(13, 'NRL : PENRITH COMMANDERS'),
    ]);
    expect(m.match(m.rules.get(1)!, index).map(([id]) => id)).toEqual([10, 11]);
  });

  it('matches a qualified alias against a section left inside the name', () => {
    // "US| MLB CHICAGO CUBS HD" has one separator, so "MLB CHICAGO CUBS" is all
    // name. The alias is still "Chicago Cubs" -- in the MLB section.
    const m = matcherFor({ channel_id: 1, aliases: ['@MLB Chicago Cubs'] });
    const index = m.buildIndex([
      stream(10, 'US| MLB CHICAGO CUBS HD'),
      stream(11, 'USA: MLB CHICAGO CUBS [720p]'),
      stream(12, 'MLB: Chicago Cubs'),
    ]);
    expect(m.match(m.rules.get(1)!, index).map(([id]) => id)).toEqual([10, 11, 12]);
  });

  it('keeps a qualified alias off fixtures that merely name the team', () => {
    // The nightly game feeds sit in the same section and carry the team name,
    // but they are not the team channel: "MLB 19" is a fixture, not a name.
    // This is why the section belongs on an *alias* and not on a `contains`.
    const m = matcherFor({ channel_id: 1, aliases: ['@MLB Chicago Cubs'] });
    const index = m.buildIndex([
      stream(10, 'US| MLB CHICAGO CUBS HD'),
      stream(11, 'MLB 19 | Los Angeles Dodgers at Chicago Cubs AWAY 04 Aug 08:05 PM ET'),
    ]);
    expect(m.match(m.rules.get(1)!, index).map(([id]) => id)).toEqual([10]);
  });

  it('strips only the section the alias named', () => {
    // Stripping any leading word would turn every qualified alias into a
    // suffix match, and "@US Chicago Cubs" would claim an MLB-sectioned name.
    const m = matcherFor({ channel_id: 1, aliases: ['@US Chicago Cubs'] });
    const index = m.buildIndex([stream(10, 'US| MLB CHICAGO CUBS HD')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([]);
  });

  it('does not let a qualifier reach past the leading words of a name', () => {
    // A qualifier names a section, not a name. Matching "Bears" anywhere in the
    // name would make `@` a second, looser spelling of `contains`.
    const m = matcherFor({ channel_id: 1, contains: ['@Bears Chicago'] });
    const index = m.buildIndex([stream(10, 'NFL Teams: CBS Bears (WBBM) Chicago IL')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([]);
  });

  it('keeps a rejecting qualifier scoped to the section too', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['@!NFL Commanders'] });
    const index = m.buildIndex([
      stream(10, 'NFL Commanders'),
      stream(11, 'US: Commanders'),
      stream(12, 'NFL Teams: Commanders'),
    ]);
    expect(m.match(m.rules.get(1)!, index).map(([id]) => id)).toEqual([11]);
  });

  it('takes an excluded provider group out of matching entirely', () => {
    const names = new Map([
      [1, 'US Sports'],
      [2, 'PPV EVENTS'],
    ]);
    const m = matcherFor({ channel_id: 1, aliases: ['ESPN'] }, { exclude_groups: ['PPV EVENTS'] });
    const index = m.buildIndex([grouped(10, 'US: ESPN', 1), grouped(11, 'US: ESPN', 2)], names);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('excludes groups by glob, so groups created later are covered', () => {
    // Dispatcharr builds "Auto | ..." groups on its own; naming ids would mean
    // the next one silently comes back into matching.
    const names = new Map([
      [1, 'Auto | MLB'],
      [2, 'Auto | NFL'],
      [3, 'US Sports'],
    ]);
    const m = matcherFor({ channel_id: 1, contains: ['Cubs'] }, { exclude_groups: ['Auto | *'] });
    const index = m.buildIndex(
      [
        grouped(10, 'MLB 19 | Dodgers at Chicago Cubs AWAY', 1),
        grouped(11, 'NFL Cubs', 2),
        grouped(12, 'US| MLB CHICAGO CUBS HD', 3),
      ],
      names,
    );
    expect(m.match(m.rules.get(1)!, index).map(([id]) => id)).toEqual([12]);
  });

  it('keeps an excluded group away from legacy regex too', () => {
    // The exclusion is "these are not candidates", not "aliases skip them" --
    // a leftover regex must not be a way back in.
    const m = matcherFor(
      { channel_id: 1, patterns: [{ pattern: '(?i)ESPN' }] },
      { exclude_groups: ['PPV EVENTS'] },
    );
    const index = m.buildIndex([grouped(10, 'PPV: ESPN', 2)], new Map([[2, 'PPV EVENTS']]));
    expect(m.match(m.rules.get(1)!, index)).toEqual([]);
  });

  it('refuses to build an index that would silently ignore exclusions', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['ESPN'] }, { exclude_groups: ['PPV EVENTS'] });
    expect(() => m.buildIndex([grouped(10, 'US: ESPN', 1)])).toThrow(/group list/);
  });

  it('leaves streams with no group alone', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['ESPN'] }, { exclude_groups: ['PPV EVENTS'] });
    const index = m.buildIndex([stream(10, 'US: ESPN')], new Map([[2, 'PPV EVENTS']]));
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('keeps the radio guard off a prefix-qualified radio channel', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['@Radio Classic Rewind'] });
    const index = m.buildIndex([stream(10, 'Radio: Classic Rewind')]);
    expect(m.match(m.rules.get(1)!, index)).toEqual([[10, 0]]);
  });

  it('ranks exact aliases above contains hits', () => {
    const m = matcherFor({ channel_id: 1, aliases: ['WRC'], contains: ['WRC'] });
    const index = m.buildIndex([stream(10, 'WRC'), stream(11, 'NBC 4 WRC')]);
    const hits = m.match(m.rules.get(1)!, index);
    expect(hits[0]![0]).toBe(10);
    expect(hits[0]![1]).toBeLessThan(hits[1]![1]);
  });
});

describe('legacy conversion', () => {
  const REAL =
    '(?i)^(?!\\s*(?:AU|NZ)\\s*(?:[:|]|\\s))(?!.*\\+\\s*1(?![0-9]))' +
    '(?:(?!Radio:)[^:|]{1,25}[:|]\\s*){0,3}' +
    '(?:Food\\s*Network\\s*East|FOOD\\s*NETWORK|Food\\s*Network)' +
    '(?:\\s*(?:HD|FHD|SD|UHD|HDR|RAW))*\\s*$';

  it('decomposes a real exported pattern', () => {
    const result = decompose(REAL);
    expect(result.converted).toBe(true);
    expect(result.aliases).toEqual(['Food Network East', 'FOOD NETWORK', 'Food Network']);
    expect([...result.regions].sort()).toEqual(['AU', 'NZ']);
    expect(result.timeshift).toBe(true);
    expect(result.radio).toBe(true);
  });

  it('unescapes literal brackets but rejects character classes', () => {
    expect(unescapeLiteral('Sky\\s*Sports\\s*\\[\\s*4K\\s*\\]')).toBe('Sky Sports [ 4K ]');
    expect(unescapeLiteral('[A-Z]{2}')).toBeNull();
  });

  it('handles \\s+ as well as \\s*', () => {
    expect(unescapeLiteral('MLB\\s+Arizona\\s*Diamondbacks')).toBe('MLB Arizona Diamondbacks');
  });

  it('detects unescaped metacharacters only', () => {
    expect(hasUnescaped('Starz\\(Pacific\\)', '()')).toBe(false);
    expect(hasUnescaped('(?:A|B)', '()')).toBe(true);
  });

  it('splits only on unescaped pipes', () => {
    expect(splitTopLevel('A|B\\|C')).toEqual(['A', 'B\\|C']);
  });

  it('reads the string "null" as unscoped', () => {
    // Imported rule sets persist an unscoped pattern as the *string* "null".
    expect(scopeOf('null')).toBeNull();
    expect(scopeOf('[6]')).toEqual([6]);
    expect(scopeOf([5, 7])).toEqual([5, 7]);
  });

  it('emits region guards per channel, never unioned', () => {
    const { doc } = convert({
      channels: [
        { channel_id: 1, patterns: [{ pattern: REAL, m3u_accounts: 'null' }] },
        { channel_id: 2, patterns: [{ pattern: '(?i)^Plain\\s*Name\\s*$', m3u_accounts: 'null' }] },
      ],
    });
    const channels = doc.channels as Array<Record<string, unknown>>;
    expect(channels[0]!.exclude_regions).toEqual(['AU', 'NZ']);
    // The second pattern had no region guard, and must not inherit the first's.
    expect(channels[1]!.exclude_regions).toEqual([]);
    expect((doc.defaults as Record<string, unknown>).exclude_regions).toEqual([]);
  });

  it('carries a uniform provider scope onto the channel', () => {
    const { doc } = convert({
      channels: [{ channel_id: 1, patterns: [{ pattern: REAL, m3u_accounts: '[6]' }] }],
    });
    expect((doc.channels as Array<Record<string, unknown>>)[0]!.providers).toEqual([6]);
  });

  it('dedupes aliases that collapse under the match key', () => {
    const { doc } = convert({
      channels: [
        {
          channel_id: 1,
          patterns: [{ pattern: '(?i)^(?:HBO\\s*EAST|HBO\\s*East)\\s*$', m3u_accounts: 'null' }],
        },
      ],
    });
    expect((doc.channels as Array<Record<string, unknown>>)[0]!.aliases).toEqual(['HBO EAST']);
  });
});

describe('black screen handling', () => {
  it('treats a black stream as unusable however healthy it looks', () => {
    // The failure quality metrics miss: right size, good bitrate, showing a slate.
    const slate = alive({ height: 1080, bitrateKbps: 6000, black: true });
    expect(isUsable(slate)).toBe(false);
    expect(score(slate)).toBe(0);
  });

  it('sinks a black stream below a lower-quality live one', () => {
    expect(
      rank([
        {
          streamId: 1,
          stepOrder: 0,
          providerId: 1,
          result: alive({ height: 1080, bitrateKbps: 9000, black: true }),
        },
        {
          streamId: 2,
          stepOrder: 5,
          providerId: 1,
          result: alive({ height: 480, bitrateKbps: 800 }),
        },
      ]),
    ).toEqual([2, 1]);
  });

  it('leaves a non-black stream alone', () => {
    expect(isUsable(alive({ black: false }))).toBe(true);
    expect(isUsable(alive())).toBe(true);
  });
});

describe('stats payload', () => {
  it('reports a readable reason for each outcome', () => {
    expect(statsPayload(alive()).quality_reason).toBe('ok');
    expect(statsPayload(alive({ black: true })).quality_reason).toBe('black screen');
    expect(statsPayload({ ...dead, error: 'timeout' }).quality_reason).toBe('timeout');
  });

  it('publishes a resolution string Dispatcharr can display', () => {
    expect(statsPayload(alive()).resolution).toBe('1920x1080');
    expect(statsPayload(dead).resolution).toBe('0x0');
  });

  it('publishes the bitrate under video_bitrate, the key Dispatcharr displays', () => {
    // The channel table reads stream_stats.video_bitrate; the older bitrate_kbps
    // key rendered an empty badge there.
    const payload = statsPayload(alive({ bitrateKbps: 4875 }));
    expect(payload.video_bitrate).toBe(4875);
    expect(payload.bitrate_kbps).toBeUndefined();
  });

  it('publishes pixel format and audio channels under the keys Dispatcharr displays', () => {
    const payload = statsPayload(alive());
    expect(payload.pixel_format).toBe('yuv420p');
    expect(payload.audio_channels).toBe(2);
    // Dispatcharr's own probe writes the count and the layout as separate keys.
    expect(payload.channel_layout).toBe('stereo');
    // Its audio stat group reads these two.
    expect(payload.audio_bitrate).toBe(128);
    expect(payload.sample_rate).toBe(48_000);
  });
});
