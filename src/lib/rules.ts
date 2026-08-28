/**
 * Loading and validating the rules file.
 *
 * Both schema 1 (the legacy all-regex export) and schema 2 (aliases) load here,
 * so a migration can be done incrementally -- convert the channels you care
 * about, leave the rest as regex.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { z } from 'zod';
import {
  type ChannelRule,
  type CompiledPattern,
  DEFAULT_GUARDS,
  type Guards,
  Matcher,
} from './matcher';
import { DEFAULT_ORDERING, type OrderingConfig } from './ordering';
import {
  NEW_INSTALL_AUDIO,
  NEW_INSTALL_HEVC_FACTOR,
  NEW_INSTALL_UHD_BITRATE_KBPS,
} from './scoring';

const patternSchema = z.object({
  pattern: z.string(),
  m3u_accounts: z.unknown().optional(),
  step_order: z.coerce.number().optional(),
});

const channelSchema = z.object({
  // Imported rule sets persist channel_id as TEXT. Dispatcharr's ids are
  // integers, so an uncoerced key silently matches nothing at all.
  channel_id: z.coerce.number(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  aliases: z.array(z.string()).optional(),
  contains: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  providers: z.unknown().optional(),
  exclude_regions: z.array(z.string()).nullish(),
  step_order: z.coerce.number().optional(),
  patterns: z.array(patternSchema).nullish(),
});

const defaultsSchema = z
  .object({
    exclude_regions: z.array(z.string()).optional(),
    exclude_timeshift: z.boolean().optional(),
    exclude_radio: z.boolean().optional(),
    /** Provider group name globs whose streams nothing may claim. */
    exclude_groups: z.array(z.string()).optional(),
    max_prefix_segments: z.coerce.number().optional(),
    case_sensitive: z.boolean().optional(),
    require_exact_match: z.boolean().optional(),
  })
  .optional();

// Permissive on purpose: a typo'd mode or stray weight must not fail the whole
// rules file (and with it every channel's matching). Unknown values fall back to
// the defaults in `parseOrdering` rather than throwing the parse.
const orderingWeightsSchema = z
  .object({
    resolution: z.coerce.number().optional(),
    bitrate: z.coerce.number().optional(),
    fps: z.coerce.number().optional(),
    codec: z.coerce.number().optional(),
    audio: z.coerce.number().optional(),
    prefer_h265: z.boolean().optional(),
    min_bitrate_kbps: z.coerce.number().optional(),
    hevc_bitrate_factor: z.coerce.number().optional(),
    uhd_bitrate_kbps: z.coerce.number().optional(),
  })
  .optional();

const orderingSchema = z
  .object({
    mode: z.string().optional(),
    provider_preference: z.array(z.string()).optional(),
    weights: orderingWeightsSchema,
  })
  .optional();

export const rulesDocSchema = z.object({
  schema: z.number().optional(),
  source: z.string().optional(),
  defaults: defaultsSchema,
  channels: z.array(channelSchema).default([]),
  groups: z.record(z.string(), z.unknown()).optional(),
  ordering: orderingSchema,
  system_settings: z.record(z.string(), z.unknown()).optional(),
});

export type RulesDoc = z.infer<typeof rulesDocSchema>;

export interface LoadReport {
  matcher: Matcher;
  loaded: number;
  aliasBased: number;
  regexBased: number;
  skippedPatterns: string[];
  ordering: OrderingConfig;
}

/**
 * Compile a Python-flavoured regex for JavaScript.
 *
 * The exported patterns all begin with Python's inline `(?i)` flag, which JS
 * `RegExp` rejects outright -- every regex carried forward from an imported rule
 * set fails to compile without this translation, and the channels they belong to
 * silently stop matching.
 *
 * Only leading inline flags are handled. Python allows them mid-pattern; JS has
 * no equivalent, so anything else is left to fail loudly rather than be
 * quietly mistranslated.
 */
