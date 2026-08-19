/**
 * Per-login variants: which URLs one stream is probed through, and which of
 * those probes the stream reports.
 */

import { describe, expect, it } from 'vitest';
import type { Provider, ProviderProfile } from './dispatcharr';
import type { ProbeResult } from './probe';
import { DEFAULT_WEIGHTS } from './scoring';
import { buildVariants, pickBestVariant, type VariantVerdict } from './variants';

function profile(over: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 2,
    name: 'Second login',
    isDefault: false,
    isActive: true,
    maxStreams: 2,
    currentViewers: 0,
    searchPattern: 'coffee/684540451',
    replacePattern: 'coffee2/secret',
    ...over,
  };
}

function provider(over: Partial<Provider> = {}): Provider {
  return {
    id: 6,
    name: 'Provider A',
    maxStreams: 3,
    profiles: [
      profile({
        id: 6,
        name: 'Default',
        isDefault: true,
        maxStreams: 3,
        searchPattern: '^(.*)$',
        replacePattern: '$1',
      }),
      profile(),
    ],
    ...over,
  };
}

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    alive: true,
    width: 1920,
    height: 1080,
    fps: 50,
    bitrateKbps: 10_000,
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

const URL = 'http://crx.watch/live/coffee/684540451/1234.ts';

describe('buildVariants', () => {
  it('probes only the stored URL while the account has one active login', () => {
    // The default install: one profile (or none), one target, byte for byte
    // the behaviour that predates profiles.
    expect(
      buildVariants(URL, provider({ profiles: [profile({ id: 6, isDefault: true })] })),
    ).toEqual([{ variantId: 0, profileId: 0, url: URL }]);
    expect(buildVariants(URL, provider({ profiles: [] }))).toEqual([
      { variantId: 0, profileId: 0, url: URL },
    ]);
  });

  it('adds one rewritten URL per active non-default login', () => {
    const variants = buildVariants(URL, provider());
    expect(variants).toEqual([
      { variantId: 0, profileId: 0, url: URL },
      {
        variantId: 2,
        profileId: 2,
        url: 'http://crx.watch/live/coffee2/secret/1234.ts',
      },
    ]);
  });

  it('skips inactive logins even when the account has several', () => {
    const variants = buildVariants(
      URL,
      provider({
        profiles: [profile({ id: 6, isDefault: true }), profile({ id: 2, isActive: false })],
      }),
    );
    // One usable login means one target -- a disabled profile rewrites nothing.
    expect(variants).toEqual([{ variantId: 0, profileId: 0, url: URL }]);
  });

  it('drops rewrites that are broken, do not match, or duplicate another target', () => {
    const variants = buildVariants(
      URL,
      provider({
        profiles: [
          profile({ id: 6, isDefault: true }),
          profile({ id: 2, searchPattern: 'unbalanced(', replacePattern: 'x' }),
          profile({ id: 3, searchPattern: 'nomatch-anywhere', replacePattern: 'x' }),
          // The identity pair every default carries, on a non-default profile:
          // rewrites the URL onto itself.
          profile({ id: 4, searchPattern: '^(.*)$', replacePattern: '$1' }),
          // Two logins that genuinely share one address: the second is noise.
          profile({ id: 5, searchPattern: '^.*$', replacePattern: 'http://shared.example/s' }),
          profile({ id: 7, searchPattern: '^.*$', replacePattern: 'http://shared.example/s' }),
          profile({ id: 8, searchPattern: 'coffee', replacePattern: 'real-second-login' }),
        ],
      }),
    );
    expect(variants.map((v) => v.variantId)).toEqual([0, 5, 8]);
  });
});

describe('pickBestVariant', () => {
  const verdict = (variantId: number, result: ProbeResult): VariantVerdict => ({
    variantId,
    result,
  });

  it('returns null for no verdicts at all', () => {
    expect(pickBestVariant([])).toBeNull();
  });

  it('reports the stream alive when any login can play it', () => {
    const dead = probe({ alive: false, error: 'HTTP 403' });
    const best = pickBestVariant([verdict(0, dead), verdict(2, probe())]);
    expect(best?.alive).toBe(true);
  });

  it('prefers the usable login, then the measured one, then the higher score', () => {
    // A black slate is alive but unusable; an unmeasured bitrate ranks behind
    // a measured one at the same tier -- the same ladder rank() climbs.
    const black = probe({ black: true });
    const unmeasured = probe({ bitrateKbps: 0, height: 1080 });
    const measured720 = probe({ height: 720, bitrateKbps: 2667 });

    expect(pickBestVariant([verdict(2, black), verdict(0, probe())])?.black).toBeFalsy();
    expect(pickBestVariant([verdict(2, unmeasured), verdict(0, measured720)])?.height).toBe(720);
    expect(pickBestVariant([verdict(2, probe()), verdict(0, probe({ height: 720 }))])?.height).toBe(
      1080,
    );
  });

  it('breaks ties toward the lower variantId, the default login first', () => {
    const a = probe({ elapsedMs: 100 });
    const b = probe({ elapsedMs: 200 });
    // Identical quality, so variantId decides -- even with the second login
    // first in the list, and first in the array.
    expect(pickBestVariant([verdict(2, a), verdict(0, b)])?.elapsedMs).toBe(200);
    expect(pickBestVariant([verdict(0, a), verdict(2, b)])?.elapsedMs).toBe(100);
  });

  it('reports a dead stream through the default login, among equals', () => {
    const deads = [
      verdict(0, probe({ alive: false, error: 'login 1 refused' })),
      verdict(2, probe({ alive: false, error: 'login 2 refused' })),
    ];
    expect(pickBestVariant(deads)?.error).toBe('login 1 refused');
  });

  it('honours the pass weights, not just the defaults', () => {
    // With h265 preferred, the hevc login wins over the h264 one.
    const h264 = verdict(0, probe({ videoCodec: 'h264' }));
    const h265 = verdict(2, probe({ videoCodec: 'hevc' }));
    expect(
      pickBestVariant([h264, h265], { ...DEFAULT_WEIGHTS, preferH265: true })?.videoCodec,
    ).toBe('hevc');
    expect(
      pickBestVariant([h264, h265], { ...DEFAULT_WEIGHTS, preferH265: false })?.videoCodec,
    ).toBe('h264');
  });
});
