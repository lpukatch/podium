/**
 * Settings that can be changed without redeploying.
 *
 * Environment variables seed these; a stored value wins. That ordering is what
 * makes both worlds work: an install configured entirely by environment keeps
 * behaving exactly as before, and a change made in the UI actually takes
 * effect rather than being silently overridden on the next boot.
 *
 * Only fields that are safe and useful to change at runtime are exposed.
 * Anything that decides where data lives (PODIUM_DATA_DIR, PODIUM_RULES) stays
 * environment-only -- moving the database out from under a running process is
 * not a settings change.
 */

import { CONFIG_DEFAULTS } from './config';
import type { Store } from './store';

export type FieldKind = 'string' | 'secret' | 'boolean' | 'number';

export interface FieldSpec {
  key: string;
  kind: FieldKind;
  label: string;
  help: string;
  /** Grouping for the settings page. */
  section: 'dispatcharr' | 'behaviour' | 'probing';
  /**
   * Stored units per displayed unit.
   *
   * The environment variables are milliseconds because that is what the code
   * does arithmetic in, but nobody thinks about a freshness target in
   * milliseconds. The form shows minutes and this converts on the way in and
   * out, so an install configured by environment keeps its existing value and
   * the field stays readable.
   */
  scale?: number;
  /** Bounds in *displayed* units. Keeps a typo from stalling every pass. */
  min?: number;
  max?: number;
}

/** Displayed units from stored units. */
function toDisplay(raw: string, field: FieldSpec): string {
  if (!field.scale || raw === '') return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return String(Math.round((n / field.scale) * 1000) / 1000);
}

/** The schema default for a field, in displayed units. */
function defaultFor(field: FieldSpec): string {
  const value = (CONFIG_DEFAULTS as Record<string, unknown>)[field.key];
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return toDisplay(String(value), field);
}

