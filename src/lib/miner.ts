/**
 * Mining scoring rules out of what stream names actually say.
 *
 * `quality.ts` fits three effects -- account, group, tier -- and two of them
 * are wholesale: a stream either came from that account or it did not. The
 * third reads the name, and today it reads it through a hand-picked vocabulary
 * of resolution tokens that fits, on the install this was developed against, to
 * exactly 0. Once you know the account, the resolution token adds nothing, and
 * 69% of stream names on Teamarr-ordered channels carry no resolution token at
 * all. This module replaces the hand-picked list with whatever the names say.
 *
 * Two passes, because a name token does two unrelated jobs.
 *
 * **Pass A, discrimination.** Tokens that vary *inside* a cell -- same account,
 * same group, same tier -- and predict a difference anyway. No wholesale rule
 * can express these at any granularity, because there is no set to belong to.
 *
 * **Pass B, consolidation.** Tokens carried by whole groups at once, where one
 * regex replaces N group rules and keeps working when a provider renames a
 * group. Not a contrast at all: inside `Sports | Peacock` every stream is a
 * Peacock stream, so nothing varies and a within-cell test sees nothing.
 *
 * Both run on the configured scope. The group effects Pass B consolidates are
 * `group` rules in Teamarr's sense, which its matcher resolves against its own
 * Event Group names rather than Dispatcharr's -- they line up only as far as an
 * operator has named them to. Teamarr's fourth lever, `dispatcharr_group`,
 * matches channel-source streams, which Podium does not probe at all; that is a
 * probing gap rather than an export one, and it is not addressed here.
 *
 * A token is a candidate for one or the other, never both -- whichever it has
 * more support for. See `docs/miner.md` for the thresholds and the evidence.
 *
 * Pass A's *export* is deliberately not here yet. Its analysis runs, its guards
 * run, and the readiness panel reports what it found; nothing it produces is
 * written as a rule. The durability guard is the only thing separating `SKY`
 * from `CHC`, and it cannot be trusted until an install has actually held seven
 * days of samples -- which, until `SAMPLES_PER_BUCKET` was raised, no install
 * ever had.
 */

import { bounded, type Effect, effectiveKbpsOf, teamarrPattern } from './quality';
import type { StoredQualitySample } from './store';

const DAY_MS = 86_400_000;

/**
 * The vocabularies `normalize.ts` already carries, as seeds.
 *
 * Not because a seed token is more likely to be real -- the whole point is that
 * the miner does not need a vocabulary -- but because these survive tokenising
 * badly. `H.265`, `DD+` and `5.1` all contain characters a word split eats, so
 * without seeding them the one token set anybody would have written by hand is
 * the one set the miner cannot see.
 */
const SEED_TOKENS = [
  'HEVC',
  'H265',
  'H.265',
  'X265',
  'AVC',
  'H264',
  'X264',
  'MPEG2',
  'AAC',
  'AC3',
  'DTS',
  'DD+',
  'ATMOS',
  '2.0',
  '5.1',
  '7.1',
  'RAW',
  'MULTI',
  'HDR',
  'VIP',
  'BACKUP',
  'ALT',
];

/**
 * The same list as a set, for the shape filter to consult.
 *
 * A seeded token bypasses the numeric rejection: `5.1` and `2.0` are pure
 * numerics by shape and audio layouts by meaning, and the shape filter exists
 * to reject tokens nothing is known about. Being in this vocabulary is exactly
 * the evidence that something is.
 */
const SEED_SET = new Set(SEED_TOKENS);

/**
 * Words that name the channel rather than the stream.
 *
 * A sport or a competition is what the *channel* is about, so it duplicates
 * what the group rule already says and adds a rule that fires on every stream
 * in the group equally -- which ranks nothing. Kept deliberately short: this is
 * a list of things that are structurally not stream properties, not a list of
 * tokens that scored badly. Anything excluded for scoring badly belongs behind
 * a guard, where the number that excluded it can be read back.
 */
