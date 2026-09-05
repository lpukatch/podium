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
// Type-only, and deliberately: `miner.ts` imports real values from here, so a
// value import in this direction would be a runtime cycle. Erased at compile.
import type { ConsolidatedToken } from './miner';
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
export function bounded(tokens: string[]): string {
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
   * For a tier: its distance from the `unknown` reference level. Null for the
   * other two dimensions, which have no designated reference.
   *
   * `deltaKbps` is measured against the install baseline, which the fit
   * re-centres so the *weighted mean of all tiers* is zero. That is the right
   * centre for the model and the wrong one for the export, and the gap between
   * them was silently costing points. Teamarr writes no rule for an unlabelled
   * stream, so an unlabelled stream scores 0 from the tier dimension -- which
   * makes the honest exported number for `fhd` its distance from *unlabelled*,
   * not from the mean. On the install this was found on, `unknown` sat at +988
   * and `fhd` at -2937, so the export understated the difference between them
   * by very nearly a megabit.
   */
  vsReferenceKbps: number | null;
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

/**
 * Where this install's watchable streams actually sit, in kbps.
 *
 * The export's one measured lever is a `stats_metric` bitrate ladder, and a
 * ladder is only worth anything if its rungs fall inside the distribution it is
 * sorting. Hand-picked thresholds do not: a rule set found in the field carried
 * rungs at 10000 and 15000 kbps against a catalogue whose median watchable
 * stream measured 6602, so the first rung cleared 5.7% of streams and the
 * second 0.4%. Both were dead weight, and neither looked wrong from the outside
 * -- a rung that never fires and a rung that fires correctly are the same line
 * in a JSON file.
 *
 * So the rungs are read off the population instead. Quartiles rather than
 * anything cleverer, because the job is only to cut the field into "better than
 * most", "top quarter", "top tenth" -- and because a percentile moves with the
 * catalogue, which is the property a hand-picked number lacks.
 *
 * The ladder is centred on the median rather than resting on zero, and that is
 * the part that matters most. A `stats_metric` rule does not fire on a stream
 * with no `stream_stats` at all -- Teamarr's `_match_stats_metric` returns
 * false on absent stats, it does not read them as zero -- so a promotion-only
 * ladder scores every unprobed stream 0 and every probed one somewhere above
 * it. That ranks *having been looked at* rather than being any good, and on
 * event inventory the two are not remotely the same thing: the streams Podium
 * has probed are the ones that sat still long enough to probe, which skews
 * hard toward the long-lived linear feeds Teamarr attaches by EPG match and
 * away from the per-event streams that appear an hour before kickoff.
 *
 * Centring it removes that. `floorKbps` demotes a stream *measured* below the
 * median, the rungs promote one measured above the upper quartile, and 0 --
 * the score of a stream nobody has probed -- lands where a median stream
 * lands. Absent stats then read as "no opinion", which is the only honest
 * thing they can mean.
 */
export interface BitrateLadder {
  /** Samples the percentiles were taken over. */
  samples: number;
  /**
   * Measured below this and a stream is demoted: the median.
   *
   * The ladder's zero point, not its bottom rung. It is what makes an unscored
   * stream sit level with a median one instead of beneath the whole field.
   */
  floorKbps: number;
  /** Which percentile `floorKbps` came from. */
  floorPercentile: number;
  /** The promotion rungs, ascending: p75, p90. */
  rungsKbps: number[];
  /** Which percentile each rung came from, same order as `rungsKbps`. */
  percentiles: number[];
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
  /** Where the watchable streams sit, for the exported bitrate ladder. */
  bitrateLadder: BitrateLadder;
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
/** The value at `q` (0-1) of an ascending list, nearest-rank. */
function percentileOf(ascending: number[], q: number): number {
  if (ascending.length === 0) return 0;
  const index = Math.min(ascending.length - 1, Math.max(0, Math.round(q * (ascending.length - 1))));
  return Math.round(ascending[index]!);
}

/** The percentile the ladder's demotion floor -- and so its zero point -- sits at. */
const LADDER_FLOOR_PERCENTILE = 0.5;

/** The percentiles the ladder's promotion rungs are taken from, ascending. */
const LADDER_PERCENTILES = [0.75, 0.9];

/**
 * The bitrate ladder, read off the streams a rule would actually be sorting.
 *
 * Dead and black streams are excluded, and so are audio-only ones. Not to
 * flatter the numbers: a ladder is a statement about how good a *watchable*
 * stream is, and the streams that are not watchable are the liveness rules'
 * business. Leaving them in would drag every rung down toward zero and hand
 * back a ladder whose bottom rung is cleared by a black screen.
 */
function buildLadder(scoped: StoredQualitySample[]): BitrateLadder {
  const kbps = scoped
    .filter(
      (sample) => !sample.audioOnly && sample.alive && !sample.black && sample.bitrateKbps > 0,
    )
    .map((sample) => sample.bitrateKbps)
    .sort((a, b) => a - b);

  return {
    samples: kbps.length,
    floorKbps: percentileOf(kbps, LADDER_FLOOR_PERCENTILE),
    floorPercentile: LADDER_FLOOR_PERCENTILE,
    rungsKbps: LADDER_PERCENTILES.map((q) => percentileOf(kbps, q)),
    percentiles: [...LADDER_PERCENTILES],
  };
}

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
    // Same population as the fit, for the same reason: a ladder exported
    // alongside these effects has to be describing the streams they describe.
    bitrateLadder: buildLadder(scoped),
  };
}