export const FIELDS: FieldSpec[] = [
  {
    key: 'DISPATCHARR_URL',
    kind: 'string',
    label: 'Dispatcharr URL',
    help: 'In-cluster service DNS where possible; an Ingress hairpins out and back.',
    section: 'dispatcharr',
  },
  {
    key: 'DISPATCHARR_API_KEY',
    kind: 'secret',
    label: 'API key',
    help: 'Simplest option, and it does not expire.',
    section: 'dispatcharr',
  },
  {
    key: 'DISPATCHARR_USERNAME',
    kind: 'string',
    label: 'Username',
    help: 'Only needed if you would rather mint a JWT than use an API key.',
    section: 'dispatcharr',
  },
  {
    key: 'DISPATCHARR_PASSWORD',
    kind: 'secret',
    label: 'Password',
    help: 'Used with the username to obtain a token.',
    section: 'dispatcharr',
  },
  {
    key: 'PODIUM_DRY_RUN',
    kind: 'boolean',
    label: 'Dry run',
    help: 'Probe and rank, but never write an ordering to Dispatcharr. Reordering has no undo, so this starts on.',
    section: 'behaviour',
  },
  {
    key: 'PODIUM_PAUSE_WHEN_WATCHING',
    kind: 'boolean',
    label: 'Pause while anyone is watching',
    help: 'Stop probing entirely when a stream is in use, rather than competing for provider slots.',
    section: 'behaviour',
  },
  {
    key: 'PODIUM_REMOVE_UNMATCHED',
    kind: 'boolean',
    label: 'Remove unmatched streams',
    help: 'Off keeps streams no rule claims, ranked below the ones it does. On unassigns them, which is destructive.',
    section: 'behaviour',
  },
  {
    key: 'PODIUM_WRITE_STATS',
    kind: 'boolean',
    label: 'Publish stats to Dispatcharr',
    help: "Write probe results into each stream's stream_stats field.",
    section: 'behaviour',
  },
  {
    key: 'PODIUM_MAX_AGE_MS',
    kind: 'number',
    label: 'Freshness target (minutes)',
    help: 'Every channel should be checked within this window. Not a schedule — a target the pacer sizes each pass against. 1440 is a day.',
    section: 'behaviour',
    scale: 60_000,
    min: 5,
    max: 43_200,
  },
  {
    key: 'PODIUM_TICK_MS',
    kind: 'number',
    label: 'Check interval (minutes)',
    help: 'How often Podium considers a pass. Each pass takes only a slice — enough to stay inside the freshness target — so a short interval means a steady trickle, not a full run.',
    section: 'behaviour',
    scale: 60_000,
    min: 1,
    max: 1_440,
  },
  {
    key: 'PODIUM_IDLE_MAX_MS',
    kind: 'number',
    label: 'Idle back-off (minutes)',
    help: 'When nothing is due, Podium sleeps until the next verdict expires rather than repeating a whole pass. This caps that sleep, so a stream the provider added is still noticed within it.',
    section: 'behaviour',
    scale: 60_000,
    min: 1,
    max: 1_440,
  },
  {
    key: 'PODIUM_EPG_TTL_MS',
    kind: 'number',
    label: 'EPG grid cache (minutes)',
    help: 'How long the EPG grid is reused across passes before re-fetching it. Each pass re-derives what is airing now from the cached rows, so an hour or two is safe unless the grid lists only a short window of upcoming programmes. 0 disables caching.',
    section: 'behaviour',
    scale: 60_000,
    min: 0,
    max: 1_440,
  },
  {
    key: 'PODIUM_LIVE_TTL_MS',
    kind: 'number',
    label: 'Live verdict lifetime (minutes)',
    help: 'How long a working stream is trusted before it is checked again. Most of the cache is this, so it is the main lever on how much probing happens at all.',
    section: 'behaviour',
    scale: 60_000,
    min: 5,
    max: 43_200,
  },
  {
    key: 'PODIUM_DEAD_TTL_MS',
    kind: 'number',
    label: 'Dead verdict lifetime (minutes)',
    help: 'How soon a stream that just died is rechecked. Shorter than the live lifetime because a stream that has only just failed is the one most likely to come back.',
    section: 'behaviour',
    scale: 60_000,
    min: 5,
    max: 43_200,
  },
  {
    key: 'PODIUM_DEAD_TTL_MAX_MS',
    kind: 'number',
    label: 'Dead verdict lifetime, backed off (minutes)',
    help: 'Each consecutive dead verdict doubles the lifetime above, up to this. Stops a permanently dead stream being re-probed every few hours forever — which is what keeps the worker awake and re-fetching the whole catalogue. Set it equal to the dead lifetime to turn the backoff off.',
    section: 'behaviour',
    scale: 60_000,
    min: 5,
    max: 43_200,
  },
  {
    key: 'PODIUM_MAX_SLICE',
    kind: 'number',
    label: 'Max streams per pass',
    help: 'Ceiling on how much one pass will take on, however far behind the target it is.',
    section: 'behaviour',
    min: 1,
    max: 10_000,
  },
  {
    key: 'PODIUM_MAX_CONCURRENT_PROBES',
    kind: 'number',
    label: 'Max probes at once',
    help: 'Across every provider, not per provider. The lane limits protect the providers; this protects the machine — each probe in flight is an ffprobe and an ffmpeg decoding video. 0 removes the cap.',
    section: 'probing',
    min: 0,
    max: 64,
  },
  {
    key: 'PODIUM_MIN_BITRATE_KBPS',
    kind: 'number',
    label: 'Minimum bitrate (kbps)',
    help: 'Alive but below this counts as dead — a 1080p stream delivering 193kbps is not watchable.',
    section: 'probing',
    min: 0,
    max: 100_000,
  },
  {
    key: 'PODIUM_DETECT_BLACK',
    kind: 'boolean',
    label: 'Detect black screens',
    help: 'Catches a stream that is alive and correctly sized but showing a slate.',
    section: 'probing',
  },
  {
    key: 'PODIUM_ANALYZE_SECONDS',
    kind: 'number',
    label: 'Analyze seconds',
    help: 'How long ffprobe reads before deciding. The biggest single lever on run time: 6s is enough to judge a stream, below about 3s healthy streams start reading as dead.',
    section: 'probing',
    min: 1,
    max: 60,
  },
];

