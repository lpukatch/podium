/**
 * Learned quality priors, and their export as Teamarr stream-ordering rules.
 *
 * The problem this solves is not "measure streams" -- `probe.ts` does that --
 * but "rank a stream nobody has ever measured". Event channels are built out
 * of streams that exist for one fixture: by the time a probe would be worth
 * paying for, the stream is being watched, and by the next morning it is gone
 * and its verdict has been swept with it. Probing harder cannot help, because
 * for those streams there is no *before* to probe in.
 *
 * What survives a fixture is where the stream came from. The provider account
 * and the quality token in its name are both visible without spending a
 * connection, and both are stable: the account that shipped a 6800kbps 1080p
 * feed last Saturday is running the same encoder this Saturday. So a bucket of
 * `(account, tier)` measurements, accumulated over months of ordinary passes,
 * predicts the stream that has not arrived yet -- and that prediction is
 * something a consumer with no probe of its own can act on.
 *
 * Teamarr is that consumer, and its scorer is additive: a stream's points are
 * the sum of every scoring rule it matches, with no way to write a conjunction.
 * That constrains the model rather than the other way round -- the export fits
 * one effect per account and one per tier, which is exactly the shape an
 * additive scorer can evaluate, instead of fitting per-bucket values it would
 * have no way to apply.
 */

import type { StoredQualitySample } from './store';

export type Tier = 'uhd' | 'fhd' | 'hd' | 'sd' | 'unknown';

/**
 * The tokens each tier is recognised by.
 *
 * One table, used for both halves of the job: bucketing a sample here and
 * writing the regex Teamarr matches with. They have to be the same predicate.
 * If Podium bucketed on a token scan Teamarr's regex would not reproduce, the
 * points would describe one population and select another -- and the failure
 * would be invisible, because both halves would look right on their own.
 *
 * Deliberately *not* `normalize()`'s tier, for that reason: that scan reads
 * the tail of a name and stops at the first word it does not recognise, so
 * "FHD | MLB Dodgers" has no tier there. Teamarr's regex is a search over the
 * whole name, so this is too.
 */
const TIER_TOKENS: Record<Exclude<Tier, 'unknown'>, string[]> = {
  uhd: ['UHD', '4K', '2160P', '2160I'],
  fhd: ['FHD', '1080P', '1080I'],
  hd: ['HD', '720P', '720I'],
  sd: ['SD', 'LQ', '576P', '576I', '480P', '480I', '360P'],
};

/** Highest first: "Sports HD 1080p" carries both tokens and is an fhd stream. */
export const TIERS: Tier[] = ['uhd', 'fhd', 'hd', 'sd', 'unknown'];

/**
 * The pattern for a tier, as both sides evaluate it.
 *
 * The boundaries are the whole reason this is generated rather than written
 * out: a bare `HD` matches inside `FHD` and `UHD`, which would put every
 * 1080p and 2160p stream in the install into the `hd` bucket and then hand
 * Teamarr a rule that does the same thing. `[A-Za-z0-9]` rather than a word
 * boundary, which sits happily between the `F` and the `HD`.
 */
export function tierPattern(tier: Exclude<Tier, 'unknown'>): string {
  return `(?<![A-Za-z0-9])(?:${TIER_TOKENS[tier].join('|')})(?![A-Za-z0-9])`;
}

const TIER_RE = new Map<Tier, RegExp>(
  (Object.keys(TIER_TOKENS) as Array<Exclude<Tier, 'unknown'>>).map((tier) => [
    tier,
    new RegExp(tierPattern(tier), 'i'),
  ]),
);

/** Which tier a stream name advertises, `unknown` when it advertises none. */
export function tierOf(name: string): Tier {
  for (const tier of TIERS) {
    if (tier === 'unknown') break;
    if (TIER_RE.get(tier)!.test(name)) return tier;
  }
  return 'unknown';
}

