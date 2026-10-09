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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/connect/events/[event]/route';
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
});
