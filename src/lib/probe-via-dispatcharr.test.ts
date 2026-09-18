/**
 * Probing through Dispatcharr rather than at the provider.
 *
 * Three things have to agree for the mode to work, and each of them is a way
 * it has been got wrong: the address ffprobe opens, the agent it opens it
 * with, and how `/proxy/ts/status` is read once Podium is itself a client of
 * it. The last is the one with teeth -- unfiltered, every probe reads back as
 * a viewer and Podium paces itself out of its own capacity.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DispatcharrClient, proxyStreamUrl } from './dispatcharr';
import { activityOptions, probeProxyBase, probeUserAgent } from './probe-routing';
import { laneKey } from './scheduler';
import { buildVariants, drawVariant, type ProviderLogin, probeTargetUrl } from './variants';

const DIRECT = {
  DISPATCHARR_URL: 'http://dispatcharr:9191',
  PODIUM_PROBE_VIA_DISPATCHARR: false,
  PODIUM_SOAK_VIA_DISPATCHARR: false,
  PODIUM_PROBE_CLIENT_USER_AGENT: 'Podium-Probe/1',
  PODIUM_USER_AGENT: 'VLC/3.0.14',
};
const PROXIED = { ...DIRECT, PODIUM_PROBE_VIA_DISPATCHARR: true };

function login(over: Partial<ProviderLogin> = {}): ProviderLogin {
  return {
    id: 0,
    dispatcharrProfileId: 1,
    name: 'default',
    rewrite: null,
    maxStreams: 2,
    currentViewers: 0,
    isDefault: true,
    xtreamCodes: false,
    ...over,
  };
}

describe('proxyStreamUrl', () => {
  it('addresses an individual stream by its hash', () => {
    // The endpoint resolves a channel uuid first and falls back to a
    // stream_hash, which is what lets a stream be probed without being
    // attached to a channel at all.
    expect(proxyStreamUrl('http://dispatcharr:9191', 'abc123')).toBe(
      'http://dispatcharr:9191/proxy/ts/stream/abc123',
    );
  });

  it('tolerates a base URL with a trailing slash', () => {
    expect(proxyStreamUrl('http://dispatcharr:9191/', 'abc123')).toBe(
      'http://dispatcharr:9191/proxy/ts/stream/abc123',
    );
  });

  it('ends at the hash, with no trailing slash', () => {
    // Not cosmetic. Dispatcharr serves the stream at the bare path and does
    // not redirect a slashed one onto it, so a trailing slash 404s -- and a
    // 404 reads back as a dead stream, which would rank every stream on the
    // install as dead without saying why.
    expect(proxyStreamUrl('http://d', 'abc123')).not.toMatch(/\/$/);
  });

  it('escapes the hash rather than pasting it into the path', () => {
    expect(proxyStreamUrl('http://d', 'a/../b')).toBe('http://d/proxy/ts/stream/a%2F..%2Fb');
  });

  it('has no address for a stream with no hash', () => {
    // Not an error: the hash is written by the M3U refresh, so a stream
    // without one is mid-import rather than unplayable.
    expect(proxyStreamUrl('http://d', null)).toBeNull();
    expect(proxyStreamUrl('http://d', '')).toBeNull();
    expect(proxyStreamUrl('http://d', '   ')).toBeNull();
  });

  it('refuses a base URL that would truncate the path', () => {
    expect(() => proxyStreamUrl('http://d/?token=x', 'abc123')).toThrow();
  });
});

describe('probeTargetUrl', () => {
  const variant = { variantId: 0, profileId: 3, url: 'http://provider/live/u/p/12.ts' };

  it('probes the provider directly by default', () => {
    expect(probeTargetUrl(variant, 'abc123', null)).toBe('http://provider/live/u/p/12.ts');
  });

  it('probes through Dispatcharr when a base is given', () => {
    expect(probeTargetUrl(variant, 'abc123', 'http://d')).toBe('http://d/proxy/ts/stream/abc123');
  });

  it('falls back to the provider URL for a stream with no hash', () => {
    // Better a measurement of the origin than no measurement at all -- the
    // stream still has to be ranked against the ones beside it.
    expect(probeTargetUrl(variant, null, 'http://d')).toBe('http://provider/live/u/p/12.ts');
  });

  it('leaves the draw alone: two logins keep two lanes', () => {
    // The reason the substitution happens here and not in `buildVariants`.
    // Dispatcharr's address for a stream is the same whoever plays it, so a
    // menu built from proxy addresses would dedupe down to one entry and the
    // second login's lane would never be drawn on -- halving the width of a
    // two-login account the moment the setting was switched on.
    const logins = [
      login(),
      login({ id: 5, dispatcharrProfileId: 5, name: 'second', isDefault: false }),
    ];
    logins[1]!.rewrite = { search: 'provider', replace: 'provider2' };
    const menu = buildVariants('http://provider/live/u/p/12.ts', logins);
    expect(menu.map((v) => v.profileId)).toEqual([0, 5]);

    const slots = new Map([
      [laneKey(6, 0), 1],
      [laneKey(6, 5), 1],
    ]);
    const drawn = [0, 1].map((seq) => drawVariant(menu, 6, slots, seq));
    expect(drawn.map((v) => v.profileId)).toEqual([0, 5]);
    // Both end up at the same address, and that is correct: whichever login
    // Dispatcharr picks, the probe occupies exactly one connection on the
    // account -- which is what the lane charged it.
    expect(drawn.map((v) => probeTargetUrl(v, 'abc123', 'http://d'))).toEqual([
      'http://d/proxy/ts/stream/abc123',
      'http://d/proxy/ts/stream/abc123',
    ]);
  });
});

describe('probe routing', () => {
  it('probes providers directly by default', () => {
    expect(probeProxyBase(DIRECT)).toBeNull();
    expect(probeUserAgent(DIRECT)).toBe('VLC/3.0.14');
    expect(activityOptions(DIRECT)).toEqual({});
  });

  it('switches address, agent and status reading together', () => {
    expect(probeProxyBase(PROXIED)).toBe('http://dispatcharr:9191');
    // Not the provider-facing agent: in proxy mode that one is whatever the
    // M3U account is set to, and this one's job is to be recognisable rather
    // than to look like a player.
    expect(probeUserAgent(PROXIED)).toBe('Podium-Probe/1');
    expect(activityOptions(PROXIED)).toEqual({ ignoreUserAgent: 'Podium-Probe/1' });
  });
});

describe('activeSessions with Podium as a client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStatus(body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      })),
    );
  }

  const client = () => new DispatcharrClient('http://d', { apiKey: 'k' });

  it('counts its own probes as viewers when told nothing', async () => {
    // The unfiltered read, kept as a test because it is the behaviour every
    // install probing directly still gets.
    stubStatus({
      channels: [{ channel_id: 8, m3u_profile_id: 9, clients: [{ user_agent: 'Podium-Probe/1' }] }],
      count: 1,
    });
    const sessions = await client().activeSessions();
    expect(sessions.map((s) => [s.channelId, s.profileId])).toEqual([[8, 9]]);
  });

  it('discounts a session that is only its own probing', async () => {
    stubStatus({
      channels: [
        {
          channel_id: 8,
          m3u_profile_id: 9,
          clients: [{ user_agent: 'Podium-Probe/1' }, { user_agent: 'Podium-Probe/1' }],
        },
      ],
      count: 1,
    });
    const sessions = await client().activeSessions(undefined, {
      ignoreUserAgent: 'Podium-Probe/1',
    });
    // And specifically does not trip the "entries resolved to no channel ids"
    // guard, which would report a healthy install as a broken payload.
    expect(sessions).toEqual([]);
  });

  it('keeps a session a real viewer is sharing with a probe', async () => {
    // The viewer is what the pacer must yield to; the probe beside them is
    // already accounted for by the lane it was drawn from.
    stubStatus({
      channels: [
        {
          channel_id: 8,
          m3u_profile_id: 9,
          clients: [{ user_agent: 'Podium-Probe/1' }, { user_agent: 'VLC/3.0.20' }],
        },
      ],
      count: 1,
    });
    const sessions = await client().activeSessions(undefined, {
      ignoreUserAgent: 'Podium-Probe/1',
    });
    expect(sessions.map((s) => [s.channelId, s.profileId])).toEqual([[8, 9]]);
  });

  it('keeps a session it cannot see the clients of', async () => {
    // An older Dispatcharr reporting only channel-level counts gives nothing
    // to match on. Fail towards "somebody is watching", never away from it.
    stubStatus({ channels: [{ channel_id: 8, m3u_profile_id: 9 }], count: 1 });
    const sessions = await client().activeSessions(undefined, {
      ignoreUserAgent: 'Podium-Probe/1',
    });
    expect(sessions.map((s) => [s.channelId, s.profileId])).toEqual([[8, 9]]);
  });

  it('still reports a payload it genuinely could not read', async () => {
    // One entry filtered, one unreadable: the guard must survive the
    // subtraction rather than being disabled by it.
    stubStatus({
      channels: [
        { channel_id: 8, clients: [{ user_agent: 'Podium-Probe/1' }] },
        { m3u_profile_id: 9, clients: [{ user_agent: 'VLC/3.0.20' }] },
      ],
      count: 2,
    });
    await expect(
      client().activeSessions(undefined, { ignoreUserAgent: 'Podium-Probe/1' }),
    ).rejects.toThrow(/0 channel IDs resolved/);
  });
});
