/**
 * What "Soak everything" queues.
 *
 * It used to read every Dispatcharr channel, and on the install it was found on
 * a sixth of the queue sat on channels Podium ranks nothing for, while an
 * eighth was streams the last probe had already found dead.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshot } from '@/lib/server/state';
import { DEAD, type ProbeResult } from './probe';
import { Store } from './store';

// The crawl is faked per test. Most tests leave it failing -- this suite is
// about the queue, and a failed crawl is also what exercises the catalogue
// fallback -- and the snapshot-path tests resolve it explicitly.
vi.mock('@/lib/server/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/state')>();
  return {
    ...actual,
    snapshot: vi.fn(() => Promise.reject(new Error('crawl unavailable in tests'))),
  };
});

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-soak-route-'));
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

const alive: ProbeResult = {
  ...DEAD,
  alive: true,
  width: 1920,
  height: 1080,
  fps: 30,
  bitrateKbps: 5000,
  videoCodec: 'h264',
  elapsedMs: 10,
  error: '',
};

function withStore<T>(fn: (store: Store) => T): T {
  const store = new Store(join(dir, 'podium.db'));
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

const post = (body: unknown) =>
  new Request('http://podium/api/soak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('soaking everything', () => {
  beforeEach(() => {
    // A snapshot-path test leaves a resolved crawl behind; every other test
    // needs the failing one so the catalogue fallback answers.
    vi.mocked(snapshot).mockReset().mockRejectedValue(new Error('crawl unavailable in tests'));
    withStore((store) => {
      store.clearSoaks();
      // Two managed channels. Stream 3 appears on both and must be queued once.
      store.replaceCatalogue(
        [
          {
            channelId: 10,
            channelName: 'A',
            slot: 0,
            streamId: 1,
            providerId: 6,
            providerName: 'P',
          },
          {
            channelId: 10,
            channelName: 'A',
            slot: 1,
            streamId: 2,
            providerId: 6,
            providerName: 'P',
          },
          {
            channelId: 10,
            channelName: 'A',
            slot: 2,
            streamId: 3,
            providerId: 6,
            providerName: 'P',
          },
          {
            channelId: 20,
            channelName: 'B',
            slot: 0,
            streamId: 3,
            providerId: 6,
            providerName: 'P',
          },
          {
            channelId: 20,
            channelName: 'B',
            slot: 1,
            streamId: 4,
            providerId: 6,
            providerName: 'P',
          },
        ],
        'run-1',
      );
      store.put(1, 'h1', alive);
      store.put(2, 'h2', { ...DEAD, elapsedMs: 10, error: 'HTTP 404' });
      store.put(3, 'h3', alive);
      // A black slate is alive at the connection, and stays in.
      store.put(4, 'h4', { ...alive, black: true });
    });
  });

  it('queues the managed catalogue, once per stream, without the dead', async () => {
    const { POST } = await import('../app/api/soak/route');
    const resp = await POST(post({ scope: 'all', now: true }));
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body).toMatchObject({ requested: 3, queued: 3, skippedDead: 1, source: 'now' });
    const queued = withStore((store) => store.pendingSoaks().map((row) => row.streamId));
    expect(queued.sort()).toEqual([1, 3, 4]);
  });

  it('refuses when no pass has written a catalogue yet', async () => {
    withStore((store) => {
      // replaceCatalogue ignores an empty set on purpose, so clear it directly.
      (store as unknown as { db: { exec: (sql: string) => void } }).db.exec(
        'DELETE FROM catalogue',
      );
    });
    const { POST } = await import('../app/api/soak/route');
    const resp = await POST(post({ scope: 'all' }));
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toContain('no managed catalogue');
  });

  it('still soaks a single stream that was dead, because somebody named it', async () => {
    const { POST } = await import('../app/api/soak/route');
    const resp = await POST(post({ scope: 'stream', id: 2 }));
    expect(resp.status).toBe(200);
    expect((await resp.json()).skippedDead).toBe(0);
  });

  it('queues streams for specified channels without the dead', async () => {
    const { POST } = await import('../app/api/soak/route');
    const resp = await POST(post({ scope: 'channels', id: [10] }));
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body).toMatchObject({ requested: 2, queued: 2, skippedDead: 1, source: 'manual' });
    const queued = withStore((store) => store.pendingSoaks().map((row) => row.streamId));
    expect(queued.sort()).toEqual([1, 3]);
  });

  it('queues streams across multiple channels deduplicated', async () => {
    const { POST } = await import('../app/api/soak/route');
    const resp = await POST(post({ scope: 'channels', channelIds: [10, 20] }));
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body).toMatchObject({ requested: 3, queued: 3, skippedDead: 1, source: 'manual' });
    const queued = withStore((store) => store.pendingSoaks().map((row) => row.streamId));
    expect(queued.sort()).toEqual([1, 3, 4]);
  });

  it('resolves named channels from the crawl, dropping ids the crawl does not know', async () => {
    // Channel 20 sits in the managed catalogue but not in the crawl: it was
    // deleted upstream, and its stale rows must not be queued.
    vi.mocked(snapshot).mockResolvedValue({
      channels: [{ id: 10, name: 'A', tvgId: 'a', streams: [1, 2], groupId: 1 }],
      streams: [],
      providers: [],
      groups: [],
      fetchedAt: Date.now(),
    });
    const { POST } = await import('../app/api/soak/route');
    const resp = await POST(post({ scope: 'channels', id: [10, 20] }));
    const body = await resp.json();
    expect(resp.status).toBe(200);
    // Requested counts the survivors of the dead filter: stream 2 on channel
    // 10 is dead, and channel 20 resolved to nothing at all.
    expect(body).toMatchObject({ requested: 1, queued: 1, skippedDead: 1 });
    const queued = withStore((store) => store.pendingSoaks().map((row) => row.streamId));
    expect(queued).toEqual([1]);
  });

  it('reports a failed crawl for a group instead of an empty one', async () => {
    vi.mocked(snapshot).mockRejectedValue(new Error('Dispatcharr unreachable'));
    const { POST } = await import('../app/api/soak/route');
    const resp = await POST(post({ scope: 'group', id: 5 }));
    expect(resp.status).toBe(500);
    expect((await resp.json()).error).toContain('Dispatcharr unreachable');
  });

  it('refuses channel ids that are not integers rather than coercing them', async () => {
    const { POST } = await import('../app/api/soak/route');
    const resp = await POST(post({ scope: 'channels', id: [10, null] }));
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toBe('bad channel ids');
  });

  it('refuses an empty channel list', async () => {
    const { POST } = await import('../app/api/soak/route');
    const resp = await POST(post({ scope: 'channels', id: [] }));
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toBe('no channel ids provided');
  });
});
