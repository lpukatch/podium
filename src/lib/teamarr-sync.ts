/**
 * Podium's rules, pushed into Teamarr.
 *
 * The last step of a chain that was otherwise complete. `quality.ts` fits the
 * rules, `miner.ts` mines the regexes, `mergeTeamarrRules` folds them into what
 * an operator already wrote and `teamarr.ts` scores the result against the
 * measurements -- and then somebody had to download a file, open Teamarr and
 * click Import. Four steps nobody repeats monthly, against numbers that are
 * re-fitted every pass.
 *
 * The reason it is safe to automate is not the HTTP call, which is trivial, but
 * that Podium can already answer the question an unattended write has to answer
 * first: *would this make the ordering worse?* `checkRules` simulates Teamarr's
 * scorer over Podium's own measurements, so the push runs it twice -- on the
 * rules Teamarr is running, and on the set about to replace them -- and refuses
 * on any regression. That check is the difference between a scheduled push and
 * a scheduled hazard.
 */

import type { Config } from './config';
import { mineNames } from './miner';
import { buildProfile, inScope, mergeTeamarrRules, scopeFromConfig, teamarrRules } from './quality';
import { applyMatches, checkInputs, scoredChannelIds } from './rule-check-inputs';
import { snapshot } from './server/state';
import type { Store } from './store';
import { checkRules, type RuleInput } from './teamarr';
import { TeamarrClient, type TeamarrRuleRow } from './teamarr-client';
import { describeSkew, type MatchCoverage, tryReadMatches } from './teamarr-match';

/** How a rule set scored, in the terms worth comparing two of them on. */
export interface SyncScore {
  channels: number;
  agreed: number;
  /** Channels led by a dead or black stream where a working one was available. */
  deadFirst: number;
  /** Measured bitrate given up across every disagreement, in kbps. */
  gapKbps: number;
}

export interface SyncOutcome {
  at: number;
  /** Whether the rules reached Teamarr. False covers both refusals and errors. */
  pushed: boolean;
  /**
   * Nothing was wrong; the guard just could not see enough to say so.
   *
   * Distinct from a refusal because it predicts the opposite thing about the
   * near future: a refusal is a decision that will hold until the rules or the
   * measurements change, while a deferral is a decision about *now* that is
   * likely to go the other way in a couple of hours. The scheduler reads this
   * to retry within the hour rather than tomorrow -- see `DEFER_RETRY_MS`.
   */
  deferred?: boolean;
  /** Present when nothing was pushed: the one sentence saying why. */
  reason?: string;
  /** Present when the push failed outright rather than being declined. */
  error?: string;
  rules?: { existing: number; generated: number; replaced: number; total: number };
  before?: SyncScore;
  after?: SyncScore;
  /** Whether the simulation had to skip rules it cannot evaluate. */
  approximate?: boolean;
  /**
   * How much of what Teamarr scores carries a stats reading, by match method.
   *
   * Absent when Teamarr could not be read. Recorded on the outcome rather than
   * left in a log because it is the only thing that says whether the exported
   * bitrate ladder is sorting the catalogue or sorting the part of it that
   * happened to sit still long enough to probe.
   */
  coverage?: MatchCoverage;
  /** That coverage in a sentence, when there is a skew worth naming. */
  skew?: string;
}

export interface SyncOptions {
  /**
   * Checked before any work starts and again immediately before the write.
   *
   * The loop passes its lock state: a worker that decided to push and then
   * lost the lock must not write a whole-set replacement on its way out while
   * the new holder is doing the same. Returning true abandons the push with a
   * reason and without an error -- an abandoned push is not a failure, and
   * recording it as one would light up the sync page for housekeeping.
   */
  shouldAbort?: () => boolean;
  /**
   * Run every check and report the outcome, but do not write.
   *
   * What the Quality page's preview uses, and the only honest way to answer
   * "what would the scheduled push do tonight" without doing it.
   */
  dryRun?: boolean;
  /**
   * Nobody is watching this one.
   *
   * Set by the worker's schedule and by nothing else. It gates the
   * population floor, which exists to stand in for the operator who is not
   * there -- see `underpowered`. A push somebody clicked is attended by
   * definition, and the Quality page offers no way past a deferral, so
   * applying the floor to it would strand them behind a guard whose whole
   * purpose they are already serving.
   */
  scheduled?: boolean;
  /**
   * Push even where the simulation says the ordering gets worse.
   *
   * Never set by the scheduler. It exists for the case the simulation cannot
   * see -- a rule set carrying `epg_match` or `stream_type`, which Podium
   * cannot evaluate and which therefore drags the comparison toward a
   * regression that may not be real.
   */
  force?: boolean;
}

