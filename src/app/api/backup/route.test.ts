/**
 * The route, not the helpers.
 *
 * Both halves of the rules round-trip live here rather than in `lib/backup`:
 * the export decides what goes in the file and the import decides what lands
 * on disk, and a bundle schema that looked right in isolation still dropped
 * `group_patterns` at both ends. Nothing reachable from a `lib` test sees
 * that, so this drives the handlers themselves against a temp data dir.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// Set before the route -- and the config it loads -- is imported.
const dir = mkdtempSync(join(tmpdir(), 'podium-backup-route-'));
process.env.PODIUM_DATA_DIR = dir;
process.env.DISPATCHARR_URL = 'http://dispatcharr.invalid';
process.env.DISPATCHARR_API_KEY = 'k';

const rulesPath = join(dir, 'rules.json');

/** A rules doc carrying a key `rulesDocSchema` does not declare. */
const DOC = {
  schema: 2,
  defaults: {},
  channels: [{ channel_id: 7, aliases: ['ESPN'] }],
  group_patterns: [
    { pattern: 'sports*', mode: 'live_only', audio_only: true, require_live: false },
  ],
};

async function route() {
  return await import('./route');
}

describe('backup route', () => {
  beforeEach(() => writeFileSync(rulesPath, JSON.stringify(DOC), 'utf8'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('exports the rules doc whole, including keys the loader never reads', async () => {
    const bundle = JSON.parse(await (await route()).GET().text());
    expect(bundle.kind).toBe('podium-backup');
    expect(bundle.rules).toEqual(DOC);
  });

  it('restores those keys rather than dropping them', async () => {
    const { GET, POST } = await route();
    const exported = await GET().text();

    writeFileSync(rulesPath, JSON.stringify({ schema: 2, channels: [] }), 'utf8');
    const resp = await POST(
      new Request('http://podium.lan/api/backup', {
        method: 'POST',
        body: exported,
      }),
    );

    expect(resp.status).toBe(200);
    expect(JSON.parse(readFileSync(rulesPath, 'utf8'))).toEqual(DOC);
  });

  it('refuses a file that is not a backup without touching rules.json', async () => {
    const { POST } = await route();
    const resp = await POST(
      new Request('http://podium.lan/api/backup', {
        method: 'POST',
        body: JSON.stringify({ kind: 'something-else' }),
      }),
    );

    expect(resp.status).toBe(400);
    expect(JSON.parse(readFileSync(rulesPath, 'utf8'))).toEqual(DOC);
  });
});