/**
 * What a set of samples is worth, all in: median bitrate discounted by how
 * often it fails to arrive at all.
 *
 * `median x aliveRate x (1 - blackRate)`. Exported because the name miner
 * splits arbitrary sample sets on a token and compares the two halves, and it
 * has to be comparing the same quantity the profile fits and the export scores.
 * Two implementations of "effective" would be two definitions of better, and
 * the disagreement would only show up as a mined rule that ranks against the
 * bucket it was mined from.
 */
export function effectiveKbpsOf(list: StoredQualitySample[]): number {
  const alive = list.filter((sample) => sample.alive);
  const black = alive.filter((sample) => sample.black);
  const rated = alive
    .filter((sample) => sample.measured && !sample.black && sample.bitrateKbps > 0)
    .map((sample) => sample.bitrateKbps)
    .sort((a, b) => a - b);
  const aliveRate = list.length === 0 ? 0 : alive.length / list.length;
  const blackRate = alive.length === 0 ? 0 : black.length / alive.length;
  return Math.round(percentile(rated, 0.5) * aliveRate * (1 - blackRate));
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
    effectiveKbps: effectiveKbpsOf(list),
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

  // Broadest first, and the order is a decision rather than an array literal.
  //
  // Backfitting cannot split factors that move together, and on a real install
  // they move together almost completely: of 121 provider groups measured on
  // one, exactly 2 appeared under more than one account. A group is a
  // provider's own way of organising what it sells, so it is nested inside the
  // account by construction, and a tier token turns out to be nested too when
  // only one account writes them.
  //
  // With collinear factors every split that sums the same predicts the same,
  // so the fit cannot choose between them -- whichever is estimated first
  // absorbs the shared signal and the rest re-centre to zero. That makes the
  // order the thing that decides attribution, and the previous order put the
  // tier first: an account whose streams answered 54% of the time against 85%
  // had its -2937kbps land on `fhd`, its four accounts all read exactly 0, and
  // the export withheld the tier rule as confounded. The signal was real and in
  // the wrong column.
  //
  // Broad to narrow gets it right for two reasons. It generalises: a group that
  // has not been measured yet still inherits its account's average, where the
  // reverse order gives it nothing. And it exports correctly -- a `regex` on
  // `1080p` is evaluated against every provider's streams, so charging one
  // account's deficit to a token that other accounts also use is wrong in a way
  // charging it to the account never is. Teamarr sums the three either way, so
  // no arrangement double-counts; only one of them attributes.
  const factors = [
    { of: (bucket: Bucket) => bucket.providerName, effects: new Map<string, number>() },
    { of: (bucket: Bucket) => bucket.groupName, effects: new Map<string, number>() },
    { of: (bucket: Bucket) => bucket.tier as string, effects: new Map<string, number>() },
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
          vsReferenceKbps: null as number | null,
          accounts: byAccount.size,
          topAccountShare: samples === 0 ? 0 : top / samples,
        };
      })
      .sort((a, b) => b.deltaKbps - a.deltaKbps);

  /**
   * Tier effects re-expressed against `unknown`, which is the level the export
   * actually scores everything from.
   */
  const againstUnknown = (effects: Effect[]): Effect[] => {
    const reference = effects.find((effect) => effect.key === 'unknown')?.deltaKbps ?? 0;
    return effects.map((effect) => ({
      ...effect,
      vsReferenceKbps: effect.key === 'unknown' ? 0 : effect.deltaKbps - reference,
    }));
  };

  return {
    baselineKbps,
    accounts: asEffects(members[0]!, factors[0]!.effects),
    groups: asEffects(members[1]!, factors[1]!.effects),
    tiers: againstUnknown(asEffects(members[2]!, factors[2]!.effects)),
  };
}

