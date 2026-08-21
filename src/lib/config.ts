/**
 * Configuration, entirely from environment variables.
 *
 * Deliberately flat and small. Every knob here changes run time or
 * correctness; anything that only changed cosmetics was left out.
 */

import { join } from 'path';
import { z } from 'zod';

/** An unset or unparseable env var falls back rather than failing the boot. */
const num = (fallback: number): z.ZodType<number> =>
  z.preprocess((raw) => {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }, z.number());

const bool = (fallback: boolean): z.ZodType<boolean> =>
  z.preprocess((raw) => {
    if (raw === undefined || raw === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
  }, z.boolean());

export const configSchema = z.object({
  DISPATCHARR_URL: z.string().default('http://dispatcharr:9191'),
  DISPATCHARR_API_KEY: z.string().default(''),
  DISPATCHARR_USERNAME: z.string().default(''),
  DISPATCHARR_PASSWORD: z.string().default(''),

  PODIUM_DATA_DIR: z.string().default('/app/data'),
  PODIUM_RULES: z.string().default(''),

  /** The single biggest lever on total run time. */
  PODIUM_ANALYZE_SECONDS: num(6),
  /**
   * Covers ffprobe and the sample that follows it, which is what makes 2160p
   * the sizing case.
   *
   * The blackdetect branch decodes single-threaded, and measured against real
   * 4K HEVC providers that runs at 0.575x-1.12x realtime -- so the five-second
   * sample costs 5-11.7s of wall time, on top of 0.4-3.8s of ffprobe. At the
   * old 12s a 4K stream could not finish: the sample was killed, and since no
   * 4K provider observed declares `bit_rate` in either the stream or the format
   * block, the sample is the only source there is and the stream ranked with an
   * unknown bitrate. 1080p never hit this -- it samples in a fraction of a
   * second.
   *
   * The cost lands on hung streams, which burn the whole budget before being
   * called dead. Measured on a 1926-stream install that is 91 streams, so ~2
   * extra minutes per pass at six concurrent probes; 0.9% of live probes reach
   * the ceiling at all.
   */
  PODIUM_PROBE_TIMEOUT_MS: num(20_000),
  PODIUM_USER_AGENT: z.string().default('VLC/3.0.14'),
  /** Live TS/HLS rarely declares a bitrate; measuring it keeps ranking honest. */
  PODIUM_MEASURE_BITRATE: bool(true),
  PODIUM_MEASURE_SECONDS: num(5),
  /** Alive but below this is unwatchable; treated as dead for ranking. */
  PODIUM_MIN_BITRATE_KBPS: num(500),
  /** Detect a black screen: alive and healthy-looking, showing a slate. */
  PODIUM_DETECT_BLACK: bool(true),
  PODIUM_BLACK_RATIO: num(0.8),
  /**
   * Publish probe results back to Dispatcharr's stream_stats.
   *
   * On by default, on the assumption Podium is the only thing writing the
   * field: with two writers it would flap, with one it is the only place these
   * numbers are visible outside this tool. Turn it off if something else owns
   * stream_stats.
   */
  PODIUM_WRITE_STATS: bool(true),

  /**
   * Whether a reorder drops streams the rule does not claim.
   *
   * Off by default: writing only the matched set silently unassigns anything
   * else on the channel, which is a destructive surprise on a first run. When
   * off, unclaimed streams are kept and appended after the ranked ones.
   */
  PODIUM_REMOVE_UNMATCHED: bool(false),

  /**
   * Whether a pass may put a matched stream onto a channel that does not carry
   * it yet.
   *
   * The point of the whole app: write one flat `ESPN` alias, add a provider,
   * and its ESPN streams join the channel on the next pass instead of waiting
   * for someone to wire each one up in Dispatcharr by hand. Without this an
   * alias only ever *reorders* what Dispatcharr already assigned, so a new
   * provider is probed on every pass and can never actually be used.
   *
   * On by default: an alias that finds a better stream and then cannot use it
   * is not what anyone writing the alias meant. The alternative default made
   * every new provider a two-step job -- wire it up in Dispatcharr, then let
   * podium rank it -- and left podium probing streams it had no way to reach.
   *
   * Note what that means on an upgrade: an install pulling a new image gets
   * this on, and its next pass may add streams to channels. Nothing is removed
   * and no channel goes past `PODIUM_AUTO_ASSIGN_MAX`, but the lineups do
   * change. Set it false to keep reorder-only behaviour.
   *
   * The risk it carries is a loose alias: `ESPN` claims ESPN2 and ESPN Deportes
   * too, and with this on that claim becomes a write. Assignment is limited to
   * streams whose verdict is *usable*, capped per channel, and never removes
   * anything -- but an alias that matches the wrong stream will now assign the
   * wrong stream. `PODIUM_DRY_RUN` logs what it would assign without doing it.
   */
  PODIUM_AUTO_ASSIGN: bool(true),
  /**
   * Ceiling on how many matched streams a channel may carry because of
   * auto-assignment. 0 removes the cap (unlimited).
   *
   * The cap limits only what a pass ADDS: a channel already over it keeps
   * everything it has and simply gains nothing, because unassigning is not this
   * setting's job.
   */
  PODIUM_AUTO_ASSIGN_MAX: num(0),

  /** Cache TTLs. Dead streams are rechecked far more often than live ones. */
  PODIUM_LIVE_TTL_MS: num(24 * 3_600_000),
  PODIUM_DEAD_TTL_MS: num(3 * 3_600_000),
  /**
   * Ceiling on the dead TTL once it has backed off.
   *
   * A dead verdict starts at PODIUM_DEAD_TTL_MS and doubles per consecutive
   * dead verdict, so a stream that just died is still rechecked promptly while
   * one that has failed every check for a week is not re-probed every three
   * hours forever. This caps the doubling; set it equal to PODIUM_DEAD_TTL_MS
   * to get the old flat behaviour back.
   */
  PODIUM_DEAD_TTL_MAX_MS: num(24 * 3_600_000),
  /**
   * How long a live verdict that never yielded a bitrate is trusted.
   *
   * ffprobe declares no `bit_rate` on most live TS/HLS, so the number comes from
   * the ffmpeg sample -- and when that times out the verdict is "alive, 0kbps",
   * which is a half-measurement rather than a reading. Ranking demotes those
   * behind every stream we have real data for, so leaving one to sit for the
   * full live lifetime parks a possibly-good stream at the bottom of its channel
   * for a day. A short lifetime books it in for another attempt instead.
   *
   * Capped by PODIUM_LIVE_TTL_MS, so it can only ever shorten a live verdict.
   * Set to 0 to disable and let these expire with everything else.
   */
  PODIUM_UNKNOWN_BITRATE_TTL_MS: num(30 * 60_000),
  /**
   * How long the EPG window is reused across passes before re-fetching it.
   *
   * The rows carry each programme's start and end, so a pass re-derives "what
   * is airing now" from the cached copy rather than asking again. That only
   * holds because the window reaches about a day ahead -- which it did not
   * until Podium started reading `/api/epg/grid/`. Against the old
   * `current-programs` source the rows described a single instant, so a
   * programme ending simply vanished from them and the channel read "no EPG
   * data" until this TTL expired: measured on a live install, 38 gated channels
   * held back that way while their games had been on for 28 minutes.
   *
   * So this is now what it always claimed to be -- how fresh a *schedule* is,
   * not how blind the gate is between fetches. It bounds how quickly a fixture
   * added or moved since the last fetch is noticed, and nothing else.
   */
  PODIUM_EPG_TTL_MS: num(60 * 60_000),

  PODIUM_LANE_STAGGER_MS: num(0),
  /**
   * Ceiling on probes in flight at once, across every provider lane.
   *
   * The lane limits protect the *providers*; this protects the machine. Peak
   * concurrency is otherwise the sum of every provider's max_streams, and each
   * probe in flight is an ffprobe plus an ffmpeg decoding video -- which is how
   * a 2GiB container gets OOM-killed by adding a provider. 0 disables the cap.
   */
  PODIUM_MAX_CONCURRENT_PROBES: num(6),

  /** Freshness target: every channel checked within this window. */
  PODIUM_MAX_AGE_MS: num(24 * 3_600_000),
  /** How often a pass is considered. Each pass takes a slice, not everything. */
  PODIUM_TICK_MS: num(60_000),
  /**
   * Longest gap between passes when there is genuinely nothing to do.
   *
   * A pass costs a full fetch of every channel and stream from Dispatcharr, so
   * repeating it every minute once every verdict is cached is load with no
   * information in it. When a pass finds nothing due, the loop sleeps until the
   * earlier of the next verdict expiring and the next held-back channel opening
   * -- but never longer than this.
   *
   * This only ever *shortens* a sleep, so it cannot make a channel probe late:
   * a kickoff further out than the cap costs one extra pass, which finds the
   * channel still held back and sleeps again until the kickoff itself. What it
   * buys is the one thing neither the cache nor the EPG can announce -- a
   * stream the provider has just added.
   *
   * Half an hour rather than the quarter it used to be. When a wake-up was the
   * only way to learn anything the cap had to be short, because it *was* the
   * schedule; now the pass that follows one is the rare case where nothing had
   * a time on it, and every real deadline -- a verdict expiring, a kickoff --
   * is waited for exactly. The cost of raising it is bounded and dull: a
   * stream the provider added is measured up to half an hour later than it
   * would have been, having sat unranked at the bottom of its channel until
   * then either way.
   */
  PODIUM_IDLE_MAX_MS: num(30 * 60_000),
  PODIUM_PAUSE_WHEN_WATCHING: bool(true),
  PODIUM_MIN_FREE_SLOTS: num(1),
  PODIUM_MAX_SLICE: num(400),

  /**
   * Dry-run by default, everywhere. Reordering a channel is a write with no
   * undo, so the safe direction for an unconfigured install is to watch and
   * record. The default used to be false with only the compose file setting
   * true, which meant the documented "it starts in dry-run" was untrue of the
   * `docker run` line people actually copy.
   */
  PODIUM_DRY_RUN: bool(true),
  PODIUM_RUN_ONCE: bool(false),
  /**
   * Expose the per-channel source series on /api/metrics -- the ordered list
   * of every managed channel's streams with provider and verdict.
   *
   * On by default because it is the view the provider dashboard is for; off is
   * the escape hatch for a Prometheus watching its cardinality; the per-channel
   * families are the only ones that scale with the catalogue (managed channels
   * x slots x four families, where every other family here is per provider).
   */
  PODIUM_METRICS_CHANNELS: bool(true),
  LOG_LEVEL: z.string().default('info'),
});

export type RawConfig = z.infer<typeof configSchema>;

export interface Config extends RawConfig {
  dbPath: string;
  rulesPath: string;
  /** Whether there is anything to authenticate to Dispatcharr with. */
  hasCredentials: boolean;
}

/** Every schema default, for surfacing "what happens if I leave this blank". */
export const CONFIG_DEFAULTS: RawConfig = configSchema.parse({});

/** Takes a plain record, not NodeJS.ProcessEnv: nothing here needs NODE_ENV. */
export const NO_CREDENTIALS =
  'set DISPATCHARR_API_KEY, or DISPATCHARR_USERNAME and DISPATCHARR_PASSWORD';

/**
 * Missing credentials are a *state*, not a configuration error.
 *
 * They used to throw here, which meant the container exited before either half
 * started -- including the settings page you would use to enter them. Anyone
 * who cleared the environment variables to set them in the UI instead got a
 * crash loop and no way back in, and every API route that reads `dbPath`
 * through this function failed with them.
 *
 * Same reasoning as `ensureRulesFile`: a fresh install has to come up empty and
 * let you fill it in. The failure belongs at the point something actually tries
 * to reach Dispatcharr -- see `requireCredentials`.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const raw = configSchema.parse(env);
  return {
    ...raw,
    dbPath: join(raw.PODIUM_DATA_DIR, 'podium.db'),
    rulesPath: raw.PODIUM_RULES || join(raw.PODIUM_DATA_DIR, 'rules.json'),
    hasCredentials: Boolean(
      raw.DISPATCHARR_API_KEY || (raw.DISPATCHARR_USERNAME && raw.DISPATCHARR_PASSWORD),
    ),
  };
}

/** Throw where a Dispatcharr call is about to be made, not at boot. */
export function requireCredentials(config: Config): void {
  if (!config.hasCredentials) throw new Error(NO_CREDENTIALS);
}
