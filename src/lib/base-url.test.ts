/**
 * The base URLs, and the request that gets built out of them.
 *
 * `PODIUM_TEAMARR_URL` reached `TeamarrClient` unvalidated -- it was the only
 * URL field that fell through `validateSettings` to the branch that stores any
 * text at all -- and the client appended its API path by concatenation. Those
 * two together are a request Podium believes it is making to Teamarr's
 * stream-ordering API and is actually making somewhere else: everything after a
 * `#` in the base is dropped, taking the appended path with it.
 *
 * The settings PUT has no credential in front of it on a default install, so
 * the URL is attacker-reachable input. These are the checks that make it one
 * Podium can only point at an http(s) service, on the path it meant.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { baseUrlProblem, normaliseBaseUrl } from './base-url';
import { validateSettings } from './settings';
import { TeamarrClient } from './teamarr-client';

describe('baseUrlProblem', () => {
  it('accepts the addresses a homelab actually uses', () => {
    for (const url of [
      'http://teamarr:9195',
      'https://teamarr.example.com',
      'http://192.168.1.10:9195',
      'http://podium.tail1234.ts.net',
      'https://host/behind/a/path',
      'http://[::1]:9195',
    ]) {
      expect(baseUrlProblem(url), url).toBe('');
    }
  });

  it('refuses a fragment, which silently truncates the API path', () => {
    // The whole mechanism: `${base}${path}` on this produces
    // `.../latest/meta-data#/api/v1/settings/stream-ordering`, and fetch drops
    // everything from the `#`. The request goes to /latest/meta-data.
    expect(baseUrlProblem('http://169.254.169.254/latest/meta-data#')).toContain('#');
    expect(baseUrlProblem('http://teamarr:9195/#anything')).toContain('#');
  });

  it('refuses a query string, which does the same thing', () => {
    expect(baseUrlProblem('http://192.168.1.1/admin?x=')).toContain('?');
  });

  it('refuses a credential smuggled into the URL', () => {
    expect(baseUrlProblem('http://user:pass@teamarr:9195')).toContain('username or password');
  });

  it('refuses a scheme that is not http(s)', () => {
    for (const url of ['file:///app/data/podium.db', 'ftp://host/x', 'javascript:alert(1)']) {
      expect(baseUrlProblem(url), url).toBe('must be an http(s) URL');
    }
  });

  it('refuses a bare host, which is the commonest typo rather than an attack', () => {
    // `new URL` accepts this -- as a URL with a scheme of "teamarr:" -- so it
    // fails on the protocol check rather than on parsing.
    expect(baseUrlProblem('teamarr:9195')).toBe('must be an http(s) URL');
    expect(baseUrlProblem('192.168.1.10:9195/x')).toContain('scheme');
    expect(baseUrlProblem('   ')).toBe('is not configured');
  });
});

describe('normaliseBaseUrl', () => {
  it('keeps a path prefix but drops trailing slashes', () => {
    expect(normaliseBaseUrl('http://host/teamarr/', 'Teamarr')).toBe('http://host/teamarr');
    expect(normaliseBaseUrl('http://host///', 'Teamarr')).toBe('http://host');
  });

  it('names the service in the error, since two fields share these rules', () => {
    expect(() => normaliseBaseUrl('http://host/#', 'Teamarr')).toThrow(/^Teamarr URL/);
    expect(() => normaliseBaseUrl('nope', 'Dispatcharr')).toThrow(/^Dispatcharr URL/);
  });
});

describe('the Teamarr URL as a setting', () => {
  it('is checked on the way in, like the Dispatcharr one', () => {
    // It used to be stored verbatim: `kind: 'string'` with no case of its own.
    const { errors } = validateSettings({ PODIUM_TEAMARR_URL: 'http://169.254.169.254/#' });
    expect(errors[0]?.key).toBe('PODIUM_TEAMARR_URL');
  });

  it('stores the normalised form, not the text as typed', () => {
    const { values, errors } = validateSettings({ PODIUM_TEAMARR_URL: 'http://teamarr:9195/' });
    expect(errors).toEqual([]);
    expect(values.PODIUM_TEAMARR_URL).toBe('http://teamarr:9195');
  });

  it('still clears to empty, which is how the push is turned off', () => {
    expect(validateSettings({ PODIUM_TEAMARR_URL: '' })).toEqual({
      values: { PODIUM_TEAMARR_URL: null },
      errors: [],
    });
  });
});

describe('TeamarrClient with a hostile base', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('refuses to be built at all, so nothing is requested', () => {
    // Refused in the constructor rather than filtered at the call site: the URL
    // also arrives from the environment, where `validateSettings` never runs.
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: true, status: 200, text: async () => '{}' } as Response;
    }) as unknown as typeof fetch;

    expect(() => new TeamarrClient('http://169.254.169.254/latest/meta-data#')).toThrow(
      'Teamarr URL must not contain a "#" fragment',
    );
    expect(calls).toEqual([]);
  });

  it('does not hand back the body of whatever answered', async () => {
    // The other half of the same reach: the test route returns this message to
    // its caller, so a 300-byte slice of an arbitrary error body is a read
    // primitive pointed at anything the container can reach. Teamarr's own
    // `detail` is the only part worth quoting.
    globalThis.fetch = (async () => ({
      ok: false,
      status: 403,
      text: async () => 'ami-0abc SecretAccessKey ASIA...',
    })) as unknown as typeof fetch;

    await expect(new TeamarrClient('http://teamarr:9195').rules()).rejects.toThrow(
      'Teamarr GET 403: the response was not JSON',
    );
  });

  it('still quotes a rule Teamarr itself rejected', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ detail: 'rule 3: unknown type "vibes"' }),
    })) as unknown as typeof fetch;

    await expect(new TeamarrClient('http://teamarr:9195').rules()).rejects.toThrow(
      'rule 3: unknown type "vibes"',
    );
  });
});