const STOP_WORDS = new Set([
  'MLB',
  'MILB',
  'NFL',
  'NBA',
  'NHL',
  'MLS',
  'EPL',
  'UFC',
  'SOCCER',
  'FOOTBALL',
  'BASEBALL',
  'BASKETBALL',
  'HOCKEY',
  'TENNIS',
  'GOLF',
  'BOXING',
  'RACING',
  'CRICKET',
  'RUGBY',
  'SPORT',
  'SPORTS',
  'LIVE',
  'EVENT',
  'EVENTS',
  'GAME',
  'GAMES',
  'MATCH',
  'CHANNEL',
  'NETWORK',
  'THE',
  'AND',
]);

/**
 * Tokens that are a date, a time, or a fixture's furniture.
 *
 * The shape filter proper handles anything numeric; this covers the words that
 * look like content and are not. The evidence for keeping it separate from the
 * stop list is `AUG`: on the live catalogue it appeared in 591 samples across
 * 46 groups, which is more support than any real token had, and it is a month.
 */
const CALENDAR_WORDS = new Set([
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'SEPT',
  'OCT',
  'NOV',
  'DEC',
  'MON',
  'TUE',
  'TUES',
  'WED',
  'THU',
  'THUR',
  'THURS',
  'FRI',
  'SAT',
  'SUN',
  'TODAY',
  'TOMORROW',
  'AM',
  'PM',
  'ET',
  'EST',
  'EDT',
  'PT',
  'PST',
  'CT',
  'CST',
  'MT',
  'UTC',
  'GMT',
  'BST',
]);

/**
 * Tokens that name a video codec.
 *
 * Held back from export rather than from mining. Bitrate is only comparable
 * within a codec -- HEVC carries roughly the same picture in roughly half the
 * bits -- so a codec token's measured effect is mostly the codec's efficiency
 * wearing a name's clothing. On the live catalogue `HEVC` cleared every
 * consolidation guard at -3076 kbps across four groups, which is a real
 * measurement and a bad rule: exported, it hands Teamarr a -15 on any stream
 * whose name says HEVC, including ones that are perfectly good and merely
 * smaller.
 *
 * The group rules those four carriers already have make the same claim, but
 * only about those groups, where it is at least true of the population it was
 * measured on. Promoting it to a regex is what makes it travel to providers it
 * was never measured on.
 *
 * The real fix is upstream and now underway: `quality_samples.video_codec`
 * records what ffprobe found, and once enough samples carry it the codec can be
 * held constant in the cell the way account, group and tier already are -- at
 * which point a codec token has no contrast to show and never becomes a
 * candidate. Until then this list is the guard, and what it withholds is
 * reported rather than dropped.
 */
const CODEC_TOKENS = new Set([
  'HEVC',
  'H265',
  'H.265',
  'X265',
  'H264',
  'H.264',
  'X264',
  'AVC',
  'AV1',
  'VP9',
  'MPEG2',
  'MPEG4',
  'XVID',
  'DIVX',
]);

/** Whether a mined token is really naming a codec. */
export function namesCodec(token: string): boolean {
  return CODEC_TOKENS.has(token.replace(/\\d\*$/, '').replace(/:$/, ''));
}

/** Fixture-title furniture: `Tigers at Royals`, `Rangers vs. Astros`. */
const FIXTURE_WORDS = new Set(['VS', 'VS.', 'AT', 'HOME', 'AWAY', 'V', 'NEXT', 'END', 'START']);

/**
 * Whether a token is the kind of thing that could name a stream property.
 *
 * Cheap and structural, run before any statistics. Everything it rejects is
 * rejected for its shape rather than its effect, so a token dropped here would
 * have been noise at any sample size -- which is what makes it safe to do this
 * first and save the arithmetic.
 */
