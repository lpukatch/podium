import { NextResponse } from 'next/server';
import { parseMaxResolution, parseMinResolution, RESOLUTION_CHOICES } from '@/lib/resolution';
import { readRulesDoc, writeRulesDoc } from '@/lib/server/state';

export const dynamic = 'force-dynamic';

interface ChannelEntry {
  channel_id: number | string;
  aliases?: string[];
  contains?: string[];
  exclude?: string[];
  [key: string]: unknown;
}

export async function PUT(request: Request, context: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await context.params;
  const id = Number(channelId);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: 'bad channel id' }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as {
    aliases?: string[];
    contains?: string[];
    exclude?: string[];
    providers?: unknown;
    groupFilter?: { includeGroups?: string[]; excludeGroups?: string[] } | null;
    aliasGroupFilters?: Record<string, { excludeGroups?: string[] }>;
    aliasProviders?: Record<string, number[]>;
    aliasProviderGroupFilters?: Record<string, Record<string, { excludeGroups?: string[] }>>;
    containsGroupFilters?: Record<string, { excludeGroups?: string[] }>;
    /**
     * `720p`, `1080p` or `2160p`; `none` to ignore the group's floor; `inherit`
     * to take the group's. Absent leaves whatever is stored alone, and `null`
     * and `""` both read as `inherit` -- a client resetting a field sends one of
     * those, and rejecting them would make "clear this" an error.
     */
    minResolution?: string | null;
    /** The ceiling twin of `minResolution`, same readings. */
    maxResolution?: string | null;
  } | null;
  if (body === null) {
    return NextResponse.json({ error: 'body is not JSON' }, { status: 400 });
  }
  const clean = (values: string[] | undefined) =>
    (values ?? []).map((v) => v.trim()).filter(Boolean);

  const inherits =
    body.minResolution === null || body.minResolution === '' || body.minResolution === 'inherit';
  const floor = inherits ? undefined : parseMinResolution(body.minResolution);
  if (body.minResolution !== undefined && !inherits && floor === undefined) {
    return NextResponse.json(
      { error: `unknown resolution ${body.minResolution}` },
      { status: 400 },
    );
  }

  const inheritsCeiling =
    body.maxResolution === null || body.maxResolution === '' || body.maxResolution === 'inherit';
  const ceiling = inheritsCeiling ? undefined : parseMaxResolution(body.maxResolution);
  if (body.maxResolution !== undefined && !inheritsCeiling && ceiling === undefined) {
    return NextResponse.json(
      { error: `unknown resolution ${body.maxResolution}` },
      { status: 400 },
    );
  }

  const doc = readRulesDoc();
  const channels = (doc.channels ?? []) as ChannelEntry[];
  let entry = channels.find((c) => Number(c.channel_id) === id);

  if (!entry) {
    // A channel with no rule yet is the normal case for a group that was never
    // managed; create the entry rather than refusing the edit.
    entry = { channel_id: id, enabled: true, patterns: [], exclude_regions: [] };
    channels.push(entry);
    doc.channels = channels;
  }

  entry.aliases = clean(body.aliases);
  entry.contains = clean(body.contains);
  entry.exclude = clean(body.exclude);
  if (body.providers !== undefined) {
    if (Array.isArray(body.providers) && body.providers.length > 0) {
      entry.providers = body.providers.map(Number).filter(Number.isFinite);
    } else {
      delete entry.providers;
    }
  }
  if (body.groupFilter !== undefined) {
    if (body.groupFilter === null) {
      delete entry.include_groups;
      delete entry.exclude_groups;
    } else {
      delete entry.include_groups;
      delete entry.exclude_groups;
      if (body.groupFilter.includeGroups !== undefined)
        entry.include_groups = clean(body.groupFilter.includeGroups);
      if (body.groupFilter.excludeGroups !== undefined)
        entry.exclude_groups = clean(body.groupFilter.excludeGroups);
    }
  }
  if (body.aliasGroupFilters !== undefined) {
    entry.alias_group_filters = Object.fromEntries(
      Object.entries(body.aliasGroupFilters)
        .filter(([line]) => clean(body.aliases).includes(line))
        .filter(([, filter]) => clean(filter.excludeGroups).length > 0)
        .map(([line, filter]) => [line, { exclude_groups: clean(filter.excludeGroups) }]),
    );
  }
  if (body.aliasProviders !== undefined) {
    entry.alias_providers = Object.fromEntries(
      Object.entries(body.aliasProviders)
        .filter(([alias, ids]) => clean(body.aliases).includes(alias) && Array.isArray(ids))
        .map(([alias, ids]) => [
          alias,
          [...new Set(ids.filter((id) => Number.isInteger(id) && id >= 0))],
        ]),
    );
  }
  if (body.aliasProviderGroupFilters !== undefined) {
    entry.alias_provider_group_filters = Object.fromEntries(
      Object.entries(body.aliasProviderGroupFilters)
        .filter(([alias]) => clean(body.aliases).includes(alias))
        .map(([alias, providers]) => [
          alias,
          Object.fromEntries(
            Object.entries(providers)
              .filter(
                ([id, filter]) =>
                  Number.isInteger(Number(id)) && clean(filter.excludeGroups).length > 0,
              )
              .map(([id, filter]) => [id, { exclude_groups: clean(filter.excludeGroups) }]),
          ),
        ]),
    );
  }
  if (body.containsGroupFilters !== undefined) {
    entry.contains_group_filters = Object.fromEntries(
      Object.entries(body.containsGroupFilters)
        .filter(([line]) => clean(body.contains).includes(line))
        .filter(([, filter]) => clean(filter.excludeGroups).length > 0)
        .map(([line, filter]) => [line, { exclude_groups: clean(filter.excludeGroups) }]),
    );
  }
  if (body.minResolution !== undefined) {
    // Stored as `none` rather than omitted: omitting it is how a channel says
    // "use my group's floor", which is the opposite.
    if (floor === undefined) delete entry.min_resolution;
    else entry.min_resolution = floor ?? 'none';
  }
  if (body.maxResolution !== undefined) {
    if (ceiling === undefined) delete entry.max_resolution;
    else entry.max_resolution = ceiling ?? 'none';
  }

  // A floor above the ceiling leaves nothing usable, and an operator who sets
  // both that way has mistyped one of them. Read off the entry as it now
  // stands, so saving one half is checked against the other.
  const heldFloor = parseMinResolution(entry.min_resolution);
  const heldCeiling = parseMaxResolution(entry.max_resolution);
  if (heldFloor && heldCeiling) {
    const tiers = RESOLUTION_CHOICES as string[];
    if (tiers.indexOf(heldCeiling) < tiers.indexOf(heldFloor)) {
      return NextResponse.json(
        { error: `ceiling ${heldCeiling} is below floor ${heldFloor}` },
        { status: 400 },
      );
    }
  }

  writeRulesDoc(doc);
  return NextResponse.json({ status: 'saved' });
}
