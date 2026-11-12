/**
 * A query-string value read as a whole, non-negative number, or `null` when it
 * is not one. Digits only: `Number()` alone would take '', '1e3' and ' 5' as
 * well, and a value past `Number.MAX_SAFE_INTEGER` would round silently.
 */
export function wholeNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}