export function plausibleToken(token: string): boolean {
  const bare = token.replace(/\\d\*$/, '').replace(/:$/, '');
  if (SEED_SET.has(bare)) return true;
  if (bare.length < 2 || bare.length > 24) return false;
  // Pure numerics: a channel number, a fixture id, a year.
  if (/^[\d.]+$/.test(bare)) return false;
  // Clock times, in the forms providers write them: 7:30, 1930, 7PM handled by
  // CALENDAR_WORDS once split.
  if (/^\d{1,2}[:.]\d{2}$/.test(bare)) return false;
  if (/^\d{1,2}(AM|PM)$/.test(bare)) return false;
  if (CALENDAR_WORDS.has(bare)) return false;
  if (FIXTURE_WORDS.has(bare)) return false;
  if (STOP_WORDS.has(bare)) return false;
  return true;
}

/**
 * Every token a name offers, as candidates.
 *
 * Four sources, because providers hide the same fact in four places:
 * bracket bodies (`[H265]`, `(HEVC)`), the prefix segment before a colon
 * (`PRIME:`, `UK-NOWTV:`, `CAN:`), the plain words, and each word's numbered
 * stem -- `SPORTS4` contributes both `SPORTS4` and `SPORTS\d*`, because a
 * provider numbering its feeds means the number is a slot and the letters are
 * the thing.
 *
 * Returns display tokens; `tokenPattern` turns one into a regex.
 */
export function candidateTokens(name: string): string[] {
  const found = new Set<string>();
  const upper = (name ?? '').toUpperCase();

  for (const match of upper.matchAll(/\[([^\]]*)\]|\(([^)]*)\)/g)) {
    const body = (match[1] ?? match[2] ?? '').trim();
    for (const word of body.split(/[^A-Z0-9.+]+/)) if (word) found.add(word);
  }

  // A prefix segment is only a prefix if it is short and unspaced. Without the
  // bound, `Live: Tigers at Royals: all:` offers its whole first clause as a
  // token, which is a fixture title wearing a colon.
  const colon = upper.indexOf(':');
  if (colon > 0 && colon <= 16) {
    const segment = upper.slice(0, colon).trim();
    if (segment && !/\s/.test(segment)) found.add(`${segment}:`);
  }

  for (const word of upper.split(/[^A-Z0-9.+]+/)) {
    if (!word) continue;
    found.add(word);
    const stem = /^([A-Z]+)\d+$/.exec(word);
    if (stem) found.add(`${stem[1]}\\d*`);
  }

  for (const seed of SEED_TOKENS) if (upper.includes(seed)) found.add(seed);

  return [...found].filter(plausibleToken);
}

/**
 * A display token as a regex body, with the boundaries that make it a token.
 *
 * Everything is escaped except a trailing `\d*`, which is the stem convention
 * from `candidateTokens` and the one piece of a token that is deliberately a
 * pattern. Escaping matters more here than in the tier export: those tokens are
 * a fixed list somebody wrote, these are provider-controlled text, and `5.1`
 * unescaped matches `521`.
 */
export function tokenPattern(token: string): string {
  const stem = token.endsWith('\\d*');
  const literal = stem ? token.slice(0, -3) : token;
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return bounded([stem ? `${escaped}\\d*` : escaped]);
}

/** Which guard a Pass A candidate failed. Empty means it cleared them all. */
export type MinerGuard = 'samples' | 'effect' | 'cells' | 'duration' | 'stability';

export interface MinerOptions {
  /** Samples required on *each* side of a token split, within one cell. */
  minSideSamples?: number;
  /** Cells a token must be paired in. One cell is a channel, not a pattern. */
  minCells?: number;
  /** Below this a rule will not survive the points rounding anyway. */
  minEffectKbps?: number;
  /** How long a token must have been predicting the same thing. */
  minDurationMs?: number;
  /** Share of a group's samples that must match before the group carries it. */
  carrierShare?: number;
  /** Below this share a group is simply not a carrier, rather than ambiguous. */
  contaminationFloor?: number;
  /** Carrier groups required before one regex beats writing the group rules. */
  minCarrierGroups?: number;
  /** Samples a carrier group needs before its effect is fitted at all. */
  minCarrierSamples?: number;
  /** Overlap above which two candidates are the same split counted twice. */
  maxOverlap?: number;
  /** Ceiling on mined rules, across both passes. */
  maxRules?: number;
}

