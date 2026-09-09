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

/** What `probeIdleProviders` needs to decide which accounts to stay off. */
export interface LaneYielding {
  /** Lane key -> provider id. See `LaneBudgets.provider`. */
  providerOf: Map<string, number>;
  /** Lane key -> viewers Dispatcharr named this login for. See `LaneBudgets.attributed`. */
  attributedByLane: Map<string, number>;
  /**
   * Whether every live session was placed on a login this pass knows about.
   *
   * The attributed counts alone cannot answer this. Two viewers, one named and
   * one not, still leaves a non-empty busy set -- so the mode would yield the
   * provider it could see and cheerfully probe the one the second viewer might
   * be sitting on. "Somebody is unaccounted for" has to be asked separately
   * from "who is accounted for".
   */
  allSessionsPlaced: boolean;
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
  /**
   * Narrow the yield further: instead of staying off the watched account
   * entirely, use whatever connections it has spare beyond `watchedFreeSlots`.
   *
   * The provider somebody is watching is usually the best one -- it is sorted
   * to the top, which is why it is being watched -- so yielding it whole gives
   * up ranking on exactly the account that matters most, for as long as one
   * game lasts. An account with several connections can carry a probe and a
   * viewer at once; an account with one cannot, and falls out of this by
   * arithmetic rather than by being named, since it has nothing spare.
   *
   * Inert unless `probeIdleProviders` is on: without per-provider yielding
   * there is no "watched provider" to single out.
   */
  probeWatchedProvider: boolean;
  /**
   * Connections held free on the watched account, over and above its viewers.
   *
   * Bigger than `minFreeSlots` on purpose. A viewer changing channel needs a
   * slot for the new stream *before* the provider releases the old one, and
   * providers commonly hold a dead connection open for another half minute,
   * so the account somebody is actively driving needs more headroom than one
   * nobody is touching.
   */
  watchedFreeSlots: number;
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
  probeWatchedProvider: false,
  watchedFreeSlots: 2,
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
   * `yielding` is what makes `probeIdleProviders` possible, and it is one
   * argument rather than two because its halves are useless apart.
   * `providerOf` maps each lane back to its provider: lanes are per login, but
   * a viewer occupies the *account*, so yielding is decided one level up from
   * the lane the arithmetic runs on. `attributedByLane` is who Dispatcharr
   * actually named -- see `LaneBudgets.attributed` for why the ordinary viewer
   * counts cannot answer that question. Without both, the mode falls back to
   * pausing.
   *
   * The watched providers are dropped outright unless `probeWatchedProvider`
   * is on, in which case `sharedLanes` puts back whatever they can spare.
   */
  laneLimits(
    base: Map<string, number>,
    activity: Activity,
    viewersByLane: Map<string, number>,
    yielding?: LaneYielding,
  ): Map<string, number> {
    const out = new Map<string, number>();
    if (this.pausedByActivity(activity)) return out;

    const reserve = activity.idle ? 0 : this.config.minFreeSlots;
    const yielded = this.yieldedProviders(activity, yielding);
    if (yielded === 'all') return out;
    if (yielded === 'none' || !yielding) {
      for (const [lane, limit] of base) {
        const free = limit - (viewersByLane.get(lane) ?? 0) - reserve;
        if (free > 0) out.set(lane, free);
      }
      return out;
    }

    for (const [lane, limit] of base) {
      // A lane whose provider cannot be named is treated as watched. The point
      // of the mode is to stay off the account somebody is streaming from, and
      // a lane we cannot place might be it.
      const provider = yielding.providerOf.get(lane);
      if (provider === undefined || yielded.has(provider)) continue;
      // Attributed counts, not the generous ones. Reaching here means every
      // viewer was placed on a provider -- `yieldedProviders` fails closed
      // otherwise -- so the provider-wide fallback folded into `viewersByLane`
      // is not merely redundant, it is double-counting a session we have
      // already charged to somebody else. Left in, it takes a connection off
      // every lane the mode just decided was free, which is enough to close a
      // two-connection provider outright.
      const free = limit - (yielding.attributedByLane.get(lane) ?? 0) - reserve;
      if (free > 0) out.set(lane, free);
    }
    for (const [lane, free] of this.sharedLanes(base, yielded, yielding)) {
      out.set(lane, free);
    }
    return out;
  }

