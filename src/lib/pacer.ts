/**
 * Opportunistic scheduling against a freshness target.
 *
 * A cron time is the wrong control knob. What you actually want is "every
 * channel has been checked within the last N hours, and checking never competes
 * with someone watching TV". A nightly batch satisfies neither: it hammers
 * every provider at once whether or not anyone is streaming, and if it overruns
 * -- which a 4.9-hour run easily can -- it is still going at breakfast.
 *
 * This paces instead. Each tick it:
 *
 *   1. asks Dispatcharr who is watching (`/proxy/ts/status`)
 *   2. subtracts live viewers from the affected provider lanes, so checking
 *      uses only genuinely spare provider capacity
 *   3. sizes the next slice of work from how far behind the freshness target it
 *      is, rather than from a fixed batch size
 *
 * The result is a steady trickle that speeds up when the house is asleep and
 * backs off the instant someone tunes in.
 */

export interface Activity {
  channelIds: Set<number>;
  /** True when nobody is watching anything. */
  idle: boolean;
}

export const IDLE: Activity = { channelIds: new Set(), idle: true };

/** A sentinel "somebody might be watching" used when the probe itself fails. */
export function busyUnknown(): Activity {
  return { channelIds: new Set([-1]), idle: false };
}

export interface PacerConfig {
  /** Freshness target, in ms. */
  maxAgeMs: number;
  /** How often to reconsider, in ms. */
  tickMs: number;
  pauseWhenWatching: boolean;
  /**
   * Narrow `pauseWhenWatching` from the whole pass to the provider being
   * watched, so the ones nobody is on keep being checked.
   *
   * Inert when `pauseWhenWatching` is off: pausing off already means "compete
   * politely for slots everywhere", and this only ever relaxes a pause.
   */
  probeIdleProviders: boolean;
  /** Never take a provider's last slot. */
  minFreeSlots: number;
  /** Ceiling on one tick's work. */
  maxSlice: number;
}

/**
 * Never take a slice smaller than this while there is anything to do.
 *
 * A pass costs a full crawl of Dispatcharr -- 883 channels and 44 pages of
 * streams, ~4s measured -- before it probes anything. Pacing arithmetic that
 * asks for one stream still pays that, so a small backlog spread thinly is
 * mostly catalogue fetching: 416 expired dead verdicts at one per tick is 416
 * crawls to do seven minutes of probing. Batching the tail costs a little
 * precision against the freshness target and saves nearly all of that load.
 */
export const MIN_BATCH = 25;

export const DEFAULT_PACER: PacerConfig = {
  maxAgeMs: 24 * 3600 * 1000,
  tickMs: 60_000,
  pauseWhenWatching: true,
  probeIdleProviders: false,
  minFreeSlots: 1,
  maxSlice: 400,
};

export interface PacerStatus {
  backlog: number;
  total: number;
  withinTarget: number;
  compliance: number;
  oldestAgeHours: number;
  targetHours: number;
  breaching: boolean;
}

export class Pacer {
  constructor(private readonly config: PacerConfig = DEFAULT_PACER) {}

  /**
   * Shrink each lane by what live viewers are already consuming.
   *
   * Lanes are keyed `provider:profile` (see `laneKey` in scheduler.ts) -- one
   * per login, each with its own cap -- but the arithmetic is per lane either
   * way.
   *
   * `minFreeSlots` is a courtesy reserve for a human who might want to tune in,
   * so it only applies when someone actually is watching. Applying it while
   * fully idle permanently starves any provider whose `max_streams` is 1:
   * `1 - 0 - 1 = 0`, so its lane would never open and its streams would never
   * be checked at all -- and a single-connection provider is a common thing to
   * have.
   *
   * `providerOf` maps each lane back to its provider, and is what makes
   * `probeIdleProviders` possible: lanes are per login, but a viewer occupies
   * the *account*, so yielding has to be decided one level up from the lane
   * the arithmetic runs on. Without it the mode cannot tell a watched login's
   * sibling lane from an unrelated provider's, and falls back to pausing.
   */
  laneLimits(
    base: Map<string, number>,
    activity: Activity,
    viewersByLane: Map<string, number>,
    providerOf?: Map<string, number>,
  ): Map<string, number> {
    const out = new Map<string, number>();
    if (this.pausedByActivity(activity)) return out;

    const reserve = activity.idle ? 0 : this.config.minFreeSlots;
    const yielded = this.yieldedProviders(activity, viewersByLane, providerOf);
    if (yielded === 'all') return out;
    for (const [lane, limit] of base) {
      if (yielded !== 'none') {
        // A lane whose provider cannot be named is treated as watched. The
        // point of the mode is to stay off the account somebody is streaming
        // from, and a lane we cannot attribute might be it.
        const provider = providerOf?.get(lane);
        if (provider === undefined || yielded.has(provider)) continue;
      }
      const inUse = viewersByLane.get(lane) ?? 0;
      const free = limit - inUse - reserve;
      if (free > 0) out.set(lane, free);
    }
    return out;
  }

