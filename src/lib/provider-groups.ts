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
  return {
    ...(Array.isArray(row.include_groups) ? { includeGroups: list(row.include_groups) } : {}),
    ...(Array.isArray(row.exclude_groups) ? { excludeGroups: list(row.exclude_groups) } : {}),
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
