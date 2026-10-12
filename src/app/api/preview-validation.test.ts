/**
 * The editor's front door, at the boundary: what a malformed body gets.
 *
 * `undefined` used to sail through as a channelId and match nothing, and a
 * non-object `aliasProviders` threw mid-handler into a 500. Both are answers
 * the request can be given up front.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  snapshot: vi.fn(),
  index: vi.fn(),
  matcher: vi.fn(),
  policies: () => new Map(),
  groupPatterns: () => [],
}));
vi.mock('@/lib/server/state', () => state);

import { POST } from '@/app/api/preview/route';

const call = (body: unknown): Promise<Response> =>
  POST(
    new Request('http://podium:3456/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('preview body validation', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-preview-'));
    process.env.PODIUM_DATA_DIR = dir;
    state.snapshot.mockResolvedValue({ providers: [], channels: [], groups: [], streams: [] });
    state.index.mockResolvedValue({ normalized: new Map() });
    state.matcher.mockReturnValue({
      rules: new Map(),
      normalize: (name: string) => ({ name, prefixes: [], quality: null }),
      match: () => [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PODIUM_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a body that is not JSON', async () => {
    const response = await POST(
      new Request('http://podium:3456/api/preview', {
        method: 'POST',
        body: 'not json',
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('not JSON');
  });

  it('refuses a missing or non-integer channelId', async () => {
    for (const channelId of [undefined, ' twelve ', 1.5]) {
      const response = await call({ channelId });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('channel id');
    }
  });

  it('refuses object fields that are not objects', async () => {
    const response = await call({ channelId: 12, aliasProviders: 42 });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('aliasProviders must be an object');
  });

  it('refuses aliasProviders whose values are not arrays', async () => {
    const response = await call({ channelId: 12, aliasProviders: { Local: '1,2,3' } });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('must be an array');
  });

  it('still answers a well-formed body', async () => {
    const response = await call({
      channelId: 12,
      aliases: ['Local'],
      aliasProviders: { Local: [1, '2', 'oops'] },
      groupFilter: { excludeGroups: ['Radio'] },
    });
    expect(response.status).toBe(200);
    // Coerced and filtered rather than trusted: the body came from a browser
    // form, and 'oops' has no business surviving into a match.
    const body = await response.json();
    expect(body.total).toBe(0);
  });
});
