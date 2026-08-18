import { afterEach, describe, expect, it, vi } from 'vitest';
import { DispatcharrClient, DispatcharrError, PAGE_CONCURRENCY, PAGE_SIZE } from './dispatcharr';

/**
 * A stub for global fetch that records every call.
 *
 * The client is otherwise almost impossible to exercise: its paging, auth
 * refresh and concurrency limiting are all in the request path, and all three
 * have had real bugs.
 */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(handler: (call: Call) => { status?: number; body?: unknown; text?: string }) {
  const calls: Call[] = [];
  const inFlight = { current: 0, peak: 0 };

  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);

    inFlight.current += 1;
    inFlight.peak = Math.max(inFlight.peak, inFlight.current);
    // A tick of real asynchrony, so overlapping requests actually overlap.
    await new Promise((r) => setTimeout(r, 5));
    inFlight.current -= 1;

    const result = handler(call);
    const status = result.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => result.body,
      text: async () => result.text ?? JSON.stringify(result.body ?? ''),
    } as Response;
  });

  globalThis.fetch = fn as unknown as typeof fetch;
  return { calls, inFlight, fn };
}

const pageOf = (count: number, page: number, size = PAGE_SIZE) => {
  const start = (page - 1) * size;
  const results = Array.from({ length: Math.min(size, count - start) }, (_, i) => ({
    id: start + i,
  }));
  return { count, next: start + results.length < count ? 'more' : null, results };
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('paging', () => {
  it('returns a bare array response untouched', async () => {
    stubFetch(() => ({ body: [{ id: 1 }, { id: 2 }] }));
    const client = new DispatcharrClient('http://d', { apiKey: 'k' });
    expect(await client.paged('/api/x')).toHaveLength(2);
  });

  it('stops after one page when there is no next', async () => {
    const { calls } = stubFetch(() => ({ body: { count: 2, next: null, results: [{}, {}] } }));
    const client = new DispatcharrClient('http://d', { apiKey: 'k' });
    await client.paged('/api/x');
    expect(calls).toHaveLength(1);
  });

  it('plans the remaining pages from count', async () => {
    const total = PAGE_SIZE * 3 + 7;
    const { calls } = stubFetch((c) => {
      const page = Number(new URL(c.url).searchParams.get('page'));
      return { body: pageOf(total, page) };
    });
    const client = new DispatcharrClient('http://d', { apiKey: 'k' });
    const rows = await client.paged('/api/x');

    expect(rows).toHaveLength(total);
    // 4 pages, fetched exactly once each -- no walking, no repeats.
    expect(calls).toHaveLength(4);
    expect(calls.map((c) => new URL(c.url).searchParams.get('page')).sort()).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('reassembles pages in order, not completion order', async () => {
    const total = PAGE_SIZE * 3;
    stubFetch((c) => {
      const page = Number(new URL(c.url).searchParams.get('page'));
      return { body: pageOf(total, page) };
    });
    const client = new DispatcharrClient('http://d', { apiKey: 'k' });
    const rows = (await client.paged<{ id: number }>('/api/x')).map((r) => r.id);
    expect(rows).toEqual(Array.from({ length: total }, (_, i) => i));
  });

  it('never exceeds the concurrency bound', async () => {
    // Unbounded paging measured ~10x slower against Dispatcharr's worker pool;
    // this is the guard against that fix being optimised back out.
    const total = PAGE_SIZE * 20;
    const { inFlight } = stubFetch((c) => {
      const page = Number(new URL(c.url).searchParams.get('page'));
      return { body: pageOf(total, page) };
    });
    const client = new DispatcharrClient('http://d', { apiKey: 'k' });
    await client.paged('/api/x');
    expect(inFlight.peak).toBeLessThanOrEqual(PAGE_CONCURRENCY);
    expect(inFlight.peak).toBeGreaterThan(1);
  });

  it('walks next serially when count is missing', async () => {
    let page = 0;
    const { calls } = stubFetch(() => {
      page += 1;
      return { body: { next: page < 3 ? 'more' : null, results: [{ id: page }] } };
    });
    const client = new DispatcharrClient('http://d', { apiKey: 'k' });
    expect(await client.paged('/api/x')).toHaveLength(3);
    expect(calls).toHaveLength(3);
  });

  it('raises with the status and body on an error', async () => {
    stubFetch(() => ({ status: 500, text: 'boom' }));
    const client = new DispatcharrClient('http://d', { apiKey: 'k' });
    await expect(client.paged('/api/x')).rejects.toBeInstanceOf(DispatcharrError);
  });
});

describe('auth', () => {
  it('sends both API key headers when no JWT is held', async () => {
    const { calls } = stubFetch(() => ({ body: [] }));
    await new DispatcharrClient('http://d', { apiKey: 'secret' }).paged('/api/x');
    expect(calls[0]?.headers['X-API-Key']).toBe('secret');
    expect(calls[0]?.headers.Authorization).toBe('Api-Key secret');
  });

  it('logs in and then sends a bearer token', async () => {
    const { calls } = stubFetch((c) =>
      c.url.includes('/token/') ? { body: { access: 'AT', refresh: 'RT' } } : { body: [] },
    );
    const client = new DispatcharrClient('http://d', { username: 'u', password: 'p' });
    await client.login();
    await client.paged('/api/x');

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ username: 'u', password: 'p' });
    expect(calls[1]?.headers.Authorization).toBe('Bearer AT');
  });

  it('does nothing on login when only an API key is configured', async () => {
    const { calls } = stubFetch(() => ({ body: [] }));
    await new DispatcharrClient('http://d', { apiKey: 'k' }).login();
    expect(calls).toHaveLength(0);
  });

  it('shares one login between concurrent callers', async () => {
    // Otherwise a burst of requests each mints a token and the last one wins.
    const { calls } = stubFetch(() => ({ body: { access: 'AT' } }));
    const client = new DispatcharrClient('http://d', { username: 'u', password: 'p' });
    await Promise.all([client.login(), client.login(), client.login()]);
    expect(calls.filter((c) => c.url.includes('/token/'))).toHaveLength(1);
  });

  it('raises when login is rejected', async () => {
    stubFetch(() => ({ status: 401, text: 'nope' }));
    const client = new DispatcharrClient('http://d', { username: 'u', password: 'p' });
    await expect(client.login()).rejects.toBeInstanceOf(DispatcharrError);
  });

  it('refreshes once on a 401 and retries the request', async () => {
    let first = true;
    const { calls } = stubFetch((c) => {
      if (c.url.includes('/token/refresh/')) return { body: { access: 'AT2' } };
      if (c.url.includes('/token/')) return { body: { access: 'AT', refresh: 'RT' } };
      if (first) {
        first = false;
        return { status: 401, text: 'expired' };
      }
      return { body: [] };
    });

    const client = new DispatcharrClient('http://d', { username: 'u', password: 'p' });
    await client.login();
    await client.paged('/api/x');

    expect(calls.some((c) => c.url.includes('/token/refresh/'))).toBe(true);
    expect(calls[calls.length - 1]?.headers.Authorization).toBe('Bearer AT2');
  });

  it('gives up rather than looping when the refresh also fails', async () => {
    stubFetch((c) =>
      c.url.includes('/token/') && !c.url.includes('refresh')
        ? { body: { access: 'AT', refresh: 'RT' } }
        : { status: 401, text: 'no' },
    );
    const client = new DispatcharrClient('http://d', { username: 'u', password: 'p' });
    await client.login();
    await expect(client.paged('/api/x')).rejects.toBeInstanceOf(DispatcharrError);
  });
});

describe('resource mapping', () => {
  it('prefers the effective_* fields on a channel', async () => {
    stubFetch(() => ({
      body: [
        {
          id: 1,
          name: 'raw',
          effective_name: 'override',
          tvg_id: 'a',
          effective_tvg_id: 'b',
          streams: [9],
          channel_group_id: 5,
          effective_channel_group_id: 6,
        },
      ],
    }));
    const [ch] = await new DispatcharrClient('http://d', { apiKey: 'k' }).channels();
    expect(ch).toMatchObject({ name: 'override', tvgId: 'b', groupId: 6, streams: [9] });
  });

  it('drops streams with no url', async () => {
    stubFetch(() => ({
      body: [
        { id: 1, name: 'ok', url: 'http://a', m3u_account: 2, stream_hash: 'h' },
        { id: 2, name: 'no url' },
      ],
    }));
    const streams = await new DispatcharrClient('http://d', { apiKey: 'k' }).streams();
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ id: 1, providerId: 2, streamHash: 'h' });
  });

  it('caps an unlimited provider rather than trusting 0', async () => {
    // 0/null means "unlimited" in Dispatcharr; an unbounded lane just moves the
    // bottleneck onto the network.
    stubFetch(() => ({
      body: [
        { id: 1, name: 'A', max_streams: 3 },
        { id: 2, name: 'B', max_streams: 0 },
        { id: 3, name: 'C' },
      ],
    }));
    const providers = await new DispatcharrClient('http://d', { apiKey: 'k' }).providers();
    expect(providers.map((p) => p.maxStreams)).toEqual([3, 4, 4]);
  });

  it('reads active channel ids in every shape the proxy returns', async () => {
    stubFetch(() => ({
      body: { channels: [7, { channel_id: 8 }, { id: 9 }, { channel: 10 }] },
    }));
    const ids = await new DispatcharrClient('http://d', { apiKey: 'k' }).activeChannelIds();
    expect(ids).toEqual([7, 8, 9, 10]);
  });

  it('resolves active channel UUIDs using uuidMap', async () => {
    stubFetch(() => ({
      body: {
        channels: [
          {
            channel_id: 'f08f5325-8fc2-4668-b765-37f90877828a',
            state: 'playing',
            stream_id: 94950,
          },
        ],
        count: 1,
      },
    }));
    const uuidMap = new Map([['f08f5325-8fc2-4668-b765-37f90877828a', 46802]]);
    const ids = await new DispatcharrClient('http://d', { apiKey: 'k' }).activeChannelIds(uuidMap);
    expect(ids).toEqual([46802]);
  });

  it('raises a DispatcharrError on shape mismatch when channels are active but cannot be resolved', async () => {
    stubFetch(() => ({
      body: {
        channels: [{ channel_id: 'f08f5325-8fc2-4668-b765-37f90877828a' }],
        count: 1,
      },
    }));
    const client = new DispatcharrClient('http://d', { apiKey: 'k' });
    await expect(client.activeChannelIds()).rejects.toThrow(/0 channel IDs resolved/);
  });

  it('treats an unreadable EPG grid as empty rather than fatal', async () => {
    stubFetch(() => ({ status: 503, text: 'down' }));
    expect(await new DispatcharrClient('http://d', { apiKey: 'k' }).epgWindow()).toEqual([]);
  });

  it('reads the grid, which carries what is coming as well as what is on', async () => {
    // The whole reason for the switch: `current-programs` describes only the
    // instant it was called, so a cached copy goes blind the moment a
    // programme ends. These rows stay answerable for the length of the window.
    const { calls } = stubFetch(() => ({
      body: {
        data: [
          {
            id: 42,
            start_time: '2026-08-17T18:00:00Z',
            end_time: '2026-08-17T21:00:00Z',
            title: 'First Pitch',
            is_live: true,
            description: 'prose nothing here reads',
            sub_title: 'nor this',
          },
        ],
      },
    }));
    const rows = await new DispatcharrClient('http://d', { apiKey: 'k' }).epgWindow();
    expect(calls[0]?.url).toContain('/api/epg/grid/');
    expect(calls[0]?.method).toBe('GET');
    // Trimmed to what the gate reads; the prose is the bulk of the payload.
    expect(rows).toEqual([
      {
        tvg_id: undefined,
        start_time: '2026-08-17T18:00:00Z',
        end_time: '2026-08-17T21:00:00Z',
        title: 'First Pitch',
        is_live: true,
      },
    ]);
  });

  it('drops the programmes Dispatcharr generates for channels with no EPG', async () => {
    // Shapes copied from Dispatcharr's grid view. Left in, these open the gate
    // on every channel that has no real schedule -- the exact failure
    // after_epg_start exists to prevent. The custom one is why the marker is
    // the id and not `is_live`: a pattern in the channel name can set it true.
    stubFetch(() => ({
      body: {
        data: [
          { id: 7, start_time: 'a', end_time: 'b', title: 'real', is_live: true },
          {
            id: 'dummy-standard-31-0',
            start_time: 'a',
            end_time: 'b',
            title: 'Some Channel',
            is_live: false,
          },
          {
            id: 'dummy-custom-31-12',
            start_time: 'a',
            end_time: 'b',
            title: 'Main Event',
            is_live: true,
          },
        ],
      },
    }));
    const rows = await new DispatcharrClient('http://d', { apiKey: 'k' }).epgWindow();
    expect(rows.map((r) => r.title)).toEqual(['real']);
  });

  it('falls back to current-programs when the grid is not there', async () => {
    // An older Dispatcharr keeps the gate it had rather than losing it.
    const { calls } = stubFetch((call) =>
      call.url.includes('/api/epg/grid/')
        ? { status: 404, text: 'no such endpoint' }
        : { body: [{ id: 9, start_time: 'a', end_time: 'b', title: 'legacy', is_live: true }] },
    );
    const rows = await new DispatcharrClient('http://d', { apiKey: 'k' }).epgWindow();
    expect(calls.map((c) => c.url.split('/api')[1])).toEqual([
      '/epg/grid/',
      '/epg/current-programs/',
    ]);
    expect(rows.map((r) => r.title)).toEqual(['legacy']);
  });
});

