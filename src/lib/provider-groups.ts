import { compileGlob } from './eligibility';

export interface ProviderGroupFilter {
  /** Unset means all groups; an empty list means no groups. */
  includeGroups?: string[];
  excludeGroups?: string[];
}

export function groupFilter(raw: unknown): ProviderGroupFilter {
  if (!raw || typeof raw !== 'object') return {};
  const row = raw as Record<string, unknown>;
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined;
  // Rules on disk use snake_case; the editor sends camelCase to /api/preview.
  // Both must produce the same filter or the live ordering contradicts a save.
  const include = row.includeGroups ?? row.include_groups;
  const exclude = row.excludeGroups ?? row.exclude_groups;
  return {
    ...(Array.isArray(include) ? { includeGroups: list(include) } : {}),
    ...(Array.isArray(exclude) ? { excludeGroups: list(exclude) } : {}),
  };
}

export function groupAllowed(name: string | undefined, filter: ProviderGroupFilter): boolean {
  if (
    filter.includeGroups !== undefined &&
    (!name || !filter.includeGroups.some((g) => compileGlob(g).test(name)))
  )
    return false;
  if (name && filter.excludeGroups?.some((g) => compileGlob(g).test(name))) return false;
  return true;
}
