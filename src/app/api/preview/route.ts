import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { Eligibility } from '@/lib/eligibility';
import type { ChannelRule } from '@/lib/matcher';
import type { ProbeResult } from '@/lib/probe';
import { groupFilter } from '@/lib/provider-groups';
import { parseProviders } from '@/lib/rules';
import { groupPatterns, index, matcher, policies, snapshot } from '@/lib/server/state';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Match a candidate rule against the live stream set, and show what Dispatcharr
 * currently has assigned alongside it.
 *
 * The diff is the point: "what would this rule claim" on its own is only half
 * the question, and the useful half is usually "what am I missing".
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      channelId: number;
      aliases?: string[];
      contains?: string[];
      exclude?: string[];
      providers?: unknown;
      groupFilter?: unknown;
      aliasGroupFilters?: Record<string, unknown>;
      aliasProviders?: Record<string, number[]>;
      aliasProviderGroupFilters?: Record<string, Record<string, unknown>>;
      containsGroupFilters?: Record<string, unknown>;
    };

    const snap = await snapshot();
    const m = matcher();
    const idx = await index();

    const existing = m.rules.get(body.channelId);
    const rule: ChannelRule = {
      channelId: body.channelId,
      name: existing?.name ?? '',
      aliases: body.aliases ?? [],
      contains: body.contains ?? [],
      exclude: body.exclude ?? [],
      patterns: existing?.patterns ?? [],
      providers:
        body.providers !== undefined
          ? Array.isArray(body.providers)
            ? new Set(body.providers.map(Number).filter(Number.isFinite))
            : parseProviders(body.providers)
          : (existing?.providers ?? null),
      stepOrder: existing?.stepOrder ?? 0,
      excludeRegions: existing?.excludeRegions ?? null,
      groupFilter:
        body.groupFilter === undefined
          ? existing?.groupFilter
          : body.groupFilter === null
            ? undefined
            : groupFilter(body.groupFilter),
      aliasGroupFilters:
        body.aliasGroupFilters === undefined
          ? existing?.aliasGroupFilters
          : Object.fromEntries(
              Object.entries(body.aliasGroupFilters).map(([k, v]) => [k, groupFilter(v)]),
            ),
      aliasProviders:
        body.aliasProviders === undefined
          ? existing?.aliasProviders
          : Object.fromEntries(
              Object.entries(body.aliasProviders).map(([alias, ids]) => [alias, new Set(ids)]),
            ),
      aliasProviderGroupFilters:
        body.aliasProviderGroupFilters === undefined
          ? existing?.aliasProviderGroupFilters
          : Object.fromEntries(
              Object.entries(body.aliasProviderGroupFilters).map(([alias, providers]) => [
                alias,
                Object.fromEntries(
                  Object.entries(providers).map(([id, filter]) => [id, groupFilter(filter)]),
                ),
              ]),
            ),
      containsGroupFilters:
        body.containsGroupFilters === undefined
          ? existing?.containsGroupFilters
          : Object.fromEntries(
              Object.entries(body.containsGroupFilters).map(([k, v]) => [k, groupFilter(v)]),
            ),
    };

    const channel = snap.channels.find((c) => c.id === body.channelId);
    const channelGroupName = snap.groups.find((g) => g.id === channel?.groupId)?.name;
    const inherited = new Eligibility(policies(), undefined, groupPatterns()).policyFor(
      channel?.groupId,
      channelGroupName,
    ).groupFilter;
    const hits = m.match(rule, idx, inherited);
    const matchedIds = new Set(hits.map(([id]) => id));
    const assigned = new Set(channel?.streams ?? []);
    // Dispatcharr's array is ordered; position is what a viewer actually gets.
    const currentOrder = new Map((channel?.streams ?? []).map((id, i) => [id, i + 1]));

    // Last probe result per stream, so the editor can show what is known
    // without having to probe again.
    let verdicts = new Map<number, { probedAt: number; alive: boolean; result: ProbeResult }>();
    let soakResults = new Map<
      number,
      {
        completedAt: number;
        heldMs: number;
        drops: number;
        failedDials: number;
        unreachable: boolean;
      }
    >();
    let store: Store | null = null;
    try {
      store = new Store(loadConfig().dbPath);
      const streamIds = [...new Set([...matchedIds, ...assigned])];
      verdicts = store.verdicts(streamIds);
      soakResults = store.soakResults(streamIds);
    } catch {
      // Cache unavailable is not fatal; the editor just shows nothing known.
    } finally {
      store?.close();
    }
    const streamById = new Map(snap.streams.map((s) => [s.id, s]));
    const providerNames = new Map(snap.providers.map((p) => [p.id, p.name]));
    const groupNames = new Map(snap.groups.map((g) => [g.id, g.name]));

    const describe = (id: number, step: number | null) => {
      const stream = streamById.get(id);
      if (!stream) return null;
      const norm = m.normalize(stream.name);
      return {
        id,
        raw: stream.name,
        normalized: norm.name,
        prefixes: norm.prefixes,
        quality: norm.quality,
        provider: providerNames.get(stream.providerId) ?? String(stream.providerId),
        providerGroup:
          stream.groupId == null
            ? null
            : (groupNames.get(stream.groupId) ?? String(stream.groupId)),
        step,
        assigned: assigned.has(id),
        matched: matchedIds.has(id),
        currentRank: currentOrder.get(id) ?? null,
        lastProbedAt: verdicts.get(id)?.probedAt ?? null,
        lastAlive: verdicts.get(id)?.alive ?? null,
        lastHeight: verdicts.get(id)?.result.height ?? null,
        lastBitrateKbps: verdicts.get(id)?.result.bitrateKbps ?? null,
        lastBlack: verdicts.get(id)?.result.black ?? null,
        lastSoak: soakResults.get(id) ?? null,
      };
    };

    const matched = hits
      .map(([id, step]) => describe(id, step))
      .filter(Boolean)
      .slice(0, 300);
    // Suggestions are scoped to what each alias actually reaches, before its
    // own provider/group restrictions. Never offer the whole provider catalogue.
    const unscopedRule: ChannelRule = {
      ...rule,
      providers: null,
      groupFilter: {},
      aliasGroupFilters: {},
      containsGroupFilters: {},
      aliasProviders: {},
      aliasProviderGroupFilters: {},
      exclude: [],
    };
    const groupCounts = new Map<string, number>();
    for (const [streamId] of m.match(unscopedRule, { ...idx, excludedGroups: new Set<number>() })) {
      const stream = streamById.get(streamId);
      if (!stream) continue;
      const name =
        stream.groupId == null
          ? '(ungrouped)'
          : (groupNames.get(stream.groupId) ?? String(stream.groupId));
      groupCounts.set(name, (groupCounts.get(name) ?? 0) + 1);
    }
    const aliasSources = Object.fromEntries(
      rule.aliases.map((alias) => {
        const unscoped: ChannelRule = {
          ...rule,
          aliases: [alias],
          contains: [],
          patterns: [],
          providers: null,
          groupFilter: {},
          aliasGroupFilters: {},
          aliasProviders: {},
          aliasProviderGroupFilters: {},
          exclude: [],
        };
        const providers = new Map<
          number,
          { id: number; name: string; groups: Map<string, number> }
        >();
        for (const [streamId] of m.match(unscoped, { ...idx, excludedGroups: new Set<number>() })) {
          const stream = streamById.get(streamId);
          if (!stream) continue;
          const row = providers.get(stream.providerId) ?? {
            id: stream.providerId,
            name: providerNames.get(stream.providerId) ?? String(stream.providerId),
            groups: new Map<string, number>(),
          };
          const group =
            stream.groupId == null
              ? '(ungrouped)'
              : (groupNames.get(stream.groupId) ?? String(stream.groupId));
          row.groups.set(group, (row.groups.get(group) ?? 0) + 1);
          providers.set(stream.providerId, row);
        }
        return [
          alias,
          [...providers.values()].map((provider) => ({
            id: provider.id,
            name: provider.name,
            groups: [...provider.groups].map(([name, count]) => ({ name, count })),
          })),
        ];
      }),
    );
    // Assigned in Dispatcharr but not claimed by this rule -- either the rule
    // regressed, or somebody assigned it by hand.
    const orphaned = [...assigned]
      .filter((id) => !matchedIds.has(id))
      .map((id) => describe(id, null))
      .filter(Boolean);

    return NextResponse.json({
      total: hits.length,
      matched,
      aliasSources,
      groupCounts: Object.fromEntries(groupCounts),
      orphaned,
      assignedCount: assigned.size,
      newlyMatched: hits.filter(([id]) => !assigned.has(id)).length,
      // The order Dispatcharr serves today, so a change can be judged against
      // what viewers currently get rather than against nothing.
      currentOrder: (channel?.streams ?? []).map((id) => describe(id, null)).filter(Boolean),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  }
}
