/**
 * When the automatic soak sweep may run, and what it should spend its time on.
 *
 * Kept apart from the runner because both halves are arithmetic worth testing
 * on their own: a window that wraps past midnight, and a priority order over a
 * catalogue far larger than any night can cover.
 *
 * ## Why there is a window at all
 *
 * A soak is the one measurement here that is expensive in the dimension the
 * whole codebase is careful about. A probe holds a provider connection for
 * seconds; a soak holds one for minutes, because the failure it looks for takes
 * tens of seconds to appear. On the install this was built against that is 13
 * connection slots across five accounts -- and 284 of the 449 managed channels
 * sit behind one account with three. Spending those on soaks while somebody
 * might want to watch television is not a trade anybody would make, so the
 * sweep is confined to hours the operator names.
 *
 * The window governs the *sweep* only. A soak somebody asked for by pressing a
 * button is queued like a re-check and drained whenever there is spare capacity
 * -- it already waits for nobody to be watching, which is the same protection
 * the window exists to provide, applied continuously rather than by the clock.
 *
 * ## Why it cannot cover everything, and what it does instead
 *
 * 3,318 streams on managed channels, at three minutes each, is 166 hours of
 * connection time. Eight usable lanes turn that into about 21 hours of
 * wall clock -- seven nights of a three-hour window for one full sweep, which
 * is inside the fortnight the ledger remembers, but only just.
 *
 * So the sweep is ordered rather than exhaustive, and `maxPerChannel` bounds it
 * by the only thing that matters: a stream ranked fifth of six will never be
 * served to anybody, so measuring whether it holds changes nothing. The top
 * few per channel are where a demotion can actually alter what a viewer gets.
 * At the default of three that is ~1,350 streams, or about three nights.
 */

import type { StabilityRecord } from './stability';

