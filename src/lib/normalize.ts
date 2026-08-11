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

const RESOLUTION_RE = /^(\d{3,4})[PI]$/;
const FPS_RE = /^(\d{2,3})FPS$/;
const BRACKETED = /\[[^\]]*\]|\([^)]*\)/g;
/**
 * Unicode decoration the providers love: superscripts, modifier letters, and
 * the bidi isolates that wrap many names ("⁨Movie Network East⁩").
 */
const DECORATION = /[¹²³ʰ-˿ᴬ-ᶿ⁰-₟⁦-⁩]+/g;
const SEPARATORS = /\s*[:|]\s*/;

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
  /** "+1", "+24" -- a different channel entirely, not a variant. */
  isTimeshift: boolean;
}

/** Strip accents and decoration so 'Águila' and 'Aguila' compare equal. */
function fold(text: string): string {
  return text
    .replace(DECORATION, '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '');
}

function tierFor(height: number): string {
  if (height >= 2000) return 'uhd';
  if (height >= 1000) return 'fhd';
  if (height >= 700) return 'hd';
  return 'sd';
}

export function normalize(raw: string, maxPrefixSegments = 3): NormalizedName {
  let text = fold(raw).replace(BRACKETED, ' ');

  // Timeshift channels ("HBO +1") are a *different* channel, never a variant of
  // the base one, so this is surfaced rather than stripped.
  const isTimeshift = /\+\s*\d+(?!\d)/.test(text);

  // Leading "COUNTRY:" / "CATEGORY |" segments. Bounded, so a name that simply
  // contains a colon does not get eaten.
  const prefixes: string[] = [];
  for (let i = 0; i < maxPrefixSegments; i++) {
    const match = SEPARATORS.exec(text);
    if (!match || match.index === 0 || match.index > 25) break;
    const head = text.slice(0, match.index).trim();
    if (!head || head.split(/\s+/).length > 4) break;
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
    } else {
      break;
    }
    words.pop();
  }

  const name = words
    .join(' ')
    .replace(/^[\s\-_.]+|[\s\-_.]+$/g, '')
    .replace(/\s+/g, ' ');

  return {
    raw,
    name,
    prefixes,
    quality: { tier, height, codec, fps, flags: [...flags].sort() },
    isTimeshift,
  };
}

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
