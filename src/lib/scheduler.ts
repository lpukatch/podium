/**
 * Provider-lane scheduling.
 *
 * This is the core of podium, and the reason it exists.
 *
 * The unit of work is a *stream*, not a channel. Every provider (Dispatcharr
 * M3U account) gets its own lane with its own concurrency limit, and the lanes
 * drain independently. A channel whose Provider A stream is waiting on a
 * saturated lane does not stop Provider B's lane from running flat out.
 *
 * The implementation this replaces checked one channel at a time and waited for
 * all of that channel's streams before starting the next. With a mix of
 * provider limits -- some generous, at least one down at 1 -- that serialises
 * the whole run behind whichever provider each channel happens to touch:
 *
 *     channel-at-a-time   sum of per-channel critical paths
 *     provider lanes      max over lanes
 *
 * Measured on a real multi-provider catalogue, lanes took hours off a full pass.
 * A provider capped at one connection is a hard floor either way -- no scheduler
 * beats N serial probes down a single-slot lane. The rest of the win comes from
 * the probe cache in store.ts, which keeps most streams out of the queue
 * entirely on a steady-state run.
 */

/**
 * A provider we have never seen before gets this limit. Deliberately 1: an
 * unknown provider is assumed fragile until Dispatcharr tells us its
 * max_streams.
 */
export const DEFAULT_LANE_LIMIT = 1;

export interface ProbeJob {
  streamId: number;
  channelId: number;
  url: string;
  providerId: number;
  stepOrder: number;
}

export interface LaneStats {
  limit: number;
  effectiveLimit?: number;
  queued: number;
  done: number;
  failed: number;
  busyMs: number;
  startedAt: number | null;
  endedAt?: number | null;
}

export interface RunStats {
  lanes: Map<number, LaneStats>;
  channelsTotal: number;
  channelsDone: number;
  skipped: number;
  elapsedMs: number;
}

/** Cooperative cancellation. Set `aborted` to stop dispatching new probes. */
export class AbortFlag {
  aborted = false;
  abort(): void {
    this.aborted = true;
  }
}

export interface SchedulerOptions<T> {
  limits: Map<number, number>;
  /**
   * Ceiling on probes in flight across every lane at once. 0 leaves it
   * uncapped.
   *
   * The lane limits answer "how much of this provider may I use"; nothing in
   * them answers "how much of this machine". Peak concurrency is the *sum* of
   * every provider's max_streams, so adding a provider silently raises it, and
   * each probe in flight is an ffprobe and an ffmpeg decoding video -- roughly
   * 100MiB apiece at 1080p, which is enough to OOM-kill a 2GiB container at
   * nine concurrent.
   */
  maxConcurrent?: number;
  probe: (job: ProbeJob) => Promise<T>;
  onChannelComplete: (channelId: number, results: Array<[ProbeJob, T | null]>) => Promise<void>;
  staggerMs?: number;
  abort?: AbortFlag;
  log?: (message: string) => void;
  onSlotAcquire?: (providerId: number) => void;
  onSlotRelease?: (providerId: number) => void;
}

/** A counting semaphore. One per provider lane. */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.available = limit;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter rather than incrementing;
      // incrementing first would let a newly-arriving caller jump the queue.
      next();
      return;
    }
    this.available += 1;
  }
}

/**
 * Runs probe jobs across independent per-provider lanes.
 *
 * `onChannelComplete` fires as soon as a channel's last stream lands -- which is
 * *out of order* with respect to other channels, by design. Reorders are
 * emitted continuously through the run rather than batched at the end, so a long
 * run still makes visible progress in Dispatcharr from the first minute.
 */
