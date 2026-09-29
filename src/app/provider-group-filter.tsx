'use client';

import { useState } from 'react';
import type { ProviderGroupFilter } from '@/lib/provider-groups';

const chip = (active: boolean) =>
  `rounded-lg border px-3 py-1.5 text-sm ${
    active
      ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
      : 'border-[var(--color-line)] text-[var(--color-muted)] hover:border-[var(--color-accent)]'
  }`;

export function ProviderGroupFilterEditor({
  groups,
  value,
  onChange,
  inheritLabel = 'Inherit channel group',
  counts,
}: {
  groups: Array<{ id: number; name: string }>;
  value: ProviderGroupFilter | null;
  onChange: (value: ProviderGroupFilter | null) => void;
  inheritLabel?: string;
  counts?: Record<string, number>;
}) {
  const [query, setQuery] = useState('');
  const included = value?.includeGroups;
  const excluded = value?.excludeGroups ?? [];
  const options = groups
    .filter((g) => g.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (counts?.[b.name] ?? 0) - (counts?.[a.name] ?? 0));
  return (
    <div className="mt-3 text-sm">
      <p className="font-medium">Provider stream groups</p>
      <p className="mt-1 text-[var(--color-muted)]">
        Choose which imported groups can supply streams. Global exclusions always win.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" className={chip(value === null)} onClick={() => onChange(null)}>
          {inheritLabel}
        </button>
        <button
          type="button"
          className={chip(value !== null && included === undefined && !excluded.length)}
          onClick={() => onChange({})}
        >
          All
        </button>
        <button
          type="button"
          className={chip(value !== null && included?.length === 0)}
          onClick={() => onChange({ includeGroups: [] })}
        >
          None
        </button>
      </div>
      {value !== null && (
        <>
          {included?.length === 0 && (
            <p className="mt-2 text-[var(--color-warn)]">
              No provider groups selected: this scope will match no streams.
            </p>
          )}
          <input
            aria-label="Find a provider group"
            className="mt-2 block w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2"
            placeholder="Find a provider group…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            Click a group to{' '}
            {included === undefined ? 'exclude or allow it' : 'allow or exclude it'}. Alt-click to
            keep only that group.
          </p>
          <div className="scroll-shadow mt-2 max-h-64 overflow-y-auto pr-4">
            <div className="space-y-1 py-1">
              {options.map((g) => {
                const selected =
                  included === undefined
                    ? !excluded.includes(g.name)
                    : included.includes(g.name) && !excluded.includes(g.name);
                return (
                  <button
                    key={g.id}
                    type="button"
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm hover:border-[var(--color-accent)] ${
                      selected
                        ? 'border-[var(--color-line)] bg-[var(--color-canvas)]'
                        : 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                    }`}
                    aria-pressed={selected}
                    title={`${g.name}: ${selected ? 'allowed' : 'excluded'}. Alt-click to select only this group.`}
                    onClick={(e) => {
                      if (e.altKey) {
                        onChange({ includeGroups: [g.name] });
                      } else if (included === undefined) {
                        const next = selected
                          ? [...excluded, g.name]
                          : excluded.filter((name) => name !== g.name);
                        onChange(next.length ? { excludeGroups: next } : {});
                      } else {
                        const next = selected
                          ? included.filter((name) => name !== g.name)
                          : [...included, g.name];
                        onChange({
                          includeGroups: next,
                          excludeGroups: excluded.filter((name) => name !== g.name),
                        });
                      }
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{g.name}</span>
                    {counts && (
                      <span className="shrink-0 tabular-nums text-[var(--color-muted)]">
                        {counts[g.name] ?? 0}
                      </span>
                    )}
                    <span
                      className={`w-16 shrink-0 text-right text-xs ${selected ? 'text-[var(--color-muted)]' : 'text-[var(--color-accent)]'}`}
                    >
                      {selected ? 'Allowed' : 'Excluded'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
