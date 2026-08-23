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

import { assignmentIsRule, globToRegExp, type PolicyMode } from './eligibility';
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
 * Which tier a stream's *measured* picture puts it in.
 *
 * The counterpart to `tierOf`, and the reason label accuracy can be checked at
 * all: one reads the provider's claim off the name, the other reads what the
 * probe actually received. Boundaries are generous on purpose -- 1088 and 1078
 * are both 1080p in practice, and a tier argument is not worth losing over
 * sixteen scan lines.
 */
export function tierOfHeight(height: number): Tier {
  if (height >= 1800) return 'uhd';
  if (height >= 900) return 'fhd';
  if (height >= 640) return 'hd';
  if (height > 0) return 'sd';
  return 'unknown';
}

/**
 * A token alternation with the boundaries that make it a token match.
 *
 * The left boundary is the whole reason this is generated rather than written
 * out: a bare `HD` matches inside `FHD` and `UHD`, which would put every
 * 1080p and 2160p stream in the install into the `hd` bucket and then hand
 * Teamarr a rule that does the same thing. `[A-Za-z0-9]` rather than a word
 * boundary, which sits happily between the `F` and the `HD`.
 *
 * The right boundary is deliberately weaker: `\d*` then "no letter". Providers
 * number their feeds -- `EPL01`, `EPL05`, `1080P60` -- and a symmetric
 * `(?![A-Za-z0-9])` rejects every one of them. Measured against three real
 * names from one provider's EPL group, the symmetric form matched one of the
 * three; this form matched all three. Letters still terminate, so `HD` does not
 * match inside `HDR`, which is the case the boundary exists for.
 */
function bounded(tokens: string[]): string {
  return `(?<![A-Za-z0-9])(?:${tokens.join('|')})\\d*(?![A-Za-z])`;
}

/** The pattern for a tier, as Podium's own scan evaluates it. */
export function tierPattern(tier: Exclude<Tier, 'unknown'>): string {
  return bounded(TIER_TOKENS[tier]);
}

/**
 * The same predicate, in the dialect Teamarr's importer is handed.
 *
 * Two accommodations, neither of which changes what is matched:
 *
 * `(?i)` because the exported pattern carries no flags of its own. Podium's
 * side compiles with `/i`; without the inline flag the exported copy is
 * case-sensitive, and every token here is written uppercase -- so a rule for
 * `1080P` would silently score nothing on the `1080p` that providers actually
 * write. Python takes the inline form; JavaScript does not, which is why this
 * is a separate function rather than something baked into the pattern both
 * sides share.
 *
 * The `.*` on each end because it is not knowable from a rules file whether
 * Teamarr calls `search`, `match` or `fullmatch`, and the three disagree about
 * an unanchored pattern: under `match` this pattern is pinned to offset 0 and
 * fires only on names that *begin* with the token. The wrapper is correct under
 * all three. The evidence it is needed is in the field -- a hand-written rule
 * in a live rule set reads `.*4K.*`, which is exactly what somebody writes
 * after discovering this the hard way.
 */
