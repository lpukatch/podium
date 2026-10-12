/**
 * The `?token=` door, at the proxy.
 *
 * Three behaviors worth pinning: an API caller presenting `?token=` gets an
 * answer rather than a redirect (a 307 asks for a second request most clients
 * will not follow, and the credential has already been checked); a *stale*
 * query token no longer defeats a session whose cookie is fine; and pages
 * still redirect with the token stripped from the URL, because that is the
 * part that keeps it out of history and pasted links.
 */

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { proxy } from './proxy';

const TOKEN = 'tok-123';

const request = (path: string, headers: Record<string, string> = {}, method = 'GET'): NextRequest =>
  new NextRequest(`http://podium.example${path}`, {
    method,
    headers: { host: 'podium.example', ...headers },
  });

describe('the ?token= door', () => {
  beforeEach(() => {
    process.env.PODIUM_AUTH_TOKEN = TOKEN;
    process.env.PODIUM_ALLOWED_HOSTS = 'podium.example';
  });

  afterEach(() => {
    delete process.env.PODIUM_AUTH_TOKEN;
    delete process.env.PODIUM_ALLOWED_HOSTS;
  });

  it('answers an API call instead of redirecting it, and plants the cookie', () => {
    const response = proxy(request(`/api/stats?token=${TOKEN}`, { accept: 'application/json' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain(`podium_token=${TOKEN}`);
  });

  it('still redirects a page, with the token stripped from the URL', () => {
    const response = proxy(request(`/?token=${TOKEN}`));
    expect(response.status).toBe(307);
    expect(response.headers.get('location') ?? '').not.toContain('token');
    expect(response.headers.get('set-cookie')).toContain('podium_token=');
  });

  it('a stale query token does not defeat a valid session cookie', () => {
    const response = proxy(
      request('/api/stats?token=stale-and-wrong', { cookie: `podium_token=${TOKEN}` }),
    );
    expect(response.status).toBe(200);
  });

  it('a bad token with no other credential is still refused', () => {
    const response = proxy(request('/?token=stale-and-wrong'));
    expect(response.status).toBe(401);
  });
});

describe('the body-size ceiling', () => {
  beforeEach(() => {
    process.env.PODIUM_ALLOWED_HOSTS = 'podium.example';
  });

  afterEach(() => {
    delete process.env.PODIUM_ALLOWED_HOSTS;
  });

  it('refuses an oversized API write with a 413', () => {
    const response = proxy(
      request('/api/rule-check', { 'content-length': String(6 * 1024 * 1024) }, 'POST'),
    );
    expect(response.status).toBe(413);
  });

  it('lets a write that declares a sane size through', () => {
    const response = proxy(request('/api/rule-check', { 'content-length': '65536' }, 'POST'));
    expect(response.status).toBe(200);
  });

  it('leaves reads alone whatever they declare', () => {
    const response = proxy(
      request('/api/state', { 'content-length': String(6 * 1024 * 1024) }, 'GET'),
    );
    expect(response.status).toBe(200);
  });

  it('ignores the ceiling outside the API', () => {
    const response = proxy(request('/', { 'content-length': String(6 * 1024 * 1024) }, 'POST'));
    expect(response.status).toBe(200);
  });
});
