import { NextResponse } from 'next/server';
import { requireCredentials } from '@/lib/config';
import { DispatcharrClient } from '@/lib/dispatcharr';
import { currentProgrammes, Eligibility } from '@/lib/eligibility';
import { Mutex } from '@/lib/mutex';
import { resolveOrdering } from '@/lib/ordering';
import { type ProbeResult, probe } from '@/lib/probe';
import { composeOrder, statsPayload } from '@/lib/runner';
import { type ProbeJob, runLanes } from '@/lib/scheduler';
import { isUsable, type RankEntry, rank, score } from '@/lib/scoring';
import {
  groupPatterns,
  index,
  matcher,
  ordering,
  policies,
  config as serverConfig,
  snapshot,
} from '@/lib/server/state';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// One on-demand probe at a time: two concurrent checks would each take a
// provider's spare slots and between them overshoot its max_streams, stealing a
// slot from a viewer. The instance is module-level, so it persists across
// requests in the single server process -- the same assumption the worker lock
// makes.
const onDemand = new Mutex();

/**
 * Probe one channel's streams right now and report the ordering it implies.
 *
 * This is the A/B tool: it never writes. It returns the order Dispatcharr
 * currently has alongside the order these probe results imply, so the two can
 * be compared directly against whatever put the current order there.
 *
 * Concurrency is deliberately conservative. The background worker may be
 * probing the same providers, and the two processes cannot see each other's
 * in-flight slots -- so when the worker is active this takes one slot per
 * provider rather than the provider's full limit. Overshooting would take
 * connections away from an actual viewer.
 *
 * A module-level mutex also serialises concurrent checks, so two on-demand
 * probes never stack their slots on top of each other.
 */
