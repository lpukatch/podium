/**
 * A saved credential never follows the URL to a host it was not saved for.
 *
 * `mergeForTest` has enforced this on the *test* endpoint since the disclosure
 * it was written for. Saving had no such rule, and saving is the worse half:
 * the test sends the credential once, a save points the worker's next pass and
 * every page in the UI at the new host and writes the decision to the database,
 * where nothing afterwards shows it happened.
 *
 * One request did it. `PUT /api/settings` carrying nothing but a URL passed the
 * credential check -- `requireCredentials` reads the merged config, and the
 * credentials were still there in the environment, exactly where a compose file
 * puts them -- and then the Dispatcharr API key went to whatever host had been
 * named, in cleartext. Restoring a backup is the same request in a different
 * shape: it replaces the settings table wholesale, so a bundle with a URL and
 * no credentials in it leaves the environment's in place and re-aimed.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { movedCredentials } from './settings';
import { Store } from './store';

const KEY = 'DISPATCHARR_API_KEY';

describe('movedCredentials', () => {
  const env = { DISPATCHARR_API_KEY: 'from-compose' };

  it('flags a credential inherited from the environment when the host changes', () => {
    // The attack, in one line: the patch names a URL and nothing else.
    const moved = movedCredentials(
      { DISPATCHARR_URL: 'http://dispatcharr:9191' },
      { DISPATCHARR_URL: 'https://attacker.example' },
      { DISPATCHARR_URL: 'https://attacker.example' },
      env,
    );
    expect(moved).toEqual([KEY]);
  });

  it('flags one left behind in the settings table just the same', () => {
    const moved = movedCredentials(
      { DISPATCHARR_URL: 'http://dispatcharr:9191', [KEY]: 'saved' },
      { DISPATCHARR_URL: 'https://attacker.example', [KEY]: 'saved' },
      { DISPATCHARR_URL: 'https://attacker.example' },
      {},
    );
    expect(moved).toEqual([KEY]);
  });

  it('allows the move when the credential is supplied in the same request', () => {
    // The person at the form, typing the key for the host they are moving to.
    // They have it; sending it there discloses nothing they did not already know.
    const moved = movedCredentials(
      { DISPATCHARR_URL: 'http://dispatcharr:9191' },
      { DISPATCHARR_URL: 'https://new-host.lan', [KEY]: 'typed-now' },
      { DISPATCHARR_URL: 'https://new-host.lan', [KEY]: 'typed-now' },
      env,
    );
    expect(moved).toEqual([]);
  });

  it('still flags the credentials the request did not re-supply', () => {
    // Supplying the API key does not license sending the username and password
    // as well: a patch can carry one and inherit the other two.
    const moved = movedCredentials(
      { DISPATCHARR_URL: 'http://dispatcharr:9191' },
      {
        DISPATCHARR_URL: 'https://attacker.example',
        [KEY]: 'typed-now',
        DISPATCHARR_USERNAME: 'u',
        DISPATCHARR_PASSWORD: 'p',
      },
      { DISPATCHARR_URL: 'https://attacker.example', [KEY]: 'typed-now' },
      {},
    );
    expect(moved).toEqual(['DISPATCHARR_USERNAME', 'DISPATCHARR_PASSWORD']);
  });

  it('says nothing about a change that keeps the host', () => {
    // Fixing the port is the commonest edit there is, and the secret stays on
    // the machine that already has it. Same reasoning as `mergeForTest`.
    const moved = movedCredentials(
      { DISPATCHARR_URL: 'http://dispatcharr:9191' },
      { DISPATCHARR_URL: 'http://dispatcharr:9192' },
      { DISPATCHARR_URL: 'http://dispatcharr:9192' },
      env,
    );
    expect(moved).toEqual([]);
  });

  it('says nothing when there is no credential to move', () => {
    const moved = movedCredentials(
      { DISPATCHARR_URL: 'http://dispatcharr:9191' },
      { DISPATCHARR_URL: 'https://elsewhere.lan' },
      { DISPATCHARR_URL: 'https://elsewhere.lan' },
      {},
    );
    expect(moved).toEqual([]);
  });

  it('compares against the default URL on an install that never set one', () => {
    // A first save that names a host is still a move away from the default the
    // app has been using, and the environment's credential is still behind it.
    expect(movedCredentials({}, { DISPATCHARR_URL: 'https://attacker.example' }, {}, env)).toEqual([
      KEY,
    ]);
  });
});

describe('PUT /api/settings', () => {
  let dir = '';
  const originalKey = process.env.DISPATCHARR_API_KEY;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-credmove-'));
    writeFileSync(join(dir, 'rules.json'), JSON.stringify({ schema: 2, channels: [] }), 'utf8');
    process.env.PODIUM_DATA_DIR = dir;
    // The deployment this is about: credentials in the environment, from a
    // compose file, and a settings table that has never held one.
    process.env.DISPATCHARR_API_KEY = 'from-compose';
  });

  afterAll(() => {
    delete process.env.PODIUM_DATA_DIR;
    if (originalKey === undefined) delete process.env.DISPATCHARR_API_KEY;
    else process.env.DISPATCHARR_API_KEY = originalKey;
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const store = new Store(join(dir, 'podium.db'));
    try {
      store.setSettings({ DISPATCHARR_URL: null, [KEY]: null });
    } finally {
      store.close();
    }
  });

  const put = async (body: unknown) => {
    const { PUT } = await import('../app/api/settings/route');
    const response = await PUT(
      new Request('http://local/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const storedUrl = () => {
    const store = new Store(join(dir, 'podium.db'));
    try {
      return store.settings().DISPATCHARR_URL;
    } finally {
      store.close();
    }
  };

  it('refuses a URL-only change that would re-aim the environment credential', async () => {
    const { status, body } = await put({ DISPATCHARR_URL: 'https://attacker.example' });

    expect(status).toBe(400);
    expect(String(body.error)).toContain('attacker.example');
    expect(String(body.error)).toContain('API key');
    // Nothing written: the next worker pass must still go to the old host.
    expect(storedUrl()).toBeUndefined();
  });

  it('accepts the same change with the credential re-entered', async () => {
    const { status } = await put({
      DISPATCHARR_URL: 'https://new-host.lan',
      [KEY]: 'typed-by-hand',
    });

    expect(status).toBe(200);
    expect(storedUrl()).toBe('https://new-host.lan');
  });

  it('leaves an unrelated setting alone', async () => {
    // The guard is about the Dispatcharr host. Everything else saves as before.
    // In displayed units, as the form sends them: seconds, not milliseconds.
    const { status } = await put({ PODIUM_TICK_MS: '90' });
    expect(status).toBe(200);
  });
});

describe('POST /api/backup', () => {
  let dir = '';
  const originalKey = process.env.DISPATCHARR_API_KEY;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-credmove-restore-'));
    writeFileSync(join(dir, 'rules.json'), JSON.stringify({ schema: 2, channels: [] }), 'utf8');
    process.env.PODIUM_DATA_DIR = dir;
    process.env.PODIUM_RULES = join(dir, 'rules.json');
    process.env.DISPATCHARR_API_KEY = 'from-compose';
  });

  afterAll(() => {
    delete process.env.PODIUM_DATA_DIR;
    delete process.env.PODIUM_RULES;
    if (originalKey === undefined) delete process.env.DISPATCHARR_API_KEY;
    else process.env.DISPATCHARR_API_KEY = originalKey;
    rmSync(dir, { recursive: true, force: true });
  });

  const post = async (settings: Record<string, string>) => {
    const { POST } = await import('../app/api/backup/route');
    const response = await POST(
      new Request('http://local/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'podium-backup',
          version: 1,
          createdAt: 0,
          rules: { schema: 2, channels: [] },
          settings,
          teamarrRules: null,
          assignBlocks: [],
        }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it('refuses a bundle that re-aims the environment credential', async () => {
    // A restore is a POST of a file, which is a request like any other. It
    // wipes the settings table, so the credential that follows the new URL is
    // the environment's.
    const { status, body } = await post({ DISPATCHARR_URL: 'https://attacker.example' });

    expect(status).toBe(400);
    expect(String(body.error)).toContain('attacker.example');
  });

  it('restores a bundle that carries its own credential', async () => {
    // The normal case: an export carries the credentials, so the caller holding
    // the file already holds them.
    const { status } = await post({
      DISPATCHARR_URL: 'https://new-host.lan',
      DISPATCHARR_API_KEY: 'from-the-bundle',
    });

    expect(status).toBe(200);
  });
});