export interface Bucket {
  providerId: number;
  providerName: string;
  tier: Tier;
  groupId: number | null;
  groupName: string;
  /**
   * A video-less feed, held out of the video model.
   *
   * Its bitrate is an audio bitrate, so 200kbps here means a healthy radio
   * stream rather than a throttled television one. Summarised like any other
   * bucket so the numbers are visible, but never mixed into the fit.
   */
  audioOnly: boolean;
  /** Every sample in the bucket, dead ones included. */
  samples: number;
  /** Fraction that answered at all. */
  aliveRate: number;
  /** Fraction of the *alive* ones that were a black screen. */
  blackRate: number;
  /** How many carried a bitrate that was read rather than declared. */
  measuredSamples: number;
  medianBitrateKbps: number;
  p90BitrateKbps: number;
  medianHeight: number;
  /**
   * What a stream drawn from this bucket is worth, in kbps.
   *
   * The median discounted by how often the bucket delivers anything watchable.
   * A bucket whose live streams run at 8000kbps but which is dead a third of
   * the time is not an 8000kbps bucket to someone picking blind, and picking
   * blind is the entire use for this number.
   */
  effectiveKbps: number;
  lastSampledAt: number;
}

export interface Effect {
  /** Account name, tier, or group name. */
  key: string;
  samples: number;
  effectiveKbps: number;
  /** Difference from the install-wide baseline, in kbps. */
  deltaKbps: number;
}

export interface QualityProfile {
  generatedAt: number;
  totalSamples: number;
  /** Samples held out of the fit because the stream carries no video. */
  audioOnlySamples: number;
  /** Sample-weighted mean of every bucket in the fit. */
  baselineKbps: number;
  buckets: Bucket[];
  accounts: Effect[];
  tiers: Effect[];
  /**
   * Fitted the same way as the others, and deliberately not exported.
   *
   * Teamarr can only match a group on channel-source streams, so a group rule
   * would be inert for most of the catalogue. It is fitted anyway because
   * leaving it out of the *model* is what does the damage: without it, an
   * account's number silently absorbs the quality of whichever groups it
   * happens to carry. Published so the question "which of my groups are any
   * good" has an answer, which is the question this whole table started as.
   */
  groups: Effect[];
}

export interface ProfileOptions {
  /**
   * Below this a bucket is not summarised.
   *
   * A prior built from four samples is not a weak prior, it is noise with a
   * number attached -- and unlike a missing rule, a wrong one is acted on.
   */
  minSamples?: number;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index]!;
}

/** Summarise raw samples into per-bucket and per-dimension effects. */
export function buildProfile(
  samples: StoredQualitySample[],
  options: ProfileOptions = {},
): QualityProfile {
  const minSamples = options.minSamples ?? 20;

  const grouped = new Map<string, StoredQualitySample[]>();
  for (const sample of samples) {
    // The cell is all three factors at once. Summarising a coarser cell and
    // fitting from that would average the factors together before the fit gets
    // to separate them, which is the exact mistake the fit exists to avoid.
    const key = `${sample.providerId} ${sample.groupId ?? ''} ${sample.tier} ${sample.audioOnly}`;
    const list = grouped.get(key);
    if (list) list.push(sample);
    else grouped.set(key, [sample]);
  }

  const buckets: Bucket[] = [];
  for (const list of grouped.values()) {
    buckets.push(summarise(list));
  }
  buckets.sort((a, b) => b.effectiveKbps - a.effectiveKbps || b.samples - a.samples);

  const eligible = buckets.filter((bucket) => bucket.samples >= minSamples && !bucket.audioOnly);
  const { baselineKbps, accounts, tiers, groups } = fitEffects(eligible);

  return {
    generatedAt: Date.now(),
    totalSamples: samples.length,
    audioOnlySamples: samples.reduce((sum, sample) => sum + (sample.audioOnly ? 1 : 0), 0),
    baselineKbps,
    buckets,
    accounts,
    tiers,
    groups,
  };
}