interface Resolved extends Required<MinerOptions> {}

function resolve(options: MinerOptions): Resolved {
  return {
    minSideSamples: options.minSideSamples ?? 20,
    minCells: options.minCells ?? 2,
    minEffectKbps: options.minEffectKbps ?? 500,
    minDurationMs: options.minDurationMs ?? 7 * DAY_MS,
    carrierShare: options.carrierShare ?? 0.8,
    contaminationFloor: options.contaminationFloor ?? 0.2,
    minCarrierGroups: options.minCarrierGroups ?? 3,
    minCarrierSamples: options.minCarrierSamples ?? 20,
    maxOverlap: options.maxOverlap ?? 0.5,
    maxRules: options.maxRules ?? 10,
  };
}

/** One token's showing inside one cell. */
interface CellContrast {
  effectKbps: number;
  /** `min(withToken, withoutToken)` -- a split is only as good as its thin side. */
  weight: number;
  firstHalfKbps: number;
  secondHalfKbps: number;
}

export interface NameCandidate {
  token: string;
  /** Weighted mean of the per-cell contrasts. */
  effectKbps: number;
  cells: number;
  support: number;
  spanDays: number;
  /** Same sign in both halves of its window. A token that flips fits a schedule. */
  stable: boolean;
  /** Guards it failed; empty means it cleared. */
  blockedBy: MinerGuard[];
  /** Names it matched, for reading a candidate back to the streams behind it. */
  examples: string[];
}

/**
 * Pass A: tokens that discriminate within a cell.
 *
 * The cell is `(provider, group, tier, audioOnly)` -- the same key the profile
 * buckets on, so a token is only ever compared against streams alike in every
 * other respect Podium can see.
 *
 * A paired contrast rather than another factor in the backfit, deliberately.
 * Adding name tokens to the fit would reproduce the failure the fit order
 * already had to be corrected for: with collinear factors whichever is
 * estimated first absorbs the signal, and a token that is really a provider
 * marker gets fitted as though it were a property of names. Pairing inside a
 * cell holds account, group and tier constant by construction, so a provider
 * marker has no cell where it varies and produces no candidate at all. Not
 * suppressed by a threshold -- absent, because there was never evidence for it.
 *
 * Note there is no account-dispersion guard. An earlier draft required a token
 * under >=2 accounts, on the theory that a single-account token is the `m3u`
 * rule in disguise. That throws out `PRIME:` -- a sub-provider route inside one
 * account, precisely the case no wholesale rule can express. The paired
 * contrast already holds the account constant. The guard must not come back.
 */