/** One rule in Teamarr's `stream-ordering-rules.json`. */
export interface TeamarrRule {
  /**
   * The four Teamarr matches Podium can speak to.
   *
   * `m3u` and `group` are wholesale -- a stream either came from that account
   * or that group -- and `regex` is the only lever that reads the stream's own
   * name. Those three are *priors*: statements about where a stream came from,
   * which is all that can be said about a stream nobody has probed.
   *
   * `stats_metric` is the fourth and it is not a prior at all. It reads the
   * `stream_stats` Podium itself publishes to Dispatcharr, so it is the one
   * rule type that can carry a measurement of *this* stream into Teamarr's
   * scorer. It was withheld at first on the grounds that exporting it would
   * score the same measurement twice, which is true of a bitrate the account
   * effect has already been fitted from -- and false of the two things that
   * matter most: whether the stream is alive, and whether it is a black screen.
   * No prior expresses those, no amount of provenance predicts them, and a rule
   * set without them ranks a dead stream from a good account above a working
   * one from a mediocre account. Measured on a live install, that was 27 of 61
   * disagreements.
   *
   * `epg_match` and `stream_type` remain somebody else's opinion to write.
   */
  type: 'm3u' | 'group' | 'regex' | 'stats_metric';
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
   * inference inside the measured ladder's span, so a stream actually measured
   * in the top decile outranks one that merely comes from a good account.
   *
   * It is a cap on any *single* prior, not on their sum, and deliberately so: a
   * stream carrying a good account, a good group and a good tier has three
   * independent reasons to be worth trying, and that is a different claim from
   * any one of them. The invariant that has to hold whatever they stack to is
   * the liveness one, and `deadPoints` is sized for it.
   */
  maxPoints?: number;
  /**
   * Pass B's consolidations, which *replace* the group rules they subsume.
   *
   * Passed in rather than mined here so this stays a function of the profile:
   * the caller decides whether mining ran at all, and the export behaves
   * identically when it did not.
   */
  consolidated?: ConsolidatedToken[];
  /**
   * What a stream measured dead, or measured as a black screen, gives up.
   *
   * Deliberately outside `maxPoints`, which is the one place in this export
   * where that cap is wrong to apply. The cap exists so that a *prior* can
   * never outrank a *measurement* -- and this is the measurement. Capping it at
   * 15 would put a dead stream one account-rule away from winning its channel,
   * which is the failure the rule exists to stop.
   *
   * Large enough to sink beneath any plausible stack of priors: three generated
   * rules at the ±15 cap, plus whatever an operator has hand-written. Teamarr
   * clamps a score to ±(BAND_STRIDE/2 - 1), so there is a great deal of room
   * and no reason to be shy with it.
   *
   * Set to 0 to suppress both liveness rules.
   */
  deadPoints?: number;
  /**
   * What each step of the bitrate ladder is worth.
   *
   * Flat per step, so the ladder is a step function centred on the median: one
   * step down below it, one step up per quartile above. At the default that
   * spans −8 to +16, putting a top-decile stream 24 points clear of a
   * bottom-half one -- more than any single prior can move it, which is the
   * point, and still short of the liveness penalty, which is also the point.
   *
   * The span is the same as it was when all three steps were promotions; what
   * changed is where zero sits in it. Zero is the score of a stream carrying no
   * `stream_stats`, and it now means "a median stream" rather than "the worst
   * stream in the catalogue".
   *
   * Set to 0 to suppress the ladder.
   */
  bitratePoints?: number;
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
  deadPoints: number;
  bitratePoints: number;
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
    // Clamped to zero or below: this is a demotion, and a positive value would
    // reward a stream for having measured dead. `0` suppresses it.
    deadPoints: Math.round(number('deadPoints', -100, -100_000, 0)),
    bitratePoints: Math.round(number('bitratePoints', 8, 0, 10_000)),
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
    /**
     * The `stats_metric` half: what a measurement is worth here, and why.
     *
     * Carried because the ladder's thresholds are the one thing in this file
     * that will look arbitrary in three months. They are not -- they are this
     * catalogue's quartiles on the day it was exported -- and the only way to
     * show that is to ship the percentiles beside them.
     */
    measured: {
      deadPoints: number;
      bitratePoints: number;
      ladder: BitrateLadder;
    };
    /**
     * Mined regexes, and the group rules each one absorbed.
     *
     * Carried so the compression is auditable from the file alone: a group rule
     * that dropped from +12 to nothing did not stop being measured, it stopped
     * being *separately* measured, and only this says which regex took it.
     */
    minedRegex: Array<{
      token: string;
      pattern: string;
      deltaKbps: number;
      replacedGroups: string[];
    }>;
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
  const consolidated = options.consolidated ?? [];
  const deadPoints = options.deadPoints ?? -100;
  const bitratePoints = options.bitratePoints ?? 8;

