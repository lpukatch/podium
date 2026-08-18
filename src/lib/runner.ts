/**
 * One pass: fetch, match, decide what is eligible, probe across provider lanes,
 * reorder.
 *
 * The pass is *paced*, not batched. It asks who is watching, shrinks the lanes
 * to whatever provider capacity is genuinely spare, and takes a slice of the
 * staleest work sized to keep every channel inside the freshness target. If
 * someone starts watching mid-pass, the abort flag stops dispatch and the
 * in-flight probes drain.
 */

import type { Config } from './config';
import { type Channel, DispatcharrClient, type Provider, type Stream } from './dispatcharr';
import {
  assignmentIsRule,
  currentProgrammes,
  type Eligibility,
  NEVER,
  nextProgrammeStarts,
  type Programme,
  type UpcomingStarts,
} from './eligibility';
import { EpgCache } from './epg-cache';
import type { Matcher, StreamIndex } from './matcher';
import { resolveOrdering } from './ordering';
import { Pacer, type PacerConfig, viewersByProvider } from './pacer';
import { type ProbeResult, probe } from './probe';
import type { RulesSource } from './rules-source';
import { AbortFlag, type ProbeJob, runLanes } from './scheduler';
import {
  DEFAULT_WEIGHTS,
  type RankEntry,
  type RankStrategy,
  rank,
  score,
  type Weights,
} from './scoring';
import { forcedAtFor, type Progress, type Store, ttlFor } from './store';

/**
 * The shape published to Dispatcharr's `stream_stats`.
 *
 * Key names follow what Dispatcharr's channel table renders: `resolution`,
 * `video_codec`, `audio_codec`, `source_fps` and `video_bitrate`. The bitrate is
 * `video_bitrate` (kbps) and not `bitrate_kbps` -- the frontend reads the former
 * and shows an empty badge for the latter. The remaining keys are podium-only
 * extras the UI ignores but that round-trip harmlessly.
 */
export function statsPayload(
  result: ProbeResult,
  weights: Weights = DEFAULT_WEIGHTS,
): Record<string, unknown> {
  return {
    width: result.width,
    height: result.height,
    resolution: result.width && result.height ? `${result.width}x${result.height}` : '0x0',
    source_fps: result.fps,
    video_codec: result.videoCodec,
    audio_codec: result.audioCodec,
    pixel_format: result.pixelFormat,
    audio_channels: result.audioChannels,
    video_bitrate: Math.round(result.bitrateKbps),
    bitrate_measured: Boolean(result.bitrateMeasured),
    blank_detected: Boolean(result.black),
    blank_seconds: result.blackSeconds ?? 0,
    quality_score: score(result, weights),
    alive: result.alive,
    quality_reason: !result.alive ? result.error || 'dead' : result.black ? 'black screen' : 'ok',
    probed_by: 'podium',
    probed_at: new Date().toISOString(),
  };
}

