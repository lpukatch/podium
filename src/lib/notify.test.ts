/**
 * Outbound webhook notifications: the URL rules, the payload shape, what a
 * delivery does when the consumer answers or does not, the flood guard, and
 * the degraded-channel sweep that turns verdicts into at-most-once events.
 *
 * `sweepDegraded` is tested against a hand-built store, because what it owns
 * is the transition logic -- announce once, recover once, never re-announce
 * across a restart -- and not the SQL that finds degraded channels. That SQL
 * is tested against a real Store further down, on the same fixtures the
 * notification copy describes: dead, black, live, and never-measured.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import {
  channelDownKey,
  createWebhook,
  type DegradedStore,
  sweepDegraded,
  WEBHOOK_FLOOD_LIMIT,
  type WebhookEvent,
  webhookPayload,
  webhookUrlProblem,
} from './notify';
import type { ProbeResult } from './probe';
import { Store } from './store';

const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  alive: true,
  width: 1920,
  height: 1080,
  fps: 50,
  bitrateKbps: 8000,
  videoCodec: 'h264',
  audioCodec: 'aac',
  pixelFormat: 'yuv420p',
  audioChannels: 2,
  channelLayout: 'stereo',
  audioBitrateKbps: 128,
  audioSampleRate: 48_000,
  elapsedMs: 100,
  error: '',
  ...over,
});

describe('webhookUrlProblem', () => {
  it('accepts empty, because empty is how notifications are off', () => {
    expect(webhookUrlProblem('')).toBeNull();
    expect(webhookUrlProblem('   ')).toBeNull();
  });

  it('refuses text that is not a URL', () => {
    expect(webhookUrlProblem('ntfy.example/podium')).toMatch(/Not a URL/);
    expect(webhookUrlProblem('http://no space in host')).toMatch(/Not a URL/);
  });

  it('refuses schemes that cannot carry a POST', () => {
    expect(webhookUrlProblem('ftp://ntfy.example/podium')).toMatch(/http and https/);
  });

  it('refuses credentials in the URL', () => {
    // They would ride into both servers' logs. Every consumer that needs a
    // secret takes it in the path (ntfy, Home Assistant) or fronts the
    // endpoint with its own auth.
    expect(webhookUrlProblem('https://user:pass@ntfy.example/podium')).toMatch(/no credentials/);
  });

  it('accepts an https URL with the path that is the destination', () => {
    expect(webhookUrlProblem('https://ntfy.example/podium-topic')).toBeNull();
    expect(webhookUrlProblem('http://ha.example:8123/api/webhook/podium')).toBeNull();
  });
});

describe('webhookPayload', () => {
  it('wraps the event in the envelope a consumer filters on', () => {
    const out = webhookPayload(
      { event: 'run_failed', error: 'Dispatcharr unreachable' },
      new Date('2026-11-15T03:04:05.000Z'),
    );
    expect(out).toEqual({
      source: 'podium',
      sentAt: '2026-11-15T03:04:05.000Z',
      event: 'run_failed',
      error: 'Dispatcharr unreachable',
    });
  });
});

/** Flush the microtask chain a fire-and-forget `send` rides on. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('deliver', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(response: { status?: number; throw?: Error } = {}) {
    const calls: Array<{ url: string; body: string; contentType?: string; redirect?: string }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (response.throw) throw response.throw;
      calls.push({
        url: String(url),
        body: String(init?.body),
        contentType: (init?.headers as Record<string, string>)?.['Content-Type'],
        redirect: init?.redirect,
      });
      return { status: response.status ?? 201 } as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  const webhook = () =>
    createWebhook(
      () => loadConfig({ PODIUM_WEBHOOK_URL: 'https://ntfy.example/podium-topic' }),
      () => {},
    );

  it('posts the event as JSON to the URL verbatim, path and all', async () => {
    const calls = stubFetch();
    const out = await webhook().deliver({ event: 'run_failed', error: 'pass threw' });

    expect(out).toEqual({ ok: true, status: 201 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://ntfy.example/podium-topic');
    expect(calls[0]?.contentType).toBe('application/json');
    expect(calls[0]?.redirect).toBe('error');
    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(body.source).toBe('podium');
    expect(body.event).toBe('run_failed');
    expect(body.error).toBe('pass threw');
    expect(body.sentAt).toEqual(expect.any(String));
  });

  it('treats any answer as delivered, 2xx or not', () => {
    // ntfy answers 201, Home Assistant 200, a personal script anything. What
    // matters is that the request arrived at something that chose a status;
    // treating a 500 as undelivered would invite a retry the design rules
    // out, so the status travels for the test route to show instead.
    const calls = stubFetch({ status: 500 });
    return webhook()
      .deliver({ event: 'test' })
      .then((out) => {
        expect(out).toEqual({ ok: true, status: 500 });
        expect(calls).toHaveLength(1);
      });
  });

  it('reports a refused connection with the reason, not "fetch failed"', async () => {
    const refused = new Error('fetch failed');
    (refused as Error & { cause?: { code?: string } }).cause = { code: 'ECONNREFUSED' };
    stubFetch({ throw: refused });
    const out = await webhook().deliver({ event: 'test' });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('ECONNREFUSED');
  });

  it('refuses to follow a redirect instead of posting to wherever it points', async () => {
    // The URL is validated before the post, but whatever answers it is not
    // this install's choice: a 302 to somewhere else does not get the event
    // -- or a retry of it -- delivered. `redirect: 'error'` makes fetch
    // refuse the hop itself; what surfaces is the same could-not-reach shape
    // every other refusal produces, never a follow.
    let redirectMode: string | undefined;
    const blocked = new TypeError('fetch failed');
    globalThis.fetch = (async (_url: string, init?: { redirect?: string }) => {
      redirectMode = init?.redirect;
      throw blocked;
    }) as unknown as typeof fetch;
    const out = await webhook().deliver({ event: 'test' });
    expect(redirectMode).toBe('error');
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Could not reach the webhook');
  });

  it('does nothing when no URL is set', async () => {
    const calls = stubFetch();
    const off = createWebhook(
      () => loadConfig({ PODIUM_WEBHOOK_URL: '' }),
      () => {},
    );
    const out = await off.deliver({ event: 'test' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/No webhook URL/);
    expect(calls).toHaveLength(0);
  });

  it('reads the URL per event, so an edit lands without a restart', async () => {
    const calls = stubFetch();
    let url = 'https://ntfy.example/first';
    const changing = createWebhook(
      () => loadConfig({ PODIUM_WEBHOOK_URL: url }),
      () => {},
    );
    await changing.deliver({ event: 'test' });
    url = 'https://ntfy.example/second';
    await changing.deliver({ event: 'test' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://ntfy.example/first',
      'https://ntfy.example/second',
    ]);
  });
});

describe('send and the flood guard', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('does not fetch, log, or consume flood tokens while disabled', async () => {
    const fetch = vi.fn(async () => new Response());
    globalThis.fetch = fetch;
    const log = vi.fn();
    let url = '   ';
    const webhook = createWebhook(() => loadConfig({ PODIUM_WEBHOOK_URL: url }), log);
    for (let i = 0; i < WEBHOOK_FLOOD_LIMIT + 5; i++) {
      expect(webhook.send({ event: 'test' })).toBe(false);
    }
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    url = 'https://ntfy.example/podium';
    for (let i = 0; i < WEBHOOK_FLOOD_LIMIT; i++) {
      expect(webhook.send({ event: 'test' })).toBe(true);
    }
    expect(webhook.send({ event: 'test' })).toBe(false);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(WEBHOOK_FLOOD_LIMIT);
  });

  it('retries flood-limited down and recovery transitions on a later sweep', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    globalThis.fetch = vi.fn(async () => new Response());
    const webhook = createWebhook(
      () => loadConfig({ PODIUM_WEBHOOK_URL: 'https://ntfy.example/podium' }),
      () => {},
    );
    const store = stubDegradedStore(
      Array.from({ length: WEBHOOK_FLOOD_LIMIT + 1 }, (_, i) => degradedRow(i + 1)),
    );
    expect(sweepDegraded(store, webhook).announced).toBe(WEBHOOK_FLOOD_LIMIT);
    expect(store.state.size).toBe(WEBHOOK_FLOOD_LIMIT);
    vi.advanceTimersByTime(60_000);
    expect(sweepDegraded(store, webhook).announced).toBe(1);
    store.degradedChannels = () => [];
    expect(sweepDegraded(store, webhook).recovered).toBe(WEBHOOK_FLOOD_LIMIT - 1);
    expect(store.state.size).toBe(2);
    vi.advanceTimersByTime(60_000);
    expect(sweepDegraded(store, webhook).recovered).toBe(2);
    expect(store.state.size).toBe(0);
  });

  it('sends without blocking and logs a failed delivery instead of throwing', async () => {
    const refused = new Error('fetch failed');
    (refused as Error & { cause?: { code?: string } }).cause = { code: 'ECONNREFUSED' };
    globalThis.fetch = (async () => {
      throw refused;
    }) as unknown as typeof fetch;
    const log = vi.fn();
    const webhook = createWebhook(
      () => loadConfig({ PODIUM_WEBHOOK_URL: 'https://ntfy.example/podium' }),
      log,
    );
    expect(() => webhook.send({ event: 'test' })).not.toThrow();
    await settle();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/webhook delivery failed.*ECONNREFUSED/),
    );
  });

  it('drops events past the per-window limit, and says so once', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return { status: 200 } as Response;
    }) as unknown as typeof fetch;
    const log = vi.fn();
    const webhook = createWebhook(
      () => loadConfig({ PODIUM_WEBHOOK_URL: 'https://ntfy.example/podium' }),
      log,
    );

    // One more than the limit: exactly the limit delivered, the remainder
    // dropped. A first pass with auto-assign on can write hundreds of
    // channels in minutes; a consumer receiving that burst is being attacked
    // by a friend.
    for (let i = 0; i < WEBHOOK_FLOOD_LIMIT + 5; i += 1) {
      webhook.send({
        event: 'channel_updated',
        channelId: i,
        channelName: `C${i}`,
        reordered: true,
        added: [],
        removed: [],
        lead: null,
        was: null,
      });
    }
    await settle();
    expect(calls).toHaveLength(WEBHOOK_FLOOD_LIMIT);
    const floodLines = log.mock.calls.filter((args) => String(args[0]).includes('flood guard'));
    expect(floodLines).toHaveLength(1);
  });
});

/** A two-method store stub with just enough state for the sweep. */
function stubDegradedStore(
  degraded: Array<{
    channelId: number;
    channelName: string;
    slots: number;
    usable: number;
    leadStreamId: number | null;
    leadProvider: string | null;
  }>,
  leads: Map<number, { streamId: number; provider: string }> = new Map(),
): DegradedStore & { state: Map<string, { value: string; at: number }> } {
  const state = new Map<string, { value: string; at: number }>();
  return {
    state,
    degradedChannels: () => degraded,
    streamVerdictStatus: (streamId) =>
      degraded.some((c) => c.leadStreamId === streamId) ? 'dead' : 'live',
    catalogueLead: (channelId) => leads.get(channelId) ?? null,
    notifyStateAll: () => [...state].map(([key, row]) => ({ key, value: row.value, at: row.at })),
    notifyStateSet: (key, value, at) => state.set(key, { value, at }),
    notifyStateDelete: (key) => state.delete(key),
  };
}

