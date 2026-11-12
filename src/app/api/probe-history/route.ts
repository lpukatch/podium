import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { Eligibility } from '@/lib/eligibility';
import { responseErrorText } from '@/lib/error-text';
import { audioOnlyByStream, type CachedVerdict, probeFields } from '@/lib/last-probe';
import { resolveOrdering } from '@/lib/ordering';
import { deadDetail } from '@/lib/probe';
import { config, groupPatterns, ordering, policies, snapshot } from '@/lib/server/state';
import type { CatalogueRow } from '@/lib/store';
import { PROBE_HISTORY_MS, PROBE_HISTORY_PER_STREAM, Store } from '@/lib/store';
import { wholeNumber } from '@/lib/whole-number';

export const dynamic = 'force-dynamic';

/** Enough for any channel and then some; past this, ask without `stream`. */
const MAX_STREAMS = 500;
const DEFAULT_LIMIT = 20;

const refuse = (error: string) => NextResponse.json({ error }, { status: 400 });

/**
 * Each stream's recent verdicts, newest first, from `probe_history`: the
 * timeline `/api/verdicts` cannot give, since the probe cache keeps only the
 * latest. An entry describes its probe with the fields `/api/verdicts` uses
 * for the latest one, read by the same code (`probeFields`), plus the probe's
 * `error` -- as `deadDetail` publishes it, without the stream URL or any
 * credential it carried. `probe_history` keeps the raw text for debugging;
 * provider URLs routinely embed the account login, and this is an API.
 *
 * Read-only. It probes nothing, and the only Dispatcharr traffic is whatever
 * `snapshot()` already does, which is needed for one thing: the channel groups
 * that decide whether a stream is judged against the video floor, so that
 * `lowBitrate` agrees with `lastLowBitrate`.
 *
 * `?stream=<id>` (repeatable) picks streams; without it, every stream with
 * history in range comes back. `?since=<epoch ms>` keeps only probes after
 * that moment, so a poller can fetch roughly what is new -- see `fetchedAt`
 * below. `?limit=<n>` caps the probes per stream.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const requested = new Set<number>();
  for (const raw of params.getAll('stream')) {
    const id = wholeNumber(raw);
    if (id === null) return refuse('stream must be a stream id; repeat it for several');
    requested.add(id);
  }
  if (requested.size > MAX_STREAMS) {
    return refuse(`at most ${MAX_STREAMS} streams per request`);
  }

  const rawSince = params.get('since');
  const since = rawSince === null ? null : wholeNumber(rawSince);
  if (rawSince !== null && since === null) {
    return refuse('since must be epoch milliseconds');
  }

  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? DEFAULT_LIMIT : wholeNumber(rawLimit);
  if (limit === null || limit < 1 || limit > PROBE_HISTORY_PER_STREAM) {
    return refuse(`limit must be a whole number from 1 to ${PROBE_HISTORY_PER_STREAM}`);
  }

  try {
    const snap = await snapshot();

    // Taken before the read. `put()` stamps a verdict before it commits, so a
    // probe stamped in this same millisecond, or committed a moment late, can
    // still land after this read with a `probedAt` no later than this -- the
    // docs tell a poller to overlap a little and dedupe rather than promise
    // `since=fetchedAt` is exact.
    const fetchedAt = Date.now();
    // Cache unavailable is not fatal, as /api/verdicts reads it: the flag says
    // why the list is empty rather than letting it claim there is no history.
    let store: Store | null = null;
    let rows: CatalogueRow[] = [];
    let history = new Map<number, CachedVerdict[]>();
    let cacheUnavailable = false;
    try {
      store = new Store(loadConfig().dbPath);
      ({ rows } = store.catalogue());
      history = store.probeHistory({
        streamIds: requested.size > 0 ? [...requested] : undefined,
        since,
        limit,
      });
    } catch {
      cacheUnavailable = true;
    } finally {
      store?.close();
    }

    // The floor and the audio-only exemption exactly as /api/verdicts reads
    // them, so the same probe reads the same on both. Both are today's: an
    // old entry is judged against the floor in force now.
    const providerNames = new Map(snap.providers.map((p) => [p.id, p.name]));
    const { weights } = resolveOrdering(
      ordering(),
      providerNames,
      config().PODIUM_MIN_BITRATE_KBPS,
    );
    const audioOnly = audioOnlyByStream(
      rows,
      snap,
      new Eligibility(policies(), undefined, groupPatterns()),
    );

    const streams = [...history]
      .sort(([a], [b]) => a - b)
      .map(([id, probes]) => ({
        id,
        probes: probes.map((probe) => ({
          probedAt: probe.probedAt,
          alive: probe.alive,
          ...probeFields(probe.result, weights, audioOnly.get(id) ?? false),
          error: deadDetail(probe.result.error) || null,
        })),
      }));

    return NextResponse.json({
      fetchedAt,
      cacheUnavailable,
      retention: { maxAgeMs: PROBE_HISTORY_MS, perStream: PROBE_HISTORY_PER_STREAM },
      streams,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Cannot read probe history', detail: responseErrorText(error) },
      { status: 500 },
    );
  }
}