function scoreOf(summary: {
  channels: number;
  agreed: number;
  deadFirst: number;
  gapKbps: number;
}): SyncScore {
  return {
    channels: summary.channels,
    agreed: summary.agreed,
    deadFirst: summary.deadFirst,
    gapKbps: summary.gapKbps,
  };
}

/**
 * Whether the proposed set is allowed to replace the current one.
 *
 * Two tests, and they are deliberately not the same one. A rise in `deadFirst`
 * is refused on its own, whatever the agreement did: a set can agree marginally
 * less while fixing the failure that actually reaches a viewer, and a channel
 * led by a dead stream is not a rounding error in a percentage; it is a black
 * screen.
 *
 * The agreement test is the one that needs care, because agreement is a *count
 * of channels* and channels are not equally wrong. `checkRules` records a
 * disagreement whenever the rules' first pick is not the measurements' first
 * pick, including where the two streams are indistinguishable -- and on a real
 * catalogue that case is not rare but typical, because the near-duplicates a
 * channel carries are usually the same broadcast from two providers. Measured
 * on a live install: of six channels a push flipped to disagreeing, three had
 * the rules picking a stream of *equal or higher* bitrate than the one the
 * measurements preferred, and two more differed by about 10 kbps out of seven
 * megabits. The set gave up 220 kbps *less* in total. Counting those six as a
 * regression refuses a push that is, by the only measure that reaches a viewer,
 * slightly better.
 *
 * So agreement has to fall *and* the ordering has to give up more measured
 * bitrate for it to count. `gapKbps` supplies the magnitude the count throws
 * away: it sums `max(0, podium - teamarr)` over the disagreements, so a channel
 * where the rules pick something no worse contributes exactly nothing. Both
 * numbers come from one pass over one population -- see `checkInputs` -- so the
 * delta is a property of the rules and not of how many streams got measured
 * last night.
 *
 * Note what this does *not* do: gap alone still gates nothing. A set that gives
 * up more bitrate while agreeing at least as often has moved streams the
 * measurements do not rank, and that is the operator's call, not a refusal.
 *
 * Ties pass. A push that changes nothing measurable still carries fresher
 * numbers, and refusing it would mean an install whose catalogue is stable
 * never updates at all.
 */
export function regression(before: SyncScore, after: SyncScore): string | null {
  if (after.deadFirst > before.deadFirst) {
    return `it would put a dead or black stream first on ${after.deadFirst} channels, up from ${before.deadFirst}`;
  }
  if (after.agreed < before.agreed && after.gapKbps > before.gapKbps) {
    return (
      `it would agree with the measurements on ${after.agreed} of ${after.channels} ` +
      `channels, down from ${before.agreed}, and give up ` +
      `${after.gapKbps - before.gapKbps} kbps more`
    );
  }
  return null;
}

/** How far back to look for evidence that this install gets busier than it is now. */
export const PEAK_WINDOW_MS = 7 * 86_400_000;

/**
 * How long a scheduled push may go without landing before the relative bar
 * stands down.
 *
 * The same seven days the peak itself is measured over. A bar set at a
 * fraction of the recent peak is a bet that this install's busy spell will
 * come round again; an install whose big population came and went without a
 * push -- cancelled fixtures, a catalogue that shrank mid-week -- must not
 * wait on a bet forever. Past this point the bar falls back to the absolute
 * floor and whatever population next clears it ships the rules.
 */
export const STALE_AFTER_MS = 7 * 86_400_000;

/**
 * The population a scheduled push must clear before it may write.
 *
 * Two parts, and the second is what makes the first incomplete. The absolute
 * floor answers "is there enough to check at all"; it cannot answer "is this
 * the check this install is capable of" -- an event-driven catalogue can run
 * twenty orderable channels on a quiet Tuesday and a hundred when the fixtures
 * are on, and a push that lands at the floor has been checked on a fifth of
 * what a day's patience would have bought.
 *
 * The fraction closes that: the bar rises to a share of the largest population
 * the install actually reached recently, so the push drifts towards whatever
 * this install's own busy spell is -- a Saturday, a nightly window, a monthly
 * event -- without any schedule being written down. The rhythm differs per
 * install and is unknown to this code; the peak is measured, not configured,
 * which is the whole reason the bar can be shared between them.
 *
 * At a fraction of zero -- the default -- this returns the absolute guard's
 * own answer unchanged, so an install that has not opted in behaves exactly
 * as `underpowered` always has.
 */
