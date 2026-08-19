/**
 * Per-login variants: which URLs one stream is probed through, and which of
 * those probes the stream reports.
 */

import { describe, expect, it } from 'vitest';
import type { Provider, ProviderProfile } from './dispatcharr';
import type { ProbeResult } from './probe';
import { DEFAULT_WEIGHTS } from './scoring';
import { buildVariants, pickBestVariant, providerLogins, type VariantVerdict } from './variants';

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

describe('providerLogins', () => {
  it('reports one login when the account carries a single active profile', () => {
    const logins = providerLogins(provider({ profiles: [profile({ id: 6, isDefault: true })] }));
    expect(logins).toEqual([
      {
        id: 0,
        name: 'Second login',
        rewrite: { search: 'coffee/684540451', replace: 'coffee2/secret' },
        maxStreams: 2,
        currentViewers: 0,
        isDefault: true,
      },
    ]);
  });

  it('falls back to the stored URL, unrewritten, when there are no profiles at all', () => {
    expect(providerLogins(provider({ profiles: [] }))).toEqual([
      {
        id: 0,
        name: 'default',
        rewrite: null,
        maxStreams: 3,
        currentViewers: 0,
        isDefault: true,
      },
    ]);
  });

  it('gives the default login id 0 and every other its profile id, default first', () => {
    expect(providerLogins(provider()).map((l) => l.id)).toEqual([0, 2]);
  });

  it("caps each login by its own max_streams, and by the account's when unlimited", () => {
    const logins = providerLogins(
      provider({
        profiles: [
          profile({ id: 6, isDefault: true, maxStreams: 5 }),
          // Dispatcharr's 0 -- unlimited -- arrives as null and is capped at
          // the account's figure rather than left unbounded.
          profile({ id: 2, maxStreams: null }),
        ],
      }),
    );
    expect(logins.map((l) => l.maxStreams)).toEqual([5, 3]);
  });

  it('skips inactive logins, and drops the stored URL when the default is one', () => {
    // Dispatcharr refuses to play an account whose default profile is off
    // ("M3U account has no default profile"), and the stored URL carries
    // exactly those switched-off credentials -- so it gets no lane.
    const logins = providerLogins(
      provider({
        profiles: [
          profile({ id: 6, isDefault: true, isActive: false }),
          profile({ id: 2 }),
          profile({ id: 3, isActive: false }),
        ],
      }),
    );
    expect(logins.map((l) => l.id)).toEqual([2]);
    expect(logins[0]?.isDefault).toBe(false);
  });
});

