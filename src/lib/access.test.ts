import { describe, expect, it } from 'vitest';
import {
  type AccessPolicy,
  type AccessRequest,
  checkAccess,
  hostOf,
  isAllowedHost,
  originHost,
  parseHostList,
  secretEquals,
} from './access';

const OPEN: AccessPolicy = { allowedHosts: [], token: '' };

/** A same-origin write from the UI: what every legitimate request looks like. */
const write = (over: Partial<AccessRequest> = {}): AccessRequest => ({
  method: 'POST',
  path: '/api/apply/1',
  host: 'podium.lan',
  origin: 'http://podium.lan:3456',
  secFetchSite: 'same-origin',
  ...over,
});

describe('hostOf', () => {
  it('strips the port and lowercases', () => {
    expect(hostOf('Podium.LAN:3456')).toBe('podium.lan');
    expect(hostOf('192.168.1.40:3456')).toBe('192.168.1.40');
  });

  it('unwraps a bracketed IPv6 address, with or without a port', () => {
    expect(hostOf('[::1]:3456')).toBe('::1');
    expect(hostOf('[fe80::1]')).toBe('fe80::1');
  });

  it('does not read a bare IPv6 literal as host:port', () => {
    expect(hostOf('fe80::1')).toBe('fe80::1');
  });

  it('treats an absent or empty header as no host at all', () => {
    expect(hostOf(null)).toBeNull();
    expect(hostOf('  ')).toBeNull();
  });
});

describe('originHost', () => {
  it('reduces an origin to its hostname', () => {
    expect(originHost('http://podium.lan:3456')).toBe('podium.lan');
    expect(originHost('https://[::1]:3456')).toBe('::1');
  });

  it('separates absent from opaque', () => {
    // Absent means "not a browser, or a same-origin GET"; opaque means a
    // sandboxed frame, which must never match a host.
    expect(originHost(null)).toBeNull();
    expect(originHost('null')).toBe('');
    expect(originHost('not a url')).toBe('');
  });
});

describe('isAllowedHost', () => {
  it('accepts loopback and private address literals', () => {
    for (const host of [
      '127.0.0.1',
      '10.4.4.4',
      '192.168.1.40',
      '172.16.0.9',
      '172.31.255.255',
      '169.254.1.1',
      '100.101.102.103',
      '::1',
      'fd7a:115c::1',
      'fe80::1',
      '::ffff:192.168.1.40',
    ]) {
      expect(isAllowedHost(host), host).toBe(true);
    }
  });

  it('refuses public address literals and public names', () => {
    for (const host of [
      '203.0.113.5',
      '8.8.8.8',
      '172.32.0.1',
      '100.128.0.1',
      'podium.example.com',
      '2606:4700::1111',
    ]) {
      expect(isAllowedHost(host), host).toBe(false);
    }
  });

  it('accepts any single-label name, which is what container DNS uses', () => {
    // A rebinding attack needs a registrable domain, and every one of those has
    // a dot -- so `http://podium:3456` between containers is safe by shape.
    expect(isAllowedHost('podium')).toBe(true);
    expect(isAllowedHost('localhost')).toBe(true);
  });

  it('accepts suffixes nobody can register against you', () => {
    expect(isAllowedHost('podium.lan')).toBe(true);
    expect(isAllowedHost('podium.default.svc.cluster.local')).toBe(true);
    expect(isAllowedHost('nas.tail1234.ts.net')).toBe(true);
    // Not a suffix match on a lookalike domain.
    expect(isAllowedHost('podium.lan.evil.com')).toBe(false);
  });

  it('accepts what PODIUM_ALLOWED_HOSTS names, exactly or by suffix', () => {
    const allowed = parseHostList('podium.example.com, .apps.example.org');
    expect(isAllowedHost('podium.example.com', allowed)).toBe(true);
    expect(isAllowedHost('podium.apps.example.org', allowed)).toBe(true);
    // The suffix rule covers subdomains, not the bare domain.
    expect(isAllowedHost('apps.example.org', allowed)).toBe(false);
    expect(isAllowedHost('other.example.com', allowed)).toBe(false);
  });

  it('has an explicit escape hatch', () => {
    expect(isAllowedHost('anything.example.com', ['*'])).toBe(true);
  });

  it('allows a request with no Host header at all', () => {
    // Only a browser sends one, and only a browser can be rebound.
    expect(isAllowedHost(null)).toBe(true);
  });
});

describe('parseHostList', () => {
  it('splits on commas or spaces and drops ports', () => {
    expect(parseHostList('Podium.example.com:3456,  other.example.com')).toEqual([
      'podium.example.com',
      'other.example.com',
    ]);
    expect(parseHostList(undefined)).toEqual([]);
  });
});