export function minePassA(
  samples: StoredQualitySample[],
  options: MinerOptions = {},
): NameCandidate[] {
  const settings = resolve(options);
  if (samples.length === 0) return [];

  const cells = new Map<string, StoredQualitySample[]>();
  for (const sample of samples) {
    const key = `${sample.providerId} ${sample.groupId ?? ''} ${sample.tier} ${sample.audioOnly}`;
    const list = cells.get(key);
    if (list) list.push(sample);
    else cells.set(key, [sample]);
  }

  const windowStart = Math.min(...samples.map((sample) => sample.sampledAt));
  const windowEnd = Math.max(...samples.map((sample) => sample.sampledAt));
  const midpoint = (windowStart + windowEnd) / 2;

  const contrasts = new Map<string, CellContrast[]>();
  const matched = new Map<string, Set<StoredQualitySample>>();

  for (const list of cells.values()) {
    const holders = new Map<string, Set<StoredQualitySample>>();
    for (const sample of list) {
      for (const token of candidateTokens(sample.streamName)) {
        const set = holders.get(token);
        if (set) set.add(sample);
        else holders.set(token, new Set([sample]));
      }
    }

    for (const [token, withToken] of holders) {
      const withList = [...withToken];
      const withoutList = list.filter((sample) => !withToken.has(sample));
      if (
        withList.length < settings.minSideSamples ||
        withoutList.length < settings.minSideSamples
      ) {
        continue;
      }

      const before = (rows: StoredQualitySample[]) =>
        rows.filter((sample) => sample.sampledAt < midpoint);
      const after = (rows: StoredQualitySample[]) =>
        rows.filter((sample) => sample.sampledAt >= midpoint);

      const contrast: CellContrast = {
        effectKbps: effectiveKbpsOf(withList) - effectiveKbpsOf(withoutList),
        weight: Math.min(withList.length, withoutList.length),
        firstHalfKbps: effectiveKbpsOf(before(withList)) - effectiveKbpsOf(before(withoutList)),
        secondHalfKbps: effectiveKbpsOf(after(withList)) - effectiveKbpsOf(after(withoutList)),
      };

      const seen = contrasts.get(token);
      if (seen) seen.push(contrast);
      else contrasts.set(token, [contrast]);

      const all = matched.get(token);
      if (all) for (const sample of withList) all.add(sample);
      else matched.set(token, new Set(withList));
    }
  }

  const candidates: NameCandidate[] = [];
  for (const [token, cellContrasts] of contrasts) {
    const support = cellContrasts.reduce((sum, cell) => sum + cell.weight, 0);
    if (support === 0) continue;
    const effectKbps = Math.round(
      cellContrasts.reduce((sum, cell) => sum + cell.effectKbps * cell.weight, 0) / support,
    );

    const hits = [...(matched.get(token) ?? [])];
    const spanMs =
      hits.length === 0
        ? 0
        : Math.max(...hits.map((sample) => sample.sampledAt)) -
          Math.min(...hits.map((sample) => sample.sampledAt));

    // Both halves must agree, and a half with no contrast to show has not
    // agreed -- it has abstained. Reading 0 as agreement would let a token seen
    // only in the back half of the window pass a durability test it never took.
    const stable = cellContrasts.every(
      (cell) =>
        cell.firstHalfKbps !== 0 &&
        cell.secondHalfKbps !== 0 &&
        Math.sign(cell.firstHalfKbps) === Math.sign(cell.secondHalfKbps),
    );

    const blockedBy: MinerGuard[] = [];
    if (Math.abs(effectKbps) < settings.minEffectKbps) blockedBy.push('effect');
    if (cellContrasts.length < settings.minCells) blockedBy.push('cells');
    if (spanMs < settings.minDurationMs) blockedBy.push('duration');
    if (!stable) blockedBy.push('stability');

    candidates.push({
      token,
      effectKbps,
      cells: cellContrasts.length,
      support,
      spanDays: Math.round((spanMs / DAY_MS) * 10) / 10,
      stable,
      blockedBy,
      examples: [...new Set(hits.map((sample) => sample.streamName))].slice(0, 3),
    });
  }

  // Greedy by `|effect| x support`, dropping anything that overlaps a candidate
  // already taken. `AM` and `PM` are one split counted twice, at exactly
  // mirrored magnitudes; without this they arrive as two rules that between
  // them say nothing.
  candidates.sort(
    (a, b) => Math.abs(b.effectKbps) * b.support - Math.abs(a.effectKbps) * a.support,
  );
  return decorrelate(
    candidates,
    (candidate) => matched.get(candidate.token) ?? new Set(),
    settings,
  );
}

/**
 * Drop candidates whose evidence is mostly somebody else's evidence.
 *
 * Overlap against the *smaller* set, not the union: `H265` inside a group where
 * every stream is `H265` overlaps that group's token completely from one side
 * and barely at all from the other, and it is the complete side that means they
 * are the same claim.
 */
