/**
 * Podium behind a reverse proxy.
 *
 * The front door reads `Host`, and behind a proxy that header is whatever the
 * proxy chose to forward. nginx's *default* is `proxy_set_header Host
 * $proxy_host`, so Podium sees `Host: 127.0.0.1:3456` while the browser sent
 * `Origin: https://podium.example.com` -- and the origin check, which compares
 * exactly those two, refuses every POST, PUT and DELETE as cross-site. The UI
 * loads and nothing in it works.
 *
 * The same hop is plain http even when the browser is on TLS, so the token
 * cookie was set without `Secure` and the `?token=` redirect pointed back at
 * `http://`, dropping the browser out of HTTPS at the moment it was handed a
 * credential.
 *
 * `PODIUM_TRUST_PROXY` answers all of it by believing `X-Forwarded-Host` and
 * `X-Forwarded-Proto`. It is opt-in and stays opt-in: `Host` is what makes the
 * rebinding defence work -- a page cannot change it -- and these two headers are
 * ones any client can write. Behind a proxy that sets them, the proxy is the
 * only thing that can reach Podium and they are as trustworthy as it is.
 */

import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { forwardedHostOf } from './access';

const { proxy } = await import('../proxy');

const ORIGINAL = {
  trust: process.env.PODIUM_TRUST_PROXY,
  hosts: process.env.PODIUM_ALLOWED_HOSTS,
  token: process.env.PODIUM_AUTH_TOKEN,
};

afterEach(() => {
  for (const [key, value] of [
    ['PODIUM_TRUST_PROXY', ORIGINAL.trust],
    ['PODIUM_ALLOWED_HOSTS', ORIGINAL.hosts],
    ['PODIUM_AUTH_TOKEN', ORIGINAL.token],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A request as it arrives from a proxy that rewrote Host to the upstream. */
const proxied = (method: string, headers: Record<string, string> = {}) =>
  proxy(
    new NextRequest(
      new Request('http://127.0.0.1:3456/api/settings', {
        method,
        headers: {
          host: '127.0.0.1:3456',
          'x-forwarded-host': 'podium.example.com',
          'x-forwarded-proto': 'https',
          origin: 'https://podium.example.com',
          'sec-fetch-site': 'same-origin',
          ...headers,
        },
      }),
    ),
  );

describe('forwardedHostOf', () => {
  it('takes the first entry, which is what the browser sent', () => {
    // A chain of proxies appends, so later entries are the hops.
    expect(forwardedHostOf('podium.example.com, inner.proxy')).toBe('podium.example.com');
    expect(forwardedHostOf('podium.example.com:443')).toBe('podium.example.com');
    expect(forwardedHostOf('')).toBeNull();
    expect(forwardedHostOf(null)).toBeNull();
  });
});

describe('a write behind a proxy that rewrote Host', () => {
  it('is refused as cross-site when the proxy is not trusted', () => {
    // The regression, stated. Host says 127.0.0.1 -- which passes the host
    // check, being a private address -- and the Origin says the public name, so
    // the two disagree and every mutation 403s.
    delete process.env.PODIUM_TRUST_PROXY;
    const response = proxied('PUT');
    expect(response.status).toBe(403);
  });

  it('is allowed once the proxy is trusted and its host is named', () => {
    process.env.PODIUM_TRUST_PROXY = 'true';
    process.env.PODIUM_ALLOWED_HOSTS = 'podium.example.com';
    expect(proxied('PUT').status).toBe(200);
  });

  it('still refuses a public forwarded host nobody allowed', () => {
    // Trusting the proxy moves which header the host rules read. It does not
    // stop them being applied: a public name still has to be named, and the 403
    // still says which one to put in PODIUM_ALLOWED_HOSTS.
    process.env.PODIUM_TRUST_PROXY = 'true';
    delete process.env.PODIUM_ALLOWED_HOSTS;
    const response = proxied('PUT');
    expect(response.status).toBe(403);
  });

  it('does not let an untrusted client forge its way past the host rules', () => {
    // The reason this is opt-in. With the variable unset, X-Forwarded-Host is
    // just a header somebody wrote, and `Host` -- which a browser will not let a
    // page change -- is still what decides.
    delete process.env.PODIUM_TRUST_PROXY;
    const response = proxy(
      new NextRequest(
        new Request('http://attacker.example/api/state', {
          method: 'GET',
          headers: { host: 'attacker.example', 'x-forwarded-host': 'podium.lan' },
        }),
      ),
    );
    expect(response.status).toBe(403);
  });
});

describe('the token cookie', () => {
  const visit = (headers: Record<string, string>) =>
    proxy(
      new NextRequest(
        new Request('http://127.0.0.1:3456/?token=s3cret', { method: 'GET', headers }),
      ),
    );

  it('keeps the browser on HTTPS when the proxy terminated it', () => {
    process.env.PODIUM_AUTH_TOKEN = 's3cret';
    process.env.PODIUM_TRUST_PROXY = 'true';
    process.env.PODIUM_ALLOWED_HOSTS = 'podium.example.com';

    const response = visit({
      host: '127.0.0.1:3456',
      'x-forwarded-host': 'podium.example.com',
      'x-forwarded-proto': 'https',
    });

    expect(response.status).toBe(307);
    // Back to the address the browser can actually reach, over the scheme it
    // came in on. Both used to come from `request.url`, which is built from the
    // Host header the proxy replaced.
    expect(response.headers.get('location')).toBe('https://podium.example.com/');
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });

  it('is not marked Secure on a plain-http install, where it would never come back', () => {
    process.env.PODIUM_AUTH_TOKEN = 's3cret';
    delete process.env.PODIUM_TRUST_PROXY;

    const response = visit({ host: 'podium.lan:3456' });

    expect(response.status).toBe(307);
    // The address is whatever the request already carried -- untrusted means
    // nothing here is rewritten -- but the scheme must stay plain http, or the
    // cookie is set with Secure and never comes back.
    expect(response.headers.get('location')).toMatch(/^http:\/\//);
    expect(response.headers.get('set-cookie')).not.toContain('Secure');
  });
});
