'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface StreamGroup {
  id: number;
  name: string;
  streams: number;
  claimed: number;
  excluded: boolean;
  excludedBy: string | null;
}

const card = 'rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]';
const btn =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-[15px] hover:border-[var(--color-accent)] disabled:opacity-50';
const pill = 'inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap';
const input =
  'w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 outline-none focus:border-[var(--color-accent)]';

/**
 * Switch provider stream groups out of matching.
 *
 * A subscription turned on for its sports channels also brings per-fixture PPV
 * feeds and auto-built event groups, and those streams are candidates for every
 * rule in the file. Nothing in the UI showed them before: the groups list is
 * built from *channels*, and a provider group holds none.
 *
 * Sorted by how many streams a group currently gets claimed, because that is
 * the only number that says whether switching it off changes anything.
 */
export function StreamGroupsView() {
  const [groups, setGroups] = useState<StreamGroup[]>([]);
  const [excludeGroups, setExcludeGroups] = useState<string[]>([]);
  const [totals, setTotals] = useState({ totalStreams: 0, excludedStreams: 0 });
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/stream-groups');
      const body = await resp.json();
      if (!resp.ok || body.error) {
        setError(String(body.error ?? `HTTP ${resp.status}`));
        return;
      }
      setError('');
      setGroups(body.groups as StreamGroup[]);
      setExcludeGroups(body.excludeGroups as string[]);
      setTotals({ totalStreams: body.totalStreams, excludedStreams: body.excludedStreams });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (next: string[]) => {
    setSaving(true);
    try {
      const resp = await fetch('/api/stream-groups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ excludeGroups: next }),
      });
      const body = await resp.json();
      if (!resp.ok || body.error) {
        setError(String(body.error ?? `HTTP ${resp.status}`));
        return;
      }
      await load();
    } finally {
      setSaving(false);
    }
  };

  const toggle = (group: StreamGroup) => {
    // Switching off adds the exact name; switching on removes whatever rule
    // covered it, which for a glob means dropping the glob. Saying so is
    // better than silently taking 40 other groups back with it.
    if (group.excluded) {
      const rule = group.excludedBy ?? group.name;
      if (rule !== group.name) {
        const covered = groups.filter((g) => g.excludedBy === rule).length;
        if (
          covered > 1 &&
          !confirm(`"${rule}" also covers ${covered - 1} other group(s). Remove the whole rule?`)
        ) {
          return;
        }
      }
      void save(excludeGroups.filter((g) => g !== rule));
    } else {
      void save([...excludeGroups, group.name]);
    }
  };

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const rows = groups.filter((g) => !needle || g.name.toLowerCase().includes(needle));
    // Everything with a claim, plus anything already switched off, is the set
    // worth a decision. The long tail of untouched groups hides behind a click.
    return showAll || needle ? rows : rows.filter((g) => g.claimed > 0 || g.excluded);
  }, [groups, filter, showAll]);

  const hidden = groups.length - visible.length;

  return (
    <div className={`${card} p-5`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Provider stream groups
        </h3>
        <span className="text-sm tabular-nums text-[var(--color-muted)]">
          {loading
            ? 'loading…'
            : `${totals.excludedStreams.toLocaleString()} of ${totals.totalStreams.toLocaleString()} streams switched off`}
        </span>
      </div>
      <p className="mt-1.5 text-sm text-[var(--color-muted)]">
        Groups your providers import. Switching one off takes its streams out of matching entirely —
        no alias, contains or regex can claim them. Use it for PPV, per-fixture event feeds and
        auto-built groups, which otherwise get picked up by any{' '}
        <span className="mono">contains</span> that names a team.
      </p>

      {error && (
        <p className="mt-3 rounded-lg border border-[var(--color-warn)] px-3 py-2 text-sm text-[var(--color-warn)]">
          {error}
        </p>
      )}

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter groups, e.g. PPV"
        className={`${input} mt-3`}
      />

      {excludeGroups.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-[var(--color-muted)]">off:</span>
          {excludeGroups.map((g) => (
            <button
              key={g}
              type="button"
              disabled={saving}
              title={`Switch "${g}" back on`}
              className={`${pill} mono border border-[var(--color-warn)] text-[var(--color-warn)] hover:border-[var(--color-accent)]`}
              onClick={() => void save(excludeGroups.filter((x) => x !== g))}
            >
              {g} ✕
            </button>
          ))}
        </div>
      )}

      {visible.length > 0 && (
        <ul className="mt-3 max-h-[420px] overflow-y-auto">
          {visible.map((g) => (
            <li
              key={g.id}
              className="flex flex-wrap items-center gap-3 border-b border-[var(--color-line)] py-2.5 last:border-0"
            >
              <span className="min-w-0 flex-1">
                <span
                  className={`block ${g.excluded ? 'text-[var(--color-muted)] line-through' : ''}`}
                >
                  {g.name}
                </span>
                <span className="mt-0.5 block text-sm text-[var(--color-muted)]">
                  {g.streams.toLocaleString()} stream{g.streams === 1 ? '' : 's'}
                  {g.claimed > 0 && (
                    <>
                      {' · '}
                      <span className={g.excluded ? '' : 'text-[var(--color-warn)]'}>
                        {g.claimed.toLocaleString()} claimed
                      </span>
                    </>
                  )}
                  {g.excludedBy && g.excludedBy !== g.name && (
                    <>
                      {' · via '}
                      <span className="mono">{g.excludedBy}</span>
                    </>
                  )}
                </span>
              </span>
              <button
                type="button"
                disabled={saving}
                className={`${btn} flex-none px-3 py-1.5 text-sm ${
                  g.excluded ? 'border-[var(--color-warn)] text-[var(--color-warn)]' : ''
                }`}
                onClick={() => toggle(g)}
              >
                {g.excluded ? 'on' : 'off'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!loading && hidden > 0 && (
        <button
          type="button"
          className="mt-3 text-sm text-[var(--color-muted)] underline hover:text-[var(--color-accent)]"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? 'Show only groups that match something' : `Show ${hidden} more with no claims`}
        </button>
      )}
      {!loading && groups.length === 0 && !error && (
        <p className="mt-3 text-[var(--color-muted)]">No provider groups found.</p>
      )}
    </div>
  );
}
