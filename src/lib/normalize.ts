/**
 * Stream-name normalisation and quality-token extraction.
 *
 * Provider stream names are noisy in a small number of very predictable ways:
 *
 *     "USA: ⁧Movie Network East⁩ FHD H265"
 *     "SPORTS | LEAGUE: Team A vs Team B 1080p 60fps"
 *     "UK-FAST: Sports Alpha Main Event ᴴᴰ [Multi]"
 *
 * The approach this replaces handled that by baking the noise into every
 * per-channel regex -- hundreds of patterns, each a couple of hundred characters
 * long, of which only the alternation in the middle differed. Changing "also
 * ignore the DE: prefix" meant rewriting every one of them.
 *
 * Here the noise is handled once, globally, and per-channel config shrinks to a
 * list of names. The quality tokens the old patterns *discarded* are instead
 * parsed out and returned, because they are useful ranking signal available
 * before paying for a probe.
 */

import { iso31661 } from 'iso-3166';

/** Resolution markers, mapped to the vertical resolution they imply. */
const QUALITY_TOKENS: Record<string, { tier: string; height: number }> = {
  UHD: { tier: 'uhd', height: 2160 },
  '4K': { tier: 'uhd', height: 2160 },
  FHD: { tier: 'fhd', height: 1080 },
  HD: { tier: 'hd', height: 720 },
  SD: { tier: 'sd', height: 480 },
  LQ: { tier: 'sd', height: 360 },
};

const CODEC_TOKENS: Record<string, string> = {
  HEVC: 'hevc',
  H265: 'hevc',
  'H.265': 'hevc',
  X265: 'hevc',
  AVC: 'h264',
  H264: 'h264',
  'H.264': 'h264',
  X264: 'h264',
};

const AUDIO_TOKENS = new Set(['AAC', 'AC3', 'DTS', 'DD', 'DD+', 'ATMOS', '2.0', '5.1', '7.1']);
const OTHER_TOKENS = new Set(['RAW', 'MULTI', 'HDR', 'VIP', 'BACKUP', 'ALT']);

/**
 * ISO 3166-1 alpha-2 codes, for the region tags providers hang off the end of a
 * name ("Sports Alpha 1 HD TH MY" -- one feed, sold into two markets).
 *
 * From the standard rather than a hand-kept list: the register changes, and a
 * stale copy fails silently -- the tag stays welded to the name and the channel
 * simply stops matching, which is the failure this is fixing.
 */
const COUNTRY_CODES = new Set(iso31661.map((entry) => entry.alpha2));

const RESOLUTION_RE = /^(\d{3,4})[PI]$/;
const FPS_RE = /^(\d{2,3})FPS$/;
const BRACKETED = /\[[^\]]*\]|\([^)]*\)/g;
/**
 * Unicode decoration the providers love: superscripts, modifier letters, and
 * the bidi isolates that wrap many names ("⁨Movie Network East⁩").
 *
 * Deleted rather than spaced, because every one of these is a modifier hung off
 * the character before it -- "HBOᴴᴰ" is "HBO", not "HBO" and something else.
 */
const DECORATION = /[¹²³ʰ-˿ᴬ-ᶿ⁰-₟⁦-⁩]+/gu;
/**
 * Marker glyphs providers stamp on a stream to flag a feature: ◉ for catch-up,
 * ▶ ⏺ ● for recording or 24/7, ★ for a promoted feed, and a long tail of
 * others that changes whenever a provider redesigns its list.
 *
 * Swept as a Unicode class rather than a hand-kept list of the ones seen so
 * far. "Symbol, other" is precisely the category nothing is *named* with, so
 * membership is the evidence -- and the next glyph a provider invents is
 * already covered, which a literal list can only be by another code change.
 *
 * Left out of the class deliberately: `+` and `$` `€` are Sm/Sc, not So, so
 * "AMC+" and "Paramount+" keep the character that makes them their own channel.
 *
 * Replaced with a space, not deleted, because a marker is a word of its own
 * however the provider spaced it -- "CNN◉FHD" has to leave two tokens behind or
 * the tail scan never sees the FHD.
 */