function decorrelate<T>(
  ranked: T[],
  setOf: (item: T) => Set<StoredQualitySample>,
  settings: Resolved,
): T[] {
  const kept: T[] = [];
  const keptSets: Array<Set<StoredQualitySample>> = [];
  for (const candidate of ranked) {
    const set = setOf(candidate);
    if (set.size === 0) continue;
    const clashes = keptSets.some((taken) => {
      let shared = 0;
      for (const sample of set) if (taken.has(sample)) shared += 1;
      return shared / Math.min(set.size, taken.size) > settings.maxOverlap;
    });
    if (clashes) continue;
    kept.push(candidate);
    keptSets.push(set);
  }
  return kept;
}

/** A group that carries a token, and what its own rule is worth. */
export interface Carrier {
  group: string;
  samples: number;
  deltaKbps: number;
  /** What the group rule keeps once the regex takes the consolidated share. */
  residualKbps: number;
}

export interface ConsolidatedToken {
  token: string;
  /** The regex as Teamarr's importer is handed it. */
  pattern: string;
  /** Sample-weighted mean of the carriers' fitted effects. */
  deltaKbps: number;
  samples: number;
  carriers: Carrier[];
}

/** A consolidation the pass declined to write, and the number behind that. */
export interface RejectedConsolidation {
  token: string;
  carrierGroups: number;
  ambiguousGroups: number;
  deltaKbps: number;
  spreadKbps: number;
  reason: 'too-few-carriers' | 'contaminated' | 'inconsistent';
}

export interface ConsolidationResult {
  consolidated: ConsolidatedToken[];
  rejected: RejectedConsolidation[];
  /**
   * Consolidations that cleared every guard and were withheld anyway, because
   * the token names a codec.
   *
   * Withheld rather than dropped, following the same rule as `confoundedTiers`
   * in the export: a rule that silently fails to appear is indistinguishable
   * from one nobody thought to write, and this is exactly the case where an
   * operator most wants to see that a judgement was made and what it cost.
   */
  confoundedCodecs: ConsolidatedToken[];
}

/**
 * Pass B: tokens carried by whole groups, where one regex replaces N group rules.
 *
 * The question is not whether the token discriminates -- inside a carrier group
 * nothing varies, so it cannot -- but whether the groups carrying it sit
 * consistently above or below the baseline. `Peacock` is four groups under
 * three accounts spelled four different ways; `H265` was thirteen groups. There
 * one regex replaces N group rules and survives a provider renaming a group.
 *
 * No account requirement, for the same reason Pass A has none: `PRIME:`
 * consolidates three groups inside one account and still replaces three rules
 * with one.
 *
 * `groups` is the fitted group effects from the profile -- their distance from
 * the install baseline, already computed. This pass does not re-estimate
 * anything; it decides which of those effects are really one effect.
 */