  const rules: TeamarrRule[] = [];

  // The measured rules first, because they are the only ones in this file that
  // describe the stream in front of you rather than the company it keeps.
  //
  // Demotion only, and no matching reward for being alive. A stream Podium has
  // never probed carries no `alive` key at all, so `_resolve_stat_value`
  // returns null and neither rule fires -- it scores its priors and nothing
  // else, which is the right answer when nobody has looked at it. A positive
  // "alive" rule would instead push every unprobed stream below every probed
  // one, and at kickoff the unprobed streams are most of them.
  if (deadPoints !== 0) {
    rules.push({
      type: 'stats_metric',
      value: 'alive|=|0',
      priority: 99,
      mode: 'score',
      points: deadPoints,
    });
    rules.push({
      type: 'stats_metric',
      value: 'blank_detected|=|1',
      priority: 99,
      mode: 'score',
      points: deadPoints,
    });
  }

  // The ladder, at this install's own quartiles, centred on the median.
  //
  // The floor is the rule that keeps this honest. Without it every rung is a
  // promotion, so a stream carrying no `stream_stats` scores 0 and loses to
  // every probed stream in the catalogue -- which is the same failure the
  // liveness rules avoid by demoting only, arriving through the other door.
  // With it, 0 is the median: measured worse than the field is demoted,
  // measured better is promoted, and never measured is an opinion nobody has.
  //
  // Rungs are cumulative -- a stream above p90 matches both -- which is what
  // makes a flat per-rung value read as a monotonic preference rather than two
  // unrelated opinions.
  //
  // A rung at or below the floor is dropped rather than de-duplicated. On a
  // thin or uniform catalogue the quartiles collapse onto one number, and a
  // `>=` at the floor is not a discrimination at all: it fires on everything
  // the floor did not demote, which is a flat bonus for having been probed,
  // reintroducing exactly what the floor was added to remove.
  if (bitratePoints !== 0) {
    const { floorKbps, rungsKbps } = profile.bitrateLadder;
    if (floorKbps > 0) {
      rules.push({
        type: 'stats_metric',
        value: `ffmpeg_output_bitrate|<|${floorKbps}`,
        priority: 99,
        mode: 'score',
        points: -bitratePoints,
      });
    }
    const seen = new Set<number>();
    for (const rung of rungsKbps) {
      if (rung <= floorKbps || rung <= 0 || seen.has(rung)) continue;
      seen.add(rung);
      rules.push({
        type: 'stats_metric',
        value: `ffmpeg_output_bitrate|>=|${rung}`,
        priority: 99,
        mode: 'score',
        points: bitratePoints,
      });
    }
  }

