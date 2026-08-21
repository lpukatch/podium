import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import type { ChannelRule } from '@/lib/matcher';
import { normalize } from '@/lib/normalize';
import type { ProbeResult } from '@/lib/probe';
import { parseProviders } from '@/lib/rules';
import { index, matcher, snapshot } from '@/lib/server/state';
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
          ? parseProviders(body.providers)
          : (existing?.providers ?? null),
      stepOrder: existing?.stepOrder ?? 0,
      excludeRegions: existing?.excludeRegions ?? null,
    };

    const hits = m.match(rule, idx);
    const matchedIds = new Set(hits.map(([id]) => id));
    const channel = snap.channels.find((c) => c.id === body.channelId);
    const assigned = new Set(channel?.streams ?? []);
    // Dispatcharr's array is ordered; position is what a viewer actually gets.
    const currentOrder = new Map((channel?.streams ?? []).map((id, i) => [id, i + 1]));

    // Last probe result per stream, so the editor can show what is known
    // without having to probe again.
    let verdicts = new Map<number, { probedAt: number; alive: boolean; result: ProbeResult }>();
    let store: Store | null = null;
    try {
      store = new Store(loadConfig().dbPath);
      verdicts = store.verdicts([...new Set([...matchedIds, ...assigned])]);
    } catch {
      // Cache unavailable is not fatal; the editor just shows nothing known.
    } finally {
      store?.close();
    }
    const streamById = new Map(snap.streams.map((s) => [s.id, s]));
    const providerNames = new Map(snap.providers.map((p) => [p.id, p.name]));

    const describe = (id: number, step: number | null) => {
      const stream = streamById.get(id);
      if (!stream) return null;
      const norm = normalize(stream.name);
      return {
        id,
        raw: stream.name,
        normalized: norm.name,
        prefixes: norm.prefixes,
        quality: norm.quality,
        provider: providerNames.get(stream.providerId) ?? String(stream.providerId),
        step,
        assigned: assigned.has(id),
        matched: matchedIds.has(id),
        currentRank: currentOrder.get(id) ?? null,
        lastProbedAt: verdicts.get(id)?.probedAt ?? null,
        lastAlive: verdicts.get(id)?.alive ?? null,
        lastHeight: verdicts.get(id)?.result.height ?? null,
        lastBitrateKbps: verdicts.get(id)?.result.bitrateKbps ?? null,
        lastBlack: verdicts.get(id)?.result.black ?? null,
      };
    };

    const matched = hits
      .map(([id, step]) => describe(id, step))
      .filter(Boolean)
      .slice(0, 300);
    // Assigned in Dispatcharr but not claimed by this rule -- either the rule
    // regressed, or somebody assigned it by hand.
    const orphaned = [...assigned]
      .filter((id) => !matchedIds.has(id))
      .map((id) => describe(id, null))
      .filter(Boolean);

    return NextResponse.json({
      total: hits.length,
      matched,
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
