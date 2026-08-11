/**
 * Decompose machine-generated rule regexes into aliases plus guards.
 *
 * The patterns this handles come from an older generation of rule exporter, and
 * share a rigid shape:
 *
 *     (?i)^  <region guard>  <timeshift guard>  <prefix allowance>
 *            (?: NAME | NAME | ... )
 *            <quality-token soup>  \s*$
 *
 * Only the alternation in the middle carries per-channel information.
 * Everything else is boilerplate repeated once per pattern, expressed once as
 * `defaults` in the schema-2 config.
 *
 * Anything that does not fit the shape is left as a regex rather than guessed
 * at -- a silently mis-converted pattern would quietly stop matching a channel,
 * which is far worse than carrying a few regexes forward.
 *
 * Region guards are emitted **per channel, never unioned**: a large share of
 * patterns carry no region guard at all, and hoisting the union to a global
 * default silently excluded every "US:"/"UK:" stream from the channels that
 * legitimately wanted them, costing thousands of stream links.
 */

import { matchKey } from './normalize';

const TIMESHIFT_GUARD = '(?!.*\\+\\s*1(?![0-9]))';
const PREFIX_ALLOWANCE = '(?:(?!Radio:)[^:|]{1,25}[:|]\\s*){0,3}';
/** "Allow up to N short bare words before the name" -- a second allowance. */
const LEADING_WORDS = /^\(\?:\[A-Za-z0-9\]\{1,\d+\}\\s\+\)\{0,(\d+)\}/;
const QUALITY_SOUP_HEAD = '(?:\\s*(?:HD|FHD|SD|UHD';
const REGION_GUARD = /^\(\?!\\s\*\(\?:([^)]+)\)\\s\*\(\?:\[:\|\]\|\\s\)\)/;
const METACHARS = new Set(['[', ']', '{', '}', '(', ')', '*', '+', '?', '^', '$', '|', '\\']);

export interface Decomposition {
  aliases: string[];
  regions: Set<string>;
  timeshift: boolean;
  radio: boolean;
  /**
   * How many leading words the old pattern let a name skip before the alias.
   * Recorded because it says how loose the pattern was, not consumed: nothing
   * downstream is configurable by it, and an inert `max_leading_words` in the
   * emitted defaults reads like it controls `@` qualifier width, which it never
   * did.
   */
  leadingWords: number;
  converted: boolean;
  reason: string;
}

/** True if a pattern is restricted to specific providers. */
export function scopeOf(raw: unknown): number[] | null {
  if (raw === null || raw === undefined || raw === '' || raw === 'null' || raw === '[]') {
    return null;
  }
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value) && value.length > 0) {
    return [...new Set(value.map(Number))].sort((a, b) => a - b);
  }
  return null;
}

/**
 * Turn a regex fragment back into a plain name, or null if it is not one.
 *
 * Metacharacters must be checked *before* unescaping: "\[4K\]" is the literal
 * name "[4K]" and is fine, while "[A-Z]" is a character class and is not. A
 * naive check after unescaping cannot tell them apart.
 */
export function unescapeLiteral(fragment: string): string | null {
  // Longest first: "\s+" must be consumed before the bare "\s" rule, or the
  // leftover "+" reads as an unescaped metachar and the name is rejected.
  let text = fragment;
  for (const token of ['\\s*', '\\s+', '\\s?', '\\s']) {
    text = text.split(token).join(' ');
  }

  const out: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\\') {
      if (index + 1 >= text.length) return null;
      out.push(text[index + 1]!);
      index += 2;
      continue;
    }
    if (METACHARS.has(char)) return null;
    out.push(char);
    index += 1;
  }

  const name = out.join('').replace(/\s+/g, ' ').trim();
  return name || null;
}

/** True if any of `chars` appears outside a backslash escape. */
export function hasUnescaped(text: string, chars: string): boolean {
  let index = 0;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (chars.includes(text[index]!)) return true;
    index += 1;
  }
  return false;
}

