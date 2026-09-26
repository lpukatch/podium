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

import { baseUrlProblem, normaliseBaseUrl } from './base-url';
import { CONFIG_DEFAULTS } from './config';
import type { Store } from './store';

export type FieldKind = 'string' | 'secret' | 'boolean' | 'number';

export interface FieldSpec {
  key: string;
  kind: FieldKind;
  label: string;
  /** One sentence: what the setting does. Always shown. */
  help: string;
  /**
   * The why and the edge cases, behind a "More" disclosure. Kept rather than
   * cut: most of it records a failure somebody hit, and it is what stops the
   * next person hitting it -- but a 70-word paragraph under every checkbox made
   * the page unreadable for the question it is usually opened for.
   */
  more?: string;
  /** Grouping for the settings page. */
  section: 'dispatcharr' | 'behaviour' | 'probing' | 'quality' | 'teamarr';
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
  /**
   * Whole numbers only. For a field counting *events* rather than measuring a
   * quantity -- "after 3 checks" is a real instruction and "after 0.5 checks"
   * is not, and a fraction that floors to zero on the way in is how a
   * threshold turns into "remove on the first one".
   */
  int?: boolean;
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
    help: 'The base URL of your Dispatcharr server, for example http://dispatcharr:9191.',
    more: 'If both apps run in the same cluster, use the internal service address instead of routing through an Ingress.',
    section: 'dispatcharr',
  },
  {
    key: 'DISPATCHARR_API_KEY',
    kind: 'secret',
    label: 'API key',
    help: 'Recommended way to sign in. Leave username and password empty if you use a key.',
    section: 'dispatcharr',
  },
  {
    key: 'DISPATCHARR_USERNAME',
    kind: 'string',
    label: 'Username',
    help: 'Use with a password instead of an API key.',
    section: 'dispatcharr',
  },
  {
    key: 'DISPATCHARR_PASSWORD',
    kind: 'secret',
    label: 'Password',
    help: 'Used with the username to sign in to Dispatcharr.',
    section: 'dispatcharr',
  },
  {
    key: 'PODIUM_DRY_RUN',
    kind: 'boolean',
    label: 'Dry run',
    help: 'Check and rank streams without changing their order in Dispatcharr. On by default; reordering cannot be undone.',
    section: 'behaviour',
  },
  {
    key: 'PODIUM_PAUSE_WHEN_WATCHING',
    kind: 'boolean',
    label: 'Pause while anyone is watching',
    help: 'Stop all checks while someone is watching, so checks do not use their provider connections.',
    section: 'behaviour',
  },
  {
    key: 'PODIUM_PROBE_IDLE_PROVIDERS',
    kind: 'boolean',
    label: 'Keep probing providers nobody is watching',
    help: 'While someone is watching, keep checking providers they are not using. Requires the pause setting above.',
    more: 'If Podium cannot tell which provider a viewer is on, it still pauses everything. Costs a full catalogue fetch on each pass while someone is watching. Does nothing unless the pause above is on.',
    section: 'behaviour',
  },
  {
    key: 'PODIUM_PROBE_WATCHED_PROVIDER',
    kind: 'boolean',
    label: 'Also probe the provider being watched',
    help: 'Also check the provider in use if it has spare connections beyond the reserve below.',
    more: 'Meant for a provider with several connections — the one sorted top is usually both the best and the one being watched, so yielding it whole costs ranking exactly where it matters. An account with nothing spare, a single-connection one above all, still yields. Does nothing unless the setting above is on.',
    section: 'behaviour',
  },
  {
    key: 'PODIUM_WATCHED_FREE_SLOTS',
    kind: 'number',
    label: 'Connections to keep free on the watched provider',
    help: 'Extra connections reserved for viewers, in addition to those already in use.',
    more: 'Two, not one: changing channel needs a slot for the new stream before the provider releases the old one, and a provider may hold a dead connection open for another half minute. Podium only knows the cap Dispatcharr was told about — another app on the same credentials is invisible to it, so raise this if anything else uses the account.',
    section: 'behaviour',
    min: 0,
    max: 20,
  },
  {
    key: 'PODIUM_REMOVE_UNMATCHED',
    kind: 'boolean',
    label: 'Remove unmatched streams',
    help: 'Unassign streams that match no channel rule. Off keeps them, ranked last. Unassigning cannot be undone.',
    more: 'A stream Dispatcharr has marked stale is never removed however long it stays that way — during a provider outage its whole catalogue goes stale, and unassigning it would survive the outage even though the streams come back.',
    section: 'behaviour',
  },
  {
    key: 'PODIUM_REMOVE_UNMATCHED_AFTER_MS',
    kind: 'number',
    label: 'Wait before removing an unmatched stream (hours)',
    help: 'How long a stream must remain unmatched before it can be unassigned. 0 means immediately. Requires the setting above.',
    more: 'The clock restarts the moment a rule claims it again, so a stream that looks unclaimed for one pass — a rule saved mid-edit, a provider group renamed upstream, a catalogue fetch that came back short — is never removed on the strength of it. 0 is how earlier versions behaved. Checking a channel by hand and ticking the drop box ignores this.',
    section: 'behaviour',
    scale: 3_600_000,
    min: 0,
    max: 720,
  },
  {
    key: 'PODIUM_REMOVE_DEAD_AFTER_CHECKS',
    kind: 'number',
    label: 'Remove a dead stream after this many checks',
    help: 'Unassign a stream after this many consecutive dead results. 0 turns this off. Unassigning cannot be undone.',
    more: 'Checks, not hours: a dead stream is re-probed after 3h, then 6, 12 and 24, so 5 checks is about two days. Any live verdict resets the count, and a stream that is merely black-screened or under the bitrate floor is alive — it sinks, but is never removed. A provider whose catalogue has mostly gone dead is left alone entirely, so an outage cannot strip its streams off every channel.',
    section: 'behaviour',
    min: 0,
    max: 100,
    int: true,
  },
  {
    key: 'PODIUM_AUTO_ASSIGN',
    kind: 'boolean',
    label: 'Assign matched streams',
    help: 'Add healthy streams that match a channel rule. Off only reorders streams already assigned.',
    more: 'A new provider’s streams then join by themselves. Never more than the cap below, and nothing is ever removed. A loose alias will write, so check a channel first — with dry run on, the log names what it would assign.',
    section: 'behaviour',
  },
  {
    key: 'PODIUM_AUTO_ASSIGN_MAX',
    kind: 'number',
    label: 'Most streams to assign per channel',
    help: 'Maximum matched streams per channel, including those already assigned. 0 means no limit. Requires the setting above.',
    more: 'Lowering this limit does not remove streams already assigned to a channel.',
    section: 'behaviour',
    min: 0,
    max: 100,
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
    help: 'Aim to check every channel within this many minutes. 1440 is one day.',
    more: 'This is a freshness target, not a fixed schedule. Podium sizes each pass to keep up with it.',
    section: 'behaviour',
    scale: 60_000,
    min: 5,
    max: 43_200,
  },
  {
    key: 'PODIUM_TICK_MS',
    kind: 'number',
    label: 'Check interval (minutes)',
    help: 'How often Podium looks for work to do. Each pass checks only what is needed to meet the freshness target.',
    section: 'behaviour',
    scale: 60_000,
    min: 1,
    max: 1_440,
  },
  {
    key: 'PODIUM_IDLE_MAX_MS',
    kind: 'number',
    label: 'Idle back-off (minutes)',
    help: 'Longest Podium waits when nothing needs checking. Shorter waits notice newly added streams sooner.',
    section: 'behaviour',
    scale: 60_000,
    min: 1,
    max: 1_440,
  },
  {
    key: 'PODIUM_EPG_TTL_MS',
    kind: 'number',
    label: 'EPG grid cache (minutes)',
    help: 'How long to reuse the programme guide before fetching it again. 0 turns caching off.',
    more: 'Podium still calculates what is airing now on every pass. An hour or two is usually fine unless the guide only lists a short window ahead.',
    section: 'behaviour',
    scale: 60_000,
    min: 0,
    max: 1_440,
  },
  {
    key: 'PODIUM_LIVE_TTL_MS',
    kind: 'number',
    label: 'Live verdict lifetime (minutes)',
    help: 'How long a working stream stays trusted before another check. The main control for check frequency.',
    section: 'behaviour',
    scale: 60_000,
    min: 5,
    max: 43_200,
  },
  {
    key: 'PODIUM_DEAD_TTL_MS',
    kind: 'number',
    label: 'Dead verdict lifetime (minutes)',
    help: 'How soon to recheck a stream after its first failed check.',
    section: 'behaviour',
    scale: 60_000,
    min: 5,
    max: 43_200,
  },
  {
    key: 'PODIUM_DEAD_TTL_MAX_MS',
    kind: 'number',
    label: 'Dead verdict lifetime, backed off (minutes)',
    help: 'Longest wait between checks of a stream that keeps failing. Match the first-failure wait to turn back-off off.',
    section: 'behaviour',
    scale: 60_000,
    min: 5,
    max: 43_200,
  },
  {
    key: 'PODIUM_UNKNOWN_BITRATE_TTL_MS',
    kind: 'number',
    label: 'Unmeasured verdict lifetime (minutes)',
    help: 'How soon to recheck a working stream with no bitrate reading. 0 uses the usual expiry time.',
    more: 'Ranking puts these behind every stream it has real data for, so a short lifetime stops a possibly-good stream sitting at the bottom of its channel all day. Never longer than the live lifetime.',
    section: 'behaviour',
    scale: 60_000,
    min: 0,
    max: 43_200,
  },
  {
    key: 'PODIUM_MAX_SLICE',
    kind: 'number',
    label: 'Max streams per pass',
    help: 'Maximum streams checked in one pass, even when Podium is behind its freshness target.',
    section: 'behaviour',
    min: 1,
    max: 10_000,
  },
  {
    key: 'PODIUM_TEAMARR_URL',
    kind: 'string',
    label: 'Teamarr URL',
    help: 'The base URL of your Teamarr server, for example http://teamarr:9195. Leave empty to download rules instead.',
    more: 'A plain http(s) base, with no path fragment, query or credentials in it. Use in-cluster service DNS where possible.',
    section: 'teamarr',
  },
  {
    key: 'PODIUM_TEAMARR_SYNC',
    kind: 'boolean',
    label: 'Push on a schedule',
    help: 'Send learned rules automatically on the interval below. Off means you push manually from Quality.',
    more: 'Every push is checked first and refused if Podium cannot show that the new rules will preserve or improve the ordering.',
    section: 'teamarr',
  },
  {
    key: 'PODIUM_TEAMARR_SYNC_MS',
    kind: 'number',
    label: 'Push every (hours)',
    help: 'Time between automatic pushes. 24 means once a day. Requires scheduled pushes above.',
    more: 'Rule scores change slowly from day to day, so pushing more often usually achieves little.',
    section: 'teamarr',
    scale: 3_600_000,
    min: 1,
    max: 720,
  },
  {
    key: 'PODIUM_TEAMARR_MIN_SAMPLES',
    kind: 'number',
    label: 'Fewest samples to push from',
    help: 'Do not push until at least this many eligible results have been collected.',
    more: 'Protects a new or cleared database from producing confident-looking rules from only a few hours of data.',
    section: 'teamarr',
    min: 0,
    max: 1_000_000,
  },
  {
    key: 'PODIUM_TEAMARR_MIN_CHANNELS',
    kind: 'number',
    label: 'Fewest channels to check against',
    help: 'Wait until old and new rules can be compared on at least this many channels.',
    more: 'It retries within the hour. Only event channels currently carrying two probed streams can be compared, so the number collapses overnight and a push landing then is effectively unchecked. Installs that never reach this many are not held back.',
    section: 'teamarr',
    min: 0,
    max: 10_000,
  },
  {
    key: 'PODIUM_QUALITY_EVENT_ONLY',
    kind: 'boolean',
    label: 'Learn only from event channels',
    help: 'Use only channels in groups set to After kickoff or Assigned when learning quality rules.',
    more: 'On by default, because the exported rules are evaluated at kickoff and a catalogue is mostly VOD and filler. Samples taken before this setting existed carry no policy and show as unrecorded until the patterns below claim them.',
    section: 'quality',
  },
  {
    key: 'PODIUM_QUALITY_INCLUDE_GROUPS',
    kind: 'string',
    label: 'Always learn from groups matching',
    help: 'Always include matching provider or channel groups. Use comma-separated patterns, e.g. “*SPORT*, *PPV*”.',
    more: 'Admits a group whatever its policy says, and it is the only setting that reaches backwards: naming the groups your existing history came from puts those samples in scope immediately.',
    section: 'quality',
  },
  {
    key: 'PODIUM_QUALITY_EXCLUDE_GROUPS',
    kind: 'string',
    label: 'Never learn from groups matching',
    help: 'Exclude matching provider or channel groups, even if included above. Use comma-separated patterns, e.g. “*VOD*, *MOVIE*”.',
    more: 'Excluded results are kept. Changing the patterns later can bring them back into scope.',
    section: 'quality',
  },
  {
    key: 'PODIUM_MAX_CONCURRENT_PROBES',
    kind: 'number',
    label: 'Max probes at once',
    help: 'Maximum checks running at once across all providers. 0 means no overall limit.',
    more: 'Provider limits protect accounts; this limit protects the machine. Each active check runs ffprobe and ffmpeg.',
    section: 'probing',
    min: 0,
    max: 64,
  },
  {
    key: 'PODIUM_STABILITY',
    kind: 'boolean',
    label: 'Record how long streams hold',
    help: 'Record how long each stream plays before it fails or switches over.',
    more: 'Answers the failure a probe cannot see: a feed that measures perfectly for five seconds and then dies every forty. It costs one small request every few seconds against an endpoint the worker already calls, and writes a row only when a viewing ends — an install nobody is watching writes nothing at all. Collecting is separate from acting on it: the Stability weight on the Ranking page is what decides whether any of this changes an order, and it starts at zero on an existing install. Leave this on even if you have not turned that weight up, or the ledger will be empty on the day you do.',
    section: 'probing',
  },
  {
    key: 'PODIUM_STABILITY_POLL_MS',
    kind: 'number',
    label: 'Session sample interval (seconds)',
    help: 'How often to check live playback sessions. Very short failures may be missed between samples.',
    more: 'A resolution, not a load setting. The failure worth catching runs in tens of seconds, so sampling much slower than ten misses the legs it is meant to measure, and sampling much faster buys precision on a figure that is reported per hour. Takes effect the next time the worker takes its lock.',
    section: 'probing',
    scale: 1_000,
    min: 1,
    max: 300,
  },
  {
    key: 'PODIUM_SOAK_WINDOW',
    kind: 'string',
    label: 'Soak during these hours',
    help: 'Hours for automatic long checks, e.g. “03:00-06:00”. Empty turns automatic checks off.',
    more: 'A soak holds one stream open for minutes to find out how long it lasts — the failure a five-second probe cannot see. That costs a provider connection for the whole time, and most accounts have only a handful, so the sweep is confined to hours you name. It still stops the moment somebody starts watching, like every other kind of work here. This governs the automatic sweep only: a soak you ask for with a button is queued and runs as soon as there is spare capacity, whatever the hour.',
    section: 'probing',
  },
  {
    key: 'PODIUM_SOAK_SECONDS',
    kind: 'number',
    label: 'Soak length (seconds)',
    help: 'How long each long check keeps a stream open.',
    more: 'Three minutes by default. The failure worth finding takes tens of seconds to appear, so a shorter soak mostly reports that nothing has gone wrong yet — which is the answer that misleads. Longer buys little: by three minutes a flapping feed has dropped several times and a steady one has proved itself.',
    section: 'probing',
    int: true,
    min: 10,
    max: 900,
  },
  {
    key: 'PODIUM_SOAK_MAX_PER_CHANNEL',
    kind: 'number',
    label: 'Soak the top N streams per channel',
    help: 'How many top-ranked streams per channel get a long check. 0 checks all matched streams.',
    more: 'A stream ranked fifth of six will never be served to anybody, so whether it holds changes nothing — and measuring it is three minutes of a connection you cannot spend elsewhere. Keeping to the top few is what lets the sweep finish: on a 449-channel install, every matched stream is about 166 hours of connection time, where the top three per channel is roughly three nights of a three-hour window.',
    section: 'probing',
    int: true,
    min: 0,
    max: 50,
  },
  {
    key: 'PODIUM_SOAK_MAX_AGE_MS',
    kind: 'number',
    label: 'Re-soak after (days)',
    help: 'Skip streams that passed a long check within this many days.',
    more: 'Defaults to the fortnight the ledger remembers, so the sweep re-measures a stream as its evidence is about to age out rather than churning through whatever happens to be oldest.',
    section: 'probing',
    scale: 86_400_000,
    min: 1,
    max: 365,
  },
  {
    key: 'PODIUM_SOAK_COOLDOWN_MS',
    kind: 'number',
    label: 'Rest between soak connections (seconds)',
    help: 'Pause between long-check connections so providers can release the previous slot.',
    more: 'Many providers keep a closed connection counted for a few seconds. Open the next one too soon and the provider sees one connection too many and closes another soak — which reconnects, and the account churns. Ten seconds clears that comfortably. Raise it if soaks on one account keep being cut off.',
    section: 'probing',
    scale: 1_000,
    min: 0,
    max: 120,
  },
  {
    key: 'PODIUM_SOAK_SPARE_SLOTS',
    kind: 'number',
    label: 'Connections a soak leaves free',
    help: 'Provider connections reserved for viewers while long checks run.',
    more: 'An account with five connections soaks four at a time at the default of one. A single-connection account still soaks one at a time. 0 runs soaks at the full limit, which is fastest and the most likely to have the provider start closing connections.',
    section: 'probing',
    int: true,
    min: 0,
    max: 10,
  },
  {
    key: 'PODIUM_MIN_BITRATE_KBPS',
    kind: 'number',
    label: 'Minimum bitrate (kbps)',
    help: 'Treat a stream below this bitrate as unusable, even if it is still playing.',
    section: 'probing',
    min: 0,
    max: 100_000,
  },
  {
    key: 'PODIUM_DETECT_BLACK',
    kind: 'boolean',
    label: 'Detect black screens',
    help: 'Flag streams that play a black screen or slate instead of video.',
    section: 'probing',
  },
  {
    key: 'PODIUM_PROBE_VIA_DISPATCHARR',
    kind: 'boolean',
    label: 'Probe through Dispatcharr',
    help: 'Check the playback path viewers use in Dispatcharr instead of the provider URL.',
    more: 'This measures the proxy mode, account user agent and any transcode a viewer receives. It makes each probe a real Dispatcharr client and consumes a provider slot while it runs, so leave it off unless that playback path is what you need to rank.',
    section: 'probing',
  },
  {
    key: 'PODIUM_DIRECT_PROFILE_USER_AGENT',
    kind: 'boolean',
    label: 'Use stream profile user agent for direct probes',
    help: 'Use the Dispatcharr stream profile’s user agent for direct provider checks.',
    more: 'This mirrors request identity only. It does not run the profile command, proxy mode or any transcode; use proxy probes when those are what you need to measure.',
    section: 'probing',
  },
  {
    key: 'PODIUM_SOAK_VIA_DISPATCHARR',
    kind: 'boolean',
    label: 'Soak through Dispatcharr',
    help: 'Run long checks through Dispatcharr instead of connecting directly to the provider.',
    more: 'This uses the stream profile, proxy mode, account user agent and any transcode a viewer receives. It is off by default to preserve direct soak behaviour. Like proxy probes, it becomes a real Dispatcharr client and consumes a provider slot for the full soak.',
    section: 'probing',
  },
  {
    key: 'PODIUM_PROBE_CLIENT_USER_AGENT',
    kind: 'string',
    label: 'Dispatcharr probe user agent',
    help: 'User agent for checks through Dispatcharr, so Podium can tell them apart from viewers.',
    section: 'probing',
  },
  {
    key: 'PODIUM_ANALYZE_SECONDS',
    kind: 'number',
    label: 'Analyze seconds',
    help: 'How many seconds to sample each stream. Shorter checks are faster but may misjudge working streams.',
    more: 'Six seconds is usually enough. Below about three seconds, healthy streams may be marked dead.',
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
      if (field.int && !Number.isInteger(n)) {
        errors.push({ key, message: 'must be a whole number' });
        continue;
      }
      values[key] = String(field.scale ? Math.round(n * field.scale) : n);
    } else if (field.kind === 'boolean') {
      values[key] = ['1', 'true', 'yes', 'on'].includes(text.toLowerCase()) ? 'true' : 'false';
    } else if (key === 'DISPATCHARR_URL' || key === 'PODIUM_TEAMARR_URL') {
      // Both are bases with an API path appended to them, and both are checked
      // by the same rules -- see `base-url.ts`. The Teamarr URL used to fall
      // through to the untyped branch below, which accepted anything at all:
      // the client then appended its path to it, and a base ending in `#` threw
      // that path away and sent the request somewhere else entirely.
      const problem = baseUrlProblem(text);
      if (problem) errors.push({ key, message: problem });
      else values[key] = normaliseBaseUrl(text, field.label);
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

/** The fields that authenticate to Dispatcharr. */
export const CREDENTIAL_KEYS = [
  'DISPATCHARR_API_KEY',
  'DISPATCHARR_USERNAME',
  'DISPATCHARR_PASSWORD',
] as const;

/** The hostname a configured URL points at, or the raw text if it will not parse. */
function hostOfUrl(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

/**
 * Merge a candidate patch over stored settings for a connection test,
 * withholding saved credentials when the patch names a different host.
 *
 * The connection test exists so a bad URL or a stale key is found at the moment
 * of typing, and to make "test just the key" work it overlays the patch on what
 * is already stored. Overlaid the other way round, that is a credential
 * disclosure: a request carrying nothing but a URL got the saved API key *and*
 * the username and password sent to whatever host it named, in cleartext, with
 * nothing written to the database to show it had happened. Podium has no login,
 * so "whoever can reach the port" is who could ask -- and that turned reaching
 * the port into holding the Dispatcharr credential.
 *
 * So a saved credential is only ever sent back to the host it was saved for.
 * Testing a new host means supplying the credential in the same request, which
 * the person typing it into the form has and an attacker does not.
 *
 * Compared by hostname alone, deliberately -- unlike the Origin check in
 * `access.ts`, which treats a different port as a different application. The
 * question there is which app is talking to Podium; the question here is which
 * *machine* is being handed a secret, and a port change keeps it on the machine
 * that already has it. That keeps the commonest URL edit -- fixing the port --
 * from demanding the key be pasted again.
 */
export function mergeForTest(
  stored: Record<string, string>,
  values: Record<string, string | null>,
  env: Record<string, string | undefined>,
): { merged: Record<string, string>; withheld: boolean } {
  const merged = { ...stored };
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }

  const urlOf = (source: Record<string, string | undefined>): string =>
    source.DISPATCHARR_URL || env.DISPATCHARR_URL || CONFIG_DEFAULTS.DISPATCHARR_URL;
  if (hostOfUrl(urlOf(stored)) === hostOfUrl(urlOf(merged))) {
    return { merged, withheld: false };
  }

  let withheld = false;
  for (const key of CREDENTIAL_KEYS) {
    // Supplied in this very request: the caller already has it, so sending it
    // back out discloses nothing.
    if (values[key]) continue;
    if (merged[key] || env[key]) withheld = true;
    // Blanked rather than deleted: a deleted key falls through to the
    // environment, which is exactly where a compose-configured credential is.
    merged[key] = '';
  }
  return { merged, withheld };
}

/** How a credential key reads in a sentence somebody has to act on. */
const CREDENTIAL_NAMES: Record<(typeof CREDENTIAL_KEYS)[number], string> = {
  DISPATCHARR_API_KEY: 'API key',
  DISPATCHARR_USERNAME: 'username',
  DISPATCHARR_PASSWORD: 'password',
};

/**
 * Credentials this change would hand to a host they were not saved for.
 *
 * `mergeForTest` stops the *test* endpoint sending a stored credential to a
 * newly typed host. Saving had no such guard, and it is the worse half of the
 * pair: a test sends the credential once, a save points every later request at
 * the new host -- the worker's next pass, every page in the UI -- and writes the
 * decision to the database, where nothing shows it happened.
 *
 * The whole attack is one request. `PUT /api/settings` with nothing but a URL
 * in it passed the credential check, because `requireCredentials` looks at the
 * *merged* config and the credentials were still there in the environment,
 * exactly where a compose file puts them. On the next tick the worker built a
 * client for `https://wherever` and sent the Dispatcharr API key to it in
 * cleartext. Restoring a backup is the same request wearing a different hat: it
 * replaces the settings table wholesale, so a bundle carrying a URL and no
 * credentials leaves the environment's in place and pointed somewhere new.
 *
 * What counts as moved is a credential the request does not itself carry. One
 * supplied in the same breath is one the caller already holds -- the person at
 * the form re-entering the key for the host they are moving to, or a backup
 * bundle that carries its own -- and one that ends up empty is sent nowhere.
 * Everything else is inherited: left in the settings table by an earlier save,
 * or sitting in the environment where a compose file put it, which is exactly
 * what the caller would not otherwise have.
 *
 * Compared by hostname only, for the reason `mergeForTest` gives: a port change
 * keeps the secret on the machine that already has it, and fixing a port is the
 * commonest edit there is.
 */
export function movedCredentials(
  before: Record<string, string>,
  after: Record<string, string>,
  supplied: Record<string, string | null | undefined>,
  env: Record<string, string | undefined>,
): string[] {
  const urlOf = (source: Record<string, string | undefined>): string =>
    source.DISPATCHARR_URL || env.DISPATCHARR_URL || CONFIG_DEFAULTS.DISPATCHARR_URL;
  if (hostOfUrl(urlOf(before)) === hostOfUrl(urlOf(after))) return [];

  return CREDENTIAL_KEYS.filter((key) => {
    const effective = after[key] || env[key] || '';
    return effective !== '' && !supplied[key];
  });
}

/** That refusal, as the sentence the caller is shown. */
export function credentialMoveMessage(moved: string[], url: string): string {
  const names = moved.map(
    (key) => CREDENTIAL_NAMES[key as (typeof CREDENTIAL_KEYS)[number]] ?? key,
  );
  const list =
    names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
  return (
    `This points Dispatcharr at ${hostOfUrl(url)}, and the saved ${list} would be sent there. ` +
    `Enter the ${list} again in the same save to confirm the move, or clear it first.`
  );
}
