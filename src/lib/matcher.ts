/**
 * Matching provider streams onto channels.
 *
 * Three layers, in order of preference:
 *
 * 1. **Aliases** -- plain channel names. "Food Network", "HBO East". Matched
 *    against the *normalised* stream name, so casing, accents, "USA:" prefixes,
 *    "FHD H265" suffixes and unicode decoration are handled centrally instead
 *    of being spelled out per channel. An alias can be *qualified* by prefix
 *    (`@AU beIN Sports`) when the prefix is the whole difference between two
 *    feeds -- see `parseAlias`.
 * 2. **Contains** -- substring aliases, for call-sign channels whose name is
 *    embedded in a longer provider name ("VA | Luray | NBC 4 WRC" for `WRC`).
 *    The legacy regexes used `search`, so whole-name aliases alone lost these.
 * 3. **Regex** -- an escape hatch for what the first two cannot express.
 *
 * Global guards (region, timeshift, radio) are config, not copy-pasted
 * lookaheads. Changing "also ignore DE:" is a one-line edit rather than a
 * rewrite of every pattern in the file.
 */

import { globToRegExp } from './eligibility';
import { matchKey, type NormalizedName, normalize, qualityKeys, tailKeys } from './normalize';

export interface StreamLike {
  id: number;
  name: string;
  providerId: number;
  /** The provider group it was imported under, if the caller knows it. */
  groupId?: number | null;
}

export interface CompiledPattern {
  regex: RegExp;
  stepOrder: number;
  providers: Set<number> | null;
}

export interface ChannelRule {
  channelId: number;
  name: string;
  aliases: string[];
  /** Substring aliases. Matched against the normalised name, case-folded. */
  contains: string[];
  exclude: string[];
  patterns: CompiledPattern[];
  providers: Set<number> | null;
  stepOrder: number;
  /**
   * `null` means "inherit the global default". An explicit empty array means
   * this channel excludes no regions at all -- which is different, and is the
   * common case: most legacy patterns carried no region guard whatsoever.
   */
  excludeRegions: Set<string> | null;
}

export interface Guards {
  regions: Set<string>;
  timeshift: boolean;
  radio: boolean;
  maxPrefixSegments: number;
  /**
   * Provider groups whose streams no channel may claim, as name globs.
   *
   * Names rather than ids because Dispatcharr recreates groups as providers
   * change their M3U -- the same reason the channel-side policy grew
   * `Auto | *` patterns -- and because "PPV EVENTS" is what the operator is
   * actually thinking of, while its id is an implementation detail.
   */
  excludeGroups: string[];
}

export const DEFAULT_GUARDS: Guards = {
  regions: new Set(),
  timeshift: true,
  radio: true,
  maxPrefixSegments: 3,
  excludeGroups: [],
};

/** Streams normalised once and bucketed by match key. */
export interface StreamIndex {
  streams: StreamLike[];
  normalized: Map<number, NormalizedName>;
  byKey: Map<string, StreamLike[]>;
  /**
   * Names keyed by `<section>/<rest>`, for aliases whose section the provider
   * left inside the name instead of punctuating it off.
   *
   * `MLB CHICAGO CUBS` is the name "Chicago Cubs" in the MLB section, but with
   * no separator `normalize` cannot lift the section, so `byKey` holds it under
   * "mlbchicagocubs" and the alias never meets it.
   */
  bySection: Map<string, StreamLike[]>;
  /** Lowercased normalised names, for the `contains` layer. */
  folded: Map<number, string>;
  /**
   * Group ids the `excludeGroups` globs resolved to against this snapshot.
   *
   * Resolved once here rather than per stream: the hot path is an integer set
   * lookup, and the globs only mean anything alongside a group list anyway.
   */
  excludedGroups: Set<number>;
}

/** Key for a name whose leading section words have been split off. */
function sectionKey(section: string, rest: string): string {
  return `${section}/${rest}`;
}

