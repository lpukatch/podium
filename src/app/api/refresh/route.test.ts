/**
 * The re-check API, as a caller sees it.
 *
 * The store and planner tests cover what a mark does; these pin the HTTP
 * shapes -- the channel scope added beside `all` and `group`, and the GET that
 * now reports channel marks without changing what it already said.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALL_GROUPS, Store } from '@/lib/store';

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-refresh-route-'));
  const rulesPath = join(dir, 'rules.json');
  writeFileSync(rulesPath, JSON.stringify({ schema: 2, channels: [] }), 'utf8');
  process.env.PODIUM_DATA_DIR = dir;
  process.env.PODIUM_RULES = rulesPath;
});

afterAll(() => {
  delete process.env.PODIUM_DATA_DIR;
  delete process.env.PODIUM_RULES;
  rmSync(dir, { recursive: true, force: true });
});

function withStore<T>(fn: (store: Store) => T): T {
  const store = new Store(join(dir, 'podium.db'));
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

const post = (body: unknown) =>
  new Request('http://podium/api/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const del = (query: string) =>
  new Request(`http://podium/api/refresh?${query}`, { method: 'DELETE' });

beforeEach(() => {
  withStore((store) => store.resetData());
});

describe('re-checking a single channel', () => {
  it('queues a channel and reports it under its own key', async () => {
    const { GET, POST } = await import('./route');
    const resp = await POST(post({ scope: 'channel', channelId: 123 }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toMatchObject({ queued: true, scope: 'channel 123' });
    expect(typeof body.forcedAt).toBe('number');

    const queued = await (await GET()).json();
    expect(queued).toEqual({ all: null, groups: {}, channels: { '123': body.forcedAt } });
  });

  it('does not touch a group that shares the id', async () => {
    const { GET, POST } = await import('./route');
    await POST(post({ scope: 'channel', channelId: 7 }));
    const queued = await (await GET()).json();
    expect(queued.groups).toEqual({});
    expect(Object.keys(queued.channels)).toEqual(['7']);
  });

  it('accepts a channel it has never heard of, the same as a group', async () => {
    // Shape is checked, existence is not: a mark that covers nothing is
    // found satisfied by the next pass and retires itself.
    const { POST } = await import('./route');
    const resp = await POST(post({ scope: 'channel', channelId: 999_999 }));
    expect(resp.status).toBe(200);
  });

  it('cancels a queued channel, and says so', async () => {
    const { DELETE, GET, POST } = await import('./route');
    await POST(post({ scope: 'channel', channelId: 123 }));

    const resp = DELETE(del('scope=channel&channelId=123'));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ cancelled: true, scope: 'channel 123' });
    expect((await (await GET()).json()).channels).toEqual({});

    // Nothing left to cancel is not an error, only nothing done.
    expect(await DELETE(del('scope=channel&channelId=123')).json()).toEqual({
      cancelled: false,
      scope: 'channel 123',
    });
  });

  it('refuses a channel id that is not a positive integer', async () => {
    const { DELETE, POST } = await import('./route');
    for (const channelId of [0, -1, 1.5, '', '1e3', null, undefined, true]) {
      const resp = await POST(post({ scope: 'channel', channelId }));
      expect(resp.status).toBe(400);
      expect(await resp.json()).toEqual({ error: 'bad channel id' });
    }
    for (const query of [
      'scope=channel',
      'scope=channel&channelId=',
      'scope=channel&channelId=x',
    ]) {
      const resp = DELETE(del(query));
      expect(resp.status).toBe(400);
      expect(await resp.json()).toEqual({ error: 'bad channel id' });
    }
  });

  it('still refuses a scope it does not know', async () => {
    const { POST } = await import('./route');
    const resp = await POST(post({ scope: 'stream', streamId: 1 }));
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: 'unknown scope "stream"' });
  });

  it('drops queued channels when the whole catalogue is queued', async () => {
    const { DELETE, GET, POST } = await import('./route');
    await POST(post({ scope: 'channel', channelId: 123 }));
    await POST(post({ scope: 'group', groupId: 42 }));
    await POST(post({ scope: 'all' }));

    const queued = await (await GET()).json();
    expect(queued.channels).toEqual({});
    expect(queued.groups).toEqual({});
    expect(typeof queued.all).toBe('number');

    // So cancelling the big request leaves nothing small behind.
    DELETE(del('scope=all'));
    expect(await (await GET()).json()).toEqual({ all: null, groups: {}, channels: {} });
  });

  it('leaves channel marks alone when a group is queued', async () => {
    // The channel is held to the later instant anyway, so there is nothing to
    // gain from working out which channels the group holds.
    const { GET, POST } = await import('./route');
    await POST(post({ scope: 'channel', channelId: 123 }));
    await POST(post({ scope: 'group', groupId: 42 }));
    const queued = await (await GET()).json();
    expect(Object.keys(queued.channels)).toEqual(['123']);
    expect(Object.keys(queued.groups)).toEqual(['42']);
  });

  it('keeps the group and catalogue scopes answering as before', async () => {
    const { DELETE, POST } = await import('./route');
    expect(await (await POST(post({ scope: 'group', groupId: 42 }))).json()).toMatchObject({
      queued: true,
      scope: 'group 42',
    });
    expect(await DELETE(del('scope=group&groupId=42')).json()).toEqual({
      cancelled: true,
      scope: 'group 42',
    });
    expect(withStore((store) => store.refreshMarks().all)).toBeNull();
    await POST(post({ scope: 'all' }));
    expect(withStore((store) => store.refreshMarks().all)).not.toBeNull();
    withStore((store) => store.clearRefreshMark(ALL_GROUPS));
  });
});
