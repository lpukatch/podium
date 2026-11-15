/**
 * The Teamarr test endpoint's door, not its answer.
 *
 * Reaching out to whatever URL a request carries is the endpoint's whole job,
 * which also makes it the one HTTP surface that will fetch an arbitrary
 * address for the asking. The Dispatcharr test gates that behind having
 * something to authenticate with; Teamarr takes no credential, so the bar
 * here is the install having committed to Teamarr already -- sync switched on
 * in *saved* settings or the environment, or the URL under test being the one
 * already saved. The request's own fields do not count -- they are exactly
 * what a drive-by POST controls -- so a patch that flips PODIUM_TEAMARR_SYNC
 * on inside the same request is refused like any other.
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
    delete process.env.PODIUM_TEAMARR_SYNC;
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to dial a fresh URL while sync is off in saved settings', async () => {
    // No settings at all: the fresh-install state, and the state an unsaved
    // patch cannot move.
    const resp = await call({ PODIUM_TEAMARR_URL: 'http://teamarr:9195' });
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.needsEnabled).toBe(true);
    expect(String(body.error)).toContain('sync is off');
    // The refusal happens before the network, which is the point.
    expect(vi.mocked(TeamarrClient)).not.toHaveBeenCalled();
  });

  it('a request that switches sync on for itself is refused the same way', async () => {
    const resp = await call({
      PODIUM_TEAMARR_URL: 'http://teamarr:9195',
      PODIUM_TEAMARR_SYNC: 'true',
    });
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.needsEnabled).toBe(true);
    expect(vi.mocked(TeamarrClient)).not.toHaveBeenCalled();
  });

  it('tests the URL that is already saved even while sync is off', async () => {
    // The one URL the install has committed to is not somewhere new, so
    // answering "is it still there?" costs the endpoint nothing it should not
    // spend. What is refused is pointing it somewhere it has never been.
    const store = new Store(join(dir, 'podium.db'));
    store.setSettings({ PODIUM_TEAMARR_URL: 'http://teamarr:9195' });
    store.close();

    const resp = await call({ PODIUM_TEAMARR_URL: 'http://teamarr:9195' });
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(vi.mocked(TeamarrClient)).toHaveBeenCalledWith('http://teamarr:9195');
  });

  it('a different port on the saved host is somewhere new while sync is off', async () => {
    const store = new Store(join(dir, 'podium.db'));
    store.setSettings({ PODIUM_TEAMARR_URL: 'http://teamarr:9195' });
    store.close();

    const resp = await call({ PODIUM_TEAMARR_URL: 'http://teamarr:9196' });
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.needsEnabled).toBe(true);
    expect(vi.mocked(TeamarrClient)).not.toHaveBeenCalled();
  });

  it('tests a fresh URL once sync is on in the environment', async () => {
    // The environment is as unmovable by a request as the settings table --
    // exactly why either side of it is a bar a drive-by POST cannot meet.
    process.env.PODIUM_TEAMARR_SYNC = 'true';
    const resp = await call({ PODIUM_TEAMARR_URL: 'http://teamarr:9195' });
    const body = await resp.json();
    expect(body.ok).toBe(true);
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