/** Split on unescaped `|` only. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\\' && index + 1 < text.length) {
      current += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === '|') {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
    index += 1;
  }
  parts.push(current);
  return parts;
}

function splitAlternation(core: string): string[] | null {
  const text = core.trim();
  if (text.startsWith('(?:') && text.endsWith(')')) {
    const inner = text.slice(3, -1);
    if (hasUnescaped(inner, '()')) return null;
    return splitTopLevel(inner);
  }
  if (hasUnescaped(text, '()|')) return null;
  return [text];
}

export function decompose(pattern: string): Decomposition {
  const out: Decomposition = {
    aliases: [],
    regions: new Set(),
    timeshift: false,
    radio: false,
    leadingWords: 0,
    converted: false,
    reason: '',
  };

  let text = pattern;
  if (text.startsWith('(?i)')) text = text.slice(4);
  if (text.startsWith('^')) text = text.slice(1);

  const region = REGION_GUARD.exec(text);
  if (region) {
    for (const part of region[1]!.split('|')) {
      const cleaned = part.replace(/\\/g, '').trim();
      if (cleaned) out.regions.add(cleaned.toUpperCase());
    }
    text = text.slice(region[0].length);
  }

  if (text.startsWith(TIMESHIFT_GUARD)) {
    out.timeshift = true;
    text = text.slice(TIMESHIFT_GUARD.length);
  }
  if (text.startsWith(PREFIX_ALLOWANCE)) {
    out.radio = true;
    text = text.slice(PREFIX_ALLOWANCE.length);
  }

  const words = LEADING_WORDS.exec(text);
  if (words) {
    out.leadingWords = Number(words[1]);
    text = text.slice(words[0].length);
  }

  const index = text.indexOf(QUALITY_SOUP_HEAD);
  let core = index >= 0 ? text.slice(0, index) : text;
  if (core.endsWith('$')) core = core.slice(0, -1);
  if (core.endsWith('\\s*')) core = core.slice(0, -3);
  core = core.trim();

  const branches = splitAlternation(core);
  if (branches === null) {
    out.reason = 'core is not a flat alternation';
    return out;
  }

  const aliases: string[] = [];
  for (const branch of branches) {
    const name = unescapeLiteral(branch);
    if (name === null) {
      out.reason = `branch is not a plain name: ${branch.slice(0, 40)}`;
      return out;
    }
    if (!aliases.includes(name)) aliases.push(name);
  }
  if (aliases.length === 0) {
    out.reason = 'no aliases extracted';
    return out;
  }

  out.aliases = aliases;
  out.converted = true;
  return out;
}

export interface ConvertStats {
  channels: number;
  converted: number;
  keptRegex: number;
  patterns: number;
}

interface LegacyPattern {
  pattern?: string;
  m3u_accounts?: unknown;
  step_order?: number;
}

interface LegacyChannel {
  channel_id: number | string;
  name?: string;
  enabled?: boolean;
  patterns?: LegacyPattern[] | null;
}

/** Convert a schema-1 export to schema 2. */
export function convert(doc: { channels?: LegacyChannel[] }): {
  doc: Record<string, unknown>;
  stats: ConvertStats;
} {
  let timeshift = false;
  let radio = false;
  const channels: Record<string, unknown>[] = [];
  const stats: ConvertStats = { channels: 0, converted: 0, keptRegex: 0, patterns: 0 };

  for (const entry of doc.channels ?? []) {
    stats.channels += 1;
    const aliases: string[] = [];
    const seenKeys = new Set<string>();
    const leftovers: LegacyPattern[] = [];
    const channelRegions = new Set<string>();

    // Provider scope is carried onto the channel rule rather than blocking
    // conversion. It only blocks when a channel's patterns disagree about
    // scope, since a single rule cannot express two different scopes.
    const scopes = new Set(
      (entry.patterns ?? []).map((s) => JSON.stringify(scopeOf(s.m3u_accounts))),
    );
    const uniformScope =
      scopes.size === 1 ? (JSON.parse([...scopes][0]!) as number[] | null) : null;

    for (const spec of entry.patterns ?? []) {
      stats.patterns += 1;
      const result = decompose(spec.pattern ?? '');
      for (const region of result.regions) channelRegions.add(region);
      timeshift = timeshift || result.timeshift;
      radio = radio || result.radio;

      const scoped = scopeOf(spec.m3u_accounts) !== null;
      const convertible = result.converted && (!scoped || uniformScope !== null);
      if (convertible) {
        // Case and punctuation variants collapse under the matcher's key, so
        // "HBO EAST" / "HBO East" / "hbo-east" are one alias, not three.
        for (const alias of result.aliases) {
          const key = matchKey(alias);
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            aliases.push(alias);
          }
        }
      } else {
        leftovers.push(spec);
      }
    }

    if (aliases.length > 0) stats.converted += 1;
    if (leftovers.length > 0) stats.keptRegex += 1;

    channels.push({
      channel_id: Number(entry.channel_id),
      name: entry.name ?? '',
      enabled: entry.enabled ?? true,
      aliases,
      contains: [],
      exclude: [],
      providers: aliases.length > 0 && uniformScope ? uniformScope : null,
      exclude_regions: [...channelRegions].sort(),
      patterns: leftovers,
    });
  }

  return {
    doc: {
      schema: 2,
      source: 'legacy-converted',
      defaults: {
        // Empty by design -- exclusions live per channel (see module docstring).
        exclude_regions: [],
        exclude_timeshift: timeshift,
        exclude_radio: radio,
        max_prefix_segments: 3,
        case_sensitive: false,
        require_exact_match: false,
      },
      channels,
    },
    stats,
  };
}