/** Whether a computed ordering is the one Dispatcharr already holds. */
export function sameOrder(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * The stream ids to write back to a channel, from a ranked list and the streams
 * it currently carries.
 *
 * Podium reorders the streams already on a channel; it never assigns streams the
 * rule matched but the channel does not carry. A match across the whole provider
 * catalogue is a ranking candidate, not an assignment -- writing it would
 * silently change the lineup and let one stream land on every channel whose rule
 * claims it. So `ranked` is intersected with `assigned`: only streams already on
 * the channel move.
 *
 * Streams on the channel the rule did not match are strays. Unless
 * `removeUnmatched` is set they are kept, after the ranked ones, so a reorder
 * never silently unassigns anything either.
 */
export function composeOrder(
  ranked: number[],
  assigned: number[] = [],
  removeUnmatched = false,
): number[] {
  const onChannel = new Set(assigned);
  const matched = ranked.filter((id) => onChannel.has(id));
  if (removeUnmatched) return matched;
  const matchedSet = new Set(matched);
  return [...matched, ...assigned.filter((id) => !matchedSet.has(id))];
}

/**
 * The order to write back when one stream is being taken off a channel.
 *
 * `live` has to be what Dispatcharr holds right now, not the list the caller is
 * looking at. The channel editor draws from a snapshot up to five minutes old,
 * so posting its copy back minus one id would also undo any reordering the
 * worker did in between and resurrect anything something else had already
 * unassigned. Filtering one id out of the live array changes exactly one thing,
 * and asking twice is the same as asking once.
 */
export function withoutStream(live: number[], streamId: number): number[] {
  return live.filter((id) => id !== streamId);
}

/** Streams on a channel, split by why they are missing from a ranked order. */
export interface AssignedSplit {
  /** Claimed by nothing. The only streams a drop may take. */
  unclaimed: number[];
  /** Claimed, but with no probe verdict this pass. */
  unprobed: number[];
}

/**
 * Why each assigned stream is absent from a ranking -- rule, or capacity.
 *
 * Two different answers that a ranked list alone cannot tell apart, because a
 * stream is missing from it either way. The on-demand check conflated them: it
 * read "not in the proposed order" as "the rule does not claim this", and
 * offered to unassign the result. On a provider whose `max_streams` is 1, every
 * stream is skipped for want of a slot the moment a viewer is reserved for, so
 * the offer was to delete streams the rule claims perfectly well -- with the
 * channel's own rule named as the justification.
 *
 * `unprobed` is therefore not a softer `unclaimed`; it is the signal that a drop
 * must not be offered at all, the same conclusion the worker reaches when it
 * refuses to reorder a channel it lacks a verdict for.
 */
export function splitAssigned(
  assigned: number[],
  claimed: Set<number>,
  probed: Set<number>,
): AssignedSplit {
  return {
    unclaimed: assigned.filter((id) => !claimed.has(id)),
    unprobed: assigned.filter((id) => claimed.has(id) && !probed.has(id)),
  };
}

/**
 * Candidates for a channel the rules file says nothing about.
 *
 * Another app creates channels as fixtures appear -- a whole `Auto | SPORT`
 * group that exists for one evening -- and assigns their streams itself. Nothing
 * in the rules file names them, so `matcher.rules` has no entry and the normal
 * path skips them before eligibility is ever consulted. For an
 * `after_epg_start` group that is backwards: the operator has already said
 * "probe this group once its programme starts", and a channel that carries its
 * own lineup needs no alias to say which streams that means. The assignment *is*
 * the rule. `assigned` is the same bargain without the kickoff clause, for
 * someone whose lineups are already curated and who wants only the ranking.
 *
 * Both are modes an operator set on a named group -- see `assignmentIsRule`.
 * Under `always`, the default every unconfigured group falls back to, this
 * would sweep every rule-less channel in the install into the backlog.
 *
 * Nothing is ever assigned from here -- `composeOrder` still intersects with
 * what the channel carries -- so this only ever reorders and probes streams
 * Dispatcharr already put on the channel.
 */
export function assignedCandidates(
  channel: Channel,
  byId: Map<number, Stream>,
  excludedGroups: Set<number>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const seen = new Set<number>();
  for (const streamId of channel.streams) {
    if (seen.has(streamId)) continue;
    const stream = byId.get(streamId);
    if (!stream) continue;
    // The one guard that still applies. An excluded provider group is the
    // operator saying those streams are not candidates for anything; the name
    // guards (region, timeshift, radio) exist to stop a rule *claiming* a
    // stream it was never meant to, and nothing is being claimed here.
    if (stream.groupId != null && excludedGroups.has(stream.groupId)) continue;
    seen.add(streamId);
    // Step order 0 for all of them, not the position in the channel's array.
    // Step order is a hard tier above quality in alias mode, so ranking by
    // assignment position would pin the existing order and leave the best
    // stream wherever the other app happened to put it -- which is the entire
    // thing being asked for here.
    out.push([streamId, 0]);
  }
  return out;
}

/**
 * What a pass worked out about one channel, computed once.
 *
 * Matching a rule against ~22,000 streams and reading a verdict per candidate
 * is the expensive half of planning, and it used to happen three times a pass:
 * once in `plan`, again in the cache-only reorder walk, and again per channel
 * as its probes came back. All three asked the same questions of the same
 * snapshot and could only ever get the same answers -- with one exception,
 * which was a bug rather than a feature: the cache-only walk read verdicts
 * without `PODIUM_UNKNOWN_BITRATE_TTL_MS`, so a stream the planner had already
 * booked for a re-probe still counted as a hit there, and the channel was
 * written twice in one pass on two different readings of the same row.
 */
export interface PlannedChannel {
  channel: Channel;
  /**
   * Matched streams the channel could actually be ranked on, in match order:
   * anything the catalogue no longer carries, or that the provider has marked
   * stale and is about to delete, is dropped here rather than at each use.
   */
  hits: Array<[number, number]>;
  /** Fresh verdicts, by stream id. A hit missing from here needs a probe. */
  cached: Map<number, RankEntry>;
  /** Every hit already has a verdict, so this channel needs no probing. */
  cacheComplete: boolean;
}

export interface OpenJobItem {
  job: ProbeJob;
  age: number;
}

export function selectLaneSlice<T extends OpenJobItem>(
  openJobs: T[],
  totalSlice: number,
  limits: Map<number, number>,
): T[] {
  if (openJobs.length === 0 || totalSlice <= 0) return [];

  const byProvider = new Map<number, T[]>();
  for (const item of openJobs) {
    const pid = item.job.providerId;
    const list = byProvider.get(pid) ?? [];
    list.push(item);
    byProvider.set(pid, list);
  }

  let totalCapacity = 0;
  for (const [pid, list] of byProvider) {
    if (list.length > 0) {
      const limit = limits.get(pid) ?? 1;
      totalCapacity += limit;
    }
  }

  if (totalCapacity === 0) return [];

  const selected: T[] = [];
  const remainingByProvider = new Map<number, T[]>();
  let remainingQuota = totalSlice;

  for (const [pid, list] of byProvider) {
    const limit = limits.get(pid) ?? 1;
    const share = Math.ceil(totalSlice * (limit / totalCapacity));
    const count = Math.min(share, list.length, remainingQuota);
    selected.push(...list.slice(0, count));
    remainingQuota -= count;
    if (list.length > count) {
      remainingByProvider.set(pid, list.slice(count));
    }
  }

  if (remainingQuota > 0 && remainingByProvider.size > 0) {
    const leftover: T[] = [];
    for (const list of remainingByProvider.values()) {
      leftover.push(...list);
    }
    leftover.sort((a, b) => b.age - a.age);
    selected.push(...leftover.slice(0, remainingQuota));
  }

  return selected;
}

export interface RunSummary {
  runId: string;
  elapsedMs: number;
  channels: number;
  probed: number;
  cached: number;
  dead: number;
  reordered: number;
  /** Channels already in the ranked order, so nothing was written. */
  unchanged: number;
  skipped: number;
  /** Streams a saturated provider left for a later pass -- still real work. */
  deferred: number;
  /** Streams needing a probe when this pass planned, before the slice. */
  backlog: number;
  /**
   * When the earliest eligible cached verdict expires, or null when there is
   * nothing cached to expire. Only counts streams a pass could actually probe.
   */
  nextDueAt: number | null;
  /**
   * The earliest instant a channel this pass held back could be found eligible:
   * a kickoff the clock alone decides, or -- for everything the rows in hand
   * cannot date -- the next EPG grid landing. Null when neither applies, which
   * on a settled install means nothing was held back at all.
   *
   * An excluded group never appears here. Only an operator clears that one, and
   * waking for it would be the once-a-minute crawl all over again.
   */
  nextEligibleAt: number | null;
  /**
   * Streams needing a probe that a provider lane actually existed for this
   * pass. The subset of `backlog` the loop may sleep on: jobs on a saturated
   * provider are counted as deferred work, and jobs on an inactive one can
   * never run at all, but anything left here is work this install could have
   * done and must come straight back to.
   */
  runnableBacklog: number;
  /**
   * Least-recently probed eligible stream (the honest "Oldest check"), or null
   * when nothing managed has been probed yet. Excluded/unmatched/removed streams
   * never appear here, unlike the cache-wide MIN(probed_at).
   */
  oldestProbedAt: number | null;
  eligibleChannels: number;
  heldBack: Record<string, number>;
  lanes: Record<string, { limit: number; done: number; failed: number }>;
  paused: boolean;
}

export interface RunnerDeps {
  /**
   * Resolved per run, not captured once.
   *
   * Settings are editable at runtime, so holding a Config for the life of the
   * process would reintroduce exactly the staleness the rules reload fixed --
   * toggling dry run in the UI would appear to work and change nothing.
   */
  config: () => Config;
  store: Store;
  /**
   * Re-read at the start of every run, so a rule edited in the UI takes effect
   * on the next pass rather than on the next restart.
   */
  rules: RulesSource;
  log?: (message: string) => void;
}

export class Runner {
  lastRun: RunSummary | null = null;
  private running = false;
  /** The EPG grid is large and slow-changing; reuse it across passes. */
  private readonly epg = new EpgCache<unknown[]>();
  private progress: Omit<Progress, 'updatedAt'> = {
    runId: null,
    phase: 'idle',
    startedAt: null,
    probed: 0,
    total: 0,
    dead: 0,
    reordered: 0,
    unchanged: 0,
    cached: 0,
    deferred: 0,
    backlog: 0,
    dueAt: null,
    heldBack: {},
    lanes: [],
    message: '',
    nextRunAt: null,
    tickMs: 0,
    maxAgeMs: 0,
    oldestManagedProbedAt: null,
  };

  constructor(private readonly deps: RunnerDeps) {}

  /**
   * Publish when the next pass is due.
   *
   * The loop owns the timer, not the runner, so it has to hand the time over
   * for the UI to see it.
   */
  noteNextRun(at: number | null): void {
    this.emit({ nextRunAt: at });
  }

  /** Built per run so a changed freshness target takes effect immediately. */
  private pacerFor(config: Config): Pacer {
    const pacerConfig: PacerConfig = {
      maxAgeMs: config.PODIUM_MAX_AGE_MS,
      tickMs: config.PODIUM_TICK_MS,
      pauseWhenWatching: config.PODIUM_PAUSE_WHEN_WATCHING,
      minFreeSlots: config.PODIUM_MIN_FREE_SLOTS,
      maxSlice: config.PODIUM_MAX_SLICE,
    };
    return new Pacer(pacerConfig);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Publish progress for the UI.
   *
   * The worker and the web process are separate, so this goes through the
   * store rather than memory. Cheap enough to call on every probe: one small
   * upsert against a WAL database.
   */
  private emit(patch: Partial<Omit<Progress, 'updatedAt'>>): void {
    this.progress = { ...this.progress, ...patch };
    try {
      this.deps.store.setProgress(this.progress);
    } catch {
      // Progress is diagnostics; never let it take a run down.
    }
  }

  async runOnce(): Promise<RunSummary> {
    // Two passes reordering the same channel would race each other into
    // Dispatcharr, so overlap is refused rather than queued.
    if (this.running) throw new Error('a run is already in progress');
    this.running = true;

    const config = this.deps.config();

    // Nothing to authenticate with yet. A quiet no-op beats a stack trace every
    // tick: this is the expected state between first start and someone filling
    // in the settings page, and the config is re-read each pass, so the run
    // after they save picks the credentials up on its own.
    if (!config.hasCredentials) {
      this.running = false;
      this.emit({
        runId: '',
        phase: 'idle',
        startedAt: Date.now(),
        probed: 0,
        total: 0,
        dead: 0,
        reordered: 0,
        unchanged: 0,
        cached: 0,
        deferred: 0,
        backlog: 0,
        dueAt: null,
        heldBack: {},
        lanes: [],
        message: 'waiting for Dispatcharr credentials — add them in Settings',
        nextRunAt: null,
        tickMs: config.PODIUM_TICK_MS,
        maxAgeMs: config.PODIUM_MAX_AGE_MS,
      });
      return {
        runId: '',
        elapsedMs: 0,
        channels: 0,
        probed: 0,
        cached: 0,
        dead: 0,
        reordered: 0,
        unchanged: 0,
        skipped: 0,
        deferred: 0,
        backlog: 0,
        nextDueAt: null,
        nextEligibleAt: null,
        runnableBacklog: 0,
        oldestProbedAt: null,
        eligibleChannels: 0,
        heldBack: { 'no credentials': 1 },
        lanes: {},
        paused: true,
      };
    }

    const pacer = this.pacerFor(config);
    const { store } = this.deps;
    // Picked up fresh each run; the source only re-parses when the file moved.
    // plan() and reorderCachedOnly() fetch the matcher themselves, so only the
    // eligibility is needed at this level.
    const { eligibility } = this.deps.rules.get();
    const log = this.deps.log ?? (() => {});
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const started = Date.now();
    store.startRun(runId);
    this.emit({
      runId,
      phase: 'fetching',
      startedAt: started,
      probed: 0,
      total: 0,
      dead: 0,
      reordered: 0,
      unchanged: 0,
      cached: 0,
      deferred: 0,
      backlog: 0,
      dueAt: null,
      heldBack: {},
      lanes: [],
      message: 'fetching channels and streams',
      // Republished every run so an interval or target changed in the UI shows
      // up in the schedule line rather than a value from boot.
      nextRunAt: null,
      tickMs: config.PODIUM_TICK_MS,
      maxAgeMs: config.PODIUM_MAX_AGE_MS,
    });

    const counters = {
      probed: 0,
      cached: 0,
      dead: 0,
      reordered: 0,
      unchanged: 0,
      skipped: 0,
      deferred: 0,
      backlog: 0,
      nextDueAt: null as number | null,
      nextEligibleAt: null as number | null,
      runnableBacklog: 0,
      oldestProbedAt: null as number | null,
    };
    const heldBack: Record<string, number> = {};

    try {
      const client = new DispatcharrClient(config.DISPATCHARR_URL, {
        apiKey: config.DISPATCHARR_API_KEY,
        username: config.DISPATCHARR_USERNAME,
        password: config.DISPATCHARR_PASSWORD,
      });
      await client.login();

      // Settle the pass with a reason. Three different things pause a run and
      // they need different answers: the activity probe failed (check
      // Dispatcharr), somebody is watching (nothing to do), or nobody is
      // watching but viewers have consumed every provider's capacity anyway.
      // `idle` alone cannot tell the first two apart -- the fail-closed path
      // reports `idle: false` -- so each caller names its own cause.
      const pause = (msg: string): RunSummary => {
        log(msg);
        this.emit({ phase: 'paused', message: msg });
        return this.finish(runId, started, counters, heldBack, 0, {}, true);
      };

      // Channels and providers first, and deliberately *only* those.
      //
      // A pass that is about to pause because someone is watching never looks
      // at the stream catalogue it used to fetch first: `pausedByActivity` is
      // decided by the activity read alone, and the viewer counts derived from
      // `streams` are not consulted. Fetching 22,000 streams across 44 pages to
      // then discard them is pure load -- and it lands on Dispatcharr at
      // exactly the moment Dispatcharr is busy serving the viewer. Measured on
      // a live install, 53% of passes paused this way.
      const [channels, providers] = await Promise.all([client.channels(), client.providers()]);

      const uuidMap = new Map<string, number>(
        channels.filter((c) => Boolean(c.uuid)).map((c) => [c.uuid!, c.id]),
      );
      const activity = await this.readActivity(client, log, uuidMap);
      const baseLimits = this.baseLimits(providers);

      if (pacer.pausedByActivity(activity)) {
        log(
          `fetched ${channels.length} channels; skipped the stream catalogue` +
            (activity.probeFailed ? ' (activity unknown)' : ' (viewers active)'),
        );
        return pause(
          activity.probeFailed
            ? 'paused: cannot reach Dispatcharr to check who is watching; assuming busy'
            : 'someone is watching; no spare provider capacity',
        );
      }

      const [streams, epg, groups] = await Promise.all([
        client.streams(),
        this.epgRows(client, config),
        client.groups(),
      ]);
      const epgRows = epg.rows;
      const groupNames = new Map(groups.map((g) => [g.id, g.name]));
      // Built once here -- both the lane snapshot below and the ranking strategy
      // need provider names, and the strategy must be resolved before the
      // cache-only reorders run.
      const providerNames = new Map(providers.map((p) => [p.id, p.name]));
      const strategy = resolveOrdering(
        this.deps.rules.get().ordering,
        providerNames,
        config.PODIUM_MIN_BITRATE_KBPS,
      );
      const programmes = currentProgrammes(epgRows as never[]);
      // Derived from the same grid, in the same breath: what is airing decides
      // the verdict, what airs next decides how long the loop may sleep on it.
      const upcoming = nextProgrammeStarts(epgRows as never[]);

      const streamToChannel = new Map<number, number>();
      for (const channel of channels) {
        for (const streamId of channel.streams) {
          streamToChannel.set(streamId, channel.id);
        }
      }

      const limits = pacer.laneLimits(
        baseLimits,
        activity,
        viewersByProvider(
          streams.map((s) => ({
            providerId: s.providerId,
            currentViewers: s.currentViewers,
            channelId: streamToChannel.get(s.id),
          })),
          activity,
        ),
      );

      log(
        `fetched ${channels.length} channels, ${streams.length} streams; ` +
          `lanes ${JSON.stringify(Object.fromEntries(limits))}` +
          (activity.probeFailed ? ' (activity unknown)' : activity.idle ? '' : ' (viewers active)'),
      );

      if (limits.size === 0) {
        // The watching case already returned above. What reaches here is either
        // idle-but-saturated, or -- with pausing switched off, the only way a
        // non-idle read gets this far -- an activity probe that failed, which
        // is still worth naming for what it is rather than blaming capacity.
        return pause(
          activity.probeFailed
            ? 'paused: cannot reach Dispatcharr to check who is watching; assuming busy'
            : 'paused: no spare provider capacity',
        );
      }

      const streamById = new Map(streams.map((s) => [s.id, s]));
      let cachedIndex: ReturnType<Matcher['buildIndex']> | null = null;
      let cachedMatcher: Matcher | null = null;
      const getIndex = () => {
        const currentMatcher = this.deps.rules.get().matcher;
        if (!cachedIndex || cachedMatcher !== currentMatcher) {
          cachedMatcher = currentMatcher;
          cachedIndex = currentMatcher.buildIndex(streams, groupNames);
        }
        return cachedIndex;
      };

      this.emit({ phase: 'planning', message: 'matching channels and checking the cache' });
      const { jobs, ages, nextDueAt, nextEligibleAt, oldestProbedAt, keepStreamIds, planned } =
        this.plan(
          channels,
          streams,
          programmes,
          eligibility,
          counters,
          heldBack,
          groupNames,
          upcoming,
          epg.expiresAt,
          getIndex(),
          streamById,
        );
      // Every later step reads this rather than matching the channel again.
      const plannedById = new Map(planned.map((entry) => [entry.channel.id, entry]));
      const eligibleChannels = new Set(jobs.map((j) => j.channelId)).size;
      counters.backlog = jobs.length;
      counters.nextDueAt = nextDueAt;
      counters.nextEligibleAt = nextEligibleAt;
      counters.oldestProbedAt = oldestProbedAt;

      // Verdicts for streams the worker no longer manages -- excluded, unmatched,
      // or pulled from every lineup -- would otherwise age here forever, dragging
      // the freshness numbers past the target for work the pacer never does.
      const pruned = store.pruneOutside(keepStreamIds, undefined, log);
      if (pruned > 0) log(`pruned ${pruned} orphan cache rows`);

      // Cache-only channels never enter the scheduler, so they are reordered
      // here or they would be skipped entirely.
      await this.reorderCachedOnly(client, planned, counters, strategy);

      // A provider the pacer left out has no spare capacity this pass. Its jobs
      // must be dropped, not merely unbounded -- the scheduler falls back to
      // DEFAULT_LANE_LIMIT for an unknown provider, so leaving them in would
      // quietly probe a saturated provider at 1 concurrent instead of skipping
      // it. They stay in the backlog and are picked up on a later tick.
      //
      // A provider that is not in the catalogue at all is a different case and
      // must not be counted as deferred. Dispatcharr's inactive accounts are
      // filtered out of `providers()`, but their streams are still in the
      // catalogue and still match rules, so they generate jobs no pass can ever
      // run. Counting those as deferred makes every pass look like it did work,
      // which stops the loop ever taking its idle sleep -- a permanent
      // once-a-minute full crawl of Dispatcharr to defer the same streams again.
      const knownProviders = new Set(providers.map((p) => p.id));
      const open: ProbeJob[] = [];
      const openAges: number[] = [];
      let unrunnable = 0;
      const noCapacity = new Set<number>();
      const unknownProviders = new Set<number>();
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const age = ages[i];
        // `ages` is built in lockstep with `jobs`, so a defined job means a
        // defined age; guard both to satisfy the index-access check together.
        if (job === undefined || age === undefined) continue;
        if (limits.has(job.providerId)) {
          open.push(job);
          openAges.push(age);
        } else if (knownProviders.has(job.providerId)) {
          noCapacity.add(job.providerId);
        } else {
          unrunnable += 1;
          unknownProviders.add(job.providerId);
        }
      }
      const closed = jobs.length - open.length - unrunnable;
      counters.deferred = closed;
      // Before the slice, deliberately: what the pacer chose to leave for later
      // is still work this install could do right now, and the loop must not
      // sleep past it.
      counters.runnableBacklog = open.length;
      if (closed > 0) {
        log(
          `deferring ${closed} streams on provider(s) ${[...noCapacity].join(', ')}: no spare capacity`,
        );
      }
      if (unrunnable > 0) {
        log(
          `ignoring ${unrunnable} streams on inactive or unknown provider(s) ` +
            `${[...unknownProviders].join(', ')}: no lane exists for them`,
        );
      }

      // Size the slice off the real oldest age of what is open this pass: a
      // never-probed stream (MAX) or anything past the target means "now", and
      // anything with time to spare is paced across the remaining window.
      // Passing a constant here used to disable that pacing and fire the ceiling
      // every tick, so the pacer's "grow the slice as the deadline nears" shape
      // was dead code.
      const oldestOpenAge = openAges.length
        ? openAges.reduce((max, age) => (age > max ? age : max), 0)
        : 0;
      // Paced against the freshness target, deliberately *not* against the TTL
      // that made an item due. Those are different questions: a dead verdict
      // expires at its own backed-off TTL so it gets *reconsidered* on that
      // cadence, but the deadline it must not breach is still PODIUM_MAX_AGE_MS.
      //
      // Passing the dead TTL here collapses the whole thing: a job only reaches
      // `open` once its verdict already expired, so its age is always at least
      // the dead TTL, `remaining` is never positive, and every pass fires the
      // ceiling -- which is not pacing, it is the batch behaviour the pacer
      // exists to replace, and it makes PODIUM_MAX_AGE_MS decorative.
      //
      // The dead-TTL problem this replaced was real, but it was the *floor*:
      // `Math.max(1, ...)` meant a small backlog trickled one stream per tick,
      // each tick paying a full catalogue fetch. Pacer.sliceSize now floors at
      // a batch instead, which fixes that without discarding the shape.
      const slice = pacer.sliceSize(open.length, oldestOpenAge);
      const openItems = open.map((job, i) => ({ job, age: openAges[i] ?? 0 }));
      const selectedItems = selectLaneSlice(openItems, Math.max(slice, 0), limits);
      const selected = selectedItems.map((item) => item.job);
      log(
        `${jobs.length} streams need probing, taking ${selected.length} this pass ` +
          `(${counters.cached} served from cache)`,
      );

      const queued = new Map<number, number>();
      for (const job of selected) queued.set(job.providerId, (queued.get(job.providerId) ?? 0) + 1);
      // Tracked here rather than read from RunStats: the scheduler only hands
      // those back once the whole run is over, and the lane bars are the part
      // of the progress view worth watching *during* a run.
      const laneDone = new Map<number, number>();
      // `done` counts every probe that returned a verdict -- alive or dead -- so
      // it reads as progress. `dead` is the subset that came back dead, surfaced
      // on its own because a dead stream is information, not a failure. `failed`
      // is the probe itself blowing up, which is the only thing worth calling one.
      const laneDead = new Map<number, number>();
      const laneFailed = new Map<number, number>();
      // In-flight channel names per lane. A lane at limit=5 can have five at
      // once, and seeing them side by side is the clearest evidence that the
      // providers really are running independently.
      const laneCurrent = new Map<number, Map<number, string>>();
      const channelNames = new Map(channels.map((c) => [c.id, c.name]));
      const laneSnapshot = () =>
        [...queued.entries()].map(([id, n]) => ({
          id,
          name: providerNames.get(id) ?? String(id),
          limit: limits.get(id) ?? 0,
          done: laneDone.get(id) ?? 0,
          dead: laneDead.get(id) ?? 0,
          failed: laneFailed.get(id) ?? 0,
          queued: n,
          current: [...(laneCurrent.get(id)?.values() ?? [])],
        }));
      this.emit({
        phase: 'probing',
        total: selected.length,
        cached: counters.cached,
        unchanged: counters.unchanged,
        deferred: closed,
        backlog: jobs.length,
        dueAt: nextDueAt,
        oldestManagedProbedAt: oldestProbedAt,
        heldBack,
        message: `probing ${selected.length} streams`,
        lanes: laneSnapshot(),
      });

      const abort = new AbortFlag();
      const watcher = this.watchForViewers(client, abort, log, uuidMap);
      let stats: Awaited<ReturnType<typeof runLanes<ProbeResult>>>;
      try {
        stats = await runLanes<ProbeResult>(selected, {
          limits,
          abort,
          maxConcurrent: config.PODIUM_MAX_CONCURRENT_PROBES,
          staggerMs: config.PODIUM_LANE_STAGGER_MS,
          log,
          probe: async (job) => {
            let inflight = laneCurrent.get(job.providerId);
            if (!inflight) {
              inflight = new Map();
              laneCurrent.set(job.providerId, inflight);
            }
            inflight.set(job.streamId, channelNames.get(job.channelId) ?? `#${job.channelId}`);
            this.emit({ lanes: laneSnapshot() });

            let result: ProbeResult;
            try {
              result = await probe(job.url, {
                timeoutMs: config.PODIUM_PROBE_TIMEOUT_MS,
                analyzeSeconds: config.PODIUM_ANALYZE_SECONDS,
                userAgent: config.PODIUM_USER_AGENT,
                measureBitrate: config.PODIUM_MEASURE_BITRATE,
                measureSeconds: config.PODIUM_MEASURE_SECONDS,
                detectBlack: config.PODIUM_DETECT_BLACK,
                blackRatio: config.PODIUM_BLACK_RATIO,
              });
            } catch (error) {
              // probe() returns DEAD rather than throwing, so this is defensive
              // -- but if it ever does, count it as a failure (a dead stream is
              // not one) and let the scheduler settle the channel without it.
              laneFailed.set(job.providerId, (laneFailed.get(job.providerId) ?? 0) + 1);
              this.emit({ lanes: laneSnapshot() });
              throw error;
            } finally {
              inflight.delete(job.streamId);
            }
            const stream = streamById.get(job.streamId);
            if (stream?.streamHash) store.put(job.streamId, stream.streamHash, result);
            counters.probed += 1;
            if (!result.alive) counters.dead += 1;
            if (config.PODIUM_WRITE_STATS && !config.PODIUM_DRY_RUN) {
              // Best-effort: publishing stats must never fail a probe.
              client
                .setStreamStats(job.streamId, statsPayload(result, strategy.weights))
                .catch((err) => {
                  log(`stats publish failed for stream ${job.streamId}: ${String(err)}`);
                });
            }
            // `done` advances for every verdict (alive or dead); `dead` is the
            // breakdown of the ones that came back dead.
            laneDone.set(job.providerId, (laneDone.get(job.providerId) ?? 0) + 1);
            if (!result.alive)
              laneDead.set(job.providerId, (laneDead.get(job.providerId) ?? 0) + 1);
            this.emit({
              probed: counters.probed,
              dead: counters.dead,
              reordered: counters.reordered,
              unchanged: counters.unchanged,
              lanes: laneSnapshot(),
              message: `${providerNames.get(job.providerId) ?? job.providerId}: ${
                stream?.name?.slice(0, 60) ?? job.streamId
              }`,
            });
            return result;
          },
          onChannelComplete: async (channelId, results) => {
            // Everything about which streams this channel ranks on, and what
            // was already known about them, was settled in `plan`. A channel
            // absent from it was never eligible and has nothing to write.
            const entry = plannedById.get(channelId);
            if (!entry) return;

            const entries: RankEntry[] = [];
            let complete = true;
            for (const [streamId, stepOrder] of entry.hits) {
              const freshlyProbed = results.find(([job]) => job.streamId === streamId);
              if (freshlyProbed) {
                if (freshlyProbed[1] !== null) {
                  entries.push({
                    streamId,
                    stepOrder,
                    providerId: freshlyProbed[0].providerId,
                    result: freshlyProbed[1] as ProbeResult,
                  });
                }
                continue;
              }

              const known = entry.cached.get(streamId);
              if (known) {
                entries.push(known);
                continue;
              }

              // Not freshly probed and not a hit when the pass planned, which
              // means its probe was deferred. The channel cannot be ranked
              // until every stream on it has a verdict.
              complete = false;
              break;
            }

            if (complete && entries.length > 0) {
              await this.reorder(
                client,
                channelId,
                entries,
                counters,
                log,
                entry.channel.streams,
                strategy,
              );
            }
          },
        });
      } finally {
        clearInterval(watcher);
      }
      counters.skipped = stats.skipped;
      this.emit({
        phase: 'done',
        probed: counters.probed,
        dead: counters.dead,
        reordered: counters.reordered,
        unchanged: counters.unchanged,
        oldestManagedProbedAt: oldestProbedAt,
        message: `finished in ${((Date.now() - started) / 1000).toFixed(1)}s`,
        // laneSnapshot() carries the same done/dead/failed counts the mid-run
        // snapshots did, so the lane bars no longer flip meaning at completion.
        // `current` is empty: the run is over and nothing is in flight.
        lanes: laneSnapshot(),
      });

      const lanes: RunSummary['lanes'] = {};
      for (const [id, lane] of stats.lanes) {
        lanes[String(id)] = { limit: lane.limit, done: lane.done, failed: lane.failed };
      }
      return this.finish(runId, started, counters, heldBack, eligibleChannels, lanes, false);
    } catch (error) {
      store.finishRun(runId, { ...counters, error: String(error).slice(0, 500) });
      this.emit({ phase: 'failed', message: String(error).slice(0, 200) });
      throw error;
    } finally {
      this.running = false;
    }
  }

  /**
   * The EPG grid, cached for PODIUM_EPG_TTL_MS so a pass-per-minute worker does
   * not hammer Dispatcharr for data that changes by the hour. An empty result
   * (a transient outage, or genuinely nothing airing right now) falls back to
   * the last good rows, since stale EPG still informs the after_epg_start call.
   */
  private async epgRows(
    client: DispatcharrClient,
    config: Config,
  ): Promise<{ rows: unknown[]; expiresAt: number | null }> {
    const source = config.DISPATCHARR_URL;
    // Read after the fetch below, so a grid refreshed by this pass reports its
    // own expiry rather than the one it replaced.
    const expiry = () => this.epg.expiresAt(source, config.PODIUM_EPG_TTL_MS);
    const fresh = this.epg.fresh(source, config.PODIUM_EPG_TTL_MS);
    if (fresh) return { rows: fresh, expiresAt: expiry() };

    const rows = await client.epgWindow();
    if (rows.length > 0) {
      this.epg.set(source, rows);
      return { rows, expiresAt: expiry() };
    }
    // An empty fetch serves the last good rows rather than clearing the cache,
    // so a Dispatcharr hiccup cannot blank out the eligibility decision. Its
    // expiry is already in the past, which is the right answer: the next pass
    // should try the fetch again rather than sleep on rows nobody refreshed.
    const stale = this.epg.stale(source);
    if (stale) this.deps.log?.('epg grid returned no rows; serving last good rows');
    return { rows: stale ?? rows, expiresAt: expiry() };
  }

  /**
   * Failing closed: if we cannot tell whether anyone is watching, assume yes.
   *
   * `probeFailed` is carried out separately because the fail-closed verdict is
   * indistinguishable from a real viewer once it is a bare `idle: false` -- both
   * say "busy". Telling an operator "someone is watching" when Dispatcharr is
   * actually unreachable sends them looking in the wrong place.
   */
  private async readActivity(
    client: DispatcharrClient,
    log: (m: string) => void,
    uuidMap?: Map<string, number>,
  ): Promise<{ channelIds: Set<number>; idle: boolean; probeFailed: boolean }> {
    try {
      const ids = await client.activeChannelIds(uuidMap);
      return { channelIds: new Set(ids), idle: ids.length === 0, probeFailed: false };
    } catch (error) {
      log(`activity probe failed (${String(error)}) -- assuming busy`);
      return { channelIds: new Set([-1]), idle: false, probeFailed: true };
    }
  }

  /**
   * Poll for viewers during the run and abort the moment one appears.
   * A probe already in flight is allowed to finish -- it holds a provider slot
   * either way, so killing it frees nothing.
   */
  private watchForViewers(
    client: DispatcharrClient,
    abort: AbortFlag,
    log: (m: string) => void,
    uuidMap?: Map<string, number>,
  ): NodeJS.Timeout {
    const config = this.deps.config();
    if (!config.PODIUM_PAUSE_WHEN_WATCHING) {
      return setInterval(() => {}, 1 << 30);
    }
    return setInterval(
      async () => {
        try {
          const ids = await client.activeChannelIds(uuidMap);
          if (ids.length > 0 && !abort.aborted) {
            log(`viewer started on channel ${ids[0]} -- stopping this pass`);
            abort.abort();
          }
        } catch {
          // A transient failure should not abort a healthy run; the next tick's
          // fail-closed activity read will catch a real outage.
        }
        // Deliberately not the tick interval: how promptly we get out of a
        // viewer's way is not the same question as how often a pass starts, and
        // tying them meant raising the interval also made Podium slower to
        // notice somebody had tuned in.
      },
      Math.min(config.PODIUM_TICK_MS, 15_000),
    );
  }

  /** Dispatcharr's own `max_streams` per provider -- it is the authority. */
  private baseLimits(providers: Provider[]): Map<number, number> {
    return new Map(providers.map((p) => [p.id, p.maxStreams]));
  }

  /**
   * Decide what to probe, staleest first, honouring group policy.
   *
   * Three things come out of here, each restricted to the streams the worker
   * actually manages -- matched by a rule on a channel whose group is not
   * excluded -- because the cache as a whole is the wrong denominator:
   *
   *   - `jobs`: the cache misses to probe, oldest first (with `ages` parallel,
   *     so the pacer can size the slice off the real oldest age).
   *   - `nextDueAt`: when the earliest *eligible* cached verdict expires. The
   *     loop sleeps on this, and it must come from here rather than the cache:
   *     a verdict on an excluded channel expires like any other and is never
   *     probed, so a cache-wide answer would wake the loop for work that does
   *     not exist.
   *   - `oldestProbedAt`: the least-recently probed eligible stream. This is the
   *     honest "Oldest check" -- the cache-wide MIN(probed_at) counts excluded,
   *     unmatched, and removed streams the pacer never rechecks, so it drifts
   *     past the target whatever the real freshness.
   *
   * `keepStreamIds` is the complement the run uses to prune: every stream on a
   * channel whose policy is not `never`. A channel held back only by time
   * (`after_epg_start`, before kickoff) is still managed, so its streams are
   * kept; only permanently excluded, unmatched, or removed streams are dropped.
   */
  private plan(
    channels: Channel[],
    streams: Stream[],
    programmes: Map<string, Programme>,
    eligibility: Eligibility,
    counters: { cached: number },
    heldBack: Record<string, number>,
    groupNames: Map<number, string>,
    upcoming: UpcomingStarts,
    gridExpiresAt: number | null,
    passedIndex?: StreamIndex,
    passedById?: Map<number, Stream>,
  ): {
    jobs: ProbeJob[];
    ages: number[];
    nextDueAt: number | null;
    nextEligibleAt: number | null;
    oldestProbedAt: number | null;
    keepStreamIds: Set<number>;
    planned: PlannedChannel[];
  } {
    const config = this.deps.config();
    const { store } = this.deps;
    // Read once for the pass, not per channel: a mark is a handful of rows and
    // the answer cannot change under us mid-plan without making the pass
    // inconsistent with itself.
    const marks = store.refreshMarks();
    const { matcher } = this.deps.rules.get();
    const index = passedIndex ?? matcher.buildIndex(streams, groupNames);
    const byId = passedById ?? new Map(streams.map((s) => [s.id, s]));
    const scored: Array<{ job: ProbeJob; age: number }> = [];
    const planned: PlannedChannel[] = [];
    const keepStreamIds = new Set<number>();
    const seenStreamIds = new Set<number>();
    let nextDueAt: number | null = null;
    let nextEligibleAt: number | null = null;
    let oldestProbedAt: number | null = null;

    for (const channel of channels) {
      if (channel.hidden_from_output) continue;
      const rule = matcher.rules.get(channel.id);
      const groupName = channel.groupId === null ? undefined : groupNames.get(channel.groupId);
      const policy = eligibility.policyFor(channel.groupId, groupName);
      // A channel with no rule is normally not ours to touch. The exceptions are
      // the groups set to `after_epg_start` or `assigned`, where the channel's
      // own assignment stands in for the rule -- see `assignedCandidates`.
      if (!rule && !assignmentIsRule(policy.mode)) continue;
      // Lazily, because matching is the expensive part of the pass and an
      // excluded channel must not pay for it.
      const candidates = (): Array<[number, number]> =>
        rule ? matcher.match(rule, index) : assignedCandidates(channel, byId, index.excludedGroups);

      const verdict = eligibility.allows(
        channel.groupId,
        channel.tvgId,
        programmes,
        new Date(),
        groupName,
        upcoming,
      );
      if (!verdict.allowed) {
        heldBack[verdict.reason] = (heldBack[verdict.reason] ?? 0) + 1;
        // Held back only by the clock (waiting for kickoff) is still managed:
        // keep its verdicts so they are not pruned, and leave them out of the
        // freshness number until the channel is actually probeable.
        if (policy.mode !== NEVER) {
          for (const [streamId] of candidates()) keepStreamIds.add(streamId);
          // When the gate opens, or -- for the channels the current rows cannot
          // date, which is most of them against a grid of what is airing now --
          // when this pass will have rows it has not already seen. Re-running
          // before either instant re-reads the same rows and reaches the same
          // answer, at the cost of a full catalogue fetch. The earliest across
          // every held-back channel is when the loop has to be awake again.
          const opensAt = verdict.eligibleAt ?? gridExpiresAt;
          if (opensAt !== null && (nextEligibleAt === null || opensAt < nextEligibleAt)) {
            nextEligibleAt = opensAt;
          }
        }
        continue;
      }

      // Whatever an operator has asked to re-check covers this channel from
      // here on: any verdict older than this instant is out of service.
      const forcedAt = forcedAtFor(marks, channel.groupId);
      const hits: Array<[number, number]> = [];
      const cachedEntries = new Map<number, RankEntry>();

      for (const [streamId, stepOrder] of candidates()) {
        const stream = byId.get(streamId);
        if (!stream || stream.is_stale) continue;
        keepStreamIds.add(stream.id);
        hits.push([stream.id, stepOrder]);

        // One read for all three things this needs from the cache: the age
        // that paces the slice, the verdict itself, and the dead streak that
        // decides how long that verdict is trusted for.
        const cached = store.entry(stream.id, stream.streamHash);
        const age = cached ? Date.now() - cached.probedAt : null;
        // Retired by an explicit re-check request rather than by its own age.
        // The verdict itself is untouched -- it goes on ranking the channel
        // until a new one lands, and cancelling the request puts it straight
        // back in service.
        //
        // Inclusive: the request means "re-check what you measured before I
        // asked", and a verdict stamped the same millisecond as the request was
        // not taken in response to it. Nothing re-probed *afterwards* can tie,
        // because the pass that re-probes it cannot start until after the mark
        // is written -- which is what makes a satisfied mark go inert on its own
        // rather than needing to be cleaned up.
        const forcedOut = cached !== null && cached.probedAt <= forcedAt;
        if (cached) {
          if (oldestProbedAt === null || cached.probedAt < oldestProbedAt) {
            oldestProbedAt = cached.probedAt;
          }
          const ttl = ttlFor(
            cached,
            config.PODIUM_LIVE_TTL_MS,
            config.PODIUM_DEAD_TTL_MS,
            config.PODIUM_DEAD_TTL_MAX_MS,
            config.PODIUM_UNKNOWN_BITRATE_TTL_MS,
          );
          // The freshness test and the unreadable-result check mirror
          // `Store.get`, which this deliberately no longer calls: a second read
          // of the same row could only disagree with the age and TTL taken here.
          if (!forcedOut && cached.result && Date.now() - cached.probedAt < ttl) {
            counters.cached += 1;
            const due = cached.probedAt + ttl;
            if (nextDueAt === null || due < nextDueAt) nextDueAt = due;
            // Kept for the reorder, which would otherwise read this same row
            // back out of the database a second time.
            cachedEntries.set(stream.id, {
              streamId: stream.id,
              stepOrder,
              providerId: stream.providerId,
              result: cached.result,
            });
            continue;
          }
        }

        if (seenStreamIds.has(stream.id)) continue;
        seenStreamIds.add(stream.id);
        scored.push({
          job: {
            streamId: stream.id,
            channelId: channel.id,
            url: stream.url,
            providerId: stream.providerId,
            stepOrder,
          },
          // Never-probed sorts first, and a stream somebody has explicitly
          // asked to re-check goes with it -- the request means "now", not "at
          // its usual turn". That also decides the pace: `sliceSize` reads the
          // oldest open age, so a requested re-check runs at the ceiling
          // instead of trickling MIN_BATCH a tick against a deadline 24 hours
          // out, which for a stream probed an hour ago is what its real age
          // would ask for.
          age: forcedOut ? Number.MAX_SAFE_INTEGER : (age ?? Number.MAX_SAFE_INTEGER),
        });
      }

      if (hits.length > 0) {
        planned.push({
          channel,
          hits,
          cached: cachedEntries,
          cacheComplete: cachedEntries.size === hits.length,
        });
      }
    }

    scored.sort((a, b) => b.age - a.age);
    return {
      jobs: scored.map((entry) => entry.job),
      ages: scored.map((entry) => entry.age),
      nextDueAt,
      nextEligibleAt,
      oldestProbedAt,
      keepStreamIds,
      planned,
    };
  }

  /**
   * Reorder channels whose streams were entirely cache hits.
   *
   * These produce no probe jobs, so without this they would never be written
   * back and a freshly-imported install would appear to do nothing.
   */
  /**
   * Write the channels a pass found nothing to probe on.
   *
   * These produce no probe jobs, so without this they would never be written
   * back and a freshly-imported install would appear to do nothing.
   *
   * Takes what `plan` already worked out rather than deriving it again. Beyond
   * the duplicated matching, the old version ran over *every* eligible channel
   * including the ones with probes pending, so a channel could be composed and
   * PATCHed here and then PATCHed again from `onChannelComplete` in the same
   * pass, off two different readings of the cache. `cacheComplete` is exactly
   * the set with nothing pending, which is the set this was always meant to be.
   */
  private async reorderCachedOnly(
    client: DispatcharrClient,
    planned: PlannedChannel[],
    counters: { reordered: number; unchanged: number },
    strategy: RankStrategy,
  ): Promise<void> {
    const log = this.deps.log ?? (() => {});
    for (const { channel, hits, cached, cacheComplete } of planned) {
      if (!cacheComplete) continue;
      const entries = hits
        .map(([streamId]) => cached.get(streamId))
        .filter((entry): entry is RankEntry => entry !== undefined);
      if (entries.length === 0) continue;
      await this.reorder(client, channel.id, entries, counters, log, channel.streams, strategy);
    }
  }

  private async reorder(
    client: DispatcharrClient,
    channelId: number,
    entries: RankEntry[],
    counters: { reordered: number; unchanged: number },
    log: (m: string) => void,
    assigned: number[] = [],
    strategy: RankStrategy,
  ): Promise<void> {
    if (entries.length === 0) return;
    const ranked = rank(entries, strategy);
    // Only streams already on the channel may move: a match the channel does not
    // carry is a ranking candidate, not an assignment, and writing it would
    // silently change the lineup. Strays are kept after the ranked ones unless
    // asked to drop them. See composeOrder.
    const ordered = composeOrder(ranked, assigned, this.deps.config().PODIUM_REMOVE_UNMATCHED);

    // Dispatcharr already serves exactly this order, so the PATCH would write
    // the row it just read back. On a settled install every verdict is a cache
    // hit and every channel ranks the same way it did a minute ago, which made
    // this 420 pointless writes a minute -- and made "420 reordered" the
    // headline on every pass, drowning out the ones that changed something.
    if (sameOrder(ordered, assigned)) {
      counters.unchanged += 1;
      return;
    }

    if (this.deps.config().PODIUM_DRY_RUN) {
      log(`[dry-run] channel ${channelId} -> ${ordered.join(',')}`);
      return;
    }
    try {
      // `ordered` was computed from the channel snapshot taken at pass start. A
      // long pass -- a provider lane pinned at its limit can run for hours --
      // means `assigned` may be stale by the time we write, and writing a stale
      // order would clobber anything Dispatcharr (its M3U refresh, or a person)
      // changed in between: re-add a removed stream, revert a reorder, drop an
      // addition. Re-fetch the one channel and recompute against its live order.
      // The GET is paid only here, past the no-op check, so a settled install
      // that writes nothing fetches nothing; a transient fetch failure falls
      // back to the pass-start order rather than blocking the write.
      const live = await client.channel(channelId).catch(() => null);
      let writeOrder = ordered;
      if (live) {
        const fresh = composeOrder(
          ranked,
          live.streams,
          this.deps.config().PODIUM_REMOVE_UNMATCHED,
        );
        if (sameOrder(fresh, live.streams)) {
          counters.unchanged += 1;
          return;
        }
        writeOrder = fresh;
      }
      await client.setStreamOrder(channelId, writeOrder);
      counters.reordered += 1;
    } catch (error) {
      log(`reorder failed for channel ${channelId}: ${String(error)}`);
    }
  }

  private finish(
    runId: string,
    started: number,
    counters: {
      probed: number;
      cached: number;
      dead: number;
      reordered: number;
      unchanged: number;
      skipped: number;
      deferred: number;
      backlog: number;
      nextDueAt: number | null;
      nextEligibleAt: number | null;
      runnableBacklog: number;
      oldestProbedAt: number | null;
    },
    heldBack: Record<string, number>,
    eligibleChannels: number,
    lanes: RunSummary['lanes'],
    paused: boolean,
  ): RunSummary {
    this.deps.store.finishRun(runId, { ...counters, channels: eligibleChannels });
    const summary: RunSummary = {
      runId,
      elapsedMs: Date.now() - started,
      channels: eligibleChannels,
      ...counters,
      eligibleChannels,
      heldBack,
      lanes,
      paused,
    };
    this.lastRun = summary;
    return summary;
  }
}