/**
 * Which group ids a set of name globs covers.
 *
 * An empty glob list resolves to an empty set rather than scanning, because
 * that is the overwhelmingly common case and the group list is large -- 2,782
 * groups on a real install.
 */
export function resolveExcludedGroups(
  globs: string[],
  groupNames?: Map<number, string>,
): Set<number> {
  const out = new Set<number>();
  if (globs.length === 0) return out;
  // Silently ignoring the operator's exclusions because a call site forgot to
  // pass the group list is the worst available outcome: the streams they
  // switched off quietly come back. Fail where the mistake is.
  if (!groupNames) {
    throw new Error(
      `buildIndex needs the group list to apply exclude_groups (${globs.join(', ')})`,
    );
  }
  const tests = globs.map((glob) => globToRegExp(glob));
  for (const [id, name] of groupNames) {
    if (tests.some((test) => test.test(name))) out.add(id);
  }
  return out;
}

/**
 * An alias with its prefix qualifiers split off.
 *
 * Providers ship the same channel name under different leading segments, and
 * the segment is sometimes the entire difference that matters: "AU: beIN
 * Sports" and "US: beIN Sports" carry different events, and a "Prime:" copy of
 * a US network is often the FAST channel rather than the linear feed.
 * `normalize` lifts those segments into `prefixes` and an unqualified alias
 * ignores them, so one alias claims every region's copy at once.
 *
 * `@AU beIN Sports` requires the segment. `@!Prime ESPN` rejects it. Several
 * may be stacked (`@US @USA Fox Sports 1`), and a multi-word segment can be
 * quoted (`@"US East" ESPN`).
 *
 * The tokens providers hang off the *end* -- "4K", "H265", "1080p" -- are the
 * same problem at the other end of the name, and take a trailing `~`:
 * `@AU beIN Sports ~4K` is the AU section's UHD copy. See `TAIL_QUALIFIER`.
 *
 * The `@` marker rather than the provider's own `AU:` syntax because aliases
 * containing a literal prefix already exist and already mean the loose thing --
 * every converted "Radio: <station>" alias, and there are usually hundreds.
 * Redefining those in place would silently narrow half the ruleset, which is the
 * exact failure `aliasKey` was written to fix.
 */
export interface AliasSpec {
  /** The alias with its qualifiers stripped. */
  text: string;
  /** Prefix keys the stream must carry, any one of. Empty means "any prefix". */
  require: Set<string>;
  /** Prefix keys that disqualify a stream. */
  reject: Set<string>;
  /** Tail tokens the stream must carry, all of them. See `tagsSatisfy`. */
  requireTags: Set<string>;
  /** Tail tokens that disqualify a stream. */
  rejectTags: Set<string>;
}

/**
 * Trailing whitespace is part of the qualifier on purpose: "@Home" was a real
 * channel, and an alias that is only an `@`-word must stay a name.
 */
const QUALIFIER = /^@(!?)(?:"([^"]+)"|(\S+))\s+/;

/**
 * The same question at the other end of the name: `CNN ~4K`, `CNN ~!hevc`.
 *
 * A separate marker, written where the thing it names actually sits. `@`
 * constrains the section a provider puts in front; `~` constrains the tokens it
 * hangs off the back. Reusing `@` for both would have meant one marker whose
 * meaning depended on position, and -- worse -- would have quietly widened every
 * `@HD` already in a rules file from "the HD: section" to "anything tagged HD".
 *
 * The tilde must start a word, for the same reason `@` must end one: a name is
 * allowed to contain a tilde. It may stand alone as the whole line, unlike `@`
 * -- "@Home" was a real channel and had to keep being a name, while a leading
 * tilde is not a way anyone writes one. That is what lets `exclude` hold
 * `~"event only"`, naming a variant that has no name of its own.
 */
const TAIL_QUALIFIER = /(?:^|\s+)~(!?)(?:"([^"]+)"|(\S+))$/;

