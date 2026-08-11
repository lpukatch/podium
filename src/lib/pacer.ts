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
   * `minFreeSlots` is a courtesy reserve for a human who might want to tune in,
   * so it only applies when someone actually is watching. Applying it while
   * fully idle permanently starves any provider whose `max_streams` is 1:
   * `1 - 0 - 1 = 0`, so its lane would never open and its streams would never
   * be checked at all -- and a single-connection provider is a common thing to
   * have.
   */
  laneLimits(
    base: Map<number, number>,
    activity: Activity,
    viewersByProvider: Map<number, number>,
  ): Map<number, number> {
    const out = new Map<number, number>();
    if (this.pausedByActivity(activity)) return out;

    const reserve = activity.idle ? 0 : this.config.minFreeSlots;
    for (const [providerId, limit] of base) {
      const inUse = viewersByProvider.get(providerId) ?? 0;
      const free = limit - inUse - reserve;
      if (free > 0) out.set(providerId, free);
    }
    return out;
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
    return this.config.pauseWhenWatching && !activity.idle;
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
