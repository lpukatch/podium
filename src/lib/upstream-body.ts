/** Response limits apply to decoded bytes, including chunked HTTP bodies. */
export const CONTROL_RESPONSE_BYTES = 2 * 1024 * 1024;
export const BULK_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Buffer a response under the fetch caller's active abort deadline. */
export async function boundedResponse(response: Response, limit: number): Promise<Response> {
  if (!response.body) return response;
  const tooLarge = () => new Error(`Upstream response exceeds ${limit} bytes`);
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
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