export function parseAlias(line: string): AliasSpec {
  let text = line.trim();
  const require = new Set<string>();
  const reject = new Set<string>();
  const requireTags = new Set<string>();
  const rejectTags = new Set<string>();

  for (;;) {
    const match = QUALIFIER.exec(text);
    if (!match) break;
    // Tolerate "@AU:" or "@AU -" -- the separator is how the prefix reads in the
    // stream name, so people will type it.
    const key = matchKey((match[2] ?? match[3] ?? '').replace(/[:|–—-]+$/, ''));
    if (key) (match[1] ? reject : require).add(key);
    text = text.slice(match[0].length);
  }

  for (;;) {
    const match = TAIL_QUALIFIER.exec(text);
    if (!match) break;
    const key = matchKey(match[2] ?? match[3] ?? '');
    if (key) (match[1] ? rejectTags : requireTags).add(key);
    text = text.slice(0, match.index);
  }

  return { text: text.trim(), require, reject, requireTags, rejectTags };
}

const UNQUALIFIED: AliasSpec = {
  text: '',
  require: new Set(),
  reject: new Set(),
  requireTags: new Set(),
  rejectTags: new Set(),
};

/**
 * How many leading words of a segment a qualifier may consume.
 *
 * A qualifier names the *section* a stream sits in, so it is short: "NFL",
 * "NFL Teams", "US East", "MiLB AAA". `normalize` already caps a prefix segment
 * at four words, so this loses no punctuated prefix, and it stops `@` from
 * quietly becoming a second way to spell an alias.
 */
const QUALIFIER_WORDS = 4;

/**
 * Every key an `@` qualifier can match on a stream.
 *
 * Providers write the same section two ways and mean the same thing:
 *
 *     NFL Teams: FOX Commanders (WTTG) Washington DC   punctuated
 *     NFL WASHINGTON COMMANDERS                        not punctuated
 *
 * Only the first has a separator, so only the first gets its section lifted
 * into `prefixes`. Matching qualifiers against `prefixes` alone therefore
 * leaves half of every section unreachable, and the only way left to say "the
 * Commanders feed in the NFL section" is the per-channel regex this tool exists
 * to delete -- `^NFL\b.*(?<![A-Za-z0-9])Commanders(?![A-Za-z0-9])`.
 *
 * So a qualifier matches the leading words of a prefix segment *or* the leading
 * words of the name *or* a trailing market tag. `@NFL` covers both lines above;
 * `Radio: Washington Commanders` and `NRL : PENRITH PANTHERS` still fall outside
 * it.
 */
function qualifierKeys(norm: NormalizedName): Set<string> {
  const cached = qualifierCache.get(norm);
  if (cached) return cached;

  const keys = new Set<string>();
  const addRuns = (text: string): void => {
    const words = text.split(/\s+/).filter(Boolean);
    for (let i = 1; i <= Math.min(words.length, QUALIFIER_WORDS); i++) {
      const key = matchKey(words.slice(0, i).join(' '));
      if (key) keys.add(key);
    }
  };

  for (const prefix of norm.prefixes) addRuns(prefix);
  // Market tags lifted off the tail. Without these the only thing telling two
  // feeds apart would be the very text `normalize` just removed, so a channel
  // sold into several markets would be unaddressable.
  for (const region of norm.regions) {
    const key = matchKey(region);
    if (key) keys.add(key);
  }
  addRuns(norm.name);

  qualifierCache.set(norm, keys);
  return keys;
}

/**
 * Normalised names are built once per stream in `buildIndex` and held for the
 * life of the index, so keying the cache on the object memoises exactly once
 * per stream without a second lookup table to keep in step.
 */
const qualifierCache = new WeakMap<NormalizedName, Set<string>>();

/** Whether a stream's sections satisfy an alias's qualifiers. */
export function prefixesSatisfy(spec: AliasSpec, norm: NormalizedName): boolean {
  if (spec.require.size === 0 && spec.reject.size === 0) return true;
  const keys = qualifierKeys(norm);
  for (const key of keys) if (spec.reject.has(key)) return false;
  if (spec.require.size === 0) return true;
  for (const key of spec.require) if (keys.has(key)) return true;
  return false;
}

