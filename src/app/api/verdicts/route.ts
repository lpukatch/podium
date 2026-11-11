import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { Eligibility } from '@/lib/eligibility';
import { responseErrorText } from '@/lib/error-text';
import { type CachedVerdict, lastProbeFields } from '@/lib/last-probe';
import { resolveOrdering } from '@/lib/ordering';
import { config, groupPatterns, ordering, policies, snapshot } from '@/lib/server/state';
import type { CatalogueRow, StoredSoakResult } from '@/lib/store';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Every managed channel's streams, in slot order, each with its cached verdict
 * and latest soak: the fields `/api/preview` gives one channel's streams, read
 * by the same code, for the whole catalogue in one GET. The one that can read
 * differently is `lastLowBitrate`, for a stream on several channels -- see
 * below.
 *
 * Read-only. It probes nothing, and the only Dispatcharr traffic is whatever
 * `snapshot()` already does for `/api/dead`. Channel membership and slot order
 * come from the catalogue the worker persists each pass -- the managed set,
 * which the snapshot alone cannot tell apart from every other channel -- and
 * names and groups come from the snapshot, as the other readers resolve them.
 *
 * `?since=<epoch ms>` keeps only the streams whose verdict or soak landed after
 * that moment, so a poller can fetch just what changed. Channels always come
 * back whole: they are how the streams are reached.
 */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get('since');
  // Digits only: `Number()` alone would take '', '1e3' and ' 5' as well.
  const since = raw === null ? null : /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (since !== null && !Number.isSafeInteger(since)) {
    return NextResponse.json({ error: 'since must be epoch milliseconds' }, { status: 400 });
  }

  try {
    const snap = await snapshot();

    // Cache unavailable is not fatal, as /api/dead reads it. The catalogue is
    // in the same database: when the store will not open there is no managed
    // set to list, and the flag says why the lists are empty rather than
    // letting them claim nothing is managed. A catalogue that was read before
    // a later read failed still answers, with every verdict unknown: a
    // half-read cache is discarded whole rather than mixed with gaps.
    let store: Store | null = null;
    let rows: CatalogueRow[] = [];
    let catalogueWrittenAt: number | null = null;
    let verdicts = new Map<number, CachedVerdict>();
    let soaks = new Map<number, StoredSoakResult>();
    let streaks = new Map<number, number>();
    let cacheUnavailable = false;
    try {
      store = new Store(loadConfig().dbPath);
      ({ rows, writtenAt: catalogueWrittenAt } = store.catalogue());
      const ids = [...new Set(rows.map((row) => row.streamId))];
      verdicts = store.verdicts(ids);
      soaks = store.soakResults(ids);
      streaks = store.deadStreaks(ids);
    } catch {
      cacheUnavailable = true;
      verdicts = new Map();
      soaks = new Map();
      streaks = new Map();
    } finally {
      store?.close();
    }

    const channelById = new Map(snap.channels.map((c) => [c.id, c]));
    const streamById = new Map(snap.streams.map((s) => [s.id, s]));
    const providerNames = new Map(snap.providers.map((p) => [p.id, p.name]));
    const groupNames = new Map(snap.groups.map((g) => [g.id, g.name]));
    // The floor the ranking resolves, exactly as /api/preview reads it, so
    // `lastLowBitrate` cannot quote a threshold of its own.
    const { weights } = resolveOrdering(
      ordering(),
      providerNames,
      config().PODIUM_MIN_BITRATE_KBPS,
    );
    const eligibility = new Eligibility(policies(), undefined, groupPatterns());

    // `catalogue()` is ordered by channel, then slot, so first-seen order is
    // slot order within each channel.
    const channels = new Map<
      number,
      { id: number; name: string; groupId: number | null; streams: number[] }
    >();
    // A stream is listed once however many channels carry it, but the video
    // floor is a per-channel judgement: an audio-only channel does not apply
    // it. A stream reads as low when any channel carrying it would call it
    // low, which is the floor applied unless every carrier is audio-only.
    const audioOnlyEverywhere = new Map<number, boolean>();
    const catalogueProvider = new Map<number, string>();
    for (const row of rows) {
      let channel = channels.get(row.channelId);
      if (!channel) {
        const live = channelById.get(row.channelId);
        channel = {
          id: row.channelId,
          name: live?.name ?? row.channelName,
          groupId: live?.groupId ?? null,
          streams: [],
        };
        channels.set(row.channelId, channel);
      }
      channel.streams.push(row.streamId);
      const groupId = channel.groupId;
      const audioOnly = Boolean(
        eligibility.policyFor(groupId, groupId == null ? undefined : groupNames.get(groupId))
          .audioOnly,
      );
      audioOnlyEverywhere.set(
        row.streamId,
        (audioOnlyEverywhere.get(row.streamId) ?? true) && audioOnly,
      );
      if (!catalogueProvider.has(row.streamId)) {
        catalogueProvider.set(row.streamId, row.providerName);
      }
    }

    const streams = [];
    for (const [id, audioOnly] of audioOnlyEverywhere) {
      const verdict = verdicts.get(id);
      const lastSoak = soaks.get(id) ?? null;
      if (
        since !== null &&
        !((verdict?.probedAt ?? 0) > since || (lastSoak?.completedAt ?? 0) > since)
      ) {
        continue;
      }
      const stream = streamById.get(id);
      streams.push({
        id,
        name: stream?.name ?? null,
        provider: stream
          ? (providerNames.get(stream.providerId) ?? String(stream.providerId))
          : (catalogueProvider.get(id) ?? null),
        providerGroup:
          stream?.groupId == null
            ? null
            : (groupNames.get(stream.groupId) ?? String(stream.groupId)),
        ...lastProbeFields(verdict, weights, audioOnly),
        // `put()` resets the streak on any alive verdict, black included, and
        // `deadStreaks` lists only streams that are dead right now. It folds
        // the current hash alone where `verdicts()` folds every row, so the
        // two can disagree when an older hash's alive row wins the verdict;
        // the streak follows the verdict shown, so alive always reads 0.
        deadStreak: verdict ? (verdict.alive ? 0 : (streaks.get(id) ?? 0)) : null,
        lastSoak,
      });
    }

    const groupIds = new Set(
      [...channels.values()].map((c) => c.groupId).filter((id) => id != null),
    );

    return NextResponse.json({
      fetchedAt: snap.fetchedAt,
      catalogueWrittenAt,
      cacheUnavailable,
      groups: snap.groups
        .filter((g) => groupIds.has(g.id))
        .map((g) => ({ id: g.id, name: g.name })),
      channels: [...channels.values()],
      streams,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Cannot read verdicts', detail: responseErrorText(error) },
      { status: 500 },
    );
  }
}
