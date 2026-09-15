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
