/**
 * Which channels are allowed to be probed right now.
 *
 * Three problems this solves, all of which a plain "check everything on a timer"
 * model gets wrong:
 *
 * **Event channels.** A channel carrying a 2pm first pitch is genuinely dead at
 * 1pm. Probing it then records a dead stream, sinks it in the ranking, and the
 * next person to tune in at 2:05 gets the worst stream on the channel. These
 * should be probed *after* their EPG programme starts, not before.
 *
 * **Groups you never want touched.** Some groups are noise -- 24/7 PPV filler,
 * adult, VOD dumps. Burning a Provider C slot on them delays what matters.
 *
 * **Lineups that are already right.** Someone who has curated their channels in
 * Dispatcharr wants the order kept honest, not a second set of rules describing
 * what the channel already carries. `assigned` says so for a whole group.
 *
 * Policy is per group, because that is the granularity Dispatcharr already
 * organises by.
 */

export const ALWAYS = 'always';
export const NEVER = 'never';
export const AFTER_EPG_START = 'after_epg_start';
export const ASSIGNED = 'assigned';
export type PolicyMode = typeof ALWAYS | typeof NEVER | typeof AFTER_EPG_START | typeof ASSIGNED;
export const VALID_MODES: PolicyMode[] = [ALWAYS, NEVER, AFTER_EPG_START, ASSIGNED];

/**
 * Whether a rule-less channel in this mode is ranked off its own assignment.
 *
 * `always` is the default every unconfigured group resolves to, so it cannot
 * carry this: a fresh install with an empty rules file would probe the entire
 * catalogue on its first pass. Both modes here are ones an operator picked for
 * a named group, which is the consent the fallback needs. See
 * `assignedCandidates` in `runner.ts` for what it then ranks.
 */
export function assignmentIsRule(mode: PolicyMode): boolean {
  return mode === AFTER_EPG_START || mode === ASSIGNED;
}

export interface GroupPolicy {
  mode: PolicyMode;
  /**
   * Wait this long after the programme starts before probing. Providers rarely
   * have the feed up exactly on the hour, and probing at start+0 mostly records
   * a stream that is about to come good.
   */
  graceMinutes: number;
  /**
   * Stop probing this long after start; past it the event is under way and a
   * late joiner has already been served by an earlier pass.
   */
  windowMinutes: number;
  /**
   * Require the programme airing now to be marked live.
   *
   * Event EPGs do not leave an event channel blank until kickoff -- they fill
   * the gap with a countdown block. A real one, from a live install:
   *
   *     16:00Z-17:05Z  "Coming up: Minor League Baseball at 1:05 PM EDT"  is_live false
   *
   * Reading `start` off that says the event began at 16:00Z when first pitch is
   * at 17:05Z, so the gate opens an hour early and every probe lands on a feed
   * that is not up yet -- which is the exact failure `after_epg_start` exists to
   * prevent. Postgame blocks are the same problem after the fact. On the install
   * this was found on, 99 of the 109 event programmes airing at any moment were
   * countdown blocks, and the gate had never once held a channel back.
   *
   * On by default, because a source with per-programme times precise enough to
   * gate on is a source that marks its live programmes. An EPG that never sets
   * the flag holds every channel back with reason `no live programme` -- visible
   * in one glance at the pass tally rather than silent -- and turning this off
   * for that group restores the old behaviour.
   */
  requireLive: boolean;
  /**
   * For radio / music channels: streams carry audio only (no video track).
   * Probes treat audio streams as alive, skip video black-screen detection,
   * bypass the video bitrate floor, and score on audio quality.
   */
  audioOnly?: boolean;
}

export const DEFAULT_POLICY: GroupPolicy = {
  mode: ALWAYS,
  graceMinutes: 5,
  windowMinutes: 180,
  requireLive: true,
  audioOnly: false,
};

export interface Programme {
  tvgId: string;
  start: Date;
  end: Date;
  title: string;
  /** Whether the EPG marks this programme as airing live. */
  isLive: boolean;
}

