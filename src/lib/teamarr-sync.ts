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
import { checkInputs } from './rule-check-inputs';
import { snapshot } from './server/state';
import type { Store } from './store';
import { checkRules, type RuleInput } from './teamarr';
import { TeamarrClient, type TeamarrRuleRow } from './teamarr-client';

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
  /** Present when nothing was pushed: the one sentence saying why. */
  reason?: string;
  /** Present when the push failed outright rather than being declined. */
  error?: string;
  rules?: { existing: number; generated: number; replaced: number; total: number };
  before?: SyncScore;
  after?: SyncScore;
  /** Whether the simulation had to skip rules it cannot evaluate. */
  approximate?: boolean;
}

export interface SyncOptions {
  /**
   * Run every check and report the outcome, but do not write.
   *
   * What the Quality page's preview uses, and the only honest way to answer
   * "what would the scheduled push do tonight" without doing it.
   */
  dryRun?: boolean;
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

  const scope = scopeFromConfig(config);
  const samples = store.qualitySamples();
  const profile = buildProfile(samples, { scope });

  if (profile.totalSamples < config.PODIUM_TEAMARR_MIN_SAMPLES) {
    return fail(
      `only ${profile.totalSamples} in-scope samples, and the floor is ` +
        `${config.PODIUM_TEAMARR_MIN_SAMPLES}. A few hours of samples still fit ` +
        `confident-looking rules; this is the guard against pushing them.`,
    );
  }

  const miner = mineNames(
    samples.filter((sample) => inScope(sample, scope)),
    profile.groups,
  );
  const generated = teamarrRules(profile, { consolidated: miner.passB.consolidated });
  if (generated.rules.length === 0) {
    return fail('the profile produced no rules worth pushing');
  }

  const client = new TeamarrClient(config.PODIUM_TEAMARR_URL);
  const existing = await client.rules();
  const merged = mergeTeamarrRules(existing, generated.rules) as TeamarrRuleRow[];

  // Scored against the same channels, from the same verdicts, in the same pass
  // -- see `checkInputs`. Two assemblies would compare two populations.
  const snap = await snapshot();
  const { channels, strategy } = checkInputs(snap, store);
  const before = checkRules(channels, existing as RuleInput[], strategy);
  const after = checkRules(channels, merged as RuleInput[], strategy);
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