const degradedRow = (channelId: number) => ({
  channelId,
  channelName: `Channel ${channelId}`,
  slots: 2,
  usable: 0,
  leadStreamId: channelId * 10,
  leadProvider: 'Provider A',
});

describe('sweepDegraded', () => {
  const notify = (): { events: WebhookEvent[]; send: (event: WebhookEvent) => boolean } => {
    const events: WebhookEvent[] = [];
    return {
      events,
      send: (event) => {
        events.push(event);
        return true;
      },
    };
  };

  it('preserves pending down and recovery transitions while notifications are disabled', () => {
    const webhook = createWebhook(() => loadConfig({ PODIUM_WEBHOOK_URL: '' }), vi.fn());
    const store = stubDegradedStore([degradedRow(7)]);
    expect(sweepDegraded(store, webhook)).toEqual({ announced: 0, recovered: 0 });
    expect(store.state.size).toBe(0);
    const sink = notify();
    expect(sweepDegraded(store, sink).announced).toBe(1);
    store.degradedChannels = () => [];
    expect(sweepDegraded(store, webhook).recovered).toBe(0);
    expect(store.state.size).toBe(1);
    expect(sweepDegraded(store, sink).recovered).toBe(1);
    expect(store.state.size).toBe(0);
  });
  it('announces a channel entering the down state, once', () => {
    const store = stubDegradedStore([degradedRow(7)]);
    const sink = notify();

    const first = sweepDegraded(store, sink, 1000);
    expect(first).toEqual({ announced: 1, recovered: 0 });
    expect(sink.events).toEqual([
      {
        event: 'channel_down',
        channelId: 7,
        channelName: 'Channel 7',
        slots: 2,
        lead: { streamId: 70, provider: 'Provider A', status: 'dead' },
      },
    ]);
    expect(store.state.get(channelDownKey(7))?.value).toBe('Channel 7');

    // The second sweep sees the same catalogue and the same tracking row:
    // an ongoing outage is announced when it starts, not once a pass.
    const second = sweepDegraded(store, sink, 2000);
    expect(second).toEqual({ announced: 0, recovered: 0 });
    expect(sink.events).toHaveLength(1);
  });

  it('announces the recovery, with the name the down event carried', () => {
    const store = stubDegradedStore([degradedRow(7)]);
    const sink = notify();
    sweepDegraded(store, sink, 1000);

    store.degradedChannels = () => [];
    const second = sweepDegraded(store, sink, 2000);
    expect(second).toEqual({ announced: 0, recovered: 1 });
    expect(sink.events[1]).toEqual({
      event: 'channel_recovered',
      channelId: 7,
      channelName: 'Channel 7',
      lead: null,
    });
    expect(store.state.has(channelDownKey(7))).toBe(false);
  });

  it('carries the recovered channel lead, when the catalogue still has one', () => {
    const leads = new Map([[7, { streamId: 70, provider: 'Provider B' }]]);
    const store = stubDegradedStore([degradedRow(7)], leads);
    const sink = notify();
    sweepDegraded(store, sink, 1000);

    store.degradedChannels = () => [];
    sweepDegraded(store, sink, 2000);
    expect(sink.events[1]).toMatchObject({
      event: 'channel_recovered',
      lead: { streamId: 70, provider: 'Provider B' },
    });
  });

  it('drops a tracking row it did not write, without announcing anything', () => {
    // A row from a key format this sweep never used must not become a
    // recovery for a channel id that cannot exist.
    const store = stubDegradedStore([]);
    store.notifyStateSet('channel_down:not-a-number', 'old', 0);
    const sink = notify();

    const out = sweepDegraded(store, sink, 1000);
    expect(out).toEqual({ announced: 0, recovered: 0 });
    expect(sink.events).toHaveLength(0);
    expect(store.state.has('channel_down:not-a-number')).toBe(false);
  });
});

