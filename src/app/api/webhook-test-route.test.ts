/**
 * The webhook test endpoint's door, not its answer.
 *
 * Sending a webhook is a POST the server makes on somebody's say-so, which
 * makes this route an outbound-request-for-hire unless it is gated -- the
 * same class of surface the Teamarr and Dispatcharr tests are, and gated by
 * the same reasoning. There is no sync toggle to read here, so the bar is
 * the URL being set in what is already saved or configured: the request's
 * own fields do not count, because they are exactly what a drive-by POST
 * controls, and a patch that supplies a URL for itself is refused like any
 * other. The delivery itself is pinned through the real `createWebhook` with
 * only `fetch` stubbed, because "did it reach the URL as typed" is the part
 * that breaks silently.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/webhook/test/route';
import { MAX_BODY_BYTES } from '@/lib/http-body';
import { Store } from '@/lib/store';

const originalFetch = globalThis.fetch;

function stubFetch(throwError?: Error) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    if (throwError) throw throwError;
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return { status: 200 } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function call(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://podium:3456/api/webhook/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('the webhook test gate', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-webhook-test-'));
    process.env.PODIUM_DATA_DIR = dir;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.PODIUM_DATA_DIR;
    delete process.env.PODIUM_WEBHOOK_URL;
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to post anywhere while no URL is saved or configured', async () => {
    const calls = stubFetch();
    const resp = await call({ PODIUM_WEBHOOK_URL: 'https://ntfy.example/fresh' });
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.needsSave).toBe(true);
    expect(String(body.error)).toContain('No webhook URL is saved');
    // The refusal happens before the network, which is the point. A request
    // that supplies the URL in its own patch is refused identically -- the
    // patch is exactly what a drive-by controls, so it cannot act as the
    // commitment -- which is this same call with nothing saved.
    expect(calls).toHaveLength(0);
  });

  it('rejects an oversized chunked body before attempting delivery', async () => {
    process.env.PODIUM_WEBHOOK_URL = 'https://ntfy.example/saved';
    const calls = stubFetch();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('http://podium:3456/api/webhook/test', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.has('content-length')).toBe(false);
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects a declared oversized body even if no body arrives', async () => {
    const response = await POST(
      new Request('http://podium:3456/api/webhook/test', {
        method: 'POST',
        headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) },
      }),
    );
    expect(response.status).toBe(413);
  });

  it.each(['not JSON', 'null', '[]', '"text"'])(
    'rejects invalid settings body %s',
    async (body) => {
      const calls = stubFetch();
      const response = await POST(
        new Request('http://podium:3456/api/webhook/test', {
          method: 'POST',
          body,
        }),
      );
      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([undefined, '', '   '])(
    'allows an empty body (%s) to test the saved URL',
    async (body) => {
      process.env.PODIUM_WEBHOOK_URL = 'https://ntfy.example/saved';
      const calls = stubFetch();
      const response = await POST(
        new Request('http://podium:3456/api/webhook/test', {
          method: 'POST',
          body,
        }),
      );
      expect((await response.json()).ok).toBe(true);
      expect(calls).toHaveLength(1);
    },
  );

  it('tests the URL as typed once something is already saved', async () => {
    const store = new Store(join(dir, 'podium.db'));
    store.setSettings({ PODIUM_WEBHOOK_URL: 'https://ntfy.example/saved-topic' });
    store.close();

    const calls = stubFetch();
    const resp = await call({ PODIUM_WEBHOOK_URL: 'https://ntfy.example/new-topic' });
    const body = await resp.json();
    expect(body.ok).toBe(true);
    // The posted URL is the one in the request -- test before save, which is
    // the flow the button exists for -- and the event is the fixed test one.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://ntfy.example/new-topic');
    expect(calls[0]?.body.event).toBe('test');
    expect(calls[0]?.body.source).toBe('podium');
    expect(body.status).toBe(200);
  });

  it('a URL configured in the environment counts as committed', async () => {
    process.env.PODIUM_WEBHOOK_URL = 'https://ntfy.example/env-topic';
    const calls = stubFetch();
    const resp = await call({ PODIUM_WEBHOOK_URL: 'https://ntfy.example/new-topic' });
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('reports a delivery failure instead of pretending it worked', async () => {
    const store = new Store(join(dir, 'podium.db'));
    store.setSettings({ PODIUM_WEBHOOK_URL: 'https://ntfy.example/saved-topic' });
    store.close();

    const refused = new Error('fetch failed');
    (refused as Error & { cause?: { code?: string } }).cause = { code: 'ECONNREFUSED' };
    stubFetch(refused);

    const resp = await call({ PODIUM_WEBHOOK_URL: 'https://ntfy.example/saved-topic' });
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain('ECONNREFUSED');
  });

  it('refuses a malformed URL before any of it', async () => {
    const calls = stubFetch();
    const resp = await call({ PODIUM_WEBHOOK_URL: 'https://user:pass@ntfy.example/topic' });
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(String(body.error)).toMatch(/no credentials/);
    expect(calls).toHaveLength(0);
  });

  it('bounds the body it reads: a body over the cap answers 413 before the gate', async () => {
    // This route was the last `request.json()` in the API -- a chunked body
    // declares no length, so the proxy's door never stopped it and the read
    // buffered whatever arrived. readJson stops at actual bytes now, the way
    // every other route already did.
    const store = new Store(join(dir, 'podium.db'));
    store.setSettings({ PODIUM_WEBHOOK_URL: 'https://ntfy.example/saved-topic' });
    store.close();

    const calls = stubFetch();
    const resp = await POST(
      new Request('http://podium:3456/api/webhook/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          PODIUM_WEBHOOK_URL: 'https://x.example/'.padEnd(5 * 1024 * 1024 + 1, 'x'),
        }),
      }),
    );
    const body = await resp.json();
    expect(resp.status).toBe(413);
    expect(String(body.error)).toContain('Request body too large');
    // Refused before anything is tested or delivered.
    expect(calls).toHaveLength(0);
  });

  it('reads an empty body as an empty patch, the shrug it always was', async () => {
    const calls = stubFetch();
    const resp = await POST(new Request('http://podium:3456/api/webhook/test', { method: 'POST' }));
    const body = await resp.json();
    // An empty patch validates to nothing, so the decision still falls to the
    // configured URL first: with nothing set and nothing saved, the route
    // answers the same "No webhook URL is set" an empty object always did.
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain('No webhook URL is set');
    expect(calls).toHaveLength(0);
  });
});