export function populationBar(
  floor: number,
  peak: number,
  fraction: number,
  lastPushAgeMs: number,
): number {
  const base = Math.min(floor, peak);
  if (fraction <= 0 || peak <= 0) return base;
  if (lastPushAgeMs >= STALE_AFTER_MS) return base;
  return Math.max(base, Math.ceil(fraction * peak));
}

/**
 * How soon a deferred push tries again.
 *
 * Short enough that a push deferred at breakfast still happens the same day
 * rather than surrendering its turn to tomorrow -- which is the trap a plain
 * refusal would fall into, since due-ness is measured from the last attempt and
 * a deferral is an attempt. Long enough that an install which is simply quiet
 * costs one catalogue fetch an hour rather than one every thirty seconds.
 */
export const DEFER_RETRY_MS = 3_600_000;

/**
 * Whether the guard saw enough channels for its verdict to mean anything.
 *
 * `regression` compares two counts of channels, and says nothing about how many
 * there were. That is the gap this closes. `checkRules` only scores channels
 * Teamarr orders that currently carry two probed streams, and an event
 * channel's streams do not outlast the fixture -- so the population is a
 * function of when the push fires, not of the rules being pushed. Two channels
 * agreeing identically before and after produce exactly the same "no
 * regression" as two hundred, and the difference never reaches the operator.
 *
 * The floor is `min(floor, peak)` rather than `floor`, and that is the whole
 * design. An absolute floor asks every install to be big, so one that never has
 * twenty orderable channels would defer at every attempt, retry hourly forever
 * and never push again -- turning a safety check into an outage. Comparing
 * against what this install has actually reached in the last week separates the
 * two cases the count alone conflates: a catalogue of hundreds seen at its low
 * point, which is worth waiting out, and a small install seen at its normal
 * size, which is as good as its evidence will ever get.
 *
 * A `peak` of zero -- nothing checked yet -- lets the push through. There is no
 * evidence of a fuller population to wait for, and a first push blocked by the
 * absence of the history that only pushing produces would never unblock.
 */
export function underpowered(channels: number, floor: number, peak: number): string | null {
  const wanted = Math.min(floor, peak);
  if (channels >= wanted) return null;
  return (
    `the ordering could only be checked on ${channels} of the ${peak} channels ` +
    `this install reaches, which is too thin to tell a safe push from a bad one`
  );
}

/**
 * Fit, merge, check and push.
 *
 * Order matters and is not arbitrary: everything that can refuse the push
 * happens before anything is written, so a refusal always leaves Teamarr
 * running exactly what it was running before.
 */
