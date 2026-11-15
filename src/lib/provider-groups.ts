import { compileGlob } from './eligibility';

export interface ProviderGroupFilter {
  /** Unset means all groups; an empty list means no groups. */
  includeGroups?: string[];
  excludeGroups?: string[];
}

const GLOB_CACHE_MAX = 512;
const globCache = new Map<string, ReturnType<typeof compileGlob>>();

function cachedGlob(pattern: string): ReturnType<typeof compileGlob> {
  let compiled = globCache.get(pattern);
  if (!compiled) {
    if (globCache.size >= GLOB_CACHE_MAX) globCache.clear();
    compiled = compileGlob(pattern);
    globCache.set(pattern, compiled);
  }
  return compiled;
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
    (!name || !filter.includeGroups.some((g) => cachedGlob(g).test(name)))
  )
    return false;
  if (name && filter.excludeGroups?.some((g) => cachedGlob(g).test(name))) return false;
  return true;
}
