/**
 * Short-lived in-memory cache for the EPG grid the worker fetches every pass.
 *
 * The grid is large and changes slowly, yet each pass re-derives "what is
 * airing now" from the rows' start/end times, so a TTL of minutes-to-hours is
 * safe: the row set is reused while the decision it feeds is recomputed. A
 * fresh fetch that comes back empty -- a Dispatcharr hiccup, or genuinely
 * nothing airing at that instant -- is recoverable via `stale()`, because stale
 * EPG beats none for the after_epg_start policy.
 *
 * Keyed on `source` (the Dispatcharr base URL) so reconfiguring the backend is
 * a cache miss rather than serving rows from the wrong install.
 */

export interface EpgCacheEntry<T> {
  source: string;
  value: T;
  fetchedAt: number;
}

export class EpgCache<T> {
  private entry: EpgCacheEntry<T> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The cached value if it is fresh for `source` within `ttlMs`, else null.
   * A different `source` is a miss even when the entry is otherwise fresh.
   */
  fresh(source: string, ttlMs: number): T | null {
    const entry = this.entry;
    if (!entry || entry.source !== source) return null;
    return this.now() - entry.fetchedAt < ttlMs ? entry.value : null;
  }

  /** The last good value regardless of age, if it matches `source`. */
  stale(source: string): T | null {
    const entry = this.entry;
    return entry && entry.source === source ? entry.value : null;
  }

  /** Record a successful fetch for `source`. */
  set(source: string, value: T): void {
    this.entry = { source, value, fetchedAt: this.now() };
  }
}