export function teamarrPattern(pattern: string): string {
  return `(?i).*${pattern}.*`;
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

/**
 * Which probes a prior is allowed to learn from.
 *
 * Every settled verdict is recorded, but not every verdict describes the thing
 * the export is for. A Teamarr rule ranks the streams behind a fixture channel,
 * and a catalogue is mostly not that: VOD dumps, 24/7 filler and entertainment
 * packages outnumber the sports groups on every install this was built against,
 * so an ungated fit measures the wrong population twice over. The baseline every
 * delta is quoted against becomes a film library's bitrate, and an account's
 * effect becomes a statement about its movie encoder -- on a rule that will only
 * ever be evaluated at kickoff.
 *
 * Two signals decide it, because they fail in opposite directions:
 *
 * - **The group's probing policy.** `after_epg_start` and `assigned` are modes
 *   an operator set on a named group, and `after_epg_start` in particular *is*
 *   the after-kickoff population -- the same declaration that decides when a
 *   channel may be probed decides whether its numbers are worth exporting. It
 *   needs no patterns and it cannot drift out of date, but it is recorded per
 *   sample, so it says nothing about history probed before this existed.
 * - **Name globs**, matched against the provider group and the channel group.
 *   The same `*`/`?` syntax the policy patterns already use, and the only lever
 *   that reaches backwards: an install with three months of samples can put its
 *   sports groups back in scope today rather than re-earning them.
 *
 * They combine as an admission with a veto. An `exclude` match rejects a sample
 * outright, whatever else says; otherwise an `include` match admits it, and
 * `eventOnly` admits anything an event policy covers. An empty scope admits
 * everything, which is what an install that has not configured this gets.
 */
export interface QualityScope {
  /**
   * Admit samples whose channel sat in a group set to `after_epg_start` or
   * `assigned` -- the groups an operator has already declared are events.
   */
  eventOnly: boolean;
  /** Globs against the provider group or channel group name. */
  include: string[];
  /** Globs that reject a sample however it was admitted. */
  exclude: string[];
}

/** Everything in scope: what an install that has not configured this gets. */
export const OPEN_SCOPE: QualityScope = { eventOnly: false, include: [], exclude: [] };

/**
 * The configured scope.
 *
 * Takes the three fields structurally rather than a `Config`, so `quality.ts`
 * stays a module about samples: everything here is testable without a boot.
 */
export function scopeFromConfig(config: {
  PODIUM_QUALITY_EVENT_ONLY: boolean;
  PODIUM_QUALITY_INCLUDE_GROUPS: string;
  PODIUM_QUALITY_EXCLUDE_GROUPS: string;
}): QualityScope {
  return {
    eventOnly: config.PODIUM_QUALITY_EVENT_ONLY,
    include: parseGlobs(config.PODIUM_QUALITY_INCLUDE_GROUPS),
    exclude: parseGlobs(config.PODIUM_QUALITY_EXCLUDE_GROUPS),
  };
}

/**
 * Split a written list of globs.
 *
 * Commas and newlines both, because the same string is typed into a settings
 * field one per line and passed as a query parameter comma-separated, and
 * having those mean different things would be a trap rather than a feature.
 */
export function parseGlobs(raw: string | string[] | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  const parts = Array.isArray(raw) ? raw : raw.split(/[,\n]/);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * Why a sample is or is not in scope.
 *
 * Reported rather than reduced to a boolean because "the table is empty" has
 * four very different causes -- a veto, a whitelist nothing matched, a
 * catalogue with no event groups configured, and history that predates the
 * recording -- and only the last one comes right on its own.
 */
export type ScopeVerdict = 'in' | 'excluded' | 'not-included' | 'not-event' | 'unrecorded';

interface CompiledScope {
  eventOnly: boolean;
  include: RegExp[];
  exclude: RegExp[];
}

function compileScope(scope: QualityScope): CompiledScope {
  return {
    eventOnly: scope.eventOnly,
    include: scope.include.map(globToRegExp),
    exclude: scope.exclude.map(globToRegExp),
  };
}

/** The names a glob is tried against: the stream's group and its channel's. */
function namesOf(sample: StoredQualitySample): string[] {
  return [sample.groupName, sample.channelGroupName].filter((name) => name !== '');
}

function judge(sample: StoredQualitySample, scope: CompiledScope): ScopeVerdict {
  const names = namesOf(sample);
  if (scope.exclude.some((test) => names.some((name) => test.test(name)))) return 'excluded';
  if (scope.include.some((test) => names.some((name) => test.test(name)))) return 'in';
  if (!scope.eventOnly) return scope.include.length > 0 ? 'not-included' : 'in';
  // Recorded before the channel's policy was: the sample is not out of scope so
  // much as unjudgeable, and saying so is what stops an upgrade reading as "the
  // priors were wrong" when it is really "these rows never carried the field".
  if (sample.policyMode === '') return 'unrecorded';
  return assignmentIsRule(sample.policyMode as PolicyMode) ? 'in' : 'not-event';
}

/** Whether one sample is in scope. Exported for callers that only want the bit. */
export function inScope(sample: StoredQualitySample, scope: QualityScope): boolean {
  return judge(sample, compileScope(scope)) === 'in';
}

/** What the gate did to a run of samples, as the UI and the export both report it. */
export interface ScopeSummary extends QualityScope {
  /** Samples the fit is built from. */
  inScope: number;
  /** Rejected by an `exclude` glob. */
  excluded: number;
  /** `include` is a whitelist and nothing matched. */
  notIncluded: number;
  /** The channel's group carries a policy, and it is not an event one. */
  notEvent: number;
  /** Probed before the policy was recorded -- reachable only by an `include`. */
  unrecorded: number;
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
  /** How many accounts contributed samples to this effect. */
  accounts: number;
  /**
   * Share of this effect's samples coming from its single largest account.
   *
   * The number that says whether an effect is about the thing it is named
   * after. A tier fitted entirely from one account is not a statement about
   * 1080p streams, it is that account's effect wearing a tier's label, and no
   * amount of backfitting can separate two factors that move together.
   * Trivially 1 for an account effect, which is the honest answer there.
   */
  topAccountShare: number;
}

/**
 * Whether an account's resolution labels mean anything.
 *
 * Podium measures the picture it receives, so it can hold a provider's own
 * claim up against it. That turns out to be worth more than the tier effect it
 * was a by-product of: on the install this was built against, streams named
 * `1080p` measured 720 sixty percent of the time, while streams naming no tier
 * at all were 1080 more often than the labelled ones. A tier token there is not
 * a weak signal, it is noise, and a Teamarr regex written against it scores
 * streams on a claim nobody is checking.
 */
export interface LabelAccuracy {
  providerId: number;
  providerName: string;
  /** In-scope samples that came back alive with a readable picture. */
  samples: number;
  /** Of those, how many carry a tier token in the name. */
  labelled: number;
  /** Of the labelled ones, how many measured the tier they claimed. */
  agreed: number;
  /** `agreed / labelled`, or null when nothing was labelled to check. */
  accuracy: number | null;
  /** `labelled / samples` -- an account that never labels cannot be wrong. */
  labelledShare: number;
  /** The most common way this account's labels are wrong, when they are. */
  commonestMiss: { claimed: string; measured: string; count: number } | null;
}

export interface QualityProfile {
  generatedAt: number;
  /**
   * Samples the fit is built from -- in scope, audio-only included.
   *
   * Not the number of rows held: `recordedSamples` is that, and the gap between
   * the two is the whole point of the gate. Reported this way round because
   * every other number on the profile describes the scoped population, so the
   * headline count has to as well or the page contradicts itself.
   */
  totalSamples: number;
  /** Every sample held, before the scope was applied. */
  recordedSamples: number;
  /**
   * In-scope samples carrying the stream's name.
   *
   * Nothing reads the names yet -- they are kept for mining name patterns, and
   * that has to wait for enough of them. This is the readiness number: samples
   * recorded before names were kept have none, so it climbs from zero as
   * ordinary passes run and says when there is something to mine.
   */
  namedSamples: number;
  /** What the gate admitted and rejected, and the rules it used. */
  scope: ScopeSummary;
  /** Samples held out of the fit because the stream carries no video. */
  audioOnlySamples: number;
  /** Sample-weighted mean of every bucket in the fit. */
  baselineKbps: number;
  buckets: Bucket[];
  accounts: Effect[];
  tiers: Effect[];
  /**
   * The strongest effect here, and the one worth exporting most.
   *
   * A group's effect routinely spans thousands of kbps where an account's spans
   * tens -- which stands to reason, since a group is how a provider organises
   * what it sells, and a sports package and a VOD dump are not the same product
   * at all.
   *
   * This was withheld from the export at first, on the belief that Teamarr
   * could match a group only on channel-source streams. A live rule set carrying
   * a hand-written `{"type": "group", "value": "Sports | DAZN US"}` says
   * otherwise, so it ships.
   */
  groups: Effect[];
  /** Per account, whether its own resolution labels survive being measured. */
  labelAccuracy: LabelAccuracy[];
}

export interface ProfileOptions {
  /**
   * Below this a bucket is not summarised.
   *
   * A prior built from four samples is not a weak prior, it is noise with a
   * number attached -- and unlike a missing rule, a wrong one is acted on.
   */
  minSamples?: number;
  /**
   * Which samples may be learned from. Defaults to all of them, so a caller
   * that has not thought about scope gets the pre-gate behaviour.
   */
  scope?: QualityScope;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index]!;
}

/**
 * Check each account's resolution labels against what the probe measured.
 *
 * Only alive samples with a readable height can testify -- a dead stream has no
 * picture to disagree with -- and audio-only feeds are excluded outright, since
 * a radio stream naming no resolution is not a provider being coy.
 */
function labelAccuracy(samples: StoredQualitySample[]): LabelAccuracy[] {
  const byAccount = new Map<
    number,
    {
      providerName: string;
      samples: number;
      labelled: number;
      agreed: number;
      misses: Map<string, number>;
    }
  >();

  for (const sample of samples) {
    if (sample.audioOnly || !sample.alive || sample.height <= 0) continue;
    let row = byAccount.get(sample.providerId);
    if (!row) {
      row = {
        providerName: sample.providerName,
        samples: 0,
        labelled: 0,
        agreed: 0,
        misses: new Map(),
      };
      byAccount.set(sample.providerId, row);
    }
    row.samples += 1;
    // `sample.tier` is what the name claimed at probe time, stored alongside
    // the measurement rather than recomputed, so a later change to the token
    // list cannot rewrite history.
    if (sample.tier === 'unknown' || sample.tier === '') continue;
    row.labelled += 1;
    const measured = tierOfHeight(sample.height);
    if (measured === sample.tier) row.agreed += 1;
    else {
      const key = `${sample.tier}>${measured}`;
      row.misses.set(key, (row.misses.get(key) ?? 0) + 1);
    }
  }

  return [...byAccount.entries()]
    .map(([providerId, row]) => {
      const worst = [...row.misses.entries()].sort((a, b) => b[1] - a[1])[0];
      const [claimed, measured] = worst ? worst[0].split('>') : [null, null];
      return {
        providerId,
        providerName: row.providerName,
        samples: row.samples,
        labelled: row.labelled,
        agreed: row.agreed,
        accuracy: row.labelled === 0 ? null : row.agreed / row.labelled,
        labelledShare: row.samples === 0 ? 0 : row.labelled / row.samples,
        commonestMiss: worst && claimed && measured ? { claimed, measured, count: worst[1] } : null,
      };
    })
    .sort((a, b) => b.labelled - a.labelled || b.samples - a.samples);
}

/** Summarise raw samples into per-bucket and per-dimension effects. */
export function buildProfile(
  samples: StoredQualitySample[],
  options: ProfileOptions = {},
): QualityProfile {
  const minSamples = options.minSamples ?? 20;
  const scope = options.scope ?? OPEN_SCOPE;
  const compiled = compileScope(scope);

  // Gated here rather than at record time, deliberately. A sample costs a row
  // and a probe that was being paid for anyway, and a scope is a guess an
  // operator revises -- narrowing it at the point of writing would make every
  // revision cost a month of waiting, and would hide the evidence that the
  // rule is wrong. Everything is kept; only the fit is selective.
  const summary: ScopeSummary = {
    ...scope,
    inScope: 0,
    excluded: 0,
    notIncluded: 0,
    notEvent: 0,
    unrecorded: 0,
  };
  const scoped: StoredQualitySample[] = [];
  for (const sample of samples) {
    const verdict = judge(sample, compiled);
    if (verdict === 'in') {
      summary.inScope += 1;
      scoped.push(sample);
    } else if (verdict === 'excluded') summary.excluded += 1;
    else if (verdict === 'not-included') summary.notIncluded += 1;
    else if (verdict === 'not-event') summary.notEvent += 1;
    else summary.unrecorded += 1;
  }

  const grouped = new Map<string, StoredQualitySample[]>();
  for (const sample of scoped) {
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
    totalSamples: scoped.length,
    recordedSamples: samples.length,
    namedSamples: scoped.reduce((sum, sample) => sum + (sample.streamName ? 1 : 0), 0),
    scope: summary,
    audioOnlySamples: scoped.reduce((sum, sample) => sum + (sample.audioOnly ? 1 : 0), 0),
    baselineKbps,
    buckets,
    accounts,
    tiers,
    groups,
    // Over everything in scope, not just the buckets that cleared `minSamples`.
    // Whether a label is honest is a question about the account's naming, and
    // holding it to the fit's threshold would hide exactly the accounts whose
    // labels are too sparse to trust.
    labelAccuracy: labelAccuracy(scoped),
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
 * `group` is fitted for two reasons, and the second one only became true
 * later. It is a confounder -- leaving it out of the model lets it contaminate
 * the other two effects, which is the sign flip above -- and it is also the
 * most valuable thing exported, now that Teamarr is known to match a group
 * rule on the streams that matter.
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
        const samples = list.reduce((sum, bucket) => sum + bucket.samples, 0);
        const byAccount = new Map<string, number>();
        for (const bucket of list) {
          byAccount.set(
            bucket.providerName,
            (byAccount.get(bucket.providerName) ?? 0) + bucket.samples,
          );
        }
        const top = Math.max(0, ...byAccount.values());
        return {
          key,
          samples,
          effectiveKbps: baselineKbps + deltaKbps,
          deltaKbps,
          accounts: byAccount.size,
          topAccountShare: samples === 0 ? 0 : top / samples,
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
  /**
   * The three Teamarr matches Podium can speak to.
   *
   * `m3u` and `group` are wholesale -- a stream either came from that account
   * or that group -- and `regex` is the only per-stream lever, matched against
   * the stream's name. Teamarr has others (`stats_metric`, `epg_match`,
   * `stream_type`); they are somebody else's opinion to write, and
   * `stats_metric` in particular already reads the bitrate Podium publishes to
   * Dispatcharr, so duplicating it here would score the same measurement twice.
   */
  type: 'm3u' | 'group' | 'regex';
  value: string;
  /**
   * Ignored by Teamarr for `score` rules -- bands only apply to `priority`
   * ones -- but its importer rejects anything outside 1-99. 99 to match the
   * convention of the hand-written rule sets this merges into, so a merged
   * file does not read as two authors disagreeing about a field neither of
   * them uses.
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
   * since Teamarr sums them. The default is set against a real rule set, whose
   * positives run +10 to +20 with a bitrate ladder at +20 per rung: 5 puts a
   * provider running 3Mbps above the house average at +15, an opinion of
   * comparable strength to the ones written by hand rather than one that
   * drowns them.
   */
  pointsPerMbps?: number;
  /**
   * Ceiling on any single generated rule.
   *
   * A prior must never outrank a measurement. Teamarr scores a probed stream
   * from `stats_metric` rules reading the bitrate Podium publishes -- a real
   * reading of that stream -- while everything generated here is an inference
   * about streams from the same provenance. The cap keeps the strongest
   * inference below the first rung of a measured ladder, so a stream that has
   * actually been measured at 10Mbps outranks one that merely comes from a
   * good account.
   */
  maxPoints?: number;
}

/**
 * The profile knobs as a URL carries them, clamped.
 *
 * Here rather than in the route so it can be tested against the URLs people
 * actually type. The absent case is checked before the number is parsed,
 * because `Number(null)` is `0` and `0` is finite: reading the parameter first
 * made every default unreachable. Measured on a live install, `?format=teamarr`
 * with no parameters -- the URL in the documentation -- returned an empty rule
 * set, because `pointsPerMbps` resolved to 0 and `teamarrRules` drops a rule
 * worth nothing; the profile meanwhile fitted at `minSamples` 1, over buckets
 * holding a single probe. The UI passes both explicitly, which is why the paths
 * people click were right while the ones they curl were not.
 */
export function profileQuery(params: URLSearchParams): {
  minSamples: number;
  pointsPerMbps: number;
} {
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const raw = params.get(key);
    // Blank as well as missing: `?pointsPerMbps=` is a parameter somebody meant
    // to fill in, not a request to score everything at zero.
    if (raw === null || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
  };
  return {
    minSamples: Math.round(number('minSamples', 20, 1, 100_000)),
    pointsPerMbps: number('pointsPerMbps', 5, 0, 10_000),
  };
}

export interface RulesExport {
  rules: TeamarrRule[];
  /** Not read by Teamarr -- context for whoever opens the file. */
  podium: {
    generatedAt: string;
    baselineKbps: number;
    pointsPerMbps: number;
    minSamples: number;
    /**
     * The population these points describe.
     *
     * Carried into the file because the numbers are otherwise unfalsifiable
     * once they leave: a +40 fitted on event channels and a +40 fitted on a
     * film library are the same two characters, and whoever opens this file in
     * three months is the person who needs to know which one it was.
     */
    scope: ScopeSummary;
    /** Tier rules withheld because one account supplied most of the evidence. */
    confoundedTiers: ConfoundedTier[];
    note: string;
  };
}

/** A tier rule the export declined to write, and the numbers behind that. */
export interface ConfoundedTier {
  tier: string;
  samples: number;
  accounts: number;
  topAccountShare: number;
  /** What it would have scored had it been exported. */
  wouldHaveScored: number;
}

/**
 * How much of a tier's evidence may come from one account before its rule is
 * withheld.
 *
 * A tier rule is a regex, and Teamarr runs it against every stream from every
 * provider. So unlike the other two dimensions it makes a claim that has to
 * travel: "streams whose names say 1080p are worth this much" is asserted about
 * accounts the number was never measured on. When one account supplies nearly
 * all the labelled samples -- because it is the only one that labels -- the
 * effect is that account's, and exporting it applies one provider's quality to
 * every other provider's occasional token.
 *
 * Measured on the install this came from: of four accounts, one labelled 100%
 * of its streams and the rest 10-15%, so `fhd` was fitted almost entirely from
 * that one account and read -2196 kbps. Its median bitrate was within 700 kbps
 * of the reference level; what actually differed was that its streams were
 * alive 54% of the time against 85%. The tier axis had become a liveness
 * measurement of a single provider, wearing a resolution's name.
 *
 * Accounts and groups are deliberately not guarded this way. Both are wholesale
 * set membership in Teamarr: a group rule fires only on that group's streams,
 * so if one account supplies all of them the rule is redundant with the account
 * rule rather than wrong about anyone.
 */
export const MAX_TIER_ACCOUNT_SHARE = 0.8;

function pointsFor(deltaKbps: number, pointsPerMbps: number, maxPoints: number): number {
  const points = Math.round((deltaKbps / 1000) * pointsPerMbps);
  return Math.max(-maxPoints, Math.min(maxPoints, points));
}

/**
 * The learned profile as scoring rules Teamarr's importer already accepts.
 *
 * One rule per account, per group and per tier, each carrying that dimension's
 * distance from the baseline. A stream is scored by the sum of the ones it
 * matches, which is the additive model Teamarr evaluates natively -- an account
 * 2Mbps above the house average, a group worth another 3 and an `fhd` token
 * worth another 1.5 add up, with no conjunction rule needed.
 *
 * The three are what Teamarr can actually match on, and they divide the way its
 * matcher does: `m3u` and `group` are wholesale set membership, `regex` is the
 * only thing that reads the stream's own name. That is also the order of how
 * much they are worth here -- a group's effect routinely spans thousands of
 * kbps where an account's spans tens -- which is why shipping the group matters
 * more than any refinement of the other two.
 *
 * `unknown` gets no rule on purpose. It is the reference level: a stream whose
 * name advertises nothing scores its account's effect alone, which is the
 * right answer when the name is the only thing there was to go on.
 */
export function teamarrRules(profile: QualityProfile, options: ExportOptions = {}): RulesExport {
  const pointsPerMbps = options.pointsPerMbps ?? 5;
  const maxPoints = options.maxPoints ?? 15;
  const minSamples = options.minSamples ?? 20;

  const rules: TeamarrRule[] = [];

  for (const account of profile.accounts) {
    if (account.samples < minSamples || !account.key.trim()) continue;
    const points = pointsFor(account.deltaKbps, pointsPerMbps, maxPoints);
    if (points === 0) continue;
    rules.push({ type: 'm3u', value: account.key, priority: 99, mode: 'score', points });
  }

  // Matched on the group's name exactly as the provider writes it, which is
  // what the samples were keyed on -- so the rule selects the population its
  // number was measured over, rather than one that merely resembles it.
  for (const group of profile.groups) {
    if (group.samples < minSamples || !group.key.trim()) continue;
    const points = pointsFor(group.deltaKbps, pointsPerMbps, maxPoints);
    if (points === 0) continue;
    rules.push({ type: 'group', value: group.key, priority: 99, mode: 'score', points });
  }

  const confounded: ConfoundedTier[] = [];
  for (const tier of profile.tiers) {
    if (tier.key === 'unknown' || tier.samples < minSamples) continue;
    const points = pointsFor(tier.deltaKbps, pointsPerMbps, maxPoints);
    if (points === 0) continue;
    if (tier.topAccountShare > MAX_TIER_ACCOUNT_SHARE) {
      // Withheld, not dropped. A rule that silently fails to appear is
      // indistinguishable from one nobody thought to write, and this is the
      // case where an operator most wants to know the export made a judgement.
      confounded.push({
        tier: tier.key,
        samples: tier.samples,
        accounts: tier.accounts,
        topAccountShare: Math.round(tier.topAccountShare * 100) / 100,
        wouldHaveScored: points,
      });
      continue;
    }
    rules.push({
      type: 'regex',
      value: teamarrPattern(tierPattern(tier.key as Exclude<Tier, 'unknown'>)),
      priority: 99,
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
      scope: profile.scope,
      confoundedTiers: confounded,
      note:
        'Generated by Podium from measured stream quality. Points are the ' +
        "dimension's measured distance from this install's baseline, in " +
        'megabits, times pointsPerMbps.' +
        (confounded.length > 0
          ? ` ${confounded.length} tier rule(s) withheld: one account supplied ` +
            'more than 80% of the samples, so the effect describes that account ' +
            'rather than the tier. See podium.confoundedTiers.'
          : ''),
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