  // What each carrier group keeps once its regex has taken the shared part.
  //
  // A consolidating regex has to *replace* the group rules it subsumes, or a
  // Peacock stream scores its group's points and the regex's on top. So the
  // carriers are re-emitted at their residual instead of their own effect,
  // which is exactly additive -- and the residuals that round to nothing are
  // the compression: four groups all sitting near +2000 become one regex and
  // silence.
  const residuals = new Map<string, number>();
  for (const token of consolidated) {
    for (const carrier of token.carriers) residuals.set(carrier.group, carrier.residualKbps);
  }

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
    const effect = residuals.get(group.key) ?? group.deltaKbps;
    const points = pointsFor(effect, pointsPerMbps, maxPoints);
    if (points === 0) continue;
    rules.push({ type: 'group', value: group.key, priority: 99, mode: 'score', points });
  }

  // Mined regexes last among the scoring rules, so a reader sees the group
  // rules they replaced immediately above them.
  for (const token of consolidated) {
    const points = pointsFor(token.deltaKbps, pointsPerMbps, maxPoints);
    if (points === 0) continue;
    rules.push({ type: 'regex', value: token.pattern, priority: 99, mode: 'score', points });
  }

  const confounded: ConfoundedTier[] = [];
  for (const tier of profile.tiers) {
    if (tier.key === 'unknown' || tier.samples < minSamples) continue;
    // Against `unknown`, not against the baseline: an unlabelled stream matches
    // no tier rule and so scores 0 here, which makes the reference level the
    // thing this number has to be a distance from.
    const points = pointsFor(tier.vsReferenceKbps ?? tier.deltaKbps, pointsPerMbps, maxPoints);
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
      measured: { deadPoints, bitratePoints, ladder: profile.bitrateLadder },
      minedRegex: consolidated.map((token) => ({
        token: token.token,
        pattern: token.pattern,
        deltaKbps: token.deltaKbps,
        replacedGroups: token.carriers.map((carrier) => carrier.group),
      })),
      note:
        'Generated by Podium from measured stream quality. Points are the ' +
        "dimension's measured distance from this install's baseline, in " +
        'megabits, times pointsPerMbps. `group` values are Dispatcharr group ' +
        'names; Teamarr matches them against its own Event Group names, so a ' +
        'group rule scores only where the two are spelled the same.' +
        (deadPoints !== 0 || bitratePoints !== 0
          ? ' `stats_metric` rules read the stream_stats Podium publishes to ' +
            'Dispatcharr, so they score a measurement of the stream itself ' +
            'rather than a prior about where it came from. The bitrate ladder ' +
            "is centred on this catalogue's median: a stream measured below " +
            'it is demoted, one measured above the upper quartile is promoted, ' +
            'and a stream with no stream_stats scores 0 and so sits level with ' +
            'a median one -- absent stats are not a low reading. Merging ' +
            'REPLACES any existing single-condition stats_metric rule on the ' +
            'same metric and comparator, whatever its threshold -- a ' +
            'recalibrated ladder has different rungs, and keeping the old ones ' +
            'would score the same bitrate twice. See podium.measured.'
          : '') +
        (consolidated.length > 0
          ? ` ${consolidated.length} regex rule(s) were mined from stream names and ` +
            'REPLACE the group rules they subsume -- those groups are re-emitted at ' +
            'their residual, so the totals are unchanged. See podium.minedRegex.'
          : '') +
        (confounded.length > 0
          ? ` ${confounded.length} tier rule(s) withheld: one account supplied ` +
            'more than 80% of the samples, so the effect describes that account ' +
            'rather than the tier. See podium.confoundedTiers.'
          : ''),
    },
  };
}

