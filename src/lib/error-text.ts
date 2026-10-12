/**
 * An error as one line, keeping the reason Node hides one level down.
 *
 * `String(error)` on a network failure from `fetch` reads "TypeError: fetch
 * failed" and nothing else: whether the connection was refused, reset, timed
 * out or never resolved lives on `error.cause`. Every failed pass on the live
 * instance was stored as exactly that, which is a record that something went
 * wrong and no help deciding what.
 *
 * The cause's `code` comes first because it is the part worth grepping for;
 * its message is added when it says more than the code does.
 */
export function errorText(error: unknown): string {
  const text = String(error);
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  if (cause === undefined || cause === null) return text;

  const code = (cause as { code?: unknown }).code;
  const message = cause instanceof Error ? cause.message : String(cause);
  const parts: string[] = [];
  if (typeof code === 'string' && code !== '') parts.push(code);
  if (message !== '' && !(typeof code === 'string' && message === code)) parts.push(message);
  // A message that already names the code, like "connect ECONNREFUSED
  // 10.0.0.1:9191", says it once.
  if (parts.length === 2 && parts[1]?.includes(parts[0] ?? '')) parts.shift();
  return parts.length > 0 ? `${text} (${parts.join(': ')})` : text;
}

/**
 * The form an HTTP error body may take.
 *
 * `errorText` is for logs, where the cause chain and the internals it names --
 * which address refused us, which database file failed to open -- are exactly
 * what an operator greps for. A response body is read by anything that can
 * reach the endpoint, which on a worst-case misconfiguration reaches further
 * than the living room. So: one line, `errorText`'s cause-unwrap, truncated,
 * with the two internals an error can carry -- addresses and absolute paths
 * -- replaced before it is sent. The failure class survives (ECONNREFUSED,
 * SQLITE_BUSY, the message proper); the map of the inside of the network does
 * not.
 *
 * Hostnames are deliberately left alone: `dispatcharr:9191` in an error is
 * the name the operator typed into Settings themselves, and telling an
 * internal DNS name from a public one is a guess this app should not make.
 */
export function responseErrorText(error: unknown): string {
  const text = errorText(error)
    // IPv4 with an optional port: the shape of every internal endpoint a
    // failed fetch names. Redacted before the path pass, so a URL's host is
    // gone by the time paths are considered.
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[address]')
    // Absolute paths under the roots this app actually touches. URL paths
    // never begin with these, and hostnames are already stripped of theirs.
    .replace(/\/(?:app|home|root|usr|var|tmp|data)\/[\w./-]+/g, '[path]')
    .replace(/\s+/g, ' ');
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}
