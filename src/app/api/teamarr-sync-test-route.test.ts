/**
 * The Teamarr test endpoint's door, not its answer.
 *
 * Reaching out to whatever URL a request carries is the endpoint's whole job,
 * which also makes it the one HTTP surface that will fetch an arbitrary
 * address for the asking. The typed Teamarr URL is validated by the settings
 * schema, and the test action is explicitly an operator-requested connection
 * check even when scheduled pushes are disabled.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/teamarr-sync/test/route';
import { Store } from '@/lib/store';
import { TeamarrClient } from '@/lib/teamarr-client';

vi.mock('@/lib/teamarr-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/teamarr-client')>();
  return { ...actual, TeamarrClient: vi.fn() };
});

function call(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://podium:3456/api/teamarr-sync/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** What mockImplementation expects: the class is constructed with the URL. */
type FakeClientCtor = new (url: string) => TeamarrClient;

describe('the teamarr test gate', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-teamarr-test-'));
    process.env.PODIUM_DATA_DIR = dir;
    vi.mocked(TeamarrClient).mockImplementation(
      class {
        rules = async () => [];
      } as unknown as FakeClientCtor,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PODIUM_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('tests a typed URL while scheduled sync is off', async () => {
    const resp = await call({ PODIUM_TEAMARR_URL: 'http://teamarr:9195' });
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.neverPushed).toBe(true);
    expect(vi.mocked(TeamarrClient)).toHaveBeenCalledWith('http://teamarr:9195');
  });

  it('tests a typed URL when the settings form enables scheduled sync', async () => {
    const resp = await call({
      PODIUM_TEAMARR_URL: 'http://teamarr:9195',
      PODIUM_TEAMARR_SYNC: 'true',
    });
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.neverPushed).toBe(true);
    expect(vi.mocked(TeamarrClient)).toHaveBeenCalledWith('http://teamarr:9195');
  });

  it('tests for real once sync is saved', async () => {
    const store = new Store(join(dir, 'podium.db'));
    store.setSettings({ PODIUM_TEAMARR_SYNC: 'true' });
    store.close();

    // A class implementation, not an arrow: the route constructs the client,
    // and vitest only treats `function`/`class` implementations as
    // constructible.
    vi.mocked(TeamarrClient).mockImplementation(
      class {
        rules = async () => [];
      } as unknown as FakeClientCtor,
    );

    const resp = await call({ PODIUM_TEAMARR_URL: 'http://teamarr:9195' });
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.total).toBe(0);
    // An install that has never pushed: not a failure, a state to report.
    expect(body.neverPushed).toBe(true);
  });
});
