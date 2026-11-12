/**
 * The bounded body readers behind the API routes.
 *
 * The cap is on the bytes that arrive, whatever length was claimed: a chunked
 * body (no length at all) and a lying length (declared small, sent big) both
 * have to stop at the cap, because `request.json()` -- the old reader -- would
 * have buffered either one whole.
 */

import { describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, readJson, readText } from './http-body';

const json = (value: unknown): Request =>
  new Request('http://podium/api/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });

/** A body of `megabytes` streamed with no Content-Length, one MB at a time. */
const chunked = (megabytes: number, bytes = 'x'): Request => {
  const chunk = new TextEncoder().encode(bytes.repeat(1024 * 1024));
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= megabytes) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      sent += 1;
    },
  });
  return new Request('http://podium/api/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stream,
    // Node's Request requires the duplex hint for a streaming body.
    duplex: 'half',
  } as RequestInit);
};

describe('readJson', () => {
  it('parses a body within the cap', async () => {
    const read = await readJson<{ n: number }>(json({ n: 1 }));
    expect(read).toEqual({ ok: true, value: { n: 1 } });
  });

  it('answers 400 for a body that is not JSON', async () => {
    const read = await readJson(json({ n: 1 }), 1024);
    const malformed = await readJson(
      new Request('http://podium/api/x', { method: 'POST', body: '{"n": ' }),
    );
    expect(read).toEqual({ ok: true, value: { n: 1 } });
    expect(malformed).toEqual({ ok: false, status: 400, message: 'body is not JSON' });
  });

  it('answers 400 for a literal null body', async () => {
    // JSON.parse("null") succeeds, and every caller reads the result as an
    // object -- letting null through would throw in a handler far from the
    // parse and surface as a 500. The routes' old `=== null` guards caught
    // exactly this; this is where they live now.
    const read = await readJson(
      new Request('http://podium/api/x', { method: 'POST', body: 'null' }),
    );
    expect(read).toEqual({ ok: false, status: 400, message: 'body is not JSON' });
  });

  it('answers 400 for a missing body', async () => {
    const read = await readJson(new Request('http://podium/api/x'));
    expect(read).toEqual({ ok: false, status: 400, message: 'body is not JSON' });
  });

  it('stops a chunked body that crosses the cap', async () => {
    const read = await readJson(chunked(6));
    expect(read).toEqual({
      ok: false,
      status: 413,
      message: `Request body too large (limit ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB).`,
    });
  });

  it('stops a body whose declared length lies about its size', async () => {
    // A length is a claim. Undici's own Request truncates a stream body to
    // match whatever it declared, and Node's HTTP framing rejects a lying
    // length on the wire -- so the only way to hand one to the reader is by
    // hand. The reader bounds the bytes regardless of what they claimed.
    const chunk = new TextEncoder().encode('x'.repeat(1024 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 6) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += 1;
      },
    });
    const lying = {
      headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? '10' : null) },
      body: stream,
    } as unknown as Request;
    const read = await readJson(lying);
    expect(read).toEqual({
      ok: false,
      status: 413,
      message: 'Request body too large (limit 5 MB).',
    });
  });

  it('accepts a chunked body that stays under it', async () => {
    const read = await readText(chunked(1));
    expect(read.ok).toBe(true);
  });

  it('refuses a declared length over the cap without reading', async () => {
    const read = await readJson(
      new Request('http://podium/api/x', {
        method: 'POST',
        headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) },
        body: '{}',
      }),
    );
    expect(read).toEqual({
      ok: false,
      status: 413,
      message: 'Request body too large (limit 5 MB).',
    });
  });

  it('takes a custom limit', async () => {
    const small = await readJson(json({ n: 1 }), 4);
    expect(small).toEqual({
      ok: false,
      status: 413,
      message: 'Request body too large (limit 0 MB).',
    });
    const fits = await readJson(json({ n: 1 }), 64);
    expect(fits).toEqual({ ok: true, value: { n: 1 } });
  });
});

describe('readText', () => {
  it('reads a plain body', async () => {
    const read = await readText(new Request('http://podium/api/x', { method: 'POST', body: 'hi' }));
    expect(read).toEqual({ ok: true, value: 'hi' });
  });

  it('stops a chunked body that crosses the cap', async () => {
    const read = await readText(chunked(6), 2 * 1024 * 1024);
    expect(read).toEqual({
      ok: false,
      status: 413,
      message: 'Request body too large (limit 2 MB).',
    });
  });
});