export function compilePattern(source: string, baseFlags: string): RegExp {
  let text = source;
  const flags = new Set(baseFlags);

  const inline = /^\(\?([imsx]+)\)/.exec(text);
  if (inline) {
    for (const flag of inline[1]!) {
      // 'x' (verbose) and 's' (dotall) have no direct JS equivalent worth
      // guessing at; 's' maps cleanly, 'x' is dropped and would change meaning
      // only for patterns with literal whitespace, which these do not have.
      if (flag === 'i') flags.add('i');
      else if (flag === 'm') flags.add('m');
      else if (flag === 's') flags.add('s');
    }
    text = text.slice(inline[0].length);
  }

  return new RegExp(text, [...flags].join(''));
}

/** Normalise a stored m3u_accounts value, which may be a JSON *string*. */
export function parseProviders(raw: unknown): Set<number> | null {
  if (raw === null || raw === undefined || raw === '' || raw === 'null') return null;
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value) && value.length > 0) {
    return new Set(value.map((x) => Number(x)).filter((x) => Number.isFinite(x)));
  }
  return null;
}

function globalSettings(doc: RulesDoc): Record<string, unknown> {
  const raw = doc.system_settings?.channel_regex_global_settings;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* fall through to defaults */
    }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return (doc.defaults ?? {}) as Record<string, unknown>;
}

/**
 * Parse the top-level `ordering` block into an `OrderingConfig`.
 *
 * Snake-case weight keys map to the camelCase `Weights` shape the rest of the
 * code uses; an unrecognised `mode` falls back to `quality` so a typo degrades
 * to the default rather than failing the load.
 */
function parseOrdering(doc: RulesDoc): OrderingConfig {
  const o = doc.ordering;
  if (!o) return DEFAULT_ORDERING;
  const w = o.weights ?? {};
  const mode: OrderingConfig['mode'] =
    o.mode === 'provider' || o.mode === 'alias' ? o.mode : 'quality';
  return {
    mode,
    providerPreference: o.provider_preference ?? [],
    weights: {
      ...(w.resolution !== undefined ? { resolution: w.resolution } : {}),
      ...(w.bitrate !== undefined ? { bitrate: w.bitrate } : {}),
      ...(w.fps !== undefined ? { fps: w.fps } : {}),
      ...(w.codec !== undefined ? { codec: w.codec } : {}),
      ...(w.audio !== undefined ? { audio: w.audio } : {}),
      ...(w.prefer_h265 !== undefined ? { preferH265: w.prefer_h265 } : {}),
      ...(w.min_bitrate_kbps !== undefined ? { minBitrateKbps: w.min_bitrate_kbps } : {}),
      ...(w.hevc_bitrate_factor !== undefined ? { hevcBitrateFactor: w.hevc_bitrate_factor } : {}),
      ...(w.uhd_bitrate_kbps !== undefined ? { uhdBitrateKbps: w.uhd_bitrate_kbps } : {}),
    },
  };
}

/**
 * An empty ruleset. What a fresh install has before anything is imported.
 *
 * It carries the opinions Podium would hold freely: `audio`, and the two
 * bitrate corrections. Each defaults to an inert value in code so that an
 * existing rules file -- which cannot mention a term that did not exist when it
 * was written -- keeps the exact ordering it had. Seeding them here is what
 * makes "off for upgrades, on for new installs" expressible at all, since the
 * two are indistinguishable by the time the weights are read.
 */
export const EMPTY_RULES_DOC = {
  schema: 2,
  defaults: {},
  channels: [],
  ordering: {
    weights: {
      audio: NEW_INSTALL_AUDIO,
      hevc_bitrate_factor: NEW_INSTALL_HEVC_FACTOR,
      uhd_bitrate_kbps: NEW_INSTALL_UHD_BITRATE_KBPS,
    },
  },
};