export async function POST(request: Request, context: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await context.params;
  const id = Number(channelId);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: 'bad channel id' }, { status: 400 });
  }

  let store: Store | null = null;
  try {
    const url = new URL(request.url);
    let force = url.searchParams.get('force') === 'true';
    if (!force && request.headers.get('content-type')?.includes('application/json')) {
      try {
        const body = (await request.clone().json()) as { force?: boolean };
        if (body?.force) force = true;
      } catch {
        // Ignored if JSON parsing fails
      }
    }

    const config = serverConfig();
    // Every settable knob here -- dry run, write stats, analyze seconds -- can
    // come from the settings table, so this must not read the environment alone.
    requireCredentials(config);
    const snap = await snapshot();
    const m = matcher();
    const idx = await index();

    // `current` must be live, not the 5-minute snapshot: this endpoint exists to
    // compare what Dispatcharr has now against what these probes imply, and a
    // reorder in the last five minutes would otherwise make the diff and the
    // `identical` flag quietly wrong. One client serves the live read and the
    // best-effort stats publish below.
    const client = new DispatcharrClient(config.DISPATCHARR_URL, {
      apiKey: config.DISPATCHARR_API_KEY,
      username: config.DISPATCHARR_USERNAME,
      password: config.DISPATCHARR_PASSWORD,
    });
    await client.login();
    const channel = await client.channel(id);
    if (!channel) return NextResponse.json({ error: 'unknown channel' }, { status: 404 });

    const rule = m.rules.get(id);
    if (!rule) {
      return NextResponse.json({ error: 'channel has no rule yet' }, { status: 400 });
    }

    const hits = m.match(rule, idx);
    if (hits.length === 0) {
      return NextResponse.json({ error: 'rule matches no streams' }, { status: 400 });
    }

    store = new Store(config.dbPath);

    // Group Eligibility Check (Finding 03)
    const groupName =
      channel.groupId !== null
        ? snap.groups.find((g) => g.id === channel.groupId)?.name
        : undefined;
    const elig = new Eligibility(policies(), undefined, groupPatterns());
    const epgRows = (await client.epgNow().catch(() => [])) as never[];
    const programmes = currentProgrammes(epgRows);
    const verdict = elig.allows(channel.groupId, channel.tvgId, programmes, new Date(), groupName);

    const current = channel.streams ?? [];

    if (!verdict.allowed && !force) {
      const removeUnmatched = config.PODIUM_REMOVE_UNMATCHED;
      const workerOrder = composeOrder([], current, removeUnmatched);
      return NextResponse.json({
        channelId: id,
        channelName: channel.name,
        probed: 0,
        dead: 0,
        workerBusy: false,
        allowed: false,
        heldBack: verdict.reason,
        identical:
          workerOrder.length === current.length && workerOrder.every((s, i) => s === current[i]),
        current,
        proposed: [],
        kept: current,
        workerOrder,
        minBitrateKbps: config.PODIUM_MIN_BITRATE_KBPS,
        rows: [],
        unclaimed: [],
      });
    }

    // Worker Busy & Staleness Guard (Finding 04)
    const progress = store.getProgress();
    const isStale = progress.updatedAt
      ? Date.now() - new Date(progress.updatedAt).getTime() > 300_000
      : true;
    const workerBusy = !isStale && progress.phase === 'probing';

    const providerNames = new Map(snap.providers.map((p) => [p.id, p.name]));
    // Same strategy the worker resolves, so the preview matches what it writes.
    const strategy = resolveOrdering(ordering(), providerNames, config.PODIUM_MIN_BITRATE_KBPS);
    const baseLimits = new Map(snap.providers.map((p) => [p.id, p.maxStreams]));

    // The courtesy reserve, on the same rule the worker uses (Pacer.laneLimits):
    // hold a slot back for a human only when a human is actually watching, since
    // reserving while idle permanently starves any provider whose max_streams is
    // 1. Taking the full limit unconditionally -- which is what "worker busy or
    // not" alone amounts to -- means an on-demand check can take the last slot
    // out from under a viewer, which is the thing this endpoint is careful about
    // everywhere else.
    const uuidMap = new Map<string, number>(
      snap.channels.filter((c) => c.uuid).map((c) => [c.uuid as string, c.id]),
    );
    const watching = await client
      .activeChannelIds(uuidMap)
      .then((ids) => ids.length > 0)
      // Fail closed, as the worker does: unknown means assume somebody is there.
      .catch(() => true);
    const reserve = watching ? config.PODIUM_MIN_FREE_SLOTS : 0;

    const limits = new Map<number, number>();
    for (const [pid, limit] of baseLimits) {
      limits.set(pid, Math.max(0, limit - reserve - (workerBusy ? 1 : 0)));
    }

    const streamById = new Map(snap.streams.map((s) => [s.id, s]));
    const jobs: ProbeJob[] = [];
    const maxCheckStreams = 50;
    const boundedHits = hits.slice(0, maxCheckStreams);
    const truncated = hits.length > boundedHits.length;

    for (const [streamId, stepOrder] of boundedHits) {
      const stream = streamById.get(streamId);
      if (!stream) continue;
      if ((limits.get(stream.providerId) ?? 0) <= 0) continue;
      jobs.push({
        streamId,
        channelId: id,
        url: stream.url,
        providerId: stream.providerId,
        stepOrder,
      });
    }

    if (jobs.length === 0 && boundedHits.length > 0) {
      return NextResponse.json(
        {
          error: watching
            ? 'Someone is watching and no provider has a spare slot; try again once the stream ends'
            : 'No spare provider capacity to probe these streams while the worker is probing',
        },
        { status: 503 },
      );
    }

    const results = new Map<number, ProbeResult>();
    const probeOptions = {
      limits,
      probe: async (job: ProbeJob) => {
        const result = await probe(job.url, {
          timeoutMs: config.PODIUM_PROBE_TIMEOUT_MS,
          analyzeSeconds: config.PODIUM_ANALYZE_SECONDS,
          userAgent: config.PODIUM_USER_AGENT,
          measureBitrate: config.PODIUM_MEASURE_BITRATE,
          measureSeconds: config.PODIUM_MEASURE_SECONDS,
          detectBlack: config.PODIUM_DETECT_BLACK,
          blackRatio: config.PODIUM_BLACK_RATIO,
        });
        results.set(job.streamId, result);
        // Do not pollute shared cache if channel is held back by group policy
        if (verdict.allowed) {
          const stream = streamById.get(job.streamId);
          if (stream?.streamHash) store?.put(job.streamId, stream.streamHash, result);
        }
        // Publish to Dispatcharr for the same reason -- best-effort, since
        // failing to publish must not fail the check.
        if (config.PODIUM_WRITE_STATS && !config.PODIUM_DRY_RUN) {
          client
            .setStreamStats(job.streamId, statsPayload(result, strategy.weights))
            .catch(() => {});
        }
        return result;
      },
      onChannelComplete: async () => {},
    };
    // Hold the only on-demand slot for the whole probe so a second concurrent
    // check waits rather than stacking provider slots on top of this one.
    await onDemand.run(() => runLanes<ProbeResult>(jobs, probeOptions));

    const entries: RankEntry[] = jobs
      .filter((j) => results.has(j.streamId))
      .map((j) => ({
        streamId: j.streamId,
        stepOrder: j.stepOrder,
        providerId: j.providerId,
        result: results.get(j.streamId) as ProbeResult,
      }));
    const ranked = rank(entries, strategy);
    // A truncated check has only seen part of what the rule claims, so it cannot
    // safely say which assigned streams are unmatched -- dropping them would
    // unassign streams purely because they fell past the cap. Keep them.
    const removeUnmatched = config.PODIUM_REMOVE_UNMATCHED && !truncated;
    const workerOrder = composeOrder(ranked, current, removeUnmatched);
    const kept = composeOrder(ranked, current, false);
    const proposed = ranked;

    const describe = (streamId: number) => {
      const stream = streamById.get(streamId);
      const result = results.get(streamId);
      return {
        id: streamId,
        name: stream?.name ?? String(streamId),
        provider: providerNames.get(stream?.providerId ?? -1) ?? '?',
        alive: result?.alive ?? null,
        width: result?.width ?? 0,
        height: result?.height ?? 0,
        fps: result?.fps ?? 0,
        bitrateKbps: result?.bitrateKbps ?? 0,
        videoCodec: result?.videoCodec ?? '',
        error: result?.error ?? '',
        elapsedMs: result?.elapsedMs ?? 0,
        score: result ? score(result, strategy.weights) : 0,
        usable: result ? isUsable(result, strategy.weights) : false,
        black: result?.black ?? false,
        currentRank: current.indexOf(streamId) >= 0 ? current.indexOf(streamId) + 1 : null,
        proposedRank: proposed.indexOf(streamId) >= 0 ? proposed.indexOf(streamId) + 1 : null,
      };
    };

    const rows = proposed.map(describe);
    // Streams Dispatcharr has on the channel that this rule does not claim.
    const unclaimed = current.filter((s) => !proposed.includes(s)).map(describe);

    const identical =
      workerOrder.length === current.length && workerOrder.every((s, i) => s === current[i]);

    return NextResponse.json({
      channelId: id,
      channelName: channel.name,
      probed: results.size,
      dead: [...results.values()].filter((r) => !r.alive).length,
      workerBusy,
      allowed: verdict.allowed,
      heldBack: verdict.allowed ? null : verdict.reason,
      identical,
      current,
      proposed,
      kept,
      workerOrder,
      // Surfaced rather than silent: a capped check has not seen the whole rule,
      // so "unclaimed" is only unclaimed among what it looked at.
      truncated,
      totalHits: hits.length,
      probeLimit: maxCheckStreams,
      minBitrateKbps: config.PODIUM_MIN_BITRATE_KBPS,
      rows,
      unclaimed,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}