const SYMBOLS = /\p{So}+/gu;
const SEPARATORS = /\s*[:|]\s*/;
/**
 * An opening delimiter, which carries no information on its own.
 *
 * Providers bracket the segment as often as they suffix it -- "|XX| Movie
 * Network" alongside "XX|Movie Network". With the leading bar left in place the
 * first separator sits at offset zero, so the segment never lifts and the whole
 * bracket keys as part of the name.
 */
const LEADING_SEPARATOR = /^[\s:|]+/;
/**
 * A bracketed segment at the *front* of the name.
 *
 * Providers write the section in brackets as readily as they punctuate it --
 * "[USA] Comedy Central HD" sits in the same catalogue as "US: Comedy Central
 * HD" and "USA | Comedy Central" and means the same thing by it. Stripped as
 * decoration along with every other bracket, that section was the one spelling
 * an `@` qualifier could not name and the region denylist could not see, so
 * "include USA, drop PL" silently skipped exactly the streams written this way.
 */
const LEADING_BRACKET = /^[\s:|]*[[(]([^\])]*)[\])]/;

/**
 * How many words a leading segment may run to before it stops reading as one.
 *
 * A section marker is short ("USA", "NFL Teams", "US East"); a longer head is
 * the name itself with punctuation in it, and lifting that empties the name.
 */
const MAX_PREFIX_WORDS = 4;

export interface Quality {
  tier: string;
  height: number;
  codec: string;
  fps: number;
  flags: string[];
}

export interface NormalizedName {
  raw: string;
  /** The cleaned channel name. */
  name: string;
  /** Leading "USA:" / "SPORTS |" segments, in order. */
  prefixes: string[];
  quality: Quality;
  /**
   * Trailing ISO 3166-1 alpha-2 market tags, in the order they were written.
   *
   * Kept rather than discarded because they are the only thing separating two
   * otherwise identical names, and an `@` qualifier can select on them.
   */
  regions: string[];
  /**
   * The contents of each bracketed group, in the order they were written.
   *
   * Brackets are stripped before anything else looks at the name, and for
   * decoration -- "[Multi]", "(HEVC)" -- that is right. But providers also put
   * the one thing that distinguishes a feed in there: "FS1 4K (Event Only)" is
   * a different stream from "FS1 4K", and with the bracket discarded the two
   * were identical to every rule Podium has. Kept so a `~` qualifier can name
   * them; still out of the name itself, so aliases are unaffected.
   */
  brackets: string[];
  /** "+1", "+24" -- a different channel entirely, not a variant. */
  isTimeshift: boolean;
}

/**
 * Extra noise to remove, from the rules file rather than from this module.
 *
 * `SYMBOLS` retires the whole glyph class in one go, but it can only reach
 * things Unicode agrees are symbols. The rest of what providers stamp on a name
 * is *words* -- "CATCHUP", "24/7", "NEW" -- and no category covers those,
 * because each one is only noise on the catalogue it appears in. Left to code
 * that means a release every time a provider invents a badge; the operator
 * looking at the name can simply say so instead.
 *
 * Entries are literal text, not patterns: what an operator has in front of them
 * is the string, and a regex here would fail silently and unreadably when it
 * was wrong.
 */
export type StripList = readonly string[];

const NO_STRIP: StripList = [];

/** A character a word can be made of -- what an entry needs a boundary against. */
const WORDISH = /[\p{L}\p{N}]/u;

/**
 * One strip entry as regex source, bounded only where a boundary means anything.
 *
 * "HD" must not eat the tail of "GOLD", so an entry that starts or ends in a
 * word character gets a lookaround on that side. A glyph or a punctuated entry
 * gets none: `\b` next to "◉" or "24/7" asserts against the neighbouring
 * character rather than the entry, which is how a naive `\b` on both sides
 * silently matches nothing at all.
 */
