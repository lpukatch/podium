'use client';

import { useState } from 'react';
import type { ProviderGroupFilter } from '@/lib/provider-groups';

export function ProviderGroupFilterEditor({
  groups,
  value,
  onChange,
  inheritLabel = 'Inherit channel group',
}: {
  groups: Array<{ id: number; name: string }>;
  value: ProviderGroupFilter | null;
  onChange: (value: ProviderGroupFilter | null) => void;
  inheritLabel?: string;
}) {
  const [query, setQuery] = useState('');
  const included = value?.includeGroups;
  const excluded = value?.excludeGroups ?? [];
  const options = groups.filter((g) => g.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="mt-3 text-sm">
      <label className="block font-medium">Provider stream groups</label>
      <p className="mt-1 text-[var(--color-muted)]">
        Choose which imported groups can supply streams. Global exclusions always win.
      </p>
      <select
        className="mt-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-1.5"
        value={value === null ? 'inherit' : included === undefined ? 'all' : 'selected'}
        onChange={(e) =>
          onChange(
            e.target.value === 'inherit'
              ? null
              : e.target.value === 'all'
                ? {}
                : { includeGroups: [] },
          )
        }
      >
        <option value="inherit">{inheritLabel}</option>
        <option value="all">All groups</option>
        <option value="selected">Only selected groups</option>
      </select>
      {value !== null && (
        <>
          {included !== undefined && included.length === 0 && (
            <p className="mt-2 text-[var(--color-warn)]">
              No provider groups selected: this scope will match no streams.
            </p>
          )}
          <input
            className="mt-2 block w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2"
            placeholder="Find a provider group…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="scroll-shadow mt-2 max-h-44 overflow-y-auto">
            {options.map((g) => (
              <div key={g.id} className="flex items-center gap-2 py-1">
                {included !== undefined && (
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={included.includes(g.name)}
                      onChange={() =>
                        onChange({
                          ...value,
                          includeGroups: included.includes(g.name)
                            ? included.filter((n) => n !== g.name)
                            : [...included, g.name],
                        })
                      }
                    />
                    Allow
                  </label>
                )}
                <span className="min-w-0 flex-1 truncate" title={g.name}>
                  {g.name}
                </span>
                <label className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
                  <input
                    type="checkbox"
                    checked={excluded.includes(g.name)}
                    onChange={() =>
                      onChange({
                        ...value,
                        excludeGroups: excluded.includes(g.name)
                          ? excluded.filter((n) => n !== g.name)
                          : [...excluded, g.name],
                      })
                    }
                  />
                  Exclude
                </label>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