describe('writes', () => {
  it('sends the stream order as a PATCH on the channel', async () => {
    const { calls } = stubFetch(() => ({ body: {} }));
    await new DispatcharrClient('http://d', { apiKey: 'k' }).setStreamOrder(5, [3, 1, 2]);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toContain('/api/channels/channels/5/');
    expect(calls[0]?.body).toEqual({ streams: [3, 1, 2] });
  });

  it('sends stream_stats as an object, never a JSON string', async () => {
    // Dispatcharr accepts a string with a 200 and stores it double-encoded,
    // which then reads back as a string and breaks every parser.
    const { calls } = stubFetch(() => ({ body: {} }));
    await new DispatcharrClient('http://d', { apiKey: 'k' }).setStreamStats(9, { height: 1080 });
    const stats = (calls[0]?.body as { stream_stats?: unknown } | undefined)?.stream_stats;
    expect(typeof stats).toBe('object');
    expect(stats).toEqual({ height: 1080 });
  });

  it('advances stream_stats_updated_at so Dispatcharr fetches the write back', async () => {
    // The channel table refreshes stats through a delta endpoint keyed on this
    // timestamp; omitting it leaves the write invisible in the UI.
    const { calls } = stubFetch(() => ({ body: {} }));
    await new DispatcharrClient('http://d', { apiKey: 'k' }).setStreamStats(9, { height: 1080 });
    const at = (calls[0]?.body as { stream_stats_updated_at?: string } | undefined)
      ?.stream_stats_updated_at;
    expect(typeof at).toBe('string');
    const parsed = new Date(at as string).getTime();
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThan(Date.now() - 60_000);
  });

  it('raises when a write is rejected', async () => {
    stubFetch(() => ({ status: 400, text: 'bad' }));
    const client = new DispatcharrClient('http://d', { apiKey: 'k' });
    await expect(client.setStreamOrder(1, [1])).rejects.toBeInstanceOf(DispatcharrError);
    await expect(client.setStreamStats(1, {})).rejects.toBeInstanceOf(DispatcharrError);
  });
});

describe('channel', () => {
  it('fetches one channel live and folds the effective fields', async () => {
    const { calls } = stubFetch(() => ({
      body: {
        id: 5,
        uuid: 'ch-5-uuid',
        effective_name: 'ESPN',
        effective_tvg_id: 'espn.id',
        streams: [10, 20],
      },
    }));
    const channel = await new DispatcharrClient('http://d', { apiKey: 'k' }).channel(5);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/api/channels/channels/5/');
    expect(channel).toEqual({
      id: 5,
      uuid: 'ch-5-uuid',
      name: 'ESPN',
      tvgId: 'espn.id',
      streams: [10, 20],
      groupId: null,
    });
  });

  it('returns null when the channel no longer exists', async () => {
    stubFetch(() => ({ status: 404 }));
    const channel = await new DispatcharrClient('http://d', { apiKey: 'k' }).channel(99);
    expect(channel).toBeNull();
  });

  it('raises on any other error', async () => {
    stubFetch(() => ({ status: 500, text: 'boom' }));
    await expect(
      new DispatcharrClient('http://d', { apiKey: 'k' }).channel(1),
    ).rejects.toBeInstanceOf(DispatcharrError);
  });
});
