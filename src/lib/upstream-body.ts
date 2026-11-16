/** Response limits apply to decoded bytes, including chunked HTTP bodies. */
export const CONTROL_RESPONSE_BYTES = 2 * 1024 * 1024;
export const BULK_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * An upstream body outgrew its cap. Typed so clients can tell "too much data"
 * apart from "could not reach the server" — the two read the same to a bare
 * catch block, but only the first means the address was right.
 */
export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Upstream response exceeds ${limit} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/** Buffer a response under the fetch caller's active abort deadline. */
export async function boundedResponse(response: Response, limit: number): Promise<Response> {
  if (!response.body) return response;
  const tooLarge = () => new ResponseTooLargeError(limit);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    void response.body.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // The wire headers describe the compressed body fetch already decoded, so
  // they lie about this one: the old `content-encoding` claims these plain
  // bytes are still gzipped, and the old `content-length` counts wire bytes
  // rather than the decoded ones a reader now receives. Answer with the
  // decoded length and no encoding claim.
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.set('content-length', String(size));
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