function entrySource(entry: string): string {
  const body = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = WORDISH.test(entry[0]!) ? '(?<![\\p{L}\\p{N}])' : '';
  const right = WORDISH.test(entry[entry.length - 1]!) ? '(?![\\p{L}\\p{N}])' : '';
  return `${left}${body}${right}`;
}

/**
 * The strip list compiled to one alternation, memoised on the list's contents.
 *
 * Compiled once per distinct list rather than per name: `buildIndex`
 * normalises every stream on the install -- 21,900 of them -- and rebuilding
 * this regex inside that loop would cost more than the match it performs. The
 * cache is keyed on content rather than identity because the list is rebuilt
 * from the rules file on every load.
 *
 * Dropped wholesale past a bound rather than grown without one. In steady state
 * there is a single list per process, but the editor previews a candidate entry
 * against the live catalogue on every keystroke, and each of those is a list
 * nothing will ask for again.
 */
const stripCache = new Map<string, RegExp | null>();

const STRIP_CACHE_MAX = 64;

function stripPattern(strip: StripList): RegExp | null {
  if (strip.length === 0) return null;
  const cacheKey = strip.join('\u0000');
  const cached = stripCache.get(cacheKey);
  if (cached !== undefined) return cached;
  if (stripCache.size >= STRIP_CACHE_MAX) stripCache.clear();

  // Entries are folded the same way the name is, and matched against the folded
  // text -- otherwise an entry typed with an accent, or with the decoration the
  // operator copied it out of the name with, could never meet the name it came
  // from.
  const sources = strip
    .map((entry) => foldBase(entry).trim())
    .filter((entry) => entry.length > 0)
    .map(entrySource);

  const pattern = sources.length > 0 ? new RegExp(sources.join('|'), 'giu') : null;
  stripCache.set(cacheKey, pattern);
  return pattern;
}

/** Strip accents and decoration so 'Águila' and 'Aguila' compare equal. */
function foldBase(text: string): string {
  return text
    .replace(DECORATION, '')
    .replace(SYMBOLS, ' ')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '');
}

/**
 * `foldBase` plus whatever the operator added.
 *
 * The strip runs last, on already-folded text, so an entry and the name it is
 * meant to delete are compared in the same shape -- and so a badly chosen entry
 * can only remove text, never change how the built-in decoration is read.
 */
function fold(text: string, strip: StripList = NO_STRIP): string {
  const base = foldBase(text);
  const pattern = stripPattern(strip);
  return pattern ? base.replace(pattern, ' ') : base;
}

function tierFor(height: number): string {
  if (height >= 2000) return 'uhd';
  if (height >= 1000) return 'fhd';
  if (height >= 700) return 'hd';
  return 'sd';
}

