import { NextResponse } from 'next/server';
import { requireCredentials } from '@/lib/config';
import { DispatcharrClient } from '@/lib/dispatcharr';
import {
  assignmentIsRule,
  currentProgrammes,
  describeVerdict,
  Eligibility,
} from '@/lib/eligibility';
import { Mutex } from '@/lib/mutex';
import { resolveOrdering, withResolutionFloor } from '@/lib/ordering';
import { isInterlaced, type ProbeResult, probe } from '@/lib/probe';
import { channelResolutionFloor } from '@/lib/resolution';
import {
  assignedCandidates,
  composeOrder,
  deadRemovalPlan,
  dropDeadStreams,
  protectedFromRemoval,
  splitAssigned,
  statsPayload,
} from '@/lib/runner';
import { laneKey, type ProbeJob, runLanes } from '@/lib/scheduler';
import { frameRate, isHealthy, isUsable, type RankEntry, rank, score } from '@/lib/scoring';
import {
  channelFloors,
  groupPatterns,
  index,
  matcher,
  ordering,
  policies,
  config as serverConfig,
  snapshot,
} from '@/lib/server/state';
import { Store } from '@/lib/store';
import {
  buildVariants,
  drawVariant,
  POOLED_VARIANT,
  pickBestVariant,
  providerLogins,
  type VariantVerdict,
} from '@/lib/variants';

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

    // Group Eligibility Check (Finding 03)
    const groupName =
      channel.groupId !== null
        ? snap.groups.find((g) => g.id === channel.groupId)?.name
        : undefined;
    const elig = new Eligibility(policies(), undefined, groupPatterns());
    const groupPolicy = elig.policyFor(channel.groupId, groupName);
    const audioOnly = groupPolicy.audioOnly;
    const epgRows = (await client.epgWindow().catch(() => [])) as never[];
    const programmes = currentProgrammes(epgRows);
    const verdict = elig.allows(channel.groupId, channel.tvgId, programmes, new Date(), groupName);

    const streamById = new Map(snap.streams.map((s) => [s.id, s]));
    const rule = m.rules.get(id);
    // The worker probes a rule-less channel in an `assigned` or
    // `after_epg_start` group off its own assignment (see
    // `assignedCandidates`), so this has to as well -- the endpoint exists to
    // preview what the worker would do, and refusing here would say "no rule"
    // about a channel the worker is actively ranking.
    const assignmentOnly = !rule && assignmentIsRule(groupPolicy.mode);
    if (!rule && !assignmentOnly) {
      return NextResponse.json({ error: 'channel has no rule yet' }, { status: 400 });
    }

    const hits = rule
      ? m.match(rule, idx)
      : assignedCandidates(channel, streamById, idx.excludedGroups);
    if (hits.length === 0) {
      return NextResponse.json(
        {
          error: rule
            ? 'rule matches no streams'
            : 'channel has no streams assigned to rank; its group policy ranks what the channel already carries, and it carries nothing',
        },
        { status: 400 },
      );
    }

    store = new Store(config.dbPath);

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
        heldBack: describeVerdict(verdict),
        identical:
          workerOrder.length === current.length && workerOrder.every((s, i) => s === current[i]),
        current,
        proposed: [],
        kept: current,
        workerOrder,
        // No rows were ranked, so there is nothing for these to explain -- but
        // they are the floors the ranking would have used, not a second opinion
        // read out of the environment beside it.
        minBitrateKbps: resolveOrdering(ordering(), new Map(), config.PODIUM_MIN_BITRATE_KBPS)
          .weights.minBitrateKbps,
        minResolution:
          channelResolutionFloor(channelFloors(), id, groupPolicy.minResolution) ?? null,
        rows: [],
        unclaimed: [],
        unprobed: [],
      });
    }

    // Worker Busy & Staleness Guard (Finding 04)
    const progress = store.getProgress();
    const isStale = progress.updatedAt
      ? Date.now() - new Date(progress.updatedAt).getTime() > 300_000
      : true;
    const workerBusy = !isStale && progress.phase === 'probing';

    const providerNames = new Map(snap.providers.map((p) => [p.id, p.name]));
    // Same strategy the worker resolves, so the preview matches what it writes --
    // down to this channel's own resolution floor.
    const strategy = withResolutionFloor(
      resolveOrdering(ordering(), providerNames, config.PODIUM_MIN_BITRATE_KBPS),
      channelResolutionFloor(channelFloors(), id, groupPolicy.minResolution),
    );

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

    // Per-login lane limits, from the same reading of the account the worker
    // uses: one lane per active login, each shrunk by the courtesy reserve
    // and -- when the worker is probing -- the one slot this check yields to it.
    const loginsByProvider = new Map(snap.providers.map((p) => [p.id, providerLogins(p)]));
    const limits = new Map<string, number>();
    const shrink = (limit: number) => Math.max(0, limit - reserve - (workerBusy ? 1 : 0));
    for (const [providerId, logins] of loginsByProvider) {
      for (const login of logins) {
        limits.set(laneKey(providerId, login.id), shrink(login.maxStreams));
      }
    }

    const jobs: ProbeJob[] = [];
    const maxCheckStreams = 50;
    const boundedHits = hits.slice(0, maxCheckStreams);
    const truncated = hits.length > boundedHits.length;

    const drawSeq = new Map<number, number>();
    for (const [streamId, stepOrder] of boundedHits) {
      const stream = streamById.get(streamId);
      if (!stream) continue;
      // One login draws each stream, weighted by the free connections each has
      // left -- the same pool the worker uses, so a check of a 40-stream
      // channel on a two-login account runs five wide instead of probing
      // twenty streams twice. A stream whose drawn lane has no room is simply
      // unprobed, feeding `unprobed` below exactly as a capacity-skipped
      // stream always did.
      const logins = loginsByProvider.get(stream.providerId);
      const menu = logins
        ? buildVariants(stream.url, logins)
        : [{ variantId: POOLED_VARIANT, profileId: 0, url: stream.url }];
      const seq = drawSeq.get(stream.providerId) ?? 0;
      drawSeq.set(stream.providerId, seq + 1);
      const variant = drawVariant(menu, stream.providerId, limits, seq);
      if ((limits.get(laneKey(stream.providerId, variant.profileId)) ?? 0) <= 0) continue;
      jobs.push({
        streamId,
        channelId: id,
        url: variant.url,
        providerId: stream.providerId,
        profileId: variant.profileId,
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

    // Per stream, the verdict its drawn login returned -- one apiece under
    // pooling. Kept as a list, and folded through `pickBestVariant` below, so
    // a cache still holding per-login rows from before the pool combines
    // correctly instead of reporting an arbitrary one of them.
    const variantResults = new Map<number, VariantVerdict[]>();
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
          audioOnly,
        });
        // Do not pollute shared cache if channel is held back by group policy
        if (verdict.allowed) {
          const stream = streamById.get(job.streamId);
          if (stream?.streamHash) {
            // Keyed on the stream, not the login that drew it -- see
            // `StreamVariant`, and the worker's matching write.
            store?.put(job.streamId, stream.streamHash, result, POOLED_VARIANT);
          }
        }
        const list = variantResults.get(job.streamId) ?? [];
        list.push({ variantId: POOLED_VARIANT, result });
        variantResults.set(job.streamId, list);
        return result;
      },
      onChannelComplete: async () => {},
    };
    // Hold the only on-demand slot for the whole probe so a second concurrent
    // check waits rather than stacking provider slots on top of this one.
    await onDemand.run(() => runLanes<ProbeResult>(jobs, probeOptions));

    const results = new Map<number, ProbeResult>();
    for (const [streamId, verdicts] of variantResults) {
      const best = pickBestVariant(verdicts, strategy.weights, audioOnly);
      if (!best) continue;
      results.set(streamId, best);
      // Published once per stream from the combined verdict, after the run --
      // per-probe publishing would have each login's stats overwrite the last,
      // and leave an arbitrary login's numbers standing.
      if (config.PODIUM_WRITE_STATS && !config.PODIUM_DRY_RUN) {
        client.setStreamStats(streamId, statsPayload(best, strategy.weights)).catch(() => {});
      }
    }

    const jobMeta = new Map(jobs.map((job) => [job.streamId, job]));
    const entries: RankEntry[] = [...results.entries()]
      .map(([streamId, result]) => {
        const job = jobMeta.get(streamId);
        if (!job) return null;
        return {
          streamId,
          stepOrder: job.stepOrder,
          providerId: job.providerId,
          result,
        } satisfies RankEntry;
      })
      .filter((entry): entry is RankEntry => entry !== null);
    const ranked = rank(entries, strategy, audioOnly);

    // Whether the rule claims a stream is a question about the rule, so it is
    // answered from `hits` -- everything the rule matched -- and not from what
    // this check managed to probe. Those are different sets, and reading the
    // second as the first is how a stream ends up reported as unclaimed for
    // reasons that have nothing to do with the rule: its provider had no spare
    // slot (`limits`, above -- a provider with max_streams 1 has none at all
    // once a viewer is reserved for), or it fell past `maxCheckStreams`.
    const claimed = new Set(hits.map(([streamId]) => streamId));
    const { unclaimed: unclaimedIds, unprobed: unprobedIds } = splitAssigned(
      current,
      claimed,
      new Set(results.keys()),
    );
    // A claimed stream with no verdict takes the drop off the table entirely --
    // the same bargain the worker strikes when it refuses to reorder a channel
    // it has not got a verdict for every stream on.
    const removeUnmatched = config.PODIUM_REMOVE_UNMATCHED && unprobedIds.length === 0;
    let assign: { eligible: Set<number>; max: number } | undefined;
    if (config.PODIUM_AUTO_ASSIGN) {
      const blocked = store.assignBlocks(id);
      assign = {
        eligible: new Set(
          entries
            .filter((entry) => isUsable(entry.result, strategy.weights, audioOnly))
            .filter((entry) => !blocked.has(entry.streamId))
            .map((entry) => entry.streamId),
        ),
        max: config.PODIUM_AUTO_ASSIGN_MAX,
      };
    }
    // Read, never advanced: previewing a channel must not start anybody's
    // grace period. See `Store.unmatchedSince`.
    const graceMs = Math.max(0, config.PODIUM_REMOVE_UNMATCHED_AFTER_MS);
    const heldFromWorker = removeUnmatched
      ? protectedFromRemoval(
          current,
          ranked,
          streamById,
          store.unmatchedSince(id),
          Date.now(),
          graceMs,
        )
      : new Set<number>();
    // The worker's other removal rule, mirrored so this preview says what a
    // pass would actually write. Read-only, like the grace period above:
    // looking at a channel neither advances a streak nor excuses one. The
    // verdicts this check just wrote are already in the cache, so a stream this
    // probe found dead for the Nth time counts here exactly as it will there.
    //
    // The one thing this cannot mirror is *when*: the worker judges an outage
    // from the whole cache as it stood when its pass began, and a check run
    // between passes sees a cache the worker has not read yet. The streaks are
    // exact either way -- they are read here, now, for this channel's streams,
    // which is what the worker does too.
    const deadRemoval =
      config.PODIUM_REMOVE_DEAD_AFTER_CHECKS > 0
        ? deadRemovalPlan(
            config.PODIUM_REMOVE_DEAD_AFTER_CHECKS,
            store.deadStreams(),
            streamById,
            store.probedStreamIds(),
          )
        : undefined;
    const workerComposed = composeOrder(ranked, current, removeUnmatched, assign, heldFromWorker);
    const workerOrder = dropDeadStreams(
      workerComposed,
      streamById,
      deadRemoval,
      deadRemoval ? store.deadStreaks(workerComposed) : new Map(),
    ).order;
    const kept = composeOrder(ranked, current, false, assign);
    // What the panel's drop tick asks for, composed here rather than left to
    // the apply. `proposed` below is the raw ranking -- every stream the rule
    // claims, dead ones included, because the table has to show them to explain
    // why they sank. Sending that as an order would assign the lot, cap and
    // block list and all, so the drop gets its own composition: the same one
    // the worker makes when remove-unmatched is on.
    //
    // The grace period deliberately does not apply here: ticking the box is a
    // person's instruction about this channel, not a pass acting on its own,
    // and making them wait a day for it would be answering a question nobody
    // asked. Streams the catalogue cannot rank are still held back, because
    // "this provider is down right now" is not a reason anyone ticked it.
    const dropOrder = composeOrder(
      ranked,
      current,
      true,
      assign,
      protectedFromRemoval(current, ranked, streamById, new Map(), Date.now(), 0),
    );
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
        // The rate the ranking actually used, not ffprobe's raw reading -- this
        // panel is where somebody goes to find out why a stream sank, so
        // showing it 50 while scoring it 25 answers that question wrongly.
        // `reportedFps` keeps the raw number so a row can say why they differ.
        fps: result ? frameRate(result) : 0,
        reportedFps: result?.fps ?? 0,
        interlaced: result ? isInterlaced(result) : false,
        bitrateKbps: result?.bitrateKbps ?? 0,
        videoCodec: result?.videoCodec ?? '',
        error: result?.error ?? '',
        elapsedMs: result?.elapsedMs ?? 0,
        score: result ? score(result, strategy.weights, audioOnly) : 0,
        usable: result ? isUsable(result, strategy.weights, audioOnly) : false,
        // Separates "below the resolution floor" from "does not play", which
        // the panel explains differently and the ranking treats differently.
        healthy: result ? isHealthy(result, strategy.weights, audioOnly) : false,
        black: result?.black ?? false,
        currentRank: current.indexOf(streamId) >= 0 ? current.indexOf(streamId) + 1 : null,
        proposedRank: proposed.indexOf(streamId) >= 0 ? proposed.indexOf(streamId) + 1 : null,
      };
    };

    const rows = proposed.map(describe);
    // Streams Dispatcharr has on the channel that this rule does not claim.
    const unclaimed = unclaimedIds.map(describe);
    // Claimed, but never probed -- see above. Reported apart from `unclaimed`
    // because the two ask for opposite things: one is a rule that could be
    // tightened, the other is a check that should be run again with capacity.
    const unprobed = unprobedIds.map(describe);

    const identical =
      workerOrder.length === current.length && workerOrder.every((s, i) => s === current[i]);

    return NextResponse.json({
      channelId: id,
      channelName: channel.name,
      probed: results.size,
      dead: [...results.values()].filter((r) => !r.alive).length,
      workerBusy,
      allowed: verdict.allowed,
      heldBack: verdict.allowed ? null : describeVerdict(verdict),
      identical,
      current,
      proposed,
      kept,
      workerOrder,
      dropOrder,
      // Surfaced rather than silent: a capped check has probed only part of what
      // the rule claims, so the ranking below is partial even though the
      // unclaimed list beside it is now complete.
      truncated,
      totalHits: hits.length,
      probeLimit: maxCheckStreams,
      // The floors this channel was actually ranked under, so the panel's reason
      // for a stream sinking quotes the number that sank it. The bitrate floor
      // used to be read from the environment here, which disagreed with the
      // ranking whenever the rules file overrode it.
      minBitrateKbps: strategy.weights.minBitrateKbps,
      minResolution: strategy.weights.minResolution ?? null,
      rows,
      unclaimed,
      unprobed,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}
