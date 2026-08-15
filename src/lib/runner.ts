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
  AFTER_EPG_START,
  currentProgrammes,
  type Eligibility,
  NEVER,
  type Programme,
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
import { type Progress, type Store, ttlFor } from './store';

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
 * Candidates for a channel the rules file says nothing about.
 *
 * Another app creates channels as fixtures appear -- a whole `Auto | SPORT`
 * group that exists for one evening -- and assigns their streams itself. Nothing
 * in the rules file names them, so `matcher.rules` has no entry and the normal
 * path skips them before eligibility is ever consulted. For an
 * `after_epg_start` group that is backwards: the operator has already said
 * "probe this group once its programme starts", and a channel that carries its
 * own lineup needs no alias to say which streams that means. The assignment *is*
 * the rule.
 *
 * Restricted to `after_epg_start` at the call sites, deliberately. The same
 * fallback under `always` would sweep every rule-less channel in the install
 * into the backlog, which is a much larger decision than the one this answers.
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

      const [streams, epgRows, groups] = await Promise.all([
        client.streams(),
        this.epgRows(client, config),
        client.groups(),
      ]);
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
      const { jobs, ages, nextDueAt, oldestProbedAt, keepStreamIds } = this.plan(
        channels,
        streams,
        programmes,
        eligibility,
        counters,
        heldBack,
        groupNames,
        getIndex(),
        streamById,
      );
      const eligibleChannels = new Set(jobs.map((j) => j.channelId)).size;
      counters.backlog = jobs.length;
      counters.nextDueAt = nextDueAt;
      counters.oldestProbedAt = oldestProbedAt;

      // Verdicts for streams the worker no longer manages -- excluded, unmatched,
      // or pulled from every lineup -- would otherwise age here forever, dragging
      // the freshness numbers past the target for work the pacer never does.
      const pruned = store.pruneOutside(keepStreamIds, undefined, log);
      if (pruned > 0) log(`pruned ${pruned} orphan cache rows`);

      // Cache-only channels never enter the scheduler, so they are reordered
      // here or they would be skipped entirely.
      await this.reorderCachedOnly(
        client,
        channels,
        streams,
        programmes,
        eligibility,
        counters,
        groupNames,
        strategy,
        getIndex(),
        streamById,
      );

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
            const channel = channels.find((c) => c.id === channelId);
            const { matcher } = this.deps.rules.get();
            const rule = channel ? matcher.rules.get(channel.id) : undefined;
            if (!channel) return;
            const groupName =
              channel.groupId === null ? undefined : groupNames.get(channel.groupId);
            // The rule-less kickoff channels `plan` admitted arrive here too, and
            // returning early would probe them every pass and never reorder them.
            if (
              !rule &&
              eligibility.policyFor(channel.groupId, groupName).mode !== AFTER_EPG_START
            ) {
              return;
            }

            const index = getIndex();
            const entries: RankEntry[] = [];
            let complete = true;
            const hits = rule
              ? matcher.match(rule, index)
              : assignedCandidates(channel, streamById, index.excludedGroups);
            for (const [streamId, stepOrder] of hits) {
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

              const stream = streamById.get(streamId);
              if (!stream) continue;
              const hit = store.get(
                stream.id,
                stream.streamHash,
                config.PODIUM_LIVE_TTL_MS,
                config.PODIUM_DEAD_TTL_MS,
                config.PODIUM_DEAD_TTL_MAX_MS,
                config.PODIUM_UNKNOWN_BITRATE_TTL_MS,
              );
              if (hit) {
                entries.push({
                  streamId,
                  stepOrder,
                  providerId: stream.providerId,
                  result: hit,
                });
                continue;
              }

              // Missing from cache and not freshly probed means it was deferred.
              // We cannot reorder this channel until we have a verdict for every stream.
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
                channel.streams,
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
  private async epgRows(client: DispatcharrClient, config: Config): Promise<unknown[]> {
    const source = config.DISPATCHARR_URL;
    const fresh = this.epg.fresh(source, config.PODIUM_EPG_TTL_MS);
    if (fresh) return fresh;

    const rows = await client.epgNow();
    if (rows.length > 0) {
      this.epg.set(source, rows);
      return rows;
    }
    // An empty fetch serves the last good rows rather than clearing the cache,
    // so a Dispatcharr hiccup cannot blank out the eligibility decision.
    const stale = this.epg.stale(source);
    if (stale) this.deps.log?.('epg grid returned no rows; serving last good rows');
    return stale ?? rows;
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
    passedIndex?: StreamIndex,
    passedById?: Map<number, Stream>,
  ): {
    jobs: ProbeJob[];
    ages: number[];
    nextDueAt: number | null;
    oldestProbedAt: number | null;
    keepStreamIds: Set<number>;
  } {
    const config = this.deps.config();
    const { store } = this.deps;
    const { matcher } = this.deps.rules.get();
    const index = passedIndex ?? matcher.buildIndex(streams, groupNames);
    const byId = passedById ?? new Map(streams.map((s) => [s.id, s]));
    const scored: Array<{ job: ProbeJob; age: number }> = [];
    const keepStreamIds = new Set<number>();
    const seenStreamIds = new Set<number>();
    let nextDueAt: number | null = null;
    let oldestProbedAt: number | null = null;

    for (const channel of channels) {
      if (channel.hidden_from_output) continue;
      const rule = matcher.rules.get(channel.id);
      const groupName = channel.groupId === null ? undefined : groupNames.get(channel.groupId);
      const policy = eligibility.policyFor(channel.groupId, groupName);
      // A channel with no rule is normally not ours to touch. The exception is a
      // group set to `after_epg_start`, where the channel's own assignment
      // stands in for the rule -- see `assignedCandidates`.
      if (!rule && policy.mode !== AFTER_EPG_START) continue;
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
      );
      if (!verdict.allowed) {
        heldBack[verdict.reason] = (heldBack[verdict.reason] ?? 0) + 1;
        // Held back only by the clock (waiting for kickoff) is still managed:
        // keep its verdicts so they are not pruned, and leave them out of the
        // freshness number until the channel is actually probeable.
        if (policy.mode !== NEVER) {
          for (const [streamId] of candidates()) keepStreamIds.add(streamId);
        }
        continue;
      }

      for (const [streamId, stepOrder] of candidates()) {
        const stream = byId.get(streamId);
        if (!stream || stream.is_stale) continue;
        keepStreamIds.add(stream.id);

        // One read for all three things this needs from the cache: the age
        // that paces the slice, the verdict itself, and the dead streak that
        // decides how long that verdict is trusted for.
        const cached = store.entry(stream.id, stream.streamHash);
        const age = cached ? Date.now() - cached.probedAt : null;
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
          if (cached.result && Date.now() - cached.probedAt < ttl) {
            counters.cached += 1;
            const due = cached.probedAt + ttl;
            if (nextDueAt === null || due < nextDueAt) nextDueAt = due;
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
          // Never-probed sorts first; otherwise oldest first.
          age: age ?? Number.MAX_SAFE_INTEGER,
        });
      }
    }

    scored.sort((a, b) => b.age - a.age);
    return {
      jobs: scored.map((entry) => entry.job),
      ages: scored.map((entry) => entry.age),
      nextDueAt,
      oldestProbedAt,
      keepStreamIds,
    };
  }

  /**
   * Reorder channels whose streams were entirely cache hits.
   *
   * These produce no probe jobs, so without this they would never be written
   * back and a freshly-imported install would appear to do nothing.
   */
  private async reorderCachedOnly(
    client: DispatcharrClient,
    channels: Channel[],
    streams: Stream[],
    programmes: Map<string, Programme>,
    eligibility: Eligibility,
    counters: { reordered: number; unchanged: number },
    groupNames: Map<number, string>,
    strategy: RankStrategy,
    passedIndex?: StreamIndex,
    passedById?: Map<number, Stream>,
  ): Promise<void> {
    const config = this.deps.config();
    const { store } = this.deps;
    const { matcher } = this.deps.rules.get();
    const index = passedIndex ?? matcher.buildIndex(streams, groupNames);
    const byId = passedById ?? new Map(streams.map((s) => [s.id, s]));
    const log = this.deps.log ?? (() => {});

    for (const channel of channels) {
      if (channel.hidden_from_output) continue;
      const rule = matcher.rules.get(channel.id);
      const groupName = channel.groupId === null ? undefined : groupNames.get(channel.groupId);
      // Same fallback `plan` applies, or a rule-less kickoff channel whose
      // streams are all cache hits would never be reordered at all.
      if (!rule && eligibility.policyFor(channel.groupId, groupName).mode !== AFTER_EPG_START) {
        continue;
      }

      const verdict = eligibility.allows(
        channel.groupId,
        channel.tvgId,
        programmes,
        new Date(),
        groupName,
      );
      if (!verdict.allowed) continue;

      const hits = rule
        ? matcher.match(rule, index)
        : assignedCandidates(channel, byId, index.excludedGroups);
      if (hits.length === 0) continue;

      const entries: RankEntry[] = [];
      let complete = true;
      for (const [streamId, stepOrder] of hits) {
        const stream = byId.get(streamId);
        if (!stream) continue;
        const hit = store.get(
          stream.id,
          stream.streamHash,
          config.PODIUM_LIVE_TTL_MS,
          config.PODIUM_DEAD_TTL_MS,
          config.PODIUM_DEAD_TTL_MAX_MS,
        );
        if (!hit) {
          complete = false;
          break;
        }
        entries.push({ streamId, stepOrder, providerId: stream.providerId, result: hit });
      }
      if (complete && entries.length > 0) {
        await this.reorder(client, channel.id, entries, counters, log, channel.streams, strategy);
      }
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