function summarise(list: StoredQualitySample[]): Bucket {
  const alive = list.filter((sample) => sample.alive);
  const black = alive.filter((sample) => sample.black);
  // Only measured, alive, non-black samples describe a bitrate. A dead stream
  // reports 0 and a black one reports the bitrate of a slate; both would drag
  // a median towards a number no real viewer ever receives, and the rate they
  // occur at is already carried separately.
  const rated = alive
    .filter((sample) => sample.measured && !sample.black && sample.bitrateKbps > 0)
    .map((sample) => sample.bitrateKbps)
    .sort((a, b) => a - b);
  const heights = alive
    .filter((sample) => sample.height > 0)
    .map((sample) => sample.height)
    .sort((a, b) => a - b);

  const aliveRate = list.length === 0 ? 0 : alive.length / list.length;
  const blackRate = alive.length === 0 ? 0 : black.length / alive.length;
  const median = Math.round(percentile(rated, 0.5));

  return {
    providerId: list[0]!.providerId,
    providerName: list[0]!.providerName,
    tier: list[0]!.tier as Tier,
    groupId: list[0]!.groupId,
    groupName: list[0]!.groupName,
    audioOnly: list[0]!.audioOnly,
    samples: list.length,
    aliveRate,
    blackRate,
    measuredSamples: rated.length,
    medianBitrateKbps: median,
    p90BitrateKbps: Math.round(percentile(rated, 0.9)),
    medianHeight: Math.round(percentile(heights, 0.5)),
    effectiveKbps: Math.round(median * aliveRate * (1 - blackRate)),
    lastSampledAt: Math.max(...list.map((sample) => sample.sampledAt)),
  };
}

/**
 * Fit one effect per tier, group and account, each holding the others constant.
 *
 * The obvious way -- average every bucket a factor owns and call that its
 * number -- is wrong, and wrong in a way that looks fine until it is checked
 * against the buckets it came from. A factor's raw average is dominated by
 * whatever it happens to be paired with, so the comparison is never like for
 * like. Two measurements from a live install, both real:
 *
 *   - Averaged independently, four provider accounts spread over 366kbps,
 *     while their 1080p buckets alone spread over 3193. Each account was
 *     being judged on a different tier mix.
 *   - One account carried a radio package. Holding group constant moved its
 *     effect from +397 to -364 -- a sign flip, from "promote this provider"
 *     to "demote it", on the same underlying probes.
 *
 * So all three are fitted together by backfitting: each factor is repeatedly
 * re-estimated on what the others do not already explain, until the estimates
 * stop moving. Sequential elimination would do for two factors but not three,
 * because the second factor's estimate is itself biased by the third.
 *
 * `group` is fitted and then not exported. That is the point of including it:
 * it is a confounder, not a product. Teamarr can only match a group on
 * channel-source streams, so shipping a group rule would mostly do nothing --
 * but leaving group out of the *model* lets it contaminate the two effects
 * that do ship.
 */