  /**
   * Which providers to stay off while somebody is watching.
   *
   * `none` is the ordinary answer -- either nobody is watching, or pausing is
   * switched off and every lane competes on its own capacity. A set names the
   * providers carrying viewers, so `probeIdleProviders` can leave those alone
   * and keep the rest working.
   *
   * `all` is the fail-closed answer, and it is the one worth being careful
   * about. This mode's whole safety argument is "we know which provider the
   * viewer is on, so we can avoid it" -- when that is not true the argument
   * collapses and the only honest move is the pause the operator relaxed.
   * Two ways it goes untrue: the activity probe failed (`busyUnknown` reports
   * a viewer nothing can be charged to), and a session Dispatcharr named no
   * M3U profile for. Both surface here as "somebody is watching but no lane
   * shows a viewer", which is why the emptiness of the count is the test
   * rather than any flag on the read.
   *
   * Public because `Runner` asks the same question a second time to explain a
   * pause in words -- "every provider is busy" and "we cannot tell who is on
   * what" send an operator to different places, and restating the test at the
   * call site is how the two answers drift apart.
   */
  yieldedProviders(
    activity: Activity,
    viewersByLane: Map<string, number>,
    providerOf?: Map<string, number>,
  ): 'none' | 'all' | Set<number> {
    if (activity.idle) return 'none';
    if (!this.config.pauseWhenWatching || !this.config.probeIdleProviders) return 'none';
    if (!providerOf) return 'all';

    const busy = new Set<number>();
    for (const [lane, viewers] of viewersByLane) {
      if (viewers <= 0) continue;
      const provider = providerOf.get(lane);
      if (provider === undefined) return 'all';
      busy.add(provider);
    }
    return busy.size === 0 ? 'all' : busy;
  }

  /**
   * Whether the activity read alone settles the pass, whatever the viewers are
   * doing per provider.
   *
   * Split out of `laneLimits` so a caller can ask the question *before* paying
   * for the data `laneLimits` would otherwise need. When this is true the lane
   * map is empty regardless of `viewersByProvider`, so the stream catalogue
   * that map is derived from never has to be fetched at all -- see the fetch
   * order in `Runner.runOnce`. The rule lives here, once, rather than being
   * restated by every caller that wants to shortcut it.
   */
  pausedByActivity(activity: Activity): boolean {
    if (!this.config.pauseWhenWatching || activity.idle) return false;
    // `probeIdleProviders` gives up the shortcut deliberately. Deciding which
    // providers to leave alone needs the per-lane viewer counts, and those are
    // derived from the stream catalogue this return exists to skip -- so the
    // mode costs a full crawl on every pass somebody is watching, which is the
    // trade an operator makes when they turn it on.
    return !this.config.probeIdleProviders;
  }

  /**
   * How many streams to probe this tick.
   *
   * Sized so the *oldest* item still lands inside the freshness window: the
   * closer the deadline, the bigger the slice. Once past the deadline it runs
   * at the ceiling until caught up.
   *
   * `targetTtlMs` exists for tests and for a caller that genuinely has a tighter
   * deadline than the freshness target. It defaults to `maxAgeMs` and callers
   * should leave it alone: passing a per-item TTL makes `remaining` permanently
   * negative (an item is only in the backlog once its TTL expired, so its age
   * always exceeds it) and every pass fires the ceiling.
   */
  sliceSize(
    backlog: number,
    oldestAgeMs: number,
    targetTtlMs: number = this.config.maxAgeMs,
  ): number {
    if (backlog <= 0) return 0;
    const remaining = targetTtlMs - oldestAgeMs;
    if (remaining <= 0) return Math.min(backlog, this.config.maxSlice);
    const ticksLeft = Math.max(remaining / this.config.tickMs, 1);
    const needed = Math.round(backlog / ticksLeft);
    return Math.max(Math.min(MIN_BATCH, backlog), Math.min(needed, this.config.maxSlice, backlog));
  }

  status(backlog: number, oldestAgeMs: number, total: number): PacerStatus {
    const withinTarget = total - backlog;
    return {
      backlog,
      total,
      withinTarget,
      compliance: total ? Math.round((1000 * withinTarget) / total) / 10 : 100,
      oldestAgeHours: Math.round((oldestAgeMs / 3_600_000) * 100) / 100,
      targetHours: Math.round((this.config.maxAgeMs / 3_600_000) * 100) / 100,
      breaching: oldestAgeMs > this.config.maxAgeMs,
    };
  }
}

export interface ViewerStream {
  providerId: number;
  currentViewers?: number;
  channelId?: number | null;
}

/** Count in-flight streams per provider, from the channels currently watched. */
export function viewersByProvider(
  streams: ViewerStream[],
  activity: Activity,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const stream of streams) {
    const viewers = stream.currentViewers ?? 0;
    const watched =
      activity.channelIds.size > 0 &&
      stream.channelId !== null &&
      stream.channelId !== undefined &&
      activity.channelIds.has(stream.channelId);
    if (viewers > 0 || watched) {
      counts.set(stream.providerId, (counts.get(stream.providerId) ?? 0) + Math.max(viewers, 1));
    }
  }
  return counts;
}