/**
 * The `metric|comparator` a single-condition `stats_metric` rule is about,
 * or null for anything else.
 *
 * Teamarr's `stats_metric` value is `metric|comparator|threshold`, and it also
 * takes several conditions joined by `;`. A multi-condition rule is somebody
 * making a compound point -- "at least 4Mbps *and* at least 50fps" -- and it is
 * not the same opinion as any rung of a generated ladder, so it is deliberately
 * not recognised here and survives a merge untouched.
 */
function statsFamily(rule: { type: string; value: string }): string | null {
  if (rule.type !== 'stats_metric') return null;
  const value = rule.value.trim();
  if (value.includes(';')) return null;
  const parts = value.split('|');
  if (parts.length < 2) return null;
  return `${parts[0]!.trim().toLowerCase()}|${parts[1]!.trim()}`;
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
 *
 * `stats_metric` is the exception, and has to be. A bitrate ladder is not a
 * fixed set of rules whose points get updated: it is N rungs at percentiles
 * that *move*, so last month's `>=|6602` and this month's `>=|7100` are the
 * same opinion wearing different numbers, and matching them by value would
 * leave both in the file scoring the same stream twice. So a generated
 * single-condition `stats_metric` rule supersedes every existing
 * single-condition rule on that same metric and comparator, whatever its
 * threshold, and the fresh set is appended whole.
 *
 * That is a bigger claim than the 1:1 rule makes, and it is the right one: an
 * operator's hand-written `ffmpeg_output_bitrate >= 10000` is an attempt at
 * exactly the job the ladder now does from measurement, and keeping both is
 * strictly worse than keeping either. Other metrics -- `source_fps`,
 * `resolution_height` -- are untouched, because Podium generates nothing that
 * competes with them.
 */
export function mergeTeamarrRules<T extends { type: string; value: string; mode?: string }>(
  existing: T[],
  generated: TeamarrRule[],
): Array<T | TeamarrRule> {
  const key = (rule: { type: string; value: string; mode?: string }): string =>
    `${rule.type} ${rule.value.trim().toLowerCase()} ${rule.mode ?? 'priority'}`;

  // Families this export has an opinion about; existing members are superseded
  // wholesale rather than matched one for one.
  const families = new Set<string>();
  for (const rule of generated) {
    const family = statsFamily(rule);
    if (family) families.add(family);
  }

  const byKey = new Map<string, TeamarrRule>();
  for (const rule of generated) {
    if (!statsFamily(rule)) byKey.set(key(rule), rule);
  }
  const used = new Set<string>();

  const merged: Array<T | TeamarrRule> = [];
  for (const rule of existing) {
    const family = statsFamily(rule);
    if (family && families.has(family)) continue;
    const replacement = byKey.get(key(rule));
    if (replacement) {
      used.add(key(rule));
      merged.push(replacement);
      continue;
    }
    merged.push(rule);
  }

  for (const rule of generated) {
    if (statsFamily(rule) || !used.has(key(rule))) merged.push(rule);
  }
  return merged;
}
