import { afterEach, describe, expect, it, vi } from 'vitest';
import { DispatcharrClient } from './dispatcharr';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const client = () => new DispatcharrClient('http://dispatcharr', { apiKey: 'test' });

describe('Dispatcharr transient GET retries', () => {
  it.each([500, 502, 503, 504])('recovers after a transient %s', async (status) => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('temporary', { status }))
      .mockResolvedValueOnce(new Response('[]'));
    vi.stubGlobal('fetch', fetch);
    const result = expect(client().providers()).resolves.toEqual([]);
    await vi.runAllTimersAsync();
    await result;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'])('recovers from %s', async (code) => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code } }))
      .mockResolvedValueOnce(new Response('[]'));
    vi.stubGlobal('fetch', fetch);
    const result = expect(client().providers()).resolves.toEqual([]);
    await vi.runAllTimersAsync();
    await result;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops after two retries and preserves the final status', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response('temporary', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const result = expect(client().providers()).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await result;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry writes or non-transient client errors', async () => {
    const fetch = vi.fn(async () => new Response('refused', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(client().setStreamOrder(1, [2])).rejects.toThrow('503');
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockImplementation(async () => new Response('refused', { status: 403 }));
    await expect(client().providers()).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry aborts or unrelated network failures', async () => {
    const fetch = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    vi.stubGlobal('fetch', fetch);
    await expect(client().providers()).rejects.toThrow('aborted');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
