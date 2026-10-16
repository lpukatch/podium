/**
 * The Dispatcharr test endpoint's answer, not its door.
 *
 * The gate -- nothing dials out without credentials, a saved credential never
 * reaches a host it was not saved for -- is covered elsewhere; this pins the
 * payload the test line renders. The point worth a test is the profiles: an
 * account's connection limits live on its profiles, and the account-level
 * max_streams is only the default profile's cap, so the response carries the
 * active profiles beside it. Inactive ones are dropped -- the lane builder
 * drops them too, and a login Dispatcharr will not play through is not a
 * connection.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/settings/test/route';
import type { Provider, ProviderProfile } from '@/lib/dispatcharr';
import { DispatcharrClient } from '@/lib/dispatcharr';
import { Store } from '@/lib/store';

vi.mock('@/lib/dispatcharr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dispatcharr')>();
  return { ...actual, DispatcharrClient: vi.fn() };
});

function call(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://podium:3456/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** What mockImplementation expects: the class is constructed with the URL. */
type FakeClientCtor = new (url: string) => DispatcharrClient;

const defaultProfile: ProviderProfile = {
  id: 11,
  name: 'Provider A Default',
  isDefault: true,
  isActive: true,
  maxStreams: 3,
  currentViewers: 0,
  searchPattern: '^(.*)$',
  replacePattern: '$1',
};

function provider(over: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: 'Provider A',
    maxStreams: 3,
    accountType: 'XC',
    profiles: [defaultProfile],
    ...over,
  };
}

describe('the dispatcharr test payload', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-settings-test-'));
    process.env.PODIUM_DATA_DIR = dir;
    const store = new Store(join(dir, 'podium.db'));
    store.setSettings({
      DISPATCHARR_URL: 'http://dispatcharr:9191',
      DISPATCHARR_API_KEY: 'key-123',
    });
    store.close();

    vi.mocked(DispatcharrClient).mockImplementation(
      class {
        login = async () => {};
        providers = async (): Promise<Provider[]> => [];
      } as unknown as FakeClientCtor,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PODIUM_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports each active profile beside the account-level cap', async () => {
    vi.mocked(DispatcharrClient).mockImplementation(
      class {
        login = async () => {};
        providers = async (): Promise<Provider[]> => [
          provider({
            profiles: [
              defaultProfile,
              {
                id: 12,
                name: 'Backup login',
                isDefault: false,
                isActive: true,
                maxStreams: 2,
                currentViewers: 0,
                searchPattern: 'host-a',
                replacePattern: 'host-b',
              },
            ],
          }),
        ];
      } as unknown as FakeClientCtor,
    );

    const body = (await (await call({})).json()) as {
      ok: boolean;
      providers: Array<{ name: string; maxStreams: number; profiles: Array<unknown> }>;
    };
    expect(body.ok).toBe(true);
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]!.name).toBe('Provider A');
    // The account cap stays in the payload: it is what an unlimited profile
    // resolves against, and what an account with no profiles probes on.
    expect(body.providers[0]!.maxStreams).toBe(3);
    expect(body.providers[0]!.profiles).toHaveLength(2);
  });

  it('drops inactive profiles the lane builder would drop', async () => {
    vi.mocked(DispatcharrClient).mockImplementation(
      class {
        login = async () => {};
        providers = async (): Promise<Provider[]> => [
          provider({
            profiles: [
              defaultProfile,
              {
                id: 13,
                name: 'Retired login',
                isDefault: false,
                isActive: false,
                maxStreams: 9,
                currentViewers: 0,
                searchPattern: 'host-a',
                replacePattern: 'host-b',
              },
            ],
          }),
        ];
      } as unknown as FakeClientCtor,
    );

    const body = (await (await call({})).json()) as {
      providers: Array<{ profiles: Array<{ name: string }> }>;
    };
    expect(body.providers[0]!.profiles.map((p) => p.name)).toEqual(['Provider A Default']);
  });

  it('an account with no profiles reports none, leaving the account cap', async () => {
    vi.mocked(DispatcharrClient).mockImplementation(
      class {
        login = async () => {};
        providers = async (): Promise<Provider[]> => [provider({ profiles: [] })];
      } as unknown as FakeClientCtor,
    );

    const body = (await (await call({})).json()) as {
      providers: Array<{ maxStreams: number; profiles: unknown[] }>;
    };
    expect(body.providers[0]!.maxStreams).toBe(3);
    expect(body.providers[0]!.profiles).toEqual([]);
  });
});