export interface EpgRow {
  tvg_id?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  title?: string | null;
  is_live?: boolean | null;
}

export interface AllowResult {
  allowed: boolean;
  /**
   * Why, as a category: one of a closed set of short phrases.
   *
   * Kept free of anything channel-specific on purpose. A pass tallies held-back
   * channels by this string, and when the programme title was part of it every
   * distinct title became its own row -- one pass reported twelve separate
   * "event window passed" entries, one per fixture, where it meant to say
   * twenty-one channels were between events.
   */
  reason: string;
  /** The channel-specific part: which programme, and when it started. */
  detail?: string;
  /**
   * The earliest instant this verdict could turn into `allowed`, computed from
   * the rows in hand.
   *
   * The loop sleeps on this. A held-back channel is not a reason to come back
   * in a minute -- it is a reason to come back *when it opens*, and where the
   * clock alone decides that, the grid says exactly when.
   *
   * Left undefined whenever these rows cannot answer it, which is more often
   * than it looks: Dispatcharr's grid endpoint returns what is airing *now*
   * rather than a window of what is coming, so a channel showing a countdown
   * block has nothing here to say when the countdown ends -- the block's own
   * end is when it stops being described, not when the event starts. The caller
   * falls back to when it will next have new rows. An excluded group answers
   * nothing here either; only an operator changes that.
   */
  eligibleAt?: number;
}

/** Reason plus detail, for somewhere that is talking about one channel. */
export function describeVerdict(verdict: AllowResult): string {
  return verdict.detail ? `${verdict.reason} — ${verdict.detail}` : verdict.reason;
}

export interface GroupPattern extends GroupPolicy {
  /** Glob against the group name, e.g. "Auto | *". Case-insensitive. */
  pattern: string;
}

