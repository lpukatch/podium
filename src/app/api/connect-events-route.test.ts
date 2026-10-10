/**
 * The webhook receiver, called as Next would call it.
 *
 * What is worth testing here is the door, not the fold -- the token check,
 * the two body spellings Dispatcharr can send, and that a delivery which
 * cannot name a channel is refused at the door rather than queued for the
 * drain to trip over.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/connect/events/[event]/route';
import { GET } from '@/app/api/connect/status/route';
import { Store } from '@/lib/store';

const TOKEN = 'a'.repeat(48);

function request(event: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://podium:3456/api/connect/events/${event}`, {
    method: 'POST',
    headers,
    body,
  });
}

async function call(event: string, body: string, headers: Record<string, string> = {}) {
  return POST(request(event, body, headers), { params: Promise.resolve({ event }) });
}

describe('the connect event receiver', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-connect-'));
    process.env.PODIUM_DATA_DIR = dir;
    const store = new Store(join(dir, 'podium.db'));
    store.setSettings({ PODIUM_CONNECT_TOKEN: TOKEN });
    store.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PODIUM_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const queued = (): number => {
    const store = new Store(join(dir, 'podium.db'));
    try {
      return store.takeConnectEvents(60_000).length;
    } finally {
      store.close();
    }
  };

  it('queues a form-encoded delivery under its event', async () => {
    const resp = await call(
      'stream_switch',
      new URLSearchParams({
        channel_id: '09bbd059-1a49-47ee-a525-c1444e1c6bd7',
        stream_id: '77177',
        previous_stream_id: '77013',
        reason: 'buffering_timeout',
      }).toString(),
      { 'content-type': 'application/x-www-form-urlencoded', 'x-podium-connect-token': TOKEN },
    );
    expect(resp.status).toBe(204);
    expect(queued()).toBe(1);
  });

  it('queues a JSON delivery too', async () => {
    const resp = await call(
      'channel_error',
      JSON.stringify({ channel_id: 'abc', stream_id: 77013, error_type: 'buffering_timeout' }),
      { 'content-type': 'application/json', 'x-podium-connect-token': TOKEN },
    );
    expect(resp.status).toBe(204);
    expect(queued()).toBe(1);
  });

  it('refuses a delivery without the token, leaving nothing queued', async () => {
    const resp = await call('stream_switch', 'channel_id=abc');
    expect(resp.status).toBe(401);
    expect(queued()).toBe(0);
  });

  it('refuses a wrong token as well, so a guessed secret learns nothing', async () => {
    const resp = await call('stream_switch', 'channel_id=abc', {
      'x-podium-connect-token': 'b'.repeat(48),
    });
    expect(resp.status).toBe(401);
  });

  it('answers 404 for an event it does not subscribe to', async () => {
    const resp = await call('channel_buffering', 'channel_id=abc', {
      'x-podium-connect-token': TOKEN,
    });
    expect(resp.status).toBe(404);
    expect(queued()).toBe(0);
  });

  it('refuses a delivery with no channel to charge', async () => {
    const resp = await call('channel_error', 'stream_id=77013', {
      'content-type': 'application/x-www-form-urlencoded',
      'x-podium-connect-token': TOKEN,
    });
    expect(resp.status).toBe(400);
    expect(queued()).toBe(0);
  });

  it('answers 401 while unprovisioned, when no token is stored', async () => {
    const store = new Store(join(dir, 'podium.db'));
    store.setSettings({ PODIUM_CONNECT_TOKEN: null });
    store.close();
    const resp = await call('stream_switch', 'channel_id=abc', {
      'x-podium-connect-token': TOKEN,
    });
    expect(resp.status).toBe(401);
  });

  it('reports accepted deliveries after consumption without exposing secrets or raw bodies', async () => {
    await call(
      'stream_switch',
      'channel_id=abc&channel_name=Demo&stream_id=2&previous_stream_id=1&reason=manual&secret=private-payload',
      { 'x-podium-connect-token': TOKEN },
    );
    expect(queued()).toBe(1);
    const resp = GET();
    const text = await resp.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      state: 'disabled',
      pending: 0,
      summary: { accepted: 1, rejected: 0 },
    });
    expect(body.recent[0]).toMatchObject({
      event: 'stream_switch',
      channelKey: 'abc',
      channelName: 'Demo',
      streamId: 2,
      previousStreamId: 1,
      reason: 'manual',
      status: 204,
    });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('private-payload');
    expect(resp.headers.get('cache-control')).toBe('no-store');
  });

  it('counts malformed and unauthorized deliveries separately from accepted events', async () => {
    await call('channel_error', 'channel_id=private-body', {
      'x-podium-connect-token': 'private-token',
    });
    await call('channel_error', 'not json', {
      'content-type': 'application/json',
      'x-podium-connect-token': TOKEN,
    });
    const body = await GET().json();
    expect(body.summary).toMatchObject({ accepted: 0, rejected: 2, lastReceivedAt: null });
    expect(body.recent.map((row: { status: number }) => row.status)).toEqual([400, 401]);
    expect(JSON.stringify(body)).not.toMatch(/private-body|private-token/);
  });

  it('reports the effective stored configuration and subscription reconciliation', async () => {
    const store = new Store(join(dir, 'podium.db'));
    store.setSettings({ PODIUM_CONNECT_EVENTS: 'true', PODIUM_CONNECT_URL: 'http://podium:3456' });
    store.recordConnectSync(
      { wanted: true, podiumUrl: 'http://podium:3456', dispatcharrUrl: 'http://dispatcharr:9191' },
      null,
    );
    store.close();
    const body = await GET().json();
    expect(body).toMatchObject({
      enabled: true,
      stabilityEnabled: true,
      callbackUrl: 'http://podium:3456',
      state: 'listening',
      summary: { accepted: 0, lastReceivedAt: null },
    });
  });

  it('counts receiver failures with a fixed diagnostic rather than exception contents', async () => {
    vi.spyOn(Store.prototype, 'recordConnectEvents').mockImplementation(() => {
      throw new Error('private-exception-detail');
    });
    const response = await call('channel_error', 'channel_id=abc', {
      'x-podium-connect-token': TOKEN,
    });
    expect(response.status).toBe(500);
    const body = await GET().json();
    expect(body.summary).toMatchObject({ accepted: 0, rejected: 1 });
    expect(body.recent[0].status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('private-exception-detail');
  });
});