export function minePassB(
  samples: StoredQualitySample[],
  groups: Effect[],
  options: MinerOptions = {},
): ConsolidationResult {
  const settings = resolve(options);
  const fitted = new Map(
    groups.filter((group) => group.samples >= settings.minCarrierSamples).map((g) => [g.key, g]),
  );

  const byGroup = new Map<string, StoredQualitySample[]>();
  for (const sample of samples) {
    if (!sample.groupName) continue;
    const list = byGroup.get(sample.groupName);
    if (list) list.push(sample);
    else byGroup.set(sample.groupName, [sample]);
  }

  // token -> group -> share of that group's samples carrying it
  const shares = new Map<string, Map<string, number>>();
  const holders = new Map<string, Set<StoredQualitySample>>();
  for (const [group, list] of byGroup) {
    const hits = new Map<string, number>();
    for (const sample of list) {
      for (const token of candidateTokens(sample.streamName)) {
        hits.set(token, (hits.get(token) ?? 0) + 1);
        const all = holders.get(token);
        if (all) all.add(sample);
        else holders.set(token, new Set([sample]));
      }
    }
    for (const [token, count] of hits) {
      const perGroup = shares.get(token) ?? new Map<string, number>();
      perGroup.set(group, count / list.length);
      shares.set(token, perGroup);
    }
  }

  const rejected: RejectedConsolidation[] = [];
  const passed: ConsolidatedToken[] = [];
  const confoundedCodecs: ConsolidatedToken[] = [];

  for (const [token, perGroup] of shares) {
    const carriers = [...perGroup].filter(([, share]) => share >= settings.carrierShare);
    // A group between the floor and the carrier share carries the token for
    // some of its streams and not others. That is neither pass's business: Pass
    // B would consolidate a group where the token is not universal, and Pass A
    // has already had its chance at it inside the cell.
    const ambiguous = [...perGroup].filter(
      ([, share]) => share > settings.contaminationFloor && share < settings.carrierShare,
    );

    const withEffects = carriers
      .map(([group]) => fitted.get(group))
      .filter((effect): effect is Effect => effect !== undefined);

    if (withEffects.length < settings.minCarrierGroups) {
      // Only worth reporting if it was close -- a token carried by one group is
      // not a rejected consolidation, it is a group.
      if (withEffects.length >= 2) {
        rejected.push({
          token,
          carrierGroups: withEffects.length,
          ambiguousGroups: ambiguous.length,
          deltaKbps: Math.round(weightedMean(withEffects)),
          spreadKbps: Math.round(weightedSpread(withEffects)),
          reason: 'too-few-carriers',
        });
      }
      continue;
    }

    const mean = weightedMean(withEffects);
    const spread = weightedSpread(withEffects);

    if (ambiguous.length > 0) {
      rejected.push({
        token,
        carrierGroups: withEffects.length,
        ambiguousGroups: ambiguous.length,
        deltaKbps: Math.round(mean),
        spreadKbps: Math.round(spread),
        reason: 'contaminated',
      });
      continue;
    }

    // Same sign everywhere, and a mean that stands clear of its own scatter.
    // `MILB` on the live catalogue carries four groups at 100% reading +49,
    // -628, -858 and -1032: the token is real, but the +49 group is a different
    // account, so what the regex would be scoring is the account. Sign
    // consistency is what catches that.
    const sameSign = withEffects.every((effect) => Math.sign(effect.deltaKbps) === Math.sign(mean));
    if (!sameSign || Math.abs(mean) < spread) {
      rejected.push({
        token,
        carrierGroups: withEffects.length,
        ambiguousGroups: ambiguous.length,
        deltaKbps: Math.round(mean),
        spreadKbps: Math.round(spread),
        reason: 'inconsistent',
      });
      continue;
    }

    const consolidation: ConsolidatedToken = {
      token,
      pattern: teamarrPattern(tokenPattern(token)),
      deltaKbps: Math.round(mean),
      samples: withEffects.reduce((sum, effect) => sum + effect.samples, 0),
      carriers: withEffects.map((effect) => ({
        group: effect.key,
        samples: effect.samples,
        deltaKbps: effect.deltaKbps,
        // The compression: what is left of the group's own opinion once the
        // regex has taken the part it shares with its siblings.
        residualKbps: Math.round(effect.deltaKbps - mean),
      })),
    };

    // Last, after the guards, so the report can say what it would have scored.
    if (namesCodec(token)) confoundedCodecs.push(consolidation);
    else passed.push(consolidation);
  }

  passed.sort((a, b) => Math.abs(b.deltaKbps) * b.samples - Math.abs(a.deltaKbps) * a.samples);
  const kept = decorrelate(
    passed,
    (token) => holders.get(token.token) ?? new Set(),
    settings,
  ).slice(0, settings.maxRules);

  return { consolidated: kept, rejected, confoundedCodecs };
}