export function normalize(
  raw: string,
  maxPrefixSegments = 3,
  strip: StripList = NO_STRIP,
): NormalizedName {
  const brackets: string[] = [];
  const prefixes: string[] = [];
  let text = fold(raw, strip);

  // Leading brackets first, while their position is still known -- the strip
  // below flattens every bracket to a space, and after it "[USA] CNN" and
  // "CNN (USA feed)" are indistinguishable. Kept in `brackets` as well as
  // lifted: a `~USA` written against one of these names before this existed
  // still means what it meant.
  for (let i = 0; i < maxPrefixSegments; i++) {
    const match = LEADING_BRACKET.exec(text);
    if (!match) break;
    const inner = match[1]!.trim();
    if (!inner || inner.split(/\s+/).length > MAX_PREFIX_WORDS) break;
    prefixes.push(inner);
    brackets.push(inner);
    text = text.slice(match[0].length);
  }

  text = text.replace(BRACKETED, (group) => {
    const inner = group.slice(1, -1).trim();
    if (inner) brackets.push(inner);
    return ' ';
  });

  // Timeshift channels ("HBO +1") are a *different* channel, never a variant of
  // the base one, so this is surfaced rather than stripped.
  const isTimeshift = /\+\s*\d+(?!\d)/.test(text);

  // Leading "COUNTRY:" / "CATEGORY |" segments. Bounded, so a name that simply
  // contains a colon does not get eaten.
  for (let i = prefixes.length; i < maxPrefixSegments; i++) {
    // Dropped per segment, not once: a bracketed segment leaves the *next*
    // segment's opening delimiter at the front of what remains.
    text = text.replace(LEADING_SEPARATOR, '');
    const match = SEPARATORS.exec(text);
    if (!match || match.index > 25) break;
    const head = text.slice(0, match.index).trim();
    if (!head || head.split(/\s+/).length > MAX_PREFIX_WORDS) break;
    prefixes.push(head);
    text = text.slice(match.index + match[0].length);
  }

  // Trailing quality tokens, consumed right-to-left until a non-token appears.
  let tier = '';
  let height = 0;
  let codec = '';
  let fps = 0;
  const flags = new Set<string>();

  const words = text.replace(/\+/g, '+ ').split(/\s+/).filter(Boolean);

  /**
   * Region tags met so far, held back rather than dropped.
   *
   * A trailing two-letter code is only noise when something else already marks
   * the tail as noise -- plenty of real channel names end in a word that is also
   * a country code ("Discovery ID", "Sky Atlantic IT"), and eating those would
   * merge distinct channels. So a run of codes is committed only once the scan
   * reaches a genuine quality token to its left, and restored to the name
   * otherwise.
   */
  const regions: string[] = [];
  let held: string[] = [];
  const commit = (): void => {
    // Right-to-left scan, so `held` is reversed relative to the name.
    if (held.length > 0) regions.push(...held.reverse());
    held = [];
  };
  const restore = (): void => {
    if (held.length > 0) words.push(...held.reverse());
    held = [];
  };

  while (words.length > 0) {
    const token = words[words.length - 1]!.replace(/^[.,\-_]+|[.,\-_]+$/g, '').toUpperCase();
    if (!token) {
      words.pop();
      continue;
    }
    const quality = QUALITY_TOKENS[token];
    const codecToken = CODEC_TOKENS[token];
    const resolution = RESOLUTION_RE.exec(token);
    const frames = FPS_RE.exec(token);
    const known =
      quality ||
      codecToken ||
      resolution ||
      frames ||
      AUDIO_TOKENS.has(token) ||
      OTHER_TOKENS.has(token);

    if (!known) {
      // Recognised tokens win: the check runs here, after them, so a code that
      // collides with a quality marker is still read as quality.
      if (COUNTRY_CODES.has(token)) {
        held.push(words.pop()!);
        continue;
      }
      break;
    }
    commit();

    if (quality) {
      if (!tier) {
        tier = quality.tier;
        height = quality.height;
      }
    } else if (codecToken) {
      codec = codec || codecToken;
    } else if (AUDIO_TOKENS.has(token) || OTHER_TOKENS.has(token)) {
      flags.add(token);
    } else if (resolution) {
      const value = Number(resolution[1]);
      if (!height) {
        height = value;
        tier = tier || tierFor(value);
      }
    } else if (frames) {
      fps = fps || Number(frames[1]);
    }
    words.pop();
  }

  // Codes the scan ran past without ever reaching a quality token: part of the
  // name after all.
  restore();

  const name = words
    .join(' ')
    .replace(/^[\s\-_.]+|[\s\-_.]+$/g, '')
    .replace(/\s+/g, ' ');

  return {
    raw,
    name,
    prefixes,
    quality: { tier, height, codec, fps, flags: [...flags].sort() },
    regions,
    brackets,
    isTimeshift,
  };
}