/**
 * Read a rules file, tolerating its absence.
 *
 * A fresh Longhorn volume has no rules.json. Treating that as fatal would
 * CrashLoop the pod -- including the web container you would use to import
 * rules in the first place.
 */
export function readRulesFile(path: string): { doc: unknown; missing: boolean } {
  try {
    return { doc: JSON.parse(readFileSync(path, 'utf8')), missing: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { doc: EMPTY_RULES_DOC, missing: true };
    }
    throw error;
  }
}

/**
 * Create the rules file if it is not there, and report whether it was created.
 *
 * Self-initialising beats documenting a manual seeding step: a first run on an
 * empty volume should work, not require someone to copy a file in before the
 * app will do anything.
 */
export function ensureRulesFile(path: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  // Written via a temp file for the same reason every other write here is: a
  // crash mid-write must not leave an unparseable rules file behind.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(EMPTY_RULES_DOC, null, 1), 'utf8');
  renameSync(tmp, path);
  return true;
}

export function loadRules(raw: unknown): LoadReport {
  const doc = rulesDocSchema.parse(raw);
  const ordering = parseOrdering(doc);
  const settings = globalSettings(doc);
  const caseSensitive = Boolean(settings.case_sensitive ?? false);
  const requireExactMatch = Boolean(settings.require_exact_match ?? false);

  const defaults = doc.defaults ?? {};
  const guards: Guards = {
    regions: new Set((defaults.exclude_regions ?? []).map((x) => x.toUpperCase())),
    timeshift: defaults.exclude_timeshift ?? DEFAULT_GUARDS.timeshift,
    radio: defaults.exclude_radio ?? DEFAULT_GUARDS.radio,
    maxPrefixSegments: defaults.max_prefix_segments ?? DEFAULT_GUARDS.maxPrefixSegments,
    excludeGroups: (defaults.exclude_groups ?? [])
      .map((glob) => glob.trim())
      .filter((glob) => glob.length > 0),
  };

  const flags = caseSensitive ? '' : 'i';
  const rules = new Map<number, ChannelRule>();
  const skippedPatterns: string[] = [];

  for (const entry of doc.channels) {
    if (entry.enabled === false) continue;

    const patterns: CompiledPattern[] = [];
    for (const spec of entry.patterns ?? []) {
      if (!spec.pattern) continue;
      try {
        patterns.push({
          regex: compilePattern(spec.pattern, flags),
          stepOrder: spec.step_order ?? 0,
          providers: parseProviders(spec.m3u_accounts),
        });
      } catch (error) {
        // An invalid pattern is an operator error worth surfacing, not a crash.
        skippedPatterns.push(`channel ${entry.channel_id}: ${String(error)}`);
      }
    }
    patterns.sort((a, b) => a.stepOrder - b.stepOrder);

    const rule: ChannelRule = {
      channelId: entry.channel_id,
      name: entry.name ?? '',
      aliases: entry.aliases ?? [],
      contains: entry.contains ?? [],
      exclude: entry.exclude ?? [],
      patterns,
      providers: parseProviders(entry.providers),
      stepOrder: entry.step_order ?? 0,
      excludeRegions:
        entry.exclude_regions === null || entry.exclude_regions === undefined
          ? null
          : new Set(entry.exclude_regions.map((x) => x.toUpperCase())),
    };

    if (rule.aliases.length === 0 && rule.contains.length === 0 && rule.patterns.length === 0) {
      continue;
    }
    rules.set(rule.channelId, rule);
  }

  const aliasBased = [...rules.values()].filter((r) => r.aliases.length > 0).length;
  const regexBased = [...rules.values()].filter(
    (r) => r.patterns.length > 0 && r.aliases.length === 0,
  ).length;

  return {
    matcher: new Matcher(rules, guards, caseSensitive, requireExactMatch),
    loaded: rules.size,
    aliasBased,
    regexBased,
    skippedPatterns,
    ordering,
  };
}