  /**
   * What the watched account may spare, for `probeWatchedProvider`.
   *
   * The reserve is taken once per *account*, not once per lane, and this is
   * the reason the method exists rather than being another branch in the loop
   * above. Lanes are per login and Podium treats their caps as independent
   * pools, which is fine while the arithmetic only ever hands out capacity the
   * provider agreed to. It stops being fine here: two logins on one account
   * with `max_streams` 5 each are one account with five connections far more
   * often than they are ten, so a per-lane reserve of two would reserve four
   * on paper and still let the pass open six probes against the five slots a
   * viewer is sitting in. Capacity is therefore read as the largest single
   * login's cap -- the conservative reading of "how big is this account" --
   * every viewer named anywhere on it is subtracted, and the reserve comes off
   * once.
   *
   * What is left is dealt out a slot at a time so several logins share the
   * work, each bounded by its own headroom: a 5-connection login and a
   * 2-connection one on the same account split three spare slots 2:1 rather
   * than the smaller login being handed capacity it does not have.
   */
  private sharedLanes(
    base: Map<string, number>,
    watched: Set<number>,
    yielding: LaneYielding,
  ): Map<string, number> {
    const out = new Map<string, number>();
    if (!this.config.probeWatchedProvider) return out;

    const lanesOf = new Map<number, string[]>();
    for (const lane of base.keys()) {
      const provider = yielding.providerOf.get(lane);
      // An unplaceable lane stays yielded even here. `yieldedProviders` has
      // already established that every *viewer* was placed; a lane that names
      // no provider is still a lane this cannot reason about.
      if (provider === undefined || !watched.has(provider)) continue;
      const lanes = lanesOf.get(provider);
      if (lanes) lanes.push(lane);
      else lanesOf.set(provider, [lane]);
    }

    for (const lanes of lanesOf.values()) {
      const cap = Math.max(...lanes.map((lane) => base.get(lane) ?? 0));
      const viewers = lanes.reduce(
        (sum, lane) => sum + (yielding.attributedByLane.get(lane) ?? 0),
        0,
      );
      let spare = cap - viewers - this.config.watchedFreeSlots;
      if (spare <= 0) continue;

      const headroom = new Map(
        lanes.map((lane) => [
          lane,
          Math.max(0, (base.get(lane) ?? 0) - (yielding.attributedByLane.get(lane) ?? 0)),
        ]),
      );
      const grants = new Map(lanes.map((lane) => [lane, 0]));
      for (let dealt = true; spare > 0 && dealt; ) {
        dealt = false;
        for (const lane of lanes) {
          if (spare <= 0) break;
          const grant = grants.get(lane) ?? 0;
          if (grant >= (headroom.get(lane) ?? 0)) continue;
          grants.set(lane, grant + 1);
          spare -= 1;
          dealt = true;
        }
      }
      for (const [lane, grant] of grants) {
        if (grant > 0) out.set(lane, grant);
      }
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
   * It reads `attributed` rather than the ordinary viewer counts on purpose.
   * Those fold in a per-provider figure derived from the streams on the
   * watched channel, and a channel normally carries one stream from every
   * provider -- so a single viewer marks every account busy, this returns the
   * whole set, and the mode yields everything while looking like it is working.
   * That was the first version, and on a live install it produced `lanes {}`
   * on every pass.
   *
   * Public because `Runner` asks the same question a second time to explain a
   * pause in words -- "every provider is busy" and "we cannot tell who is on
   * what" send an operator to different places, and restating the test at the
   * call site is how the two answers drift apart.
   */
  yieldedProviders(activity: Activity, yielding?: LaneYielding): 'none' | 'all' | Set<number> {
    if (activity.idle) return 'none';
    if (!this.config.pauseWhenWatching || !this.config.probeIdleProviders) return 'none';
    if (!yielding?.allSessionsPlaced) return 'all';

    const busy = new Set<number>();
    for (const [lane, viewers] of yielding.attributedByLane) {
      if (viewers <= 0) continue;
      const provider = yielding.providerOf.get(lane);
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
