/**
 * Bounded body reading for the API routes.
 *
 * The proxy refuses a declared `Content-Length` over the cap at the door, but
 * a chunked request carries no length at all and sails past that check --
 * Node's HTTP framing enforces a declared length on the wire, so chunked is
 * the body that actually arrives unbounded. It reaches `request.json()`,
 * which buffers the whole body into memory before parsing -- the one
 * unbounded read in the codebase.
 *
 * These helpers read the stream and stop at the cap, so the bytes that arrive
 * are what is bounded. Parsing is part of the same read, so a route asks once
 * and gets either a value or a verdict it can answer with: 400 for a body
 * that is not JSON, 413 for one that is too big. The limit matches the
 * proxy's door -- the same number, imported from here, so the two cannot
 * drift.
 */

/** The most a request body may be, whatever the client claimed. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type ParsedBody<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413; message: string };

const TOO_LARGE = (limit: number): string =>
  `Request body too large (limit ${Math.round(limit / 1024 / 1024)} MB).`;

/**
 * Read a request body as text, stopping at `limit` actual bytes.
 *
 * A `Content-Length` over the limit refuses without reading, the same cheap
 * door the proxy closes; the point of the loop beneath it is the body whose
 * length said nothing true.
 */
export async function readText(
  request: Request,
  limit: number = MAX_BODY_BYTES,
): Promise<ParsedBody<string>> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    return { ok: false, status: 413, message: TOO_LARGE(limit) };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400, message: 'body is not JSON' };

  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      // Stop the client's upload rather than reading the rest of it: a body
      // already refused should not cost the connection its full length.
      void reader.cancel();
      return { ok: false, status: 413, message: TOO_LARGE(limit) };
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: new TextDecoder().decode(buffer) };
}

/**
 * Read a request body as JSON, bounded the same way.
 *
 * A body that is not JSON answers 400 -- the routes' own wording, kept so the
 * client sees the same refusal it always did -- and one over the cap answers
 * 413 whether or not it declared a length.
 */
export async function readJson<T = unknown>(
  request: Request,
  limit: number = MAX_BODY_BYTES,
): Promise<ParsedBody<T>> {
  const read = await readText(request, limit);
  if (!read.ok) return read;
  try {
    return { ok: true, value: JSON.parse(read.value) as T };
  } catch {
    return { ok: false, status: 400, message: 'body is not JSON' };
  }
}