/**
 * Every spelling the tokens stripped off a name can be addressed by.
 *
 * The tail tokens are the one part of a stream name a rule cannot otherwise
 * reach: `normalize` lifts "4K" out so that "US: CNN 4K" and "CNN" key alike,
 * which is exactly what makes one alias claim every variant -- and exactly why
 * "keep the 4K feed off this channel" had no way to be said. An `exclude` entry
 * is matched against this set as well as against the name.
 *
 * A resolution word means its *tier*, not the literal token: "US: CNN UHD" and
 * "US: CNN 2160p" are the same feed described twice, and an operator excluding
 * `4K` means both. The exact height is addressable separately (`2160p`) for the
 * rare case where that distinction is the point.
 *
 * Keys are `matchKey`ed, so what the operator types is compared the same way an
 * alias is -- and no *name* can collide with one, because every token in here is
 * one `normalize` has already taken out of the name.
 */
export function qualityKeys(quality: Quality): Set<string> {
  const cached = qualityKeyCache.get(quality);
  if (cached) return cached;

  const keys = new Set<string>();
  const add = (text: string): void => {
    const key = matchKey(text);
    if (key) keys.add(key);
  };

  if (quality.tier) {
    for (const [token, spec] of Object.entries(QUALITY_TOKENS)) {
      if (spec.tier === quality.tier) add(token);
    }
  }
  if (quality.height) add(`${quality.height}p`);
  if (quality.codec) {
    for (const [token, codec] of Object.entries(CODEC_TOKENS)) {
      if (codec === quality.codec) add(token);
    }
  }
  if (quality.fps) add(`${quality.fps}fps`);
  for (const flag of quality.flags) add(flag);

  qualityKeyCache.set(quality, keys);
  return keys;
}

/**
 * Keyed on the quality object, which `buildIndex` holds for the life of the
 * index -- one set per stream, built only if a rule ever asks.
 */
const qualityKeyCache = new WeakMap<Quality, Set<string>>();

/**
 * Everything at the tail of a name a `~` qualifier can address: the quality
 * tokens above, plus whatever the provider put in brackets.
 *
 * A bracket is keyed whole *and* by word. Whole, because "(Event Only)" is one
 * phrase and that is how an operator will name it. By word, because providers
 * pack several tokens into one bracket -- "(1080p 60fps)", "[HEVC Multi]" --
 * and a key for that whole string would be one nobody could guess.
 *
 * Bracket keys stay out of `qualityKeys` on purpose. A quality token can never
 * collide with a name, because `normalize` has already removed every one of
 * them from every name; bracket text has no such guarantee, so it is reachable
 * only when a rule names it explicitly with `~`. That is what keeps a bare
 * `exclude` line meaning exactly what it meant before this existed.
 */
export function tailKeys(norm: NormalizedName): Set<string> {
  const cached = tailKeyCache.get(norm);
  if (cached) return cached;

  const keys = new Set(qualityKeys(norm.quality));
  for (const bracket of norm.brackets) {
    const whole = matchKey(bracket);
    if (whole) keys.add(whole);
    for (const word of bracket.split(/\s+/)) {
      const key = matchKey(word);
      if (key) keys.add(key);
    }
  }

  tailKeyCache.set(norm, keys);
  return keys;
}

const tailKeyCache = new WeakMap<NormalizedName, Set<string>>();

/**
 * Key for alias comparison: fold, casefold, drop insignificant punctuation.
 *
 * 'The Discovery Channel', 'DISCOVERY CHANNEL' and 'Discovery-Channel' all
 * collapse to the same key, which is what makes a plain alias list workable
 * where the old config needed an explicit alternation of every casing.
 *
 * '+' is deliberately *kept*: "AMC" and "AMC+" are different channels, as are
 * "Paramount" and "Paramount+". Folding it away silently merges them.
 */
export function matchKey(name: string): string {
  return fold(name)
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, '');
}

/**
 * The first word of a segment or name -- the section marker an `@` qualifier
 * is written against.
 *
 * "NFL Teams" and "NFL WASHINGTON COMMANDERS" both reduce to "NFL", which is
 * the point: providers punctuate the section on some names and not on others,
 * and both are the same section.
 */
export function leadingWord(text: string): string {
  return fold(text).trim().split(/\s+/)[0] ?? '';
}