/** Compile a `*`/`?` glob to an anchored, case-insensitive regex. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

export class Eligibility {
  private readonly compiled: Array<{ test: RegExp; policy: GroupPattern }>;

  constructor(
    private readonly policies: Map<number, GroupPolicy>,
    private readonly fallback: GroupPolicy = DEFAULT_POLICY,
    patterns: GroupPattern[] = [],
  ) {
    this.compiled = patterns.map((policy) => ({ test: globToRegExp(policy.pattern), policy }));
  }

  /**
   * Resolve the policy for a group.
   *
   * An explicit per-group entry always wins; name patterns are the fallback.
   * Patterns matter because Dispatcharr *creates* groups over time -- a new
   * "Auto | Soccer | Whatever" appears on its own, and a static id list would
   * silently start probing it.
   */
  policyFor(groupId: number | null | undefined, groupName?: string): GroupPolicy {
    if (groupId !== null && groupId !== undefined) {
      const explicit = this.policies.get(groupId);
      if (explicit) return explicit;
    }
    if (groupName) {
      for (const { test, policy } of this.compiled) {
        if (test.test(groupName)) return policy;
      }
    }
    return this.fallback;
  }

  /**
   * `nextStarts` is optional because only the loop's sleep depends on it: every
   * `allowed` decision here is made from `programmes` alone, so a caller that
   * only wants the verdict can leave it out and get the same answer.
   */
  allows(
    groupId: number | null | undefined,
    tvgId: string,
    programmes: Map<string, Programme>,
    now: Date = new Date(),
    groupName?: string,
    upcoming?: UpcomingStarts,
  ): AllowResult {
    const policy = this.policyFor(groupId, groupName);
    if (policy.mode === NEVER) return { allowed: false, reason: 'group excluded' };
    // `assigned` differs from `always` only in where a rule-less channel's
    // candidates come from; the timing is the same, so there is nothing to gate.
    if (policy.mode === ALWAYS || policy.mode === ASSIGNED) return { allowed: true, reason: '' };

    // The soonest this channel could open, whatever is holding it back now: the
    // next programme that could actually pass this policy, plus the grace it
    // waits out anyway. Waking at the start itself would only re-hold it for
    // the length of the grace period and pay a second full pass to learn that.
    //
    // `requireLive` picks the index, and it matters: an event channel's grid is
    // mostly countdown and postgame filler, so the next start of *any*
    // programme is usually a block that will be held back again. Waking on the
    // next start marked live is a wake-up per event rather than one per block.
    const grace = policy.graceMinutes * 60_000;
    const nextStart = policy.requireLive
      ? upcoming?.nextLive.get(tvgId)
      : upcoming?.next.get(tvgId);
    const opensNext = nextStart === undefined ? undefined : nextStart + grace;

    const programme = programmes.get(tvgId);
    if (!programme) {
      // Falling back to "probe it" would defeat the whole point of the policy,
      // so it waits until there is EPG data.
      return { allowed: false, reason: 'no EPG data', eligibleAt: opensNext };
    }

    const title = programme.title ? `"${programme.title}"` : '';
    // Before the clock arithmetic, not after: a countdown block's `start` is the
    // moment the *countdown* began, so every window computed from it is a window
    // around the wrong instant. One reason for both sides of the event -- a
    // countdown block and a postgame block are the same answer, "not the event".
    if (policy.requireLive && !programme.isLive) {
      return {
        allowed: false,
        reason: 'no live programme',
        detail: title || undefined,
        // Deliberately not the block's own end. A countdown block ending does
        // not make this channel probeable -- it makes it a channel with no
        // programme listed, which is held back just the same. Only a programme
        // marked live opens it, and only new rows can carry one.
        eligibleAt: opensNext,
      };
    }

    const opens = programme.start.getTime() + grace;
    const closes = programme.start.getTime() + policy.windowMinutes * 60_000;
    if (now.getTime() < opens) {
      const at = `${programme.start.toISOString().slice(11, 16)}Z`;
      return {
        allowed: false,
        reason: 'before kickoff',
        detail: title ? `${at} ${title}` : at,
        eligibleAt: opens,
      };
    }
    if (now.getTime() > closes) {
      return {
        allowed: false,
        reason: 'event window passed',
        detail: title || undefined,
        // Nothing about *this* programme can reopen the window -- only the next
        // one starting can.
        eligibleAt: opensNext,
      };
    }
    return { allowed: true, reason: '' };
  }
}

/**
 * A boolean knob that has to survive JSON, a form post and a hand-edited rules
 * file, where `false` arrives as `false`, `"false"` or `0` depending on which.
 * Anything unset keeps the default rather than reading as off.
 */
function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return !/^(false|0|no|off)$/i.test(String(value).trim());
}

/** Parse `{"1571": "never", "3419": {"mode": "after_epg_start", ...}}`. */
export function parsePolicies(
  raw: unknown,
  warn: (message: string) => void = () => {},
): Map<number, GroupPolicy> {
  const out = new Map<number, GroupPolicy>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const groupId = Number(key);
    if (!Number.isInteger(groupId)) {
      warn(`ignoring non-numeric group id ${JSON.stringify(key)} in group policy`);
      continue;
    }
    let mode: string;
    let extra: Record<string, unknown> = {};
    if (typeof value === 'string') {
      mode = value;
    } else if (value && typeof value === 'object') {
      extra = value as Record<string, unknown>;
      mode = String(extra.mode ?? ALWAYS);
    } else {
      continue;
    }
    if (!VALID_MODES.includes(mode as PolicyMode)) {
      warn(`group ${groupId}: unknown mode ${JSON.stringify(mode)}, using ${ALWAYS}`);
      mode = ALWAYS;
    }
    out.set(groupId, {
      mode: mode as PolicyMode,
      graceMinutes: Number(extra.grace_minutes ?? DEFAULT_POLICY.graceMinutes),
      windowMinutes: Number(extra.window_minutes ?? DEFAULT_POLICY.windowMinutes),
      requireLive: bool(extra.require_live, DEFAULT_POLICY.requireLive),
      audioOnly: bool(extra.audio_only ?? extra.audioOnly, Boolean(DEFAULT_POLICY.audioOnly)),
    });
  }
  return out;
}