export async function syncToTeamarr(
  store: Store,
  config: Config,
  options: SyncOptions = {},
): Promise<SyncOutcome> {
  const at = Date.now();
  const fail = (reason: string): SyncOutcome => ({ at, pushed: false, reason });

  if (!config.PODIUM_TEAMARR_URL.trim()) {
    return fail('no Teamarr URL is configured');
  }

  // Before anything expensive -- a lost lock is a reason to do none of it.
  if (options.shouldAbort?.()) {
    return fail('the worker no longer holds the lock; nothing was pushed');
  }

  const scope = scopeFromConfig(config);
  const samples = store.qualitySamples();
  const scoped = samples.filter((sample) => inScope(sample, scope));

  if (scoped.length < config.PODIUM_TEAMARR_MIN_SAMPLES) {
    return fail(
      `only ${scoped.length} in-scope samples, and the floor is ` +
        `${config.PODIUM_TEAMARR_MIN_SAMPLES}. A few hours of samples still fit ` +
        `confident-looking rules; this is the guard against pushing them.`,
    );
  }

  // Assembled before anything below it, and not only because everything below
  // it scores what it produces. The population floor used to sit behind the
  // profile fit, the miner, the rules fetch and the per-channel match read --
  // minutes of fitting and a sweep that makes Teamarr refresh its stats cache,
  // all to compute a channel count whose only role was to say "come back in an
  // hour". Ninety-six per cent of scheduled attempts on a live install were
  // deferrals; each one paid for the whole pipeline to decline. The count needs
  // the verdicts and nothing else, so the guard is asked here, before any of
  // that runs -- and the assembly is reused below rather than repeated, because
  // a second assembly is the comparison bug `checkInputs` exists to prevent.
  const snap = await snapshot();
  const { channels, strategy } = checkInputs(snap, store);

  // Asked before the fitting as well as before the write, for the same reason
  // it is asked before the write: a regression found on a population this thin
  // is the same unreliable reading as the agreement that produced it. Deferring
  // re-asks the question when the answer is worth having, where refusing would
  // bank the doubtful one -- and deferring *early* re-asks it without having
  // spent the fitting on an answer nobody will use.
  if (!options.force && (options.scheduled || options.dryRun)) {
    const peak = store.peakManagedChannels(at - PEAK_WINDOW_MS);
    // The last *push*, not the last attempt -- a deferral is an attempt too,
    // and measuring staleness from one would keep the escape hatch permanently
    // armed on an install that defers hourly but has pushed recently.
    const lastPush = store.teamarrSyncLog().find((row) => row.pushed);
    const thin = underpowered(
      scoredChannelIds(channels).length,
      populationBar(
        config.PODIUM_TEAMARR_MIN_CHANNELS,
        peak,
        config.PODIUM_TEAMARR_PEAK_FRACTION,
        at - (lastPush?.ranAt ?? 0),
      ),
      peak,
    );
    if (thin) return { at, pushed: false, deferred: true, reason: `deferred: ${thin}` };
  }

  const profile = buildProfile(samples, { scope });
  const miner = mineNames(scoped, profile.groups);
  const generated = teamarrRules(profile, { consolidated: miner.passB.consolidated });
  if (generated.rules.length === 0) {
    return fail('the profile produced no rules worth pushing');
  }

  const client = new TeamarrClient(config.PODIUM_TEAMARR_URL);
  const existing = await client.rules();
  const merged = mergeTeamarrRules(existing, generated.rules) as TeamarrRuleRow[];

  // Teamarr's own attach-time state, for the channels about to be scored. Read
  // once and applied to both sides, because a rule set carrying `epg_match`
  // that can be evaluated on one side and not the other is not a comparison.
  const match = await tryReadMatches(client, scoredChannelIds(channels));
  if (match.known) applyMatches(channels, match.index);

  const before = checkRules(channels, existing as RuleInput[], strategy, {
    matchKnown: match.known,
  });
  const after = checkRules(channels, merged as RuleInput[], strategy, { matchKnown: match.known });
  const approximate = before.summary.approximate || after.summary.approximate;

  const outcome: SyncOutcome = {
    at,
    pushed: false,
    rules: {
      existing: existing.length,
      generated: generated.rules.length,
      replaced: existing.length + generated.rules.length - merged.length,
      total: merged.length,
    },
    before: scoreOf(before.summary),
    after: scoreOf(after.summary),
    approximate,
    coverage: match.known ? match.coverage : undefined,
    skew: match.known ? (describeSkew(match.coverage) ?? undefined) : undefined,
  };

  // Only where there was something to compare. An install whose channels carry
  // no verdicts yet scores 0 against 0, which is not evidence of anything.
  if (!options.force && before.summary.channels > 0) {
    const worse = regression(outcome.before!, outcome.after!);
    if (worse) return { ...outcome, reason: `refused: ${worse}` };
  }

  if (options.dryRun) {
    return { ...outcome, reason: 'preview only, nothing was written' };
  }

  // The push is the one irreversibly shared thing this function does, and the
  // world it decided in -- lock held, rules fitted -- is minutes stale by the
  // time it gets here. A deposed worker writing while the new holder writes
  // the same set is a race with no winner, so the caller's state is asked once
  // more, at the door.
  if (options.shouldAbort?.()) {
    return fail('the worker no longer holds the lock; nothing was pushed');
  }

  try {
    await client.putRules(merged);
  } catch (error) {
    return { ...outcome, error: String(error).slice(0, 300) };
  }

  // Recorded only after the write lands, so the stored set is what Teamarr is
  // actually running -- which is what every later pass scores against.
  store.saveTeamarrRules(merged);
  return { ...outcome, pushed: true };
}