function weightedMean(effects: Effect[]): number {
  const weight = effects.reduce((sum, effect) => sum + effect.samples, 0);
  if (weight === 0) return 0;
  return effects.reduce((sum, effect) => sum + effect.deltaKbps * effect.samples, 0) / weight;
}

function weightedSpread(effects: Effect[]): number {
  const weight = effects.reduce((sum, effect) => sum + effect.samples, 0);
  if (weight === 0) return 0;
  const mean = weightedMean(effects);
  const variance =
    effects.reduce((sum, effect) => sum + effect.samples * (effect.deltaKbps - mean) ** 2, 0) /
    weight;
  return Math.sqrt(variance);
}

/** What the readiness panel reports, and the shape the API returns. */
export interface MinerReport {
  /** Days between the oldest and newest sample Pass A was offered. */
  windowDays: number;
  /** How much longer the window has to get before the duration guard can pass. */
  durationShortfallDays: number;
  cells: number;
  /** Cells big enough that a split could have both sides. */
  cellsWithBothSides: number;
  passA: {
    candidates: NameCandidate[];
    /** Candidates clearing every guard. Reported, not yet exported. */
    clearing: number;
    /** How many died on each guard, most common first. */
    blockedBy: Array<{ guard: MinerGuard; count: number }>;
  };
  passB: ConsolidationResult;
}

/**
 * Both passes, assembled for the panel.
 *
 * One sample set, and it is the configured scope -- the same population the
 * profile is fitted on and the export is applied to. Not a detail: the whole
 * feature is Teamarr rules for event channels, so a rule mined from a film
 * library would be scored against fixtures it was never measured on, which is
 * the mistake the scope gate exists to prevent.
 *
 * That costs real evidence and it is worth being honest about the size of it.
 * The tokens Pass B exists for sit mostly outside the gate on the install this
 * was developed against -- `H265` 12 samples in scope against 130 recorded,
 * `HEVC` 4 against 205, `PRIME:` 11 against 90 -- so Pass B finds nothing there
 * yet. That is the correct amount for it to find. Those samples describe
 * always-on channels, and what they would buy is a rule that fires on Saturday's
 * fixtures. Raising `SAMPLES_PER_BUCKET` is the fix that actually applies:
 * three of the ten buckets that were pinned at the old cap were event buckets,
 * so the in-scope window grows directly.
 */
export function mineNames(
  scoped: StoredQualitySample[],
  groups: Effect[],
  options: MinerOptions = {},
): MinerReport {
  const settings = resolve(options);
  const candidates = minePassA(scoped, options);

  const cells = new Map<string, number>();
  for (const sample of scoped) {
    const key = `${sample.providerId} ${sample.groupId ?? ''} ${sample.tier} ${sample.audioOnly}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }

  const span =
    scoped.length === 0
      ? 0
      : Math.max(...scoped.map((sample) => sample.sampledAt)) -
        Math.min(...scoped.map((sample) => sample.sampledAt));

  const guardCounts = new Map<MinerGuard, number>();
  for (const candidate of candidates) {
    for (const guard of candidate.blockedBy) {
      guardCounts.set(guard, (guardCounts.get(guard) ?? 0) + 1);
    }
  }

  return {
    windowDays: Math.round((span / DAY_MS) * 10) / 10,
    durationShortfallDays: Math.max(
      0,
      Math.round(((settings.minDurationMs - span) / DAY_MS) * 10) / 10,
    ),
    cells: cells.size,
    cellsWithBothSides: [...cells.values()].filter((count) => count >= settings.minSideSamples * 2)
      .length,
    passA: {
      candidates,
      clearing: candidates.filter((candidate) => candidate.blockedBy.length === 0).length,
      blockedBy: [...guardCounts.entries()]
        .map(([guard, count]) => ({ guard, count }))
        .sort((a, b) => b.count - a.count),
    },
    passB: minePassB(scoped, groups, options),
  };
}