export const FIELD_KEYS = new Set(FIELDS.map((f) => f.key));
const SECRET_KEYS = new Set(FIELDS.filter((f) => f.kind === 'secret').map((f) => f.key));

/** Environment overlaid with stored values, stored winning. */
export function resolveEnv(
  env: Record<string, string | undefined>,
  stored: Record<string, string>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const [key, value] of Object.entries(stored)) {
    // Ignore anything not on the allowlist: the settings table must not be a
    // way to set arbitrary process configuration.
    if (FIELD_KEYS.has(key)) out[key] = value;
  }
  return out;
}

export interface FieldView extends FieldSpec {
  /** Never the secret itself. In displayed units. */
  value: string;
  /** True when a secret has some value, so the UI can say so without showing it. */
  isSet: boolean;
  /** Where the effective value came from. */
  source: 'stored' | 'environment' | 'default';
  /**
   * What a blank field falls back to, in displayed units.
   *
   * Shown as the placeholder: an empty box with no hint of what it means is
   * why "what is analyze seconds actually set to?" was unanswerable from here.
   */
  defaultValue: string;
}

/**
 * The settings page's view of the world.
 *
 * Secrets are reported as set-or-not and never returned, so the API cannot be
 * used to read back a credential that was written through it.
 */
export function describeSettings(
  env: Record<string, string | undefined>,
  stored: Record<string, string>,
): FieldView[] {
  return FIELDS.map((field) => {
    const storedValue = stored[field.key];
    const envValue = env[field.key];
    const effective = storedValue ?? envValue ?? '';
    const source: FieldView['source'] =
      storedValue !== undefined ? 'stored' : envValue ? 'environment' : 'default';
    return {
      ...field,
      value: SECRET_KEYS.has(field.key) ? '' : toDisplay(effective, field),
      isSet: effective !== '',
      source,
      defaultValue: defaultFor(field),
    };
  });
}

export interface ValidationError {
  key: string;
  message: string;
}

/**
 * Validate and normalise an incoming settings patch.
 *
 * An empty string means "clear this and fall back to the environment", which is
 * how a field is handed back rather than pinned to blank.
 */
export function validateSettings(patch: Record<string, unknown>): {
  values: Record<string, string | null>;
  errors: ValidationError[];
} {
  const values: Record<string, string | null> = {};
  const errors: ValidationError[] = [];

  for (const [key, raw] of Object.entries(patch)) {
    const field = FIELDS.find((f) => f.key === key);
    if (!field) {
      errors.push({ key, message: 'not a settable field' });
      continue;
    }
    if (raw === null || raw === '') {
      values[key] = null;
      continue;
    }

    const text = String(raw).trim();
    if (field.kind === 'number') {
      const n = Number(text);
      if (!Number.isFinite(n) || n < 0) {
        errors.push({ key, message: 'must be a non-negative number' });
        continue;
      }
      // Bounds are in displayed units, so they read the way the label does.
      if (field.min !== undefined && n < field.min) {
        errors.push({ key, message: `must be at least ${field.min}` });
        continue;
      }
      if (field.max !== undefined && n > field.max) {
        errors.push({ key, message: `must be at most ${field.max}` });
        continue;
      }
      values[key] = String(field.scale ? Math.round(n * field.scale) : n);
    } else if (field.kind === 'boolean') {
      values[key] = ['1', 'true', 'yes', 'on'].includes(text.toLowerCase()) ? 'true' : 'false';
    } else if (key === 'DISPATCHARR_URL') {
      try {
        const url = new URL(text);
        if (!/^https?:$/.test(url.protocol)) throw new Error('protocol');
        values[key] = text.replace(/\/+$/, '');
      } catch {
        errors.push({ key, message: 'must be an http(s) URL' });
      }
    } else {
      values[key] = text;
    }
  }
  return { values, errors };
}

/** Read stored settings without holding the store open. */
export function readStored(store: Store): Record<string, string> {
  return store.settings();
}