function fitEffects(buckets: Bucket[]): {
  baselineKbps: number;
  accounts: Effect[];
  tiers: Effect[];
  groups: Effect[];
} {
  if (buckets.length === 0) {
    return { baselineKbps: 0, accounts: [], tiers: [], groups: [] };
  }

  const weightedMean = (rows: Array<{ value: number; weight: number }>): number => {
    const weight = rows.reduce((sum, row) => sum + row.weight, 0);
    if (weight === 0) return 0;
    return rows.reduce((sum, row) => sum + row.value * row.weight, 0) / weight;
  };

  const grand = weightedMean(
    buckets.map((bucket) => ({ value: bucket.effectiveKbps, weight: bucket.samples })),
  );

  const factors = [
    { of: (bucket: Bucket) => bucket.tier as string, effects: new Map<string, number>() },
    { of: (bucket: Bucket) => bucket.groupName, effects: new Map<string, number>() },
    { of: (bucket: Bucket) => bucket.providerName, effects: new Map<string, number>() },
  ];

  const members = factors.map((factor) => {
    const index = new Map<string, Bucket[]>();
    for (const bucket of buckets) {
      const key = factor.of(bucket);
      const list = index.get(key);
      if (list) list.push(bucket);
      else index.set(key, [bucket]);
    }
    for (const key of index.keys()) factor.effects.set(key, 0);
    return index;
  });

  /** What the other factors already account for, on top of the baseline. */
  const explainedBy = (bucket: Bucket, skip: number): number =>
    factors.reduce(
      (sum, factor, i) => (i === skip ? sum : sum + (factor.effects.get(factor.of(bucket)) ?? 0)),
      0,
    );

  // Converges in a handful of rounds on data this shape; the cap is only there
  // so a pathological design cannot spin.
  for (let round = 0; round < 20; round += 1) {
    let moved = 0;
    for (const [i, factor] of factors.entries()) {
      for (const [key, list] of members[i]!) {
        const estimate = weightedMean(
          list.map((bucket) => ({
            value: bucket.effectiveKbps - grand - explainedBy(bucket, i),
            weight: bucket.samples,
          })),
        );
        moved = Math.max(moved, Math.abs(estimate - (factor.effects.get(key) ?? 0)));
        factor.effects.set(key, estimate);
      }
      // Re-centre so the factors cannot drift against each other while their
      // sum stays put -- without this the split between them is arbitrary and
      // the exported numbers wander between runs on identical data.
      const centre = weightedMean(
        [...members[i]!.entries()].map(([key, list]) => ({
          value: factor.effects.get(key) ?? 0,
          weight: list.reduce((sum, bucket) => sum + bucket.samples, 0),
        })),
      );
      for (const key of factor.effects.keys()) {
        factor.effects.set(key, (factor.effects.get(key) ?? 0) - centre);
      }
    }
    if (moved < 1) break;
  }

  const baselineKbps = Math.round(grand);
  const asEffects = (index: Map<string, Bucket[]>, effects: Map<string, number>): Effect[] =>
    [...index.entries()]
      .map(([key, list]) => {
        const deltaKbps = Math.round(effects.get(key) ?? 0);
        return {
          key,
          samples: list.reduce((sum, bucket) => sum + bucket.samples, 0),
          effectiveKbps: baselineKbps + deltaKbps,
          deltaKbps,
        };
      })
      .sort((a, b) => b.deltaKbps - a.deltaKbps);

  return {
    baselineKbps,
    tiers: asEffects(members[0]!, factors[0]!.effects),
    groups: asEffects(members[1]!, factors[1]!.effects),
    accounts: asEffects(members[2]!, factors[2]!.effects),
  };
}

/** One rule in Teamarr's `stream-ordering-rules.json`. */
export interface TeamarrRule {
  type: 'm3u' | 'regex';
  value: string;
  /**
   * Ignored by Teamarr for `score` rules -- bands only apply to `priority`
   * ones -- but its importer rejects anything outside 1-99, so it is set to a
   * valid middle rather than left off.
   */
  priority: number;
  mode: 'score';
  points: number;
}

export interface ExportOptions extends ProfileOptions {
  /**
   * Points awarded per megabit of measured advantage over the baseline.
   *
   * Only the ratio between this and other people's hand-written rules matters,
   * since Teamarr sums them: at the default, a provider running 3Mbps above
   * the house average earns +30, which sits alongside a hand-written "+30 for
   * the home feed" as a comparable-strength opinion rather than drowning it.
   */
  pointsPerMbps?: number;
  /** Teamarr clamps to this either way; applied here so the file is honest. */
  maxPoints?: number;
}