describe('degradedChannels against a real store', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-notify-'));
    store = new Store(join(dir, 'podium.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const dead = probe({ alive: false, width: 0, height: 0, bitrateKbps: 0, error: 'timeout' });
  const black = probe({ black: true });
  const alive = probe();

  const row = (
    channelId: number,
    name: string,
    slot: number,
    streamId: number,
    provider: string,
  ) => ({
    channelId,
    channelName: name,
    slot,
    streamId,
    providerId: 5,
    providerName: provider,
  });

  it('returns channels where every measured stream is dead or black', () => {
    // 7: two streams, both dead -- down.
    // 8: one live, one dead -- fine.
    // 9: never measured -- unknown, not down. Announcing it would be a lie
    // about evidence nobody has gathered.
    // 10: one stream, black slate -- down, because a slate is not a fallback.
    store.replaceCatalogue(
      [
        row(7, 'Down', 0, 70, 'Provider A'),
        row(7, 'Down', 1, 71, 'Provider A'),
        row(8, 'Fine', 0, 80, 'Provider A'),
        row(8, 'Fine', 1, 81, 'Provider A'),
        row(9, 'Unknown', 0, 90, 'Provider A'),
        row(10, 'Slate', 0, 100, 'Provider B'),
      ],
      null,
    );
    store.put(70, 'h', dead);
    store.put(71, 'h', dead);
    store.put(80, 'h', alive);
    store.put(81, 'h', dead);
    store.put(100, 'h', black);

    const rows = store.degradedChannels();
    expect(rows.map((r) => r.channelId).sort((a, b) => a - b)).toEqual([7, 10]);
    const down = rows.find((r) => r.channelId === 7);
    expect(down).toMatchObject({
      channelName: 'Down',
      slots: 2,
      usable: 0,
      leadStreamId: 70,
      leadProvider: 'Provider A',
    });
    const slate = rows.find((r) => r.channelId === 10);
    expect(slate).toMatchObject({ leadStreamId: 100, leadProvider: 'Provider B' });
  });

  it('reads the lead verdict back in the three words the payload uses', () => {
    store.put(70, 'h', dead);
    store.put(71, 'h', black);
    store.put(72, 'h', alive);
    expect(store.streamVerdictStatus(70)).toBe('dead');
    expect(store.streamVerdictStatus(71)).toBe('black');
    expect(store.streamVerdictStatus(72)).toBe('live');
    expect(store.streamVerdictStatus(999)).toBeNull();
  });

  it('names slot 0, and nothing for a channel the catalogue dropped', () => {
    store.replaceCatalogue([row(7, 'Down', 0, 70, 'Provider A')], null);
    expect(store.catalogueLead(7)).toEqual({ streamId: 70, provider: 'Provider A' });
    expect(store.catalogueLead(99)).toBeNull();
  });

  it('keeps the tracking rows until told to forget them', () => {
    expect(store.notifyStateAll()).toEqual([]);
    store.notifyStateSet(channelDownKey(7), 'Down', 1000);
    expect(store.notifyStateAll()).toEqual([{ key: channelDownKey(7), value: 'Down', at: 1000 }]);
    store.notifyStateSet(channelDownKey(7), 'Renamed Down', 2000);
    expect(store.notifyStateAll()).toEqual([
      { key: channelDownKey(7), value: 'Renamed Down', at: 2000 },
    ]);
    store.notifyStateDelete(channelDownKey(7));
    expect(store.notifyStateAll()).toEqual([]);
  });
});
