'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface Hit {
  normalized: string;
  count: number;
  providers: string[];
  samples: string[];
  claimedBy: string | null;
  prefixes: Array<{ name: string; count: number }>;
  sections: Array<{ name: string; count: number }>;
}

/**
 * Quote a prefix that would not survive being read back as one token.
 *
 * "US East" has to come back as one segment, not as `@US` plus a stray "East"
 * in the alias name.
 */
function qualifier(prefix: string): string {
  return /\s/.test(prefix) ? `@"${prefix}"` : `@${prefix}`;
}

/**
 * Whether the search term is a word *inside* this name rather than the name.
 *
 * "Commanders" against "NFL WASHINGTON COMMANDERS" is the case an alias cannot
 * express: the alias layer matches whole normalised names, so the broadcaster,
 * call sign and city wrapped around the team make every name its own alias.
 * `contains` is the layer for it, and the section chips scope it so the term
 * does not also drag in the radio feed and three rugby fixtures.
 */
function isFragment(query: string, normalized: string): boolean {
  const needle = query.trim().toLowerCase();
  const words = normalized.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  return words.length > needle.split(/\s+/).length && words.includes(needle);
}

const btn =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-[15px] hover:border-[var(--color-accent)] disabled:opacity-50';
const pill = 'inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap';

/**
 * Browse the provider catalogue while writing aliases.
 *
 * Results are grouped by normalised name because that is the unit an alias
 * matches: twelve providers carrying "NBC 4 WRC" is one decision, not twelve
 * rows. "Claimed by" matters just as much as the name -- adding an alias that
 * another channel already owns is how you quietly steal its streams.
 */
export function StreamSearch({
  onAdd,
  onAddContains,
}: {
  onAdd: (name: string) => void;
  onAddContains?: (needle: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setHits([]);
      setTotal(0);
      return;
    }
    setBusy(true);
    try {
      const resp = await fetch(`/api/streams?q=${encodeURIComponent(q)}`);
      if (!resp.ok) return;
      const body = await resp.json();
      setHits(body.groups as Hit[]);
      setTotal(body.total as number);
      setTruncated(Boolean(body.truncated));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void search(query), 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, search]);

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Find streams
        </h3>
        <span className="text-sm tabular-nums text-[var(--color-muted)]">
          {busy ? 'searching…' : total > 0 ? `${total} distinct names` : ''}
        </span>
      </div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search all provider streams, e.g. NBC"
        className="mt-3 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
      />
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        Everything the providers carry, grouped by normalised name. Add one as an alias, or check
        whether another channel already claims it.
      </p>

      {hits.length > 0 && (
        <ul className="mt-3 max-h-[360px] overflow-y-auto">
          {hits.map((h) => (
            <li
              key={h.normalized}
              className="flex flex-wrap items-start gap-3 border-b border-[var(--color-line)] py-3 last:border-0"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{h.normalized}</span>
                <span className="mt-0.5 block text-sm text-[var(--color-muted)]">
                  {h.count} stream{h.count === 1 ? '' : 's'} · {h.providers.join(', ')}
                  {h.claimedBy && (
                    <>
                      {' · '}
                      <span className="text-[var(--color-warn)]">claimed by {h.claimedBy}</span>
                    </>
                  )}
                </span>
                <span className="mono mt-1 block truncate text-xs text-[var(--color-muted)]">
                  {h.samples[0]}
                </span>
                {/* The term is buried inside this name, so no alias can claim
                    it. Offer the section-scoped `contains` that can, and the
                    bare one only as the last resort it is. */}
                {onAddContains && isFragment(query, h.normalized) && (
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-[var(--color-muted)]">“{query.trim()}” in:</span>
                    {h.sections.map((s) => (
                      <button
                        key={s.name}
                        type="button"
                        title={`Add contains "${qualifier(s.name)} ${query.trim()}" — every ${
                          s.name
                        } stream with “${query.trim()}” in the name`}
                        className={`${pill} mono border border-[var(--color-line)] hover:border-[var(--color-accent)]`}
                        onClick={() => onAddContains(`${qualifier(s.name)} ${query.trim()}`)}
                      >
                        {s.name} <span className="text-[var(--color-muted)]">×{s.count}</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      title={`Add contains "${query.trim()}" — every stream with that word, in any section`}
                      className={`${pill} mono border border-dashed border-[var(--color-line)] text-[var(--color-muted)] hover:border-[var(--color-accent)]`}
                      onClick={() => onAddContains(query.trim())}
                    >
                      anywhere
                    </button>
                  </span>
                )}
                {/* Only when there is a decision to make. One prefix, or none,
                    means the plain alias already says everything. */}
                {h.prefixes.length > 1 && (
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-[var(--color-muted)]">only:</span>
                    {h.prefixes.map((p) => (
                      <button
                        key={p.name}
                        type="button"
                        title={`Add "${qualifier(p.name)} ${h.normalized}" — matches the ${
                          p.name
                        } feed only`}
                        className={`${pill} mono border border-[var(--color-line)] hover:border-[var(--color-accent)]`}
                        onClick={() => onAdd(`${qualifier(p.name)} ${h.normalized}`)}
                      >
                        {p.name} <span className="text-[var(--color-muted)]">×{p.count}</span>
                      </button>
                    ))}
                  </span>
                )}
              </span>
              <button
                type="button"
                className={`${btn} flex-none px-3 py-1.5 text-sm`}
                onClick={() => onAdd(h.normalized)}
              >
                + alias
              </button>
            </li>
          ))}
        </ul>
      )}

      {truncated && (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Showing the most common {hits.length}. Narrow the search to see the rest.
        </p>
      )}
      {query.trim().length >= 2 && !busy && hits.length === 0 && (
        <p className="mt-3 text-[var(--color-muted)]">
          No streams match “{query}”. <span className={pill}>tip</span> search the bare name,
          without any “USA:” prefix or quality suffix.
        </p>
      )}
    </div>
  );
}
