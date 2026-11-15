import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { DispatcharrClient } from './dispatcharr';
import { TeamarrClient } from './teamarr-client';
import { boundedResponse, CONTROL_RESPONSE_BYTES } from './upstream-body';

describe('bounded upstream responses', () => {
  it('preserves status and JSON within the cap', async () => {
    const response = await boundedResponse(
      new Response('{"ok":true}', {
        status: 201,
        headers: { 'x-test': 'kept' },
      }),
      64,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('x-test')).toBe('kept');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('preserves bodyless responses', async () => {
    expect((await boundedResponse(new Response(null, { status: 204 }), 4)).status).toBe(204);
  });

  it('cancels a body that exceeds the byte limit without a declared length', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(10));
      },
      cancel,
    });
    await expect(boundedResponse(new Response(body), 15)).rejects.toThrow('exceeds 15 bytes');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('refuses a declared oversized body before consuming it', async () => {
    const response = new Response('small', { headers: { 'content-length': '1000' } });
    await expect(boundedResponse(response, 10)).rejects.toThrow('exceeds 10 bytes');
  });

  it('counts UTF-8 bytes rather than characters', async () => {
    await expect(boundedResponse(new Response('éé'), 3)).rejects.toThrow('exceeds 3 bytes');
    expect(await (await boundedResponse(new Response('éé'), 4)).text()).toBe('éé');
  });

  it('keeps the Dispatcharr timeout active after headers arrive', async () => {
    let started = false;
    const server = createServer((_request, response) => {
      started = true;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('[');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no server port');
      const client = new DispatcharrClient(
        `http://127.0.0.1:${address.port}`,
        { apiKey: 'test' },
        200,
      );
      await expect(client.providers()).rejects.toThrow();
      expect(started).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('bounds Dispatcharr login and Teamarr bodies through their clients', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('x'.repeat(CONTROL_RESPONSE_BYTES + 1)));
    try {
      await expect(
        new DispatcharrClient('http://d', { username: 'u', password: 'p' }).login(),
      ).rejects.toThrow('exceeds');
      await expect(new TeamarrClient('http://t').rules()).rejects.toThrow(
        'Could not reach Teamarr',
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