describe('buildVariants', () => {
  it('probes only the stored URL while the account has one active login', () => {
    // The default install: one profile (or none), one target, byte for byte
    // the behaviour that predates profiles.
    expect(
      buildVariants(
        URL,
        providerLogins(
          provider({
            profiles: [
              profile({ id: 6, isDefault: true, searchPattern: '^(.*)$', replacePattern: '$1' }),
            ],
          }),
        ),
      ),
    ).toEqual([{ variantId: 0, profileId: 0, url: URL }]);
    expect(buildVariants(URL, providerLogins(provider({ profiles: [] })))).toEqual([
      { variantId: 0, profileId: 0, url: URL },
    ]);
  });

  it('adds one rewritten URL per active non-default login', () => {
    const variants = buildVariants(URL, providerLogins(provider()));
    expect(variants).toEqual([
      { variantId: 0, profileId: 0, url: URL },
      {
        variantId: 2,
        profileId: 2,
        url: 'http://crx.watch/live/coffee2/secret/1234.ts',
      },
    ]);
  });

  it("applies the default profile's own rewrite to the stored URL", () => {
    // Dispatcharr creates the default profile as an identity rewrite but its
    // editor exposes the pattern precisely so it can be made to do something
    // -- swapping a LAN address for a WAN one is the documented use. Playback
    // runs the stored URL through it, so probing must too.
    const variants = buildVariants(
      URL,
      providerLogins(
        provider({
          profiles: [
            profile({
              id: 6,
              isDefault: true,
              searchPattern: '^http://crx\\.watch',
              replacePattern: 'http://10.0.0.5:8080',
            }),
          ],
        }),
      ),
    );
    expect(variants).toEqual([
      { variantId: 0, profileId: 0, url: 'http://10.0.0.5:8080/live/coffee/684540451/1234.ts' },
    ]);
  });

  it('keeps the stored URL when the default rewrite is unusable or does not match', () => {
    // `transform_url` returns its input on either, so the default login is
    // never the one that goes missing.
    for (const search of ['unbalanced(', '', 'nomatch-anywhere']) {
      const variants = buildVariants(
        URL,
        providerLogins(
          provider({
            profiles: [
              profile({ id: 6, isDefault: true, searchPattern: search, replacePattern: 'x' }),
            ],
          }),
        ),
      );
      expect(variants).toEqual([{ variantId: 0, profileId: 0, url: URL }]);
    }
  });

  it('drops rewrites that are broken, do not match, or duplicate another target', () => {
    const variants = buildVariants(
      URL,
      providerLogins(
        provider({
          profiles: [
            profile({ id: 6, isDefault: true, searchPattern: '^(.*)$', replacePattern: '$1' }),
            profile({ id: 2, searchPattern: 'unbalanced(', replacePattern: 'x' }),
            profile({ id: 3, searchPattern: 'nomatch-anywhere', replacePattern: 'x' }),
            // The identity pair every default carries, on a non-default
            // profile: rewrites the URL onto itself.
            profile({ id: 4, searchPattern: '^(.*)$', replacePattern: '$1' }),
            // Two logins that genuinely share one address: the second is noise.
            profile({ id: 5, searchPattern: '^.*$', replacePattern: 'http://shared.example/s' }),
            profile({ id: 7, searchPattern: '^.*$', replacePattern: 'http://shared.example/s' }),
            profile({ id: 8, searchPattern: 'coffee', replacePattern: 'real-second-login' }),
          ],
        }),
      ),
    );
    expect(variants.map((v) => v.variantId)).toEqual([0, 5, 8]);
  });

  it('reports why each login contributed no target, so a broken pattern is not silent', () => {
    const issues: Array<[number, string]> = [];
    buildVariants(
      URL,
      providerLogins(
        provider({
          profiles: [
            profile({ id: 6, isDefault: true, searchPattern: '^(.*)$', replacePattern: '$1' }),
            // Python's `regex` accepts this spelling of a named group; JS does
            // not, so the pattern will not compile here.
            profile({ id: 2, searchPattern: '(?P<host>crx)', replacePattern: 'x' }),
            profile({ id: 3, searchPattern: 'nomatch-anywhere', replacePattern: 'x' }),
          ],
        }),
      ),
      (login, issue) => issues.push([login.id, issue]),
    );
    expect(issues).toEqual([
      [2, 'unusable-pattern'],
      [3, 'duplicate-url'],
    ]);
  });

  it('falls an unusable login back to the stored URL, in its own lane', () => {
    // `transform_url` returns its input when the pattern throws, so a login
    // with a broken pattern still plays -- through the stored URL, on its own
    // connection. A broken profile is a reason to go and look at the account,
    // not a reason to quietly stop checking its streams.
    const issues: string[] = [];
    const variants = buildVariants(
      URL,
      [
        {
          id: 4,
          name: 'Only login',
          rewrite: { search: 'unbalanced(', replace: 'x' },
          maxStreams: 1,
          currentViewers: 0,
          isDefault: false,
        },
      ],
      (_login, issue) => issues.push(issue),
    );
    // Its own id, not 0: 0 is the default login's lane, and this account has
    // no default to charge the connection to.
    expect(variants).toEqual([{ variantId: 4, profileId: 4, url: URL }]);
    expect(issues).toEqual(['unusable-pattern']);
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