/**
 * Whether a stream's tail tokens satisfy an alias's `~` qualifiers.
 *
 * `require` is **all of**, where the `@` side is **any of**, and the difference
 * is not an inconsistency -- it follows from what the two sides name. A stream
 * sits in one section, spelled several ways, so `@US @USA` is one question with
 * two acceptable answers. A stream carries several tail tokens *at once* -- tier,
 * codec, fps, flags -- so `~4K ~hevc` is two questions, and meaning "either"
 * there would make the pair say less than each line alone.
 */
export function tagsSatisfy(spec: AliasSpec, norm: NormalizedName): boolean {
  if (spec.requireTags.size === 0 && spec.rejectTags.size === 0) return true;
  const keys = tailKeys(norm);
  for (const key of spec.rejectTags) if (keys.has(key)) return false;
  for (const key of spec.requireTags) if (!keys.has(key)) return false;
  return true;
}

export function rejectedBy(guards: Guards, norm: NormalizedName): string {
  if (guards.timeshift && norm.isTimeshift) return 'timeshift';
  for (const prefix of norm.prefixes) {
    if (guards.radio && prefix.toLowerCase().startsWith('radio')) return 'radio';
    if (guards.regions.size > 0 && guards.regions.has(prefix.trim().toUpperCase())) return 'region';
  }
  return '';
}

export class Matcher {
  constructor(
    readonly rules: Map<number, ChannelRule>,
    readonly guards: Guards = DEFAULT_GUARDS,
    readonly caseSensitive = false,
    readonly requireExactMatch = false,
  ) {}

  /**
   * With caseSensitive on, casing is preserved but punctuation and decoration
   * are still folded -- otherwise the setting would just mean "match nothing",
   * which is what it effectively meant in the tool this replaces.
   */
  key(text: string): string {
    return this.caseSensitive ? text.trim() : matchKey(text);
  }

  /**
   * Key an alias the same way a stream name is keyed.
   *
   * Aliases and stream names must go through *identical* processing or they can
   * never meet. Converted radio aliases are literally "Radio: Coast FM" --
   * prefix included -- while the stream "Radio: Coast FM" normalises to
   * "Coast FM" with "Radio" lifted into `prefixes`. Keying the raw alias gives
   * "radiocoastfm" against the stream's "coastfm", so every one of those
   * channels matched nothing at all.
   */
  aliasKey(alias: string): string {
    return this.key(normalize(alias, this.guards.maxPrefixSegments).name);
  }

  /** An alias line split into its prefix qualifiers and its lookup key. */
  compileAlias(line: string): { key: string; spec: AliasSpec } {
    const spec = parseAlias(line);
    return { key: this.aliasKey(spec.text), spec };
  }

  /**
   * An `exclude` line, keyed both as a name and as a tail token.
   *
   * `tag` is keyed off the raw text rather than through `aliasKey`, because
   * `normalize` eats the very token being named: "4K" normalises to the empty
   * name, so the alias key of an entry like that is `''` and would otherwise
   * silently mean "exclude every stream whose name normalises away".
   *
   * Both are kept, and neither can be mistaken for the other: a name that
   * survives normalisation never keys to a token normalisation removes.
   */
  compileExclude(line: string): { key: string; tag: string; named: boolean; spec: AliasSpec } {
    const { key, spec } = this.compileAlias(line);
    // Always case-insensitive: "4k" and "4K" are the same tag, and a
    // case-sensitive ruleset is asking about *names*, not decoration.
    const tag = matchKey(spec.text);
    return { key, tag, named: key !== '' || tag !== '', spec };
  }