/** Minutes past midnight, local time. */
export interface SoakWindow {
  startMin: number;
  endMin: number;
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Parse `HH:MM-HH:MM` into minutes past midnight.
 *
 * Returns null for anything it cannot read, including the empty string, and
 * that null is the "off" state rather than an error -- a malformed window must
 * leave the sweep switched off rather than default it to some window nobody
 * chose. A range whose ends are equal is also null: "03:00-03:00" is more
 * likely a half-finished edit than a request to soak for twenty-four hours.
 */
export function parseSoakWindow(spec: string): SoakWindow | null {
  const [rawStart, rawEnd, ...rest] = spec.trim().split('-');
  if (rest.length > 0 || rawStart === undefined || rawEnd === undefined) return null;
  const start = HHMM.exec(rawStart.trim());
  const end = HHMM.exec(rawEnd.trim());
  if (!start || !end) return null;
  const startMin = Number(start[1]) * 60 + Number(start[2]);
  const endMin = Number(end[1]) * 60 + Number(end[2]);
  if (startMin === endMin) return null;
  return { startMin, endMin };
}

/** Minutes past local midnight for a given instant. */
function minutesOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * Whether the sweep may run now.
 *
 * Wrapping past midnight is the normal case, not the edge one -- the hours
 * nobody watches television are `22:00-04:00` far more often than they are
 * `02:00-05:00` -- so the wrapped form is handled first-class rather than
 * rejected.
 */
export function soakWindowOpen(spec: string, now: Date = new Date()): boolean {
  const window = parseSoakWindow(spec);
  if (!window) return false;
  const minute = minutesOfDay(now);
  return window.startMin < window.endMin
    ? minute >= window.startMin && minute < window.endMin
    : minute >= window.startMin || minute < window.endMin;
}

/**
 * Minutes until the window shuts, or 0 when it is not open.
 *
 * What bounds the queue: a pass near the end of a window must not start more
 * soaks than it can finish inside it, or the sweep runs on into the morning
 * holding connections somebody now wants.
 */
export function minutesLeftInWindow(spec: string, now: Date = new Date()): number {
  const window = parseSoakWindow(spec);
  if (!window || !soakWindowOpen(spec, now)) return 0;
  const minute = minutesOfDay(now);
  const left =
    window.startMin < window.endMin
      ? window.endMin - minute
      : minute >= window.startMin
        ? 24 * 60 - minute + window.endMin
        : window.endMin - minute;
  return Math.max(0, left);
}

/** One stream the sweep could spend a slot on. */
export interface SoakCandidate {
  streamId: number;
  channelId: number;
  /** Its place in the channel's current order; 0 is what Dispatcharr serves first. */
  slot: number;
}

export interface SoakPlanOptions {
  candidates: SoakCandidate[];
  /** What the ledger already knows, from `Store.stabilityRecords`. */
  records: Map<number, StabilityRecord>;
  /**
   * How deep into each channel's order to bother measuring. 0 means every
   * stream, which is honest but takes several times as many nights.
   */
  maxPerChannel: number;
  /** A stream observed more recently than this is left alone. */
  maxAgeMs: number;
  now: number;
  /** How many the caller has room for. */
  limit: number;
}

/**
 * The streams worth soaking next, best use of a slot first.
 *
 * Never-observed before stale, then oldest-first, then by slot. Coverage leads
 * because the term this feeds gives full marks to a stream it knows nothing
 * about: an unmeasured stream is not merely unranked, it is ranked *as though
 * it holds*, so the first measurement of a stream is worth more than the
 * hundredth of another. Slot breaks the ties that remain, which keeps a
 * channel's own order meaningful inside a night that cannot finish it.
 */
export function planSoaks(options: SoakPlanOptions): number[] {
  const { candidates, records, maxPerChannel, maxAgeMs, now, limit } = options;
  if (limit <= 0) return [];

  const eligible = candidates.filter((candidate) => {
    if (maxPerChannel > 0 && candidate.slot >= maxPerChannel) return false;
    const record = records.get(candidate.streamId);
    if (!record) return true;
    // Observed recently enough that another three minutes would tell us
    // nothing we do not already have.
    return now - record.lastSeenAt >= maxAgeMs;
  });

  return eligible
    .sort((a, b) => {
      const ra = records.get(a.streamId);
      const rb = records.get(b.streamId);
      const seen = (ra ? 1 : 0) - (rb ? 1 : 0);
      if (seen !== 0) return seen;
      const age = (ra?.lastSeenAt ?? 0) - (rb?.lastSeenAt ?? 0);
      if (age !== 0) return age;
      if (a.slot !== b.slot) return a.slot - b.slot;
      return a.streamId - b.streamId;
    })
    .slice(0, limit)
    .map((candidate) => candidate.streamId);
}

/**
 * How many soaks fit in the time left, given the lanes free to run them.
 *
 * Deliberately pessimistic by a whole soak: `Math.floor` of the division means
 * a pass never queues work whose last job would be cut off by the window
 * closing. Overrunning is the failure that matters -- it is connections held
 * into the morning -- and under-filling by one merely leaves three minutes of a
 * window unused.
 */
export function soaksThatFit(minutesLeft: number, lanes: number, soakSeconds: number): number {
  if (minutesLeft <= 0 || lanes <= 0 || soakSeconds <= 0) return 0;
  const perLane = Math.floor((minutesLeft * 60) / soakSeconds);
  return Math.max(0, perLane * lanes);
}

/**
 * How long a one-round soak pass allows for its jobs to get started.
 *
 * Covers lane stagger and dispatch, which on a full lane set is a few seconds,
 * with plenty to spare. It is not a measurement tolerance -- a soak's length is
 * enforced on the wall clock inside `soakStream` -- only the window in which a
 * job may still *begin* and finish before the round is considered over.
 */
export const SOAK_DISPATCH_SLACK_MS = 60_000;

/**
 * The deadline budget for one round of soaks: one soak per free slot.
 *
 * Sized to the longest soak in the round plus `SOAK_DISPATCH_SLACK_MS`. It used
 * to be exactly one soak length, and a job refuses to start unless a whole
 * soak still fits before the deadline -- so the moment a single millisecond had
 * passed, nothing fitted. On the first real run, five of six queued streams
 * were skipped pass after pass; only one that happened to start in the same
 * millisecond the deadline was set ever ran.
 *
 * `rowSeconds` are the per-request lengths, null or absent meaning "use the
 * setting". A row asking for longer than the setting still has to fit, or it
 * would be skipped forever outside the window.
 */
export function oneRoundBudgetMs(
  defaultSeconds: number,
  rowSeconds: Array<number | null | undefined>,
): number {
  const longest = Math.max(
    defaultSeconds,
    ...rowSeconds.map((seconds) => (seconds && seconds > 0 ? seconds : 0)),
  );
  return longest * 1_000 + SOAK_DISPATCH_SLACK_MS;
}