/** Parse `[{"pattern": "Auto | *", "mode": "never"}]`. */
export function parseGroupPatterns(
  raw: unknown,
  warn: (message: string) => void = () => {},
): GroupPattern[] {
  if (!Array.isArray(raw)) return [];
  const out: GroupPattern[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const pattern = typeof row.pattern === 'string' ? row.pattern.trim() : '';
    if (!pattern) continue;
    let mode = String(row.mode ?? ALWAYS);
    if (!VALID_MODES.includes(mode as PolicyMode)) {
      warn(`group pattern ${pattern}: unknown mode ${mode}, using ${ALWAYS}`);
      mode = ALWAYS;
    }
    out.push({
      pattern,
      mode: mode as PolicyMode,
      graceMinutes: Number(row.grace_minutes ?? DEFAULT_POLICY.graceMinutes),
      windowMinutes: Number(row.window_minutes ?? DEFAULT_POLICY.windowMinutes),
      requireLive: bool(row.require_live, DEFAULT_POLICY.requireLive),
      audioOnly: bool(row.audio_only ?? row.audioOnly, Boolean(DEFAULT_POLICY.audioOnly)),
    });
  }
  return out;
}

/** Index EPG rows to the programme airing now, keyed by tvg_id. */
export function currentProgrammes(rows: EpgRow[], now: Date = new Date()): Map<string, Programme> {
  const out = new Map<string, Programme>();
  const at = now.getTime();
  for (const row of rows) {
    if (!row.tvg_id || !row.start_time || !row.end_time) continue;
    const start = new Date(row.start_time);
    const end = new Date(row.end_time);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (start.getTime() <= at && at < end.getTime()) {
      out.set(row.tvg_id, {
        tvgId: row.tvg_id,
        start,
        end,
        title: row.title ?? '',
        isLive: row.is_live === true,
      });
    }
  }
  return out;
}

/**
 * When each channel's next programme starts, and when its next *live* one does.
 *
 * Two indexes because the answer depends on the policy asking. A group with
 * `requireLive` on is waiting for an event, and the next thing on an event
 * channel is usually another countdown block -- waking for that costs a full
 * pass to reach the same verdict. A group with it off is gated on start times
 * alone, so any programme will do.
 */
export interface UpcomingStarts {
  next: Map<string, number>;
  nextLive: Map<string, number>;
}

/**
 * Index the grid by what comes next for each tvg_id.
 *
 * The companion to `currentProgrammes`, and the reason a held-back channel can
 * be slept on rather than polled. `currentProgrammes` answers "what is airing",
 * which is what the gate needs; this answers "when does the next thing start",
 * which is what the gate's *waiting* needs -- a channel showing a countdown
 * block turns eligible when the event after it begins, and the grid says when.
 *
 * Only starts strictly in the future count, so the programme airing now is
 * never its own answer. Empty against a source that lists only what is airing,
 * which is what `current-programs` returns -- callers must still have an answer
 * for a miss rather than treating it as "never".
 */
export function nextProgrammeStarts(rows: EpgRow[], now: Date = new Date()): UpcomingStarts {
  const upcoming: UpcomingStarts = { next: new Map(), nextLive: new Map() };
  const at = now.getTime();
  const soonest = (into: Map<string, number>, tvgId: string, start: number): void => {
    const held = into.get(tvgId);
    if (held === undefined || start < held) into.set(tvgId, start);
  };
  for (const row of rows) {
    if (!row.tvg_id || !row.start_time) continue;
    const start = new Date(row.start_time).getTime();
    if (Number.isNaN(start) || start <= at) continue;
    soonest(upcoming.next, row.tvg_id, start);
    if (row.is_live === true) soonest(upcoming.nextLive, row.tvg_id, start);
  }
  return upcoming;
}