export async function runLanes<T>(
  jobs: ProbeJob[],
  options: SchedulerOptions<T>,
): Promise<RunStats> {
  const startedAt = Date.now();
  const lanes = new Map<number, LaneStats>();
  const stats: RunStats = {
    lanes,
    channelsTotal: 0,
    channelsDone: 0,
    skipped: 0,
    elapsedMs: 0,
  };
  if (jobs.length === 0) return stats;

  const { limits, probe, onChannelComplete, staggerMs = 0, log } = options;
  const abort = options.abort ?? new AbortFlag();
  // Taken *after* the lane slot and released before it, so the two are always
  // acquired in the same order and nothing can deadlock. Holding a lane slot
  // while queued here idles that slot, which is the point: the cap exists to
  // keep total in-flight work below what the machine can hold.
  const overall =
    options.maxConcurrent && options.maxConcurrent > 0
      ? new Semaphore(options.maxConcurrent)
      : null;

  // One semaphore per lane. This -- not a global worker pool -- is what
  // decouples the providers from each other.
  const semaphores = new Map<number, Semaphore>();
  for (const job of jobs) {
    let lane = lanes.get(job.providerId);
    if (!lane) {
      const limit = limits.get(job.providerId) ?? DEFAULT_LANE_LIMIT;
      lane = { limit, queued: 0, done: 0, failed: 0, busyMs: 0, startedAt: null, endedAt: null };
      lanes.set(job.providerId, lane);
      semaphores.set(job.providerId, new Semaphore(limit));
    }
    lane.queued += 1;
  }

  // What a lane can *actually* sustain, once the global cap is accounted for.
  //
  // `maxConcurrent` protects the machine while the lane limits protect the
  // providers, and when their sum exceeds the cap the lanes cannot all run at
  // their limits at once. The honest per-lane ceiling is its share of the cap,
  // proportional to its limit -- with 1/3/5 against a cap of 6 that is 1/2/3,
  // not 1/3/5.
  //
  // `Math.min(limit, maxConcurrent)` was the obvious-looking formula and is a
  // no-op for every realistic topology: it only binds when a *single* provider
  // allows more concurrency than the whole machine. It reported nothing, which
  // is how a lane advertising limit=5 while never exceeding 3 went unexplained.
  //
  // This is reporting only. The semaphores still hold the provider's real
  // limit, so a lane opportunistically uses spare capacity when its neighbours
  // are idle -- which is the point of sharing one cap rather than partitioning
  // it. `effectiveLimit` is the sustained figure, not a hard ceiling.
  const sumLimits = [...lanes.values()].reduce((acc, l) => acc + l.limit, 0);
  const maxConc = options.maxConcurrent && options.maxConcurrent > 0 ? options.maxConcurrent : 0;
  for (const [, lane] of lanes) {
    lane.effectiveLimit =
      maxConc > 0 && maxConc < sumLimits && sumLimits > 0
        ? Math.max(1, Math.min(lane.limit, Math.floor((maxConc * lane.limit) / sumLimits)))
        : lane.limit;
  }

  // Channel completion bookkeeping. A channel is done when every stream we
  // queued for it has landed, success or failure.
  const outstanding = new Map<number, number>();
  const results = new Map<number, Array<[ProbeJob, T | null]>>();
  for (const job of jobs) {
    outstanding.set(job.channelId, (outstanding.get(job.channelId) ?? 0) + 1);
  }
  stats.channelsTotal = outstanding.size;

  for (const [id, lane] of lanes) {
    const effStr =
      lane.effectiveLimit !== undefined && lane.effectiveLimit !== lane.limit
        ? ` (effective limit=${lane.effectiveLimit})`
        : '';
    const capForFloor = lane.effectiveLimit ?? lane.limit;
    log?.(
      `lane ${id}: ${lane.queued} streams, limit=${lane.limit}${effStr}, ` +
        `serial floor ${((lane.queued * 30) / capForFloor / 3600).toFixed(2)}h`,
    );
  }

  /**
   * Record a landed job and fire the channel callback if it was the last.
   * Skipped jobs still settle -- otherwise an aborted run would leave channels
   * permanently outstanding and their partial results never written back.
   */
  async function settle(job: ProbeJob, result: T | null, skipped = false): Promise<void> {
    if (!skipped) {
      const bucket = results.get(job.channelId);
      if (bucket) bucket.push([job, result]);
      else results.set(job.channelId, [[job, result]]);
    }
    const left = (outstanding.get(job.channelId) ?? 1) - 1;
    outstanding.set(job.channelId, left);
    if (left > 0) return;

    stats.channelsDone += 1;
    const payload = results.get(job.channelId);
    results.delete(job.channelId);
    if (!payload || payload.length === 0) return;
    try {
      await onChannelComplete(job.channelId, payload);
    } catch (error) {
      log?.(`channel completion failed: channel=${job.channelId}: ${String(error)}`);
    }
  }

  async function runJob(job: ProbeJob): Promise<void> {
    const lane = lanes.get(job.providerId)!;
    const semaphore = semaphores.get(job.providerId)!;

    if (abort.aborted) {
      stats.skipped += 1;
      await settle(job, null, true);
      return;
    }

    await semaphore.acquire();
    options.onSlotAcquire?.(job.providerId);
    let result: T | null = null;
    try {
      if (abort.aborted) {
        stats.skipped += 1;
        await settle(job, null, true);
        return;
      }
      if (lane.startedAt === null) lane.startedAt = Date.now();
      if (staggerMs > 0) await new Promise((r) => setTimeout(r, staggerMs));

      await overall?.acquire();
      const t0 = Date.now();
      try {
        result = await probe(job);
        lane.done += 1;
      } catch (error) {
        // A probe blowing up must not take down the lane, and must not strand
        // the channel it belongs to -- record a failure and let the channel
        // complete without it.
        log?.(`probe failed: stream=${job.streamId}: ${String(error)}`);
        lane.failed += 1;
      } finally {
        lane.busyMs += Date.now() - t0;
        if (lane.done + lane.failed === lane.queued) {
          lane.endedAt = Date.now();
        }
        overall?.release();
      }
    } finally {
      options.onSlotRelease?.(job.providerId);
      semaphore.release();
    }

    await settle(job, result);
  }

  await Promise.all(jobs.map(runJob));

  if (abort.aborted) log?.(`run aborted: ${stats.skipped} probes skipped`);
  for (const [id, lane] of lanes) {
    const ended = lane.endedAt ?? Date.now();
    const span = lane.startedAt ? ended - lane.startedAt : 0;
    // Against the provider's real limit, which is what the semaphore holds and
    // therefore the only figure a lane cannot exceed. Dividing by
    // `effectiveLimit` -- a sustained *share* of the global cap that a lane is
    // free to exceed while its neighbours idle, as the comment above says --
    // is what produced log lines reading "149.8% utilisation".
    const utilisation = span && lane.limit ? (lane.busyMs / (span * lane.limit)) * 100 : 0;
    log?.(
      `lane ${id} complete: ${lane.done} ok, ${lane.failed} failed, ` +
        `${utilisation.toFixed(1)}% utilisation`,
    );
  }

  stats.elapsedMs = Date.now() - startedAt;
  return stats;
}