  /**
   * Global guards, narrowed for this channel.
   *
   * The radio guard exists to stop radio streams being claimed by TV channels,
   * and it is inherited from the legacy `(?!Radio:)` lookahead. But a channel
   * whose *own* aliases are radio names obviously wants radio: applying the
   * guard there rejects every candidate it could ever have. On a ruleset with a
   * large radio section that silently kills every one of those channels, because
   * their aliases are all "Radio: <station>".
   */
  guardsFor(rule: ChannelRule): Guards {
    const regions = rule.excludeRegions ?? this.guards.regions;
    const wantsRadio = rule.aliases.some((alias) => {
      const spec = parseAlias(alias);
      return /^\s*radio\b/i.test(spec.text) || spec.require.has('radio');
    });
    if (regions === this.guards.regions && !wantsRadio) return this.guards;
    return { ...this.guards, regions, radio: this.guards.radio && !wantsRadio };
  }

  /**
   * Normalise every stream once, up front.
   *
   * Matching naively rescans the whole stream list per channel: 790 channels x
   * 21,900 streams is 17 million normalisations, ~111 seconds of blocking CPU.
   * Normalising once and bucketing by match key makes alias lookup O(1) per
   * alias -- measured 51x faster with identical results.
   */
  buildIndex(streams: StreamLike[], groupNames?: Map<number, string>): StreamIndex {
    const normalized = new Map<number, NormalizedName>();
    const byKey = new Map<string, StreamLike[]>();
    const bySection = new Map<string, StreamLike[]>();
    const folded = new Map<number, string>();
    const excludedGroups = resolveExcludedGroups(this.guards.excludeGroups, groupNames);

    const push = (map: Map<string, StreamLike[]>, key: string, stream: StreamLike): void => {
      const bucket = map.get(key);
      if (bucket) bucket.push(stream);
      else map.set(key, [stream]);
    };

    for (const stream of streams) {
      const norm = normalize(stream.name, this.guards.maxPrefixSegments);
      normalized.set(stream.id, norm);
      folded.set(stream.id, norm.name.toLowerCase());
      push(byKey, this.key(norm.name), stream);

      // Every way the name could split into a section and a name. At least one
      // word has to stay behind: a section that swallows the whole name leaves
      // nothing for the alias to be.
      const words = norm.name.split(/\s+/).filter(Boolean);
      for (let i = 1; i < Math.min(words.length, QUALIFIER_WORDS + 1); i++) {
        const section = matchKey(words.slice(0, i).join(' '));
        const rest = this.key(words.slice(i).join(' '));
        if (section && rest) push(bySection, sectionKey(section, rest), stream);
      }
    }
    return { streams, normalized, byKey, bySection, folded, excludedGroups };
  }