describe('checkAccess', () => {
  it('allows the UI writing to its own API', () => {
    expect(checkAccess(write(), OPEN)).toEqual({ ok: true });
  });

  it('takes the Host header exactly as it arrives, port and all', () => {
    // What a browser actually sends. Normalising this at the call site instead
    // meant every check refused every request the moment one caller forgot.
    expect(
      checkAccess(write({ host: '127.0.0.1:3456', origin: 'http://127.0.0.1:3456' }), OPEN),
    ).toEqual({ ok: true });
    expect(checkAccess(write({ host: '[::1]:3456', origin: 'http://[::1]:3456' }), OPEN)).toEqual({
      ok: true,
    });
    // And the allowlist matches a host that arrived with a port on it.
    expect(
      checkAccess(
        write({ host: 'podium.example.com:3456', origin: 'https://podium.example.com' }),
        { allowedHosts: parseHostList('podium.example.com'), token: '' },
      ),
    ).toEqual({ ok: true });
  });

  it('refuses a host it does not recognise, and names the fix', () => {
    const verdict = checkAccess(write({ host: 'podium.example.com' }), OPEN);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.status).toBe(403);
    expect(verdict.reason).toBe('host');
    expect(verdict.message).toContain('PODIUM_ALLOWED_HOSTS');
  });

  it('refuses a cross-site write even when the host is fine', () => {
    // The CSRF case: a page on the internet POSTing at your LAN address.
    const verdict = checkAccess(
      write({ origin: 'https://evil.example', secFetchSite: 'cross-site' }),
      OPEN,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('cross-site');
  });

  it('refuses a same-site write from another port or subdomain', () => {
    expect(checkAccess(write({ secFetchSite: 'same-site', origin: null }), OPEN).ok).toBe(false);
  });

  it('falls back to Origin when Sec-Fetch-Site is absent', () => {
    expect(checkAccess(write({ secFetchSite: null, origin: 'http://evil.example' }), OPEN).ok).toBe(
      false,
    );
    expect(checkAccess(write({ secFetchSite: null }), OPEN)).toEqual({ ok: true });
  });

  it('allows a write with neither header, which is a non-browser client', () => {
    expect(checkAccess(write({ secFetchSite: null, origin: null }), OPEN)).toEqual({ ok: true });
  });

  it('refuses an opaque origin', () => {
    expect(checkAccess(write({ secFetchSite: null, origin: 'null' }), OPEN).ok).toBe(false);
  });

  it('ignores cross-site headers on a read', () => {
    // A cross-site GET cannot be read back without CORS, and refusing it would
    // break following a link to the UI from anywhere.
    expect(
      checkAccess(write({ method: 'GET', path: '/api/state', secFetchSite: 'cross-site' }), OPEN),
    ).toEqual({ ok: true });
  });

  it('requires the token on reads and writes once one is set', () => {
    const guarded: AccessPolicy = { allowedHosts: [], token: 'sekret' };
    expect(checkAccess(write({ method: 'GET', path: '/api/state' }), guarded).ok).toBe(false);
    expect(checkAccess(write({ credentials: ['sekret'] }), guarded)).toEqual({ ok: true });
    expect(checkAccess(write({ credentials: ['wrong'] }), guarded).ok).toBe(false);
  });

  it('lets the container health check through without one', () => {
    // Otherwise a token-protected install fails its own healthcheck and gets
    // restarted forever.
    const guarded: AccessPolicy = { allowedHosts: [], token: 'sekret' };
    expect(
      checkAccess({ ...write({ method: 'GET', path: '/api/health' }), credentials: [] }, guarded),
    ).toEqual({ ok: true });
    // Metrics describe your library, so they are not exempt.
    expect(
      checkAccess({ ...write({ method: 'GET', path: '/api/metrics' }), credentials: [] }, guarded)
        .ok,
    ).toBe(false);
  });

  it('checks the host before the token, so the message is the useful one', () => {
    const guarded: AccessPolicy = { allowedHosts: [], token: 'sekret' };
    const verdict = checkAccess(write({ host: 'podium.example.com' }), guarded);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('host');
  });
});

describe('secretEquals', () => {
  it('matches only an exact string', () => {
    expect(secretEquals('abc', 'abc')).toBe(true);
    expect(secretEquals('abc', 'abd')).toBe(false);
    expect(secretEquals('abc', 'ab')).toBe(false);
    expect(secretEquals('', '')).toBe(true);
  });
});
