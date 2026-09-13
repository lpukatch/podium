/**
 * The two halves of a restore, and what happens when only one lands.
 *
 * A restore writes rules.json and then the database, and no atomic commit spans
 * a file and SQLite. The order is already the safety -- everything that can
 * reject runs first, so a 400 never mutates anything -- but the last step can
 * still fail on its own account: a busy database, a disk that filled between
 * the two writes, a bundle the transaction rejects. That left rules.json
 * replaced and the settings, rule set and assign blocks as they were. An
 * install running half of somebody's backup, in the one operation people reach
 * for *because* something has already gone wrong.
 *
 * Also here: the download half. Its body carries the Dispatcharr credential in
 * the clear -- deliberately, since a backup that cannot restore the credential
 * is not a backup -- which makes it the one GET that is checked like a write.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAccess } from './access';

let dir = '';
let rulesPath = '';

const before = { key: process.env.DISPATCHARR_API_KEY };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-restore-'));
  rulesPath = join(dir, 'rules.json');
  process.env.PODIUM_DATA_DIR = dir;
  process.env.PODIUM_RULES = rulesPath;
  process.env.DISPATCHARR_API_KEY = 'k';
});

afterAll(() => {
  delete process.env.PODIUM_DATA_DIR;
  delete process.env.PODIUM_RULES;
  if (before.key === undefined) delete process.env.DISPATCHARR_API_KEY;
  else process.env.DISPATCHARR_API_KEY = before.key;
  rmSync(dir, { recursive: true, force: true });
});

const EXISTING = { schema: 2, channels: [{ channel_id: 1, aliases: ['was here'] }], groups: {} };

beforeEach(() => {
  writeFileSync(rulesPath, JSON.stringify(EXISTING), 'utf8');
  vi.restoreAllMocks();
});

const onDisk = () => JSON.parse(readFileSync(rulesPath, 'utf8')) as typeof EXISTING;

const bundle = (settings: Record<string, string> = {}) => ({
  kind: 'podium-backup',
  version: 1,
  createdAt: 0,
  rules: { schema: 2, channels: [{ channel_id: 99, aliases: ['from the bundle'] }], groups: {} },
  settings,
  teamarrRules: null,
  assignBlocks: [],
});

const post = async (body: unknown) => {
  const { POST } = await import('../app/api/backup/route');
  const response = await POST(
    new Request('http://local/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe('a restore whose database write fails', () => {
  it('puts rules.json back rather than leaving half a backup applied', async () => {
    const { Store } = await import('./store');
    vi.spyOn(Store.prototype, 'restoreConfig').mockImplementation(() => {
      throw new Error('database is locked');
    });

    const { status, body } = await post(bundle());

    expect(status).toBe(500);
    expect(String(body.error)).toContain('Nothing was changed');
    expect(onDisk()).toEqual(EXISTING);
  });

  it('says so plainly when it could not put it back', async () => {
    // An unreadable rules.json cannot be restored from memory it was never read
    // into. The message has to be the honest one rather than the reassuring one:
    // somebody is about to decide whether to re-import.
    writeFileSync(rulesPath, 'not json at all', 'utf8');
    const { Store } = await import('./store');
    vi.spyOn(Store.prototype, 'restoreConfig').mockImplementation(() => {
      throw new Error('database is locked');
    });

    const { status, body } = await post(bundle());

    expect(status).toBe(500);
    expect(String(body.error)).toContain('rules.json was replaced');
  });

  it('writes the bundle through when the database write lands', async () => {
    const { status } = await post(bundle());
    expect(status).toBe(200);
    expect(onDisk().channels[0]?.channel_id).toBe(99);
  });
});

describe('GET /api/backup is checked like a write', () => {
  const policy = { allowedHosts: [], token: '' };
  const request = (over: Record<string, unknown> = {}) => ({
    method: 'GET',
    path: '/api/backup',
    host: 'podium.lan',
    origin: null,
    secFetchSite: null,
    ...over,
  });

  it('refuses a browser sent there by somebody else', () => {
    // It cannot read the response -- but it can start a top-level navigation,
    // and on a token-protected install that carries the cookie and writes the
    // Dispatcharr credential to the victim's disk.
    const verdict = checkAccess(request({ secFetchSite: 'cross-site' }), policy);
    expect(verdict).toMatchObject({ ok: false, reason: 'cross-site' });
    // In the caller's own terms, rather than telling them Podium only accepts
    // writes in answer to a download.
    if (!verdict.ok) expect(verdict.message).toContain('backup downloads');
  });

  it('refuses one whose Origin is another site', () => {
    expect(checkAccess(request({ origin: 'https://elsewhere.example' }), policy)).toMatchObject({
      ok: false,
      reason: 'cross-site',
    });
  });

  it('still lets the backup page fetch it', () => {
    expect(
      checkAccess(request({ secFetchSite: 'same-origin', origin: 'http://podium.lan' }), policy),
    ).toEqual({ ok: true });
  });

  it('still lets a scheduled job fetch it', () => {
    // curl sends neither header, and their absence is not evidence of anything.
    // A nightly backup must keep working.
    expect(checkAccess(request(), policy)).toEqual({ ok: true });
  });

  it('leaves every other read alone', () => {
    expect(
      checkAccess(request({ path: '/api/state', secFetchSite: 'cross-site' }), policy),
    ).toEqual({ ok: true });
  });
});