export interface RulesExport {
  rules: TeamarrRule[];
  /** Not read by Teamarr -- context for whoever opens the file. */
  podium: {
    generatedAt: string;
    baselineKbps: number;
    pointsPerMbps: number;
    minSamples: number;
    note: string;
  };
}

function pointsFor(deltaKbps: number, pointsPerMbps: number, maxPoints: number): number {
  const points = Math.round((deltaKbps / 1000) * pointsPerMbps);
  return Math.max(-maxPoints, Math.min(maxPoints, points));
}

/**
 * The learned profile as scoring rules Teamarr's importer already accepts.
 *
 * One `m3u` rule per account and one `regex` rule per tier, each carrying that
 * dimension's distance from the baseline. A stream is then scored by the sum
 * of the two, which is the additive model Teamarr evaluates natively -- an
 * account 2Mbps above the house average and an `fhd` token worth another 1.5
 * come to +35 together, with no conjunction rule needed.
 *
 * `unknown` gets no rule on purpose. It is the reference level: a stream whose
 * name advertises nothing scores its account's effect alone, which is the
 * right answer when the name is the only thing there was to go on.
 */
export function teamarrRules(profile: QualityProfile, options: ExportOptions = {}): RulesExport {
  const pointsPerMbps = options.pointsPerMbps ?? 10;
  const maxPoints = options.maxPoints ?? 100_000;
  const minSamples = options.minSamples ?? 20;

  const rules: TeamarrRule[] = [];

  for (const account of profile.accounts) {
    if (account.samples < minSamples || !account.key.trim()) continue;
    const points = pointsFor(account.deltaKbps, pointsPerMbps, maxPoints);
    if (points === 0) continue;
    rules.push({ type: 'm3u', value: account.key, priority: 50, mode: 'score', points });
  }

  for (const tier of profile.tiers) {
    if (tier.key === 'unknown' || tier.samples < minSamples) continue;
    const points = pointsFor(tier.deltaKbps, pointsPerMbps, maxPoints);
    if (points === 0) continue;
    rules.push({
      type: 'regex',
      value: tierPattern(tier.key as Exclude<Tier, 'unknown'>),
      priority: 50,
      mode: 'score',
      points,
    });
  }

  return {
    rules,
    podium: {
      generatedAt: new Date(profile.generatedAt).toISOString(),
      baselineKbps: profile.baselineKbps,
      pointsPerMbps,
      minSamples,
      note:
        'Generated by Podium from measured stream quality. Points are the ' +
        "dimension's measured distance from this install's baseline, in " +
        'megabits, times pointsPerMbps.',
    },
  };
}

/**
 * Podium's rules folded into a rule set someone already has.
 *
 * Teamarr's import replaces the entire rule set rather than merging, so
 * handing over a bare export would silently delete every hand-written rule on
 * the instance. Merging here rather than asking the operator to splice two
 * JSON files by hand is the difference between a feature and a footgun.
 *
 * A generated rule replaces an existing one with the same `(type, value,
 * mode)` -- that is the same opinion, newly measured -- and leaves everything
 * else untouched, in its original order. So re-importing after a month of
 * fresh samples updates the numbers in place instead of stacking a second set
 * of points on top of the first.
 */
export function mergeTeamarrRules<T extends { type: string; value: string; mode?: string }>(
  existing: T[],
  generated: TeamarrRule[],
): Array<T | TeamarrRule> {
  const key = (rule: { type: string; value: string; mode?: string }): string =>
    `${rule.type} ${rule.value.trim().toLowerCase()} ${rule.mode ?? 'priority'}`;

  const byKey = new Map(generated.map((rule) => [key(rule), rule]));
  const used = new Set<string>();

  const merged: Array<T | TeamarrRule> = existing.map((rule) => {
    const replacement = byKey.get(key(rule));
    if (!replacement) return rule;
    used.add(key(rule));
    return replacement;
  });

  for (const rule of generated) {
    if (!used.has(key(rule))) merged.push(rule);
  }
  return merged;
}