  /** Return `[streamId, stepOrder]` for every stream this channel claims. */
  match(rule: ChannelRule, index: StreamIndex): Array<[number, number]> {
    const guards = this.guardsFor(rule);
    const excludes = rule.exclude.map((entry) => this.compileExclude(entry));
    const best = new Map<number, number>();

    /**
     * An explicitly required prefix outranks the region denylist.
     *
     * Asking for "@AU beIN Sports" on a channel whose `exclude_regions` holds
     * AU otherwise matches nothing at all, silently -- and 389 channels here
     * carry the AU/NZ denylist inherited from the legacy patterns. Naming a
     * region in an alias is the more specific statement, so it wins. Only the
     * named regions are lifted; the rest of the denylist still applies.
     */
    const guardsWith = (spec: AliasSpec): Guards => {
      if (spec.require.size === 0 || guards.regions.size === 0) return guards;
      const regions = new Set(
        [...guards.regions].filter((region) => !spec.require.has(matchKey(region))),
      );
      return regions.size === guards.regions.size ? guards : { ...guards, regions };
    };

    const admit = (stream: StreamLike, step: number, spec: AliasSpec): void => {
      if (rule.providers && !rule.providers.has(stream.providerId)) return;
      // Before anything a rule can say: an excluded group is the operator
      // saying these streams are not candidates at all, so no alias, contains
      // or regex reaches them -- including the legacy patterns.
      if (stream.groupId != null && index.excludedGroups.has(stream.groupId)) return;
      const norm = index.normalized.get(stream.id);
      if (!norm || !prefixesSatisfy(spec, norm) || !tagsSatisfy(spec, norm)) return;
      if (rejectedBy(guardsWith(spec), norm)) return;
      const key = this.key(norm.name);
      // An exclude entry names a stream three ways, and its qualifiers narrow
      // whichever it used: by name (`CNN`, or `CNN ~4K` for one variant of it),
      // by bare quality token (`4K` -- the variant across every name), or by
      // qualifier alone (`~"event only"` -- a variant whose only mark is text
      // the name does not keep). An empty name key is not a name match: it means
      // the entry named something other than a name.
      const excluded = excludes.some((x) => {
        const hit = x.named
          ? (key !== '' && x.key === key) || (x.tag !== '' && qualityKeys(norm.quality).has(x.tag))
          : // Qualifiers alone. An entry with nothing at all -- a blank line in
            // the box -- names nothing and must reject nothing, or one stray
            // newline empties the channel.
            x.spec.requireTags.size > 0 || x.spec.rejectTags.size > 0;
        return hit && prefixesSatisfy(x.spec, norm) && tagsSatisfy(x.spec, norm);
      });
      if (excluded) return;
      const current = best.get(stream.id);
      if (current === undefined || step < current) best.set(stream.id, step);
    };

    // Alias order is preference order, same contract as step order. That is
    // what makes "prefer the AU feed, fall back to any" just two lines:
    //
    //     @AU beIN Sports
    //     beIN Sports
    rule.aliases.forEach((alias, position) => {
      const { key, spec } = this.compileAlias(alias);
      const step = rule.stepOrder + position;
      for (const stream of index.byKey.get(key) ?? []) admit(stream, step, spec);

      // Then the same alias against names that carry their section inline:
      // "@MLB Chicago Cubs" has to reach "US| MLB CHICAGO CUBS HD".
      //
      // Only sections the alias *named* are stripped. Stripping any leading
      // word would make "@US Chicago Cubs" match "MLB CHICAGO CUBS" -- and,
      // worse, would quietly turn every alias into a suffix match.
      for (const section of spec.require) {
        for (const stream of index.bySection.get(sectionKey(section, key)) ?? []) {
          admit(stream, step, spec);
        }
      }
    });

    // `contains` ranks after exact aliases -- an exact name is always the
    // better claim on a stream than a substring hit.
    if (rule.contains.length > 0) {
      const base = rule.stepOrder + rule.aliases.length;
      rule.contains.forEach((needle, position) => {
        const spec = parseAlias(needle);
        const probe = spec.text.toLowerCase();
        if (!probe) return;
        const matcher = wordBoundaryMatcher(probe);
        for (const stream of index.streams) {
          if (matcher.test(index.folded.get(stream.id) ?? '')) {
            admit(stream, base + position, spec);
          }
        }
      });
    }

    for (const pattern of rule.patterns) {
      for (const stream of index.streams) {
        if (pattern.providers && !pattern.providers.has(stream.providerId)) continue;
        const hit = this.requireExactMatch
          ? matchesFully(pattern.regex, stream.name)
          : pattern.regex.test(stream.name);
        // Shared RegExp objects with /g would carry lastIndex between calls.
        pattern.regex.lastIndex = 0;
        if (hit) admit(stream, pattern.stepOrder, UNQUALIFIED);
      }
    }

    return [...best.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  }
}

const boundaryCache = new Map<string, RegExp>();

/**
 * Whole-word matcher for a `contains` needle.
 *
 * A raw substring is far too loose for call signs: "WRC" hits "WRCB" (a
 * different station in a different city) and "NBC 3 WRCB". Anchoring to word
 * boundaries keeps the call-sign case working without dragging in every name
 * that merely has those letters in a row.
 */
function wordBoundaryMatcher(needle: string): RegExp {
  const cached = boundaryCache.get(needle);
  if (cached) return cached;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Not \b: the needle can start or end with a non-word character, where \b
  // would assert the wrong way round.
  const regex = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
  boundaryCache.set(needle, regex);
  return regex;
}

function matchesFully(regex: RegExp, text: string): boolean {
  const match = regex.exec(text);
  regex.lastIndex = 0;
  return match !== null && match[0] === text;
}
