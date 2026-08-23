/**
 * Probe result cache and run history.
 *
 * The cache is the second big lever after provider lanes. A full pass over a
 * few thousand mapped streams is a day of probe work at tens of seconds each,
 * no matter how well it is scheduled. But provider stream sets barely change
 * between runs, so most of that work is repeated for nothing.
 *
 * Dispatcharr gives every stream a `stream_hash`. Keying the cache on
 * `(streamId, streamHash, variantId)` means a stream is re-probed only when
 * the provider actually changes it, or when the cached verdict ages out.
 * `variantId` is always 0 now that the logins on an account are pooled rather
 * than each probed in turn -- a verdict describes the stream, not the login
 * that fetched it -- and the column survives only to key the rows the earlier
 * per-login probing wrote, which `pruneVariants` sweeps. Dead streams get a
 * much shorter TTL than live ones: a dead stream is the thing most likely to
 * have come back, and the thing most worth rechecking.
 *
 * That last part is only true of a stream that *just* died. A stream dead on
 * twenty consecutive checks is not coming back between now and the next one,
 * and rechecking it every three hours forever is the single largest source of
 * pointless work here: a small set of permanently dead streams can account for
 * something like 40% of all probes in a day, every one of them re-confirming
 * HTTP 4XX and "Invalid data found" against the same URLs. Worse, that trickle
 * is never empty, so the worker's idle sleep never engages and every pass pays
 * a full catalogue crawl. So the dead TTL doubles per consecutive dead verdict,
 * up to a cap: quick to notice a stream that comes back, cheap about one that
 * does not. See `deadTtlFor`.
 *
 * Together the cache and the backoff keep the large majority of streams out of
 * the queue on a steady-state pass.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { ProbeResult } from './probe';
import { pickBestVariant, type VariantVerdict } from './variants';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS probe_cache (
    stream_id    INTEGER NOT NULL,
    stream_hash  TEXT    NOT NULL,
    -- 0 = the stored (default-login) URL; otherwise a Dispatcharr profile id
    -- whose pattern rewrites that URL to another login. A profile's pattern
    -- being edited does not change stream_hash, so a variant row can hold a
    -- verdict for a different effective URL until its TTL expires -- bounded
    -- by the live lifetime and self-healing.
    variant_id   INTEGER NOT NULL DEFAULT 0,
    probed_at    INTEGER NOT NULL,
    alive        INTEGER NOT NULL,
    result       TEXT    NOT NULL,
    -- Consecutive dead verdicts, reset to 0 by any alive one. Drives the
    -- backoff in deadTtlFor(). Per variant: one login dying says nothing
    -- about when another login should be rechecked.
    dead_streak  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (stream_id, stream_hash, variant_id)
);
CREATE INDEX IF NOT EXISTS probe_cache_probed_at ON probe_cache (probed_at);

CREATE TABLE IF NOT EXISTS runs (
    run_id           TEXT PRIMARY KEY,
    started_at       INTEGER NOT NULL,
    finished_at      INTEGER,
    channels         INTEGER NOT NULL DEFAULT 0,
    probed           INTEGER NOT NULL DEFAULT 0,
    cached           INTEGER NOT NULL DEFAULT 0,
    dead             INTEGER NOT NULL DEFAULT 0,
    reordered        INTEGER NOT NULL DEFAULT 0,
    unchanged        INTEGER NOT NULL DEFAULT 0,
    assigned         INTEGER NOT NULL DEFAULT 0,
    -- Channels probed under a measure-only policy and deliberately not written.
    measured         INTEGER NOT NULL DEFAULT 0,
    skipped          INTEGER NOT NULL DEFAULT 0,
    deferred         INTEGER NOT NULL DEFAULT 0,
    backlog          INTEGER NOT NULL DEFAULT 0,
    next_due_at      INTEGER,
    oldest_probed_at INTEGER,
    error            TEXT
);
CREATE INDEX IF NOT EXISTS runs_started_at ON runs (started_at DESC);

-- Single-row live progress. The worker and the UI are separate processes
-- sharing this database, so progress goes through SQLite (WAL) rather than
-- in-process state the UI could never see.
-- Singleton worker lock. Two workers would double-probe every stream and race
-- each other's reorders into Dispatcharr, and their progress rows would stomp
-- on one another. A rolling deploy briefly runs two, so this cannot rely on
-- replicas=1 alone.
CREATE TABLE IF NOT EXISTS worker_lock (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    owner       TEXT    NOT NULL,
    heartbeat   INTEGER NOT NULL
);

-- Settings edited in the UI. Env vars seed these; a stored value wins, so an
-- install configured by environment keeps working and a change made in the UI
-- actually takes effect.
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    updated_at  INTEGER NOT NULL,
    payload     TEXT    NOT NULL
);

-- "Re-check this, whatever the cache says."
--
-- A mark is one instant. Every verdict older than it is treated as expired by
-- the planner, which is deliberately the *only* thing it does: the work then
-- flows through the ordinary pass, so lane limits, the viewer pause and the EPG
-- gate all keep applying to it. A button that probed on the spot instead would
-- be a second scheduler, and the one thing this whole codebase is about is not
-- having one of those.
--
-- Stamping an instant rather than clearing rows is what makes it cancellable.
-- The verdicts are all still there, still ranking the channel, and deleting the
-- mark puts them straight back in service -- where deleting from probe_cache
-- would have thrown away the measurements and the ages the freshness numbers
-- are computed from.
CREATE TABLE IF NOT EXISTS refresh_marks (
    -- A Dispatcharr group id, or ALL_GROUPS for the whole catalogue.
    group_id   INTEGER PRIMARY KEY,
    forced_at  INTEGER NOT NULL
);

-- Streams a person explicitly took off a channel, so auto-assign does not put
-- them back. Without this the unassign button is useless whenever
-- PODIUM_AUTO_ASSIGN is on: the stream is still matched by the alias and still
-- has a usable verdict, so the very next pass re-assigns it and the removal
-- looks like it never happened. Podium cannot tell "never added" from
-- "deliberately removed" by looking at the channel, so the decision is recorded
-- here at the moment it is made.
--
-- Deliberately permanent, and deliberately only written by the unassign
-- endpoint: a reorder that drops a stray under PODIUM_REMOVE_UNMATCHED is
-- podium's own ranking decision and must stay reversible, but a person removing
-- one stream from one channel is an instruction.
CREATE TABLE IF NOT EXISTS assign_blocks (
    channel_id INTEGER NOT NULL,
    stream_id  INTEGER NOT NULL,
    blocked_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, stream_id)
);

-- The managed catalogue as of the last pass that fetched it: one row per
-- (channel, slot), slot being the index in the channel's streams array, so
-- slot 0 is what Dispatcharr plays first. Provider attribution lives here and
-- nowhere else -- probe_cache keys on stream id alone, and the id -> provider
-- mapping only exists in the Dispatcharr catalogue the runner fetches and used
-- to hold in memory for the length of a pass. Without a persisted copy there is
-- no way to ask "how good are this provider's streams" after the fact, which is
-- the question the metrics endpoint exists to answer.
--
-- A single replace-all snapshot, not per-run history: one current view, rewritten
-- per pass and patched per reorder, so it never grows.
CREATE TABLE IF NOT EXISTS catalogue (
    channel_id    INTEGER NOT NULL,
    channel_name  TEXT    NOT NULL,
    slot          INTEGER NOT NULL,
    stream_id     INTEGER NOT NULL,
    provider_id   INTEGER NOT NULL,
    provider_name TEXT    NOT NULL,
    PRIMARY KEY (channel_id, slot)
);

-- When the snapshot above was last written as a whole, and by which pass. The
-- per-channel patches a reorder makes do not touch it: the age this carries is
-- "how long since a full catalogue refresh", which is the staleness signal.
CREATE TABLE IF NOT EXISTS catalogue_state (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    written_at INTEGER NOT NULL,
    run_id     TEXT
);

-- Measured quality kept by provenance rather than by stream identity.
--
-- probe_cache answers "what is this stream", and is deliberately thrown away
-- with the stream: pruneOutside drops verdicts for anything no longer in the
-- catalogue. On an install carrying event channels that is most of them -- a
-- fixture's streams exist for one afternoon -- so by the time "how good are
-- this provider's 1080p feeds" is worth asking, every measurement that could
-- have answered it has been swept. Probing harder does not fix that; the
-- verdict was never going to outlive the stream it described.
--
-- What generalises is not the measurement but its provenance. The stream from
-- account 4 whose name says FHD came off the same encoder as next Saturday's,
-- so (provider, tier) is a bucket worth keeping after the stream is gone,
-- and a stream nobody has ever probed can be ranked off the bucket it arrives
-- in. That is the whole point: the ranking has to be available *before* the
-- probe, because for an event stream there is no before.
--
-- Rows are individual samples, not a running mean, because the useful summary
-- is a percentile and percentiles need the distribution. They are capped per
-- bucket at SAMPLES_PER_BUCKET and trimmed oldest-first: a bucket that has
-- seen ten thousand streams is not better described by all ten thousand than
-- by its most recent few hundred, and the recent ones are the ones that
-- describe the encoder the provider is running *now*.
CREATE TABLE IF NOT EXISTS quality_samples (
    provider_id   INTEGER NOT NULL,
    -- Denormalised on purpose. The export keys on account *name* because that
    -- is what Teamarr's rules match on, and the id -> name mapping lives only
    -- in Dispatcharr -- which is exactly the thing that may not be reachable,
    -- or may have renumbered, when the export is built.
    provider_name TEXT    NOT NULL,
    -- The quality token parsed out of the stream's own name (normalize), not
    -- the measured height. Deliberately: this is the dimension a consumer can
    -- still see on an unprobed stream, so it has to be one that is legible
    -- from the name alone. The measured height goes in its own column, and the
    -- gap between the two is the lie the provider told.
    tier          TEXT    NOT NULL,
    -- The provider group the stream was imported under (its group-title).
    --
    -- Not a bucketing dimension anybody consumes -- Teamarr can only match a
    -- group on channel-source streams -- but recorded because leaving it out
    -- silently biases the dimensions that ARE consumed. An account's measured
    -- quality is really the quality of whichever groups it happens to carry,
    -- so an account selling one radio package reads as a worse video provider
    -- than it is. Measured on a live install, omitting this flipped the sign
    -- of an account's exported effect: the rules said promote where the video
    -- evidence said demote. It is here to be held constant, not to be shipped.
    group_id      INTEGER,
    group_name    TEXT    NOT NULL DEFAULT '',
    -- The channel this probe was run for, and the probing policy its group
    -- resolved to at that moment.
    --
    -- The provider group above says where a stream came from; this says what it
    -- was being ranked *for*, which is the question the export actually answers.
    -- A Teamarr rule is evaluated behind a fixture channel, so a sample taken
    -- for a film library describes a population the rule will never meet, and
    -- pooling the two makes the baseline every exported delta is quoted against
    -- a number from the wrong catalogue.
    --
    -- The policy is denormalised alongside the id for the same reason the
    -- provider name is: it is what the group was set to when the probe ran, and
    -- re-reading it later would re-judge months of history against a rule that
    -- has since been edited. Empty on rows written before this column existed,
    -- which is a third state -- unjudgeable, not out of scope -- and is
    -- reported as such rather than silently dropped.
    channel_group_id   INTEGER,
    channel_group_name TEXT NOT NULL DEFAULT '',
    policy_mode        TEXT NOT NULL DEFAULT '',
    -- The stream's name as the provider wrote it, truncated.
    --
    -- Kept because the name is the only per-stream thing a consumer can match
    -- on -- Teamarr's account and group rules are wholesale, its regex rules
    -- read this -- and because what generalises out of a name is not knowable
    -- yet. Storing the raw name rather than extracted tokens is the whole
    -- point: the token vocabulary will improve, and a stored token set freezes
    -- today's extractor while a stored name lets months of history be re-mined
    -- for nothing. Same argument as keeping samples instead of a running mean.
    stream_name        TEXT NOT NULL DEFAULT '',
    -- Radio and music feeds carry no video track at all, so their bitrate is
    -- an audio bitrate: a few hundred kbps that means "fine" rather than
    -- "throttled". Pooled into a video model they read as catastrophic, and on
    -- a real install they were 30% of the untagged tier. Kept rather than
    -- dropped -- Podium ranks these streams on their own terms and a prior for
    -- them is worth having -- but kept separable.
    audio_only    INTEGER NOT NULL DEFAULT 0,
    sampled_at    INTEGER NOT NULL,
    alive         INTEGER NOT NULL,
    black         INTEGER NOT NULL,
    bitrate_kbps  INTEGER NOT NULL,
    -- Whether that bitrate came from reading the stream or from a container
    -- that declared one. Only measured values feed the percentiles; live TS
    -- rarely declares a bitrate, and averaging in the ones that do biases the
    -- bucket towards whichever streams happened to be muxed with metadata.
    measured      INTEGER NOT NULL,
    height        INTEGER NOT NULL,
    fps           REAL    NOT NULL
);
-- The Teamarr rule set to check each pass against, and what the checks found.
--
-- A pass is the only moment the comparison can be made at all. Teamarr's rules
-- are evaluated against streams, Podium's verdict describes the same stream, and
-- for a fixture channel both exist for one afternoon: pruneOutside sweeps the
-- verdict when the stream leaves the catalogue, so by Monday there is nothing
-- left to compare and the question "did my rules serve the right stream on
-- Saturday" has no answer anywhere. Running the check while the verdicts are hot
-- and keeping the result is the only way that question survives the fixture.
--
-- The rule set is stored because the check has to run unattended. It arrives by
-- upload -- there is no way to read it out of Teamarr -- so the last one
-- uploaded is the one every later pass is measured against, and the date it
-- arrived is reported next to the findings.
CREATE TABLE IF NOT EXISTS teamarr_rules (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    rules        TEXT    NOT NULL,
    uploaded_at  INTEGER NOT NULL
);

-- One row per pass that ran a check.
CREATE TABLE IF NOT EXISTS rule_checks (
    checked_at      INTEGER PRIMARY KEY,
    run_id          TEXT,
    channels        INTEGER NOT NULL,
    agreed          INTEGER NOT NULL,
    -- The same counts over the channels Teamarr actually orders, which is the
    -- population its rules are evaluated on and the one worth reading first.
    managed_channels   INTEGER NOT NULL DEFAULT 0,
    managed_agreed     INTEGER NOT NULL DEFAULT 0,
    managed_dead_first INTEGER NOT NULL DEFAULT 0,
    managed_gap_kbps   INTEGER NOT NULL DEFAULT 0,
    disagreed       INTEGER NOT NULL,
    ambiguous       INTEGER NOT NULL,
    dead_first      INTEGER NOT NULL,
    gap_kbps        INTEGER NOT NULL,
    approximate     INTEGER NOT NULL,
    rules_evaluated INTEGER NOT NULL,
    rules_skipped   INTEGER NOT NULL
);

-- The disagreements themselves, which is the half worth reading.
--
-- Only the disagreements: an agreeing channel is fully described by the counts
-- above, and storing every channel every pass would write the whole catalogue
-- to disk hourly to record that nothing was wrong.
CREATE TABLE IF NOT EXISTS rule_check_misses (
    checked_at       INTEGER NOT NULL,
    channel_id       INTEGER NOT NULL,
    channel_name     TEXT    NOT NULL,
    managed          INTEGER NOT NULL DEFAULT 0,
    teamarr_stream   INTEGER NOT NULL,
    teamarr_name     TEXT    NOT NULL,
    teamarr_provider TEXT    NOT NULL,
    teamarr_points   INTEGER NOT NULL,
    teamarr_bitrate  INTEGER NOT NULL,
    teamarr_alive    INTEGER NOT NULL,
    teamarr_black    INTEGER NOT NULL,
    -- The rules that scored Teamarr's pick, as JSON: the blame line. Kept with
    -- the miss because the rule set is editable, so re-deriving it later would
    -- explain a past miss with a rule that was not in force when it happened.
    teamarr_matched  TEXT    NOT NULL DEFAULT '[]',
    podium_stream    INTEGER NOT NULL,
    podium_name      TEXT    NOT NULL,
    podium_provider  TEXT    NOT NULL,
    podium_bitrate   INTEGER NOT NULL,
    gap_kbps         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rule_check_misses_at ON rule_check_misses (checked_at DESC);

CREATE INDEX IF NOT EXISTS quality_samples_bucket
    ON quality_samples (provider_id, tier, sampled_at);
`;

/**
 * The `group_id` a whole-catalogue refresh is stored under.
 *
 * Negative because Dispatcharr's ids are positive, so it cannot collide with a
 * real group, and in the same table as the per-group marks so one read answers
 * both questions.
 */
export const ALL_GROUPS = -1;

/** Outstanding re-check requests. */
export interface RefreshMarks {
  /** The whole-catalogue mark, if one is set. */
  all: number | null;
  /** Per-group marks, by group id. */
  byGroup: Map<number, number>;
}

export const NO_MARKS: RefreshMarks = { all: null, byGroup: new Map() };

/**
 * The instant a channel in this group was last told to re-check from scratch.
 *
 * The later of the two marks that can cover it, and 0 when neither does -- so a
 * caller compares `probedAt <= forcedAt` unconditionally rather than branching
 * on whether a mark exists, since no real verdict is stamped at or before the
 * epoch. A channel with no group at all is still covered by a whole-catalogue
 * mark; it is in the catalogue.
 */
export function forcedAtFor(marks: RefreshMarks, groupId: number | null | undefined): number {
  const all = marks.all ?? 0;
  if (groupId === null || groupId === undefined) return all;
  return Math.max(all, marks.byGroup.get(groupId) ?? 0);
}

export interface Progress {
  runId: string | null;
  phase: 'idle' | 'fetching' | 'planning' | 'probing' | 'paused' | 'done' | 'failed';
  startedAt: number | null;
  probed: number;
  total: number;
  dead: number;
  reordered: number;
  /** Channels checked and found already in the right order. */
  unchanged: number;
  /**
   * Channels probed under a measure-only policy, whose order was withheld.
   *
   * Optional because a pass that has not reached the writing phase has no
   * answer yet, and a zero there would read as "none" rather than "not known".
   */
  measured?: number;
  cached: number;
  deferred: number;
  /**
   * Streams waiting for a probe, and when the next verdict expires.
   *
   * Both count only streams a pass could actually probe -- matched by a rule
   * and on an eligible channel. The cache as a whole cannot answer this: a
   * verdict on an excluded channel expires like any other and is never
   * refreshed, so a cache-wide number would report work that never happens.
   */
  backlog: number;
  /**
   * Verdicts a re-check request has retired and not yet replaced -- the honest
   * "still to go" for the banner, and unlike `backlog` it includes channels
   * the EPG gate is holding back, whose verdicts are retired but cannot be
   * probed until something airs. Absent on a row from an older worker, and
   * zero whenever no request is outstanding.
   */
  retired?: number;
  dueAt: number | null;
  heldBack: Record<string, number>;
  lanes: Array<{
    id: number;
    name: string;
    limit: number;
    /** Probes that returned a verdict this run, alive or dead (reads as progress). */
    done: number;
    /** Probes that came back dead. Absent on a row from an older worker. */
    dead?: number;
    /** Probes that errored rather than returning a verdict -- an actual failure. */
    failed: number;
    queued: number;
    /**
     * Channels this lane is probing right now.
     *
     * The runner has always emitted this and the progress view has always read
     * it; the type simply never declared it, which slipped through because it
     * arrives from a function return rather than an object literal.
     */
    current: string[];
  }>;
  message: string;
  /**
   * When the next pass is due, and the cadence and target it is working to.
   *
   * Without these the UI could say what a run *did* but never when the next one
   * happens, which makes a paced trickle look like a loop firing at random.
   */
  nextRunAt: number | null;
  tickMs: number;
  maxAgeMs: number;
  /**
   * The least-recently probed *managed* stream, or null before the first pass.
   *
   * The cache-wide MIN(probed_at) also counts verdicts on excluded, unmatched,
   * or removed streams that the pacer never rechecks, so it drifts past the
   * target whatever the real freshness. This is that number restricted to the
   * streams the worker actually manages (matched + eligible), sourced from
   * `plan()` -- the same set `backlog` and `dueAt` already describe. Absent on a
   * progress row written by an older worker, so readers fall back to the cache.
   */
  oldestManagedProbedAt?: number | null;
  updatedAt: number;
}

/**
 * Beyond this with no heartbeat, the worker holding the lock is considered gone.
 *
 * One definition for the lock's own takeover window, the health endpoint, the
 * metrics gauge and the progress page, so the four cannot disagree about
 * whether a worker is alive. Generous next to the 30s heartbeat interval: a
 * missed beat under load is not an outage.
 */
export const STALE_LOCK_MS = 120_000;

/**
 * How much run history to keep.
 *
 * One row per pass, and nothing reads further back than a day: the progress
 * page asks for the last 30 rows, a 24-hour tally and a 24-hour activity
 * series. A month is generous enough to answer "what did it do last week" by
 * hand and still bounds a table that would otherwise grow for the life of the
 * install -- a pass a minute is half a million rows a year.
 */
export const RUN_HISTORY_MS = 30 * 86_400_000;

export const IDLE_PROGRESS: Progress = {
  runId: null,
  phase: 'idle',
  startedAt: null,
  probed: 0,
  total: 0,
  dead: 0,
  reordered: 0,
  unchanged: 0,
  cached: 0,
  deferred: 0,
  backlog: 0,
  dueAt: null,
  heldBack: {},
  lanes: [],
  message: '',
  nextRunAt: null,
  tickMs: 0,
  maxAgeMs: 0,
  oldestManagedProbedAt: null,
  updatedAt: 0,
};

export interface RunRow {
  run_id: string;
  started_at: number;
  finished_at: number | null;
  channels: number;
  probed: number;
  cached: number;
  dead: number;
  reordered: number;
  unchanged?: number;
  skipped: number;
  deferred?: number;
  backlog?: number;
  next_due_at?: number | null;
  oldest_probed_at?: number | null;
  error: string | null;
}

/**
 * What the cache says about the library as a whole.
 *
 * The progress page used to answer only "what is this pass doing", which on a
 * settled install is "nothing, again" once a minute. These are the numbers that
 * are still interesting when there is no work to do: how much is alive, how
 * stale it is getting, and when anything next falls due.
 */
export interface CacheHealth {
  total: number;
  alive: number;
  dead: number;
  oldestProbedAt: number | null;
  newestProbedAt: number | null;
  /** Verdicts already past their TTL: the work the next pass would pick up. */
  due: number;
  /** When the earliest verdict expires. Null when the cache is empty. */
  nextDueAt: number | null;
  /** Verdict ages in coarse buckets, so freshness reads as a distribution. */
  ages: { hour: number; sixHours: number; day: number; older: number };
}

export interface RunStats {
  passes: number;
  /** Passes that actually probed or rewrote something. */
  working: number;
  probed: number;
  dead: number;
  reordered: number;
  failed: number;
}

/** One hour of run history, for the activity chart. */
export interface ActivityBucket {
  from: number;
  probed: number;
  dead: number;
}

/** One (channel, slot) entry of the persisted catalogue snapshot. */
export interface CatalogueRow {
  channelId: number;
  channelName: string;
  slot: number;
  streamId: number;
  providerId: number;
  providerName: string;
}

export interface RunUpdate {
  channels?: number;
  probed?: number;
  cached?: number;
  dead?: number;
  reordered?: number;
  unchanged?: number;
  assigned?: number;
  /** Channels probed under a measure-only policy and deliberately not written. */
  measured?: number;
  skipped?: number;
  deferred?: number;
  backlog?: number;
  nextDueAt?: number | null;
  oldestProbedAt?: number | null;
  error?: string;
}

/**
 * How long a dead verdict is trusted, given how many times running it has been dead.
 *
 * Doubles per consecutive dead verdict and stops at `deadTtlMaxMs`: with the
 * defaults that is 3h, 6h, 12h, 24h, 24h, ... A stream that dies is still
 * rechecked within the base TTL, because the streak is 1 at that point; only
 * one that keeps failing gets left alone.
 *
 * The cap defaults to the base TTL, which makes the backoff opt-in: a caller
 * that passes no cap gets the old flat behaviour exactly, and setting
 * PODIUM_DEAD_TTL_MAX_MS equal to PODIUM_DEAD_TTL_MS turns it off in
 * production. A cap below the base is a typo rather than a request to expire
 * dead verdicts faster than live ones, so it is raised to the base.
 *
 * The exponent is clamped before it is used: `2 ** 1024` is Infinity, and a
 * stream dead every three hours for a year would otherwise reach it and make
 * the verdict permanent.
 */
export function deadTtlFor(
  deadStreak: number,
  deadTtlMs: number,
  deadTtlMaxMs: number = deadTtlMs,
): number {
  const cap = Math.max(deadTtlMaxMs, deadTtlMs);
  const doublings = Math.min(Math.max(Math.floor(deadStreak) - 1, 0), 30);
  return Math.min(deadTtlMs * 2 ** doublings, cap);
}

/**
 * The TTL that applies to one cached verdict. The single source for it.
 *
 * Three cases, not two. A dead verdict backs off; a live one lasts the live
 * lifetime; and a live one carrying no bitrate reading -- `alive` with
 * `bitrateKbps <= 0`, which means the sample never landed rather than that the
 * stream delivers nothing -- expires early so the next pass can try to measure
 * it. Ranking sinks an unmeasured stream behind everything with real data, so
 * without this a stream that might be the channel's best sits at the bottom of
 * it until the full live lifetime runs out.
 *
 * `unknownBitrateTtlMs` only ever shortens: it is capped by `liveTtlMs`, and 0
 * turns the case off so the function reduces to the old two-case behaviour.
 */
export function ttlFor(
  entry: Pick<CacheEntry, 'alive' | 'deadStreak' | 'result'>,
  liveTtlMs: number,
  deadTtlMs: number,
  deadTtlMaxMs: number = deadTtlMs,
  unknownBitrateTtlMs = 0,
): number {
  if (!entry.alive) return deadTtlFor(entry.deadStreak, deadTtlMs, deadTtlMaxMs);
  // An unreadable result is an unknown verdict, not an unmeasured one -- it gets
  // the plain live lifetime, matching what `entry()` already does with it.
  if (unknownBitrateTtlMs > 0 && entry.result && entry.result.bitrateKbps <= 0) {
    return Math.min(liveTtlMs, unknownBitrateTtlMs);
  }
  return liveTtlMs;
}

/** The `probe_cache` columns `entry` reads, as SQLite hands them back. */
interface CacheRow {
  probed_at: number;
  alive: number;
  result: string;
  dead_streak: number;
}

/** A cached verdict with the bookkeeping `ttlFor` needs. */
/**
 * How many samples a single `(provider, tier)` bucket keeps.
 *
 * Set for the shape of the summary rather than for the disk: a p90 is stable
 * enough to act on somewhere in the low hundreds of samples, and past that the
 * extra rows only slow the bucket's response to a provider changing encoder.
 */
export const SAMPLES_PER_BUCKET = 400;

/**
 * Longest stream name kept on a sample.
 *
 * Generous for a channel name and short enough that the table stays small at
 * tens of thousands of rows. Everything a name rule could be mined from is at
 * the front; what runs past this is fixture text and decoration.
 */
export const MAX_STREAM_NAME = 200;

/** Samples older than this stop describing anything the provider still runs. */
export const QUALITY_HISTORY_MS = 90 * 86_400_000;

/** How long a rule check is worth keeping. Long enough to cover a season's shape. */
export const RULE_CHECK_HISTORY_MS = 90 * 86_400_000;

export interface StoredRuleMiss {
  channelId: number;
  channelName: string;
  managed: boolean;
  teamarrStream: number;
  teamarrName: string;
  teamarrProvider: string;
  teamarrPoints: number;
  teamarrBitrate: number;
  teamarrAlive: boolean;
  teamarrBlack: boolean;
  /** The rules that scored Teamarr's pick, as they stood when it was checked. */
  teamarrMatched: Array<{ type: string; value: string; points: number }>;
  podiumStream: number;
  podiumName: string;
  podiumProvider: string;
  podiumBitrate: number;
  gapKbps: number;
}

export interface StoredRuleCheckRow {
  checkedAt: number;
  runId: string | null;
  channels: number;
  agreed: number;
  disagreed: number;
  ambiguous: number;
  deadFirst: number;
  gapKbps: number;
  managedChannels: number;
  managedAgreed: number;
  managedDeadFirst: number;
  managedGapKbps: number;
  approximate: boolean;
  rulesEvaluated: number;
  rulesSkipped: number;
}

export interface StoredRuleCheck extends StoredRuleCheckRow {
  misses: StoredRuleMiss[];
}

function parseMatched(raw: string): Array<{ type: string; value: string; points: number }> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? (parsed as Array<{ type: string; value: string; points: number }>)
      : [];
  } catch {
    return [];
  }
}

/** One settled verdict, tagged with the provenance that outlives its stream. */
export interface QualitySample {
  providerId: number;
  providerName: string;
  /** Quality token from the stream's own name -- see the column comment. */
  tier: string;
  groupId: number | null;
  groupName: string;
  /** The provider's own name for the stream -- see the column comment. */
  streamName: string;
  /** The channel the probe was run for -- see the column comment. */
  channelGroupId: number | null;
  channelGroupName: string;
  /** The channel group's probing policy at probe time; '' when unrecorded. */
  policyMode: string;
  /** Video-less feed: its bitrate is an audio bitrate. See the column comment. */
  audioOnly: boolean;
  alive: boolean;
  black: boolean;
  bitrateKbps: number;
  measured: boolean;
  height: number;
  fps: number;
}

export interface StoredQualitySample extends QualitySample {
  sampledAt: number;
}

export interface CacheEntry {
  probedAt: number;
  alive: boolean;
  deadStreak: number;
  result: ProbeResult | null;
}

export class Store {
  private readonly db: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();
  private static initializedPaths = new Set<string>();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    if (path === ':memory:' || !Store.initializedPaths.has(path)) {
      this.db.exec(SCHEMA);
      for (const [table, col] of [
        ['runs', 'unchanged INTEGER NOT NULL DEFAULT 0'],
        ['runs', 'deferred INTEGER NOT NULL DEFAULT 0'],
        ['runs', 'backlog INTEGER NOT NULL DEFAULT 0'],
        ['runs', 'next_due_at INTEGER'],
        ['runs', 'oldest_probed_at INTEGER'],
        // Default 0 is the truth for every run recorded before auto-assign
        // existed: none of them ever put a stream onto a channel.
        ['runs', 'assigned INTEGER NOT NULL DEFAULT 0'],
        // 0 is the truth for every run recorded before measure-only groups
        // existed: none of them ever withheld a write.
        ['runs', 'measured INTEGER NOT NULL DEFAULT 0'],
        // Existing rows land on 0, which `deadTtlFor` treats as the base TTL:
        // an install upgrading in place re-probes its dead streams once at the
        // old cadence and starts backing them off from there, rather than
        // inheriting a streak it never measured.
        ['probe_cache', 'dead_streak INTEGER NOT NULL DEFAULT 0'],
        // Samples recorded before the quality scope existed carry no channel
        // and no policy. Empty rather than a guessed default: '' means "never
        // recorded", and `buildProfile` counts those separately from the ones
        // it judged and rejected.
        ['quality_samples', 'channel_group_id INTEGER'],
        ['quality_samples', "channel_group_name TEXT NOT NULL DEFAULT ''"],
        ['quality_samples', "policy_mode TEXT NOT NULL DEFAULT ''"],
        // Empty on every row written before names were kept. The profile
        // reports how many samples carry one, because that count is what says
        // whether there is yet anything to mine.
        ['quality_samples', "stream_name TEXT NOT NULL DEFAULT ''"],
        // Checks recorded before the managed split read as unmanaged, which is
        // the honest default: nothing recorded which channels Teamarr owned.
        ['rule_checks', 'managed_channels INTEGER NOT NULL DEFAULT 0'],
        ['rule_checks', 'managed_agreed INTEGER NOT NULL DEFAULT 0'],
        ['rule_checks', 'managed_dead_first INTEGER NOT NULL DEFAULT 0'],
        ['rule_checks', 'managed_gap_kbps INTEGER NOT NULL DEFAULT 0'],
        ['rule_check_misses', 'managed INTEGER NOT NULL DEFAULT 0'],
      ] as const) {
        try {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
        } catch {
          // column already exists
        }
      }
      this.splitProbeCacheByVariant();
      if (path !== ':memory:') {
        Store.initializedPaths.add(path);
      }
    }
  }

  /**
   * Widen `probe_cache` from one verdict per stream to one per (stream,
   * variant).
   *
   * Kept although pooling has since put every verdict back on variant 0: an
   * install upgrading across both changes still has to pass through this table
   * shape, and the rows it leaves behind are swept by `pruneVariants` rather
   * than by another migration.
   *
   * SQLite cannot alter a primary key, so this is the recreate-and-copy the
   * ALTER idiom above cannot express: a new table with `variant_id` in the
   * key, the old rows copied across as variant 0 -- the stored URL, which is
   * the only thing they were ever a verdict for -- then the swap. Everything
   * survives, streaks included.
   *
   * Immediate rather than deferred, with the shape re-checked inside: the web
   * process and the worker both construct a Store at boot, and a deferred
   * transaction's check-then-write could interleave with the other process's
   * identical migration against the same file. The immediate lock serialises
   * them and the loser's re-check sees the winner's table.
   */
  private splitProbeCacheByVariant(): void {
    const hasVariantColumn = () =>
      (this.db.pragma('table_info(probe_cache)') as Array<{ name: string }>).some(
        (col) => col.name === 'variant_id',
      );
    if (hasVariantColumn()) return;

    this.db
      .transaction(() => {
        if (hasVariantColumn()) return;
        this.db.exec(`
          CREATE TABLE probe_cache_split (
              stream_id    INTEGER NOT NULL,
              stream_hash  TEXT    NOT NULL,
              variant_id   INTEGER NOT NULL DEFAULT 0,
              probed_at    INTEGER NOT NULL,
              alive        INTEGER NOT NULL,
              result       TEXT    NOT NULL,
              dead_streak  INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (stream_id, stream_hash, variant_id)
          );
          INSERT INTO probe_cache_split
              (stream_id, stream_hash, variant_id, probed_at, alive, result, dead_streak)
            SELECT stream_id, stream_hash, 0, probed_at, alive, result, dead_streak
            FROM probe_cache;
          DROP TABLE probe_cache;
          ALTER TABLE probe_cache_split RENAME TO probe_cache;
          CREATE INDEX IF NOT EXISTS probe_cache_probed_at ON probe_cache (probed_at);
        `);
      })
      .immediate();
  }

  /**
   * A prepared statement, compiled once per connection and reused after that.
   *
   * `db.prepare` compiles SQL every time it is called, and the planner calls
   * `entry()` once per candidate stream -- twice over, since the cache-only
   * reorder pass walks the same channels again. On a 1,757-stream install that
   * is ~3,500 compilations a pass, every pass, forever. Measured against a live
   * database: 55.3ms of compiling to do 10.9ms of reading.
   *
   * Keyed on the SQL text and held per instance, because a statement belongs to
   * the connection that compiled it. Only *constant* SQL goes through here --
   * the three places that build a statement from a variable number of columns
   * or bind holes call `db.prepare` directly, so this map cannot grow with the
   * data.
   */
  private sql(text: string): Database.Statement {
    let statement = this.statements.get(text);
    if (!statement) {
      statement = this.db.prepare(text);
      this.statements.set(text, statement);
    }
    return statement;
  }

  close(): void {
    // better-sqlite3 finalises these with the connection; dropping the map
    // keeps a closed store from handing out a statement that no longer exists.
    this.statements.clear();
    this.db.close();
  }

  /**
   * The stored verdict for a stream, whether or not it is still within its TTL.
   *
   * One query for what the planner used to take two to learn -- it needed the
   * age for pacing and the result for the cache hit, and now needs the streak
   * for the TTL as well. At ~1,700 managed streams a pass that is thousands of
   * round trips a minute saved.
   */
  entry(streamId: number, streamHash: string, variantId = 0): CacheEntry | null {
    const row = this.sql(
      `SELECT probed_at, alive, result, dead_streak FROM probe_cache
       WHERE stream_id = ? AND stream_hash = ? AND variant_id = ?`,
    ).get(streamId, streamHash, variantId) as CacheRow | undefined;
    if (!row) return null;

    let result: ProbeResult | null = null;
    try {
      result = JSON.parse(row.result) as ProbeResult;
    } catch {
      // An unreadable row is an unknown verdict, but its age and streak are
      // still good -- it was written by a probe that did happen.
    }
    return {
      probedAt: row.probed_at,
      alive: Boolean(row.alive),
      deadStreak: row.dead_streak ?? 0,
      result,
    };
  }

  /**
   * Every stored verdict for a stream, by variant -- by login.
   *
   * The read the planner wants: a stream is served from cache only when all
   * its variants are fresh, and only the stale ones become probe jobs, so it
   * needs the whole set rather than `entry`'s one-of-them.
   */
  variants(streamId: number, streamHash: string): Map<number, CacheEntry> {
    const rows = this.sql(
      `SELECT variant_id, probed_at, alive, result, dead_streak FROM probe_cache
       WHERE stream_id = ? AND stream_hash = ?`,
    ).all(streamId, streamHash) as Array<CacheRow & { variant_id: number }>;
    const out = new Map<number, CacheEntry>();
    for (const row of rows) {
      let result: ProbeResult | null = null;
      try {
        result = JSON.parse(row.result) as ProbeResult;
      } catch {
        // As `entry`: the age and streak are still good.
      }
      out.set(row.variant_id, {
        probedAt: row.probed_at,
        alive: Boolean(row.alive),
        deadStreak: row.dead_streak ?? 0,
        result,
      });
    }
    return out;
  }

  /**
   * Record a verdict, maintaining the consecutive-dead count.
   *
   * The streak is updated in the same statement that writes the verdict rather
   * than read-then-written: the worker holds the lock so nothing else writes
   * here, but a count that can silently skip on a retry is not worth the risk
   * when SQL expresses it exactly.
   */
  put(streamId: number, streamHash: string, result: ProbeResult, variantId = 0): void {
    this.sql(
      `INSERT INTO probe_cache (stream_id, stream_hash, variant_id, probed_at, alive, result, dead_streak)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stream_id, stream_hash, variant_id) DO UPDATE SET
         probed_at   = excluded.probed_at,
         alive       = excluded.alive,
         result      = excluded.result,
         dead_streak = CASE WHEN excluded.alive = 1 THEN 0
                            ELSE probe_cache.dead_streak + 1 END`,
    ).run(
      streamId,
      streamHash,
      variantId,
      Date.now(),
      result.alive ? 1 : 0,
      JSON.stringify(result),
      result.alive ? 0 : 1,
    );
  }

  startRun(runId: string): void {
    const now = Date.now();
    this.sql('INSERT OR REPLACE INTO runs (run_id, started_at) VALUES (?, ?)').run(runId, now);
    // Trimmed here rather than in `prune()`, which only runs when a worker
    // starts: a container that stays up for months would never trim this table
    // at all. Against `runs_started_at` this is an index seek that matches
    // nothing on every pass but the first of the day, so paying it per pass
    // costs less than the bookkeeping to pay it less often.
    this.sql('DELETE FROM runs WHERE started_at < ?').run(now - RUN_HISTORY_MS);
    // Same bargain, same place, for the same reason: the quality table grows
    // by one row per probe and a container that stays up for months would
    // otherwise never trim it. Bounded by SAMPLES_PER_BUCKET times the number
    // of buckets -- tens of thousands of rows at the very most -- so the sweep
    // is cheap enough to pay every pass rather than only at boot.
    this.trimQuality();
    // Same sweep, same reason. A check is a handful of rows per pass, but a
    // pass runs hourly forever.
    const cutoff = now - RULE_CHECK_HISTORY_MS;
    this.sql('DELETE FROM rule_check_misses WHERE checked_at < ?').run(cutoff);
    this.sql('DELETE FROM rule_checks WHERE checked_at < ?').run(cutoff);
  }

  finishRun(runId: string, fields: RunUpdate = {}): void {
    const columnMap: Array<[keyof RunUpdate, string]> = [
      ['channels', 'channels'],
      ['probed', 'probed'],
      ['cached', 'cached'],
      ['dead', 'dead'],
      ['reordered', 'reordered'],
      ['unchanged', 'unchanged'],
      ['assigned', 'assigned'],
      ['measured', 'measured'],
      ['skipped', 'skipped'],
      ['deferred', 'deferred'],
      ['backlog', 'backlog'],
      ['nextDueAt', 'next_due_at'],
      ['oldestProbedAt', 'oldest_probed_at'],
      ['error', 'error'],
    ];
    const entries = columnMap
      .filter(([key]) => fields[key] !== undefined)
      .map(([key, col]) => [col, fields[key]] as const);
    const setClause = entries.map(([col]) => `${col} = ?`).join(', ');
    // Not cached: the statement is built from whichever fields were supplied.
    this.db
      .prepare(
        `UPDATE runs SET finished_at = ?${setClause ? `, ${setClause}` : ''} WHERE run_id = ?`,
      )
      .run(Date.now(), ...entries.map(([, value]) => value as string | number), runId);
  }

  /**
   * Cached verdicts for a set of streams, keyed by stream id.
   *
   * Batched rather than one `get` per stream: the editor wants the last probe
   * time and result for every stream on a channel at once, and a query per
   * stream would be dozens of round trips for one page render.
   *
   * One row per stream under pooling. A cache still holding the per-login
   * rows an earlier version wrote is folded through `pickBestVariant`, the
   * same choice the pass reports, so the upgrade reads correctly before the
   * sweep catches up. The default weights serve: this reader is for display,
   * and the ranking pass supplies its own.
   */
  verdicts(
    streamIds: number[],
  ): Map<number, { probedAt: number; alive: boolean; result: ProbeResult }> {
    const out = new Map<number, { probedAt: number; alive: boolean; result: ProbeResult }>();
    if (streamIds.length === 0) return out;

    // Chunked to stay under SQLite's bound-variable limit on a large channel.
    for (let i = 0; i < streamIds.length; i += 400) {
      const chunk = streamIds.slice(i, i + 400);
      const holes = chunk.map(() => '?').join(',');
      // Not cached: one bind hole per id, so the text varies with the chunk.
      const rows = this.db
        .prepare(
          `SELECT stream_id, variant_id, probed_at, alive, result FROM probe_cache
           WHERE stream_id IN (${holes})`,
        )
        .all(...chunk) as Array<{
        stream_id: number;
        variant_id: number;
        probed_at: number;
        alive: number;
        result: string;
      }>;
      const byStream = new Map<number, Array<{ variantId: number; row: (typeof rows)[number] }>>();
      for (const row of rows) {
        const list = byStream.get(row.stream_id) ?? [];
        list.push({ variantId: row.variant_id, row });
        byStream.set(row.stream_id, list);
      }
      for (const [streamId, entries] of byStream) {
        const verdicts: VariantVerdict[] = [];
        for (const { variantId, row } of entries) {
          try {
            verdicts.push({ variantId, result: JSON.parse(row.result) as ProbeResult });
          } catch {
            // An unreadable row is simply an unknown verdict.
          }
        }
        const best = pickBestVariant(verdicts);
        if (best) {
          // The newest verdict any login contributed: "when did we last look
          // at this stream through any of its logins".
          const probedAt = Math.max(...entries.map((e) => e.row.probed_at));
          out.set(streamId, { probedAt, alive: best.alive, result: best });
        }
      }
    }
    return out;
  }

  recentRuns(limit = 20): RunRow[] {
    // rowid breaks ties: two runs started in the same millisecond would
    // otherwise come back in arbitrary order.
    return this.sql('SELECT * FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?').all(
      limit,
    ) as RunRow[];
  }

  /**
   * Claim the worker lock, or report who holds it.
   *
   * A lock whose heartbeat has gone stale is taken over: a worker that was
   * SIGKILLed never releases, and the alternative is a deployment that stays
   * dead until someone clears a row by hand.
   */
  acquireLock(owner: string, staleAfterMs = STALE_LOCK_MS): { ok: boolean; heldBy?: string } {
    const now = Date.now();
    const row = this.sql('SELECT owner, heartbeat FROM worker_lock WHERE id = 1').get() as
      | { owner: string; heartbeat: number }
      | undefined;

    if (row && row.owner !== owner && now - row.heartbeat < staleAfterMs) {
      return { ok: false, heldBy: row.owner };
    }
    this.sql(
      `INSERT INTO worker_lock (id, owner, heartbeat) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, heartbeat = excluded.heartbeat`,
    ).run(owner, now);
    return { ok: true };
  }

  heartbeat(owner: string): void {
    this.sql('UPDATE worker_lock SET heartbeat = ? WHERE id = 1 AND owner = ?').run(
      Date.now(),
      owner,
    );
  }

  releaseLock(owner: string): void {
    this.sql('DELETE FROM worker_lock WHERE id = 1 AND owner = ?').run(owner);
  }

  /** Every stored setting. */
  settings(): Record<string, string> {
    const rows = this.sql('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /**
   * Write settings. A value of null removes the key, which is how a field is
   * handed back to whatever the environment provides.
   */
  setSettings(values: Record<string, string | null>): void {
    const upsert = this.sql(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const remove = this.sql('DELETE FROM settings WHERE key = ?');
    const now = Date.now();
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (value === null) remove.run(key);
        else upsert.run(key, value, now);
      }
    })();
  }

  /** When settings last changed, so readers can cheaply detect an edit. */
  settingsVersion(): number {
    const row = this.sql('SELECT MAX(updated_at) AS v FROM settings').get() as {
      v: number | null;
    };
    return row.v ?? 0;
  }

  setProgress(progress: Omit<Progress, 'updatedAt'>): void {
    this.sql(
      `INSERT INTO progress (id, updated_at, payload) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, payload = excluded.payload`,
    ).run(Date.now(), JSON.stringify(progress));
  }

  getProgress(): Progress {
    const row = this.sql('SELECT updated_at, payload FROM progress WHERE id = 1').get() as
      | { updated_at: number; payload: string }
      | undefined;
    if (!row) return IDLE_PROGRESS;
    try {
      return { ...(JSON.parse(row.payload) as Progress), updatedAt: row.updated_at };
    } catch {
      return IDLE_PROGRESS;
    }
  }

  /** Every outstanding re-check request. */
  refreshMarks(): RefreshMarks {
    const rows = this.sql('SELECT group_id, forced_at FROM refresh_marks').all() as Array<{
      group_id: number;
      forced_at: number;
    }>;
    const marks: RefreshMarks = { all: null, byGroup: new Map() };
    for (const row of rows) {
      if (row.group_id === ALL_GROUPS) marks.all = row.forced_at;
      else marks.byGroup.set(row.group_id, row.forced_at);
    }
    return marks;
  }

  /**
   * Ask for everything in a scope to be re-checked, from `at` onwards.
   *
   * Re-marking an already-marked scope moves the instant forward rather than
   * stacking, which is what someone clicking the button twice means: re-check
   * it as of now.
   */
  setRefreshMark(groupId: number, at: number = Date.now()): void {
    this.sql(
      `INSERT INTO refresh_marks (group_id, forced_at) VALUES (?, ?)
       ON CONFLICT(group_id) DO UPDATE SET forced_at = excluded.forced_at`,
    ).run(groupId, at);
  }

  /**
   * Cancel a request, or retire one a pass found satisfied. Returns how many
   * marks that cleared.
   *
   * With `at`, only that exact request goes: a pass must not drop a mark that
   * was re-armed after the snapshot it planned against, because the newer
   * request retired verdicts that pass never counted.
   */
  clearRefreshMark(groupId: number, at?: number): number {
    if (at === undefined) {
      return this.sql('DELETE FROM refresh_marks WHERE group_id = ?').run(groupId).changes;
    }
    return this.sql('DELETE FROM refresh_marks WHERE group_id = ? AND forced_at = ?').run(
      groupId,
      at,
    ).changes;
  }

  /**
   * Drop every per-group mark, leaving any whole-catalogue one alone.
   *
   * Used when a whole-catalogue request arrives and subsumes them: a group mark
   * underneath it can only retire verdicts the catalogue-wide one has already
   * retired, and leaving it there means cancelling the big request quietly
   * leaves the small ones behind still running.
   */
  clearGroupRefreshMarks(): number {
    return this.sql('DELETE FROM refresh_marks WHERE group_id <> ?').run(ALL_GROUPS).changes;
  }

  /**
   * A monotonic stamp over the marks, for a reader that wants to know whether a
   * new request has arrived without caring which.
   *
   * This is what the worker's heartbeat watches: an idle loop can be asleep for
   * PODIUM_IDLE_MAX_MS, and a re-check that waits that long for its first pass
   * is not a button anybody would press twice. Only *new* requests move it --
   * a cancel lowers it, and nothing should wake for a cancel.
   */
  refreshMarksVersion(): number {
    const row = this.sql('SELECT MAX(forced_at) AS v FROM refresh_marks').get() as {
      v: number | null;
    };
    return row.v ?? 0;
  }

  /**
   * Aggregate probe-cache state, for metrics.
   *
   * `oldestProbedAt` is the freshness signal that matters: the pacer targets
   * "every stream checked within max_age", so the oldest entry is how far
   * behind that target the install actually is.
   *
   * Counted per *stream* (a stream with several logins is several rows but
   * one entry on every page that reads this): alive when any login is, as old
   * as its least-recently-checked login.
   */
  cacheStats(): { total: number; alive: number; dead: number; oldestProbedAt: number | null } {
    const row = this.sql(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(alive), 0) AS alive,
              MIN(probed_at) AS oldest
       FROM (SELECT MAX(alive) AS alive, MIN(probed_at) AS probed_at
             FROM probe_cache GROUP BY stream_id)`,
    ).get() as { total: number; alive: number; oldest: number | null };
    return {
      total: row.total,
      alive: row.alive,
      dead: row.total - row.alive,
      oldestProbedAt: row.oldest,
    };
  }

  /** Cache state as the progress page reads it: alive, dead, stale, due. */
  cacheHealth(
    liveTtlMs: number,
    deadTtlMs: number,
    now = Date.now(),
    deadTtlMaxMs: number = deadTtlMs,
    unknownBitrateTtlMs = 0,
    forcedAt = 0,
  ): CacheHealth {
    // `ttlFor` in SQL, so "when is this due" answers the same here as it does in
    // the planner. Two-argument MIN/MAX are SQLite's scalar forms, not
    // aggregates; the shift is the doubling and is clamped for the same reason
    // the TypeScript is. `json_valid` guards the extract because a corrupt row
    // would otherwise raise and take the whole health query down -- and it lands
    // on the plain live lifetime, which is what `ttlFor` does with a result it
    // could not parse.
    const ttl = `CASE
                   WHEN alive = 0
                     THEN MIN(:deadMax, :dead * (1 << MIN(MAX(dead_streak - 1, 0), 30)))
                   WHEN :unknown > 0
                        AND json_valid(result)
                        AND COALESCE(json_extract(result, '$.bitrateKbps'), 0) <= 0
                     THEN MIN(:live, :unknown)
                   ELSE :live
                 END`;
    // A whole-catalogue re-check request brings every older verdict due now,
    // exactly as the planner reads it. Only the global mark is applied: this
    // table has stream ids and no idea which channel -- let alone which group --
    // any of them belongs to, and a per-group mark cannot be answered without
    // matching. The number that does account for those is the pass's own
    // `backlog`, which the progress page prefers over this one anyway.
    const due = `CASE WHEN probed_at <= :forced THEN :now ELSE probed_at + ${ttl} END`;
    // One row per *stream*, not per verdict. That is one and the same thing
    // under pooling; it still matters for a cache holding the per-login rows an
    // earlier version wrote, where counting verdicts would read as more streams
    // than exist.
    const row = this.sql(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(alive), 0)      AS alive,
              MIN(probed_at)               AS oldest,
              MAX(probed_at)               AS newest,
              MIN(due)                     AS nextDue,
              COALESCE(SUM(due <= :now), 0) AS due,
              COALESCE(SUM(probed_at >  :now - 3600000), 0)  AS hour,
              COALESCE(SUM(probed_at <= :now - 3600000
                       AND probed_at >  :now - 21600000), 0) AS sixHours,
              COALESCE(SUM(probed_at <= :now - 21600000
                       AND probed_at >  :now - 86400000), 0) AS day,
              COALESCE(SUM(probed_at <= :now - 86400000), 0) AS older
       FROM (SELECT MAX(alive) AS alive, MIN(probed_at) AS probed_at, MIN(${due}) AS due
             FROM probe_cache GROUP BY stream_id)`,
    ).get({
      live: liveTtlMs,
      dead: deadTtlMs,
      deadMax: Math.max(deadTtlMaxMs, deadTtlMs),
      unknown: unknownBitrateTtlMs,
      forced: forcedAt,
      now,
    }) as Record<string, number | null>;
    const total = (row.total as number) ?? 0;
    const alive = (row.alive as number) ?? 0;
    return {
      total,
      alive,
      dead: total - alive,
      oldestProbedAt: row.oldest ?? null,
      newestProbedAt: row.newest ?? null,
      due: (row.due as number) ?? 0,
      nextDueAt: row.nextDue ?? null,
      ages: {
        hour: (row.hour as number) ?? 0,
        sixHours: (row.sixHours as number) ?? 0,
        day: (row.day as number) ?? 0,
        older: (row.older as number) ?? 0,
      },
    };
  }

  /** Run totals over a window -- "what has it done today", not since install. */
  runStats(sinceMs: number): RunStats {
    const row = this.sql(
      `SELECT COUNT(*) AS passes,
              COALESCE(SUM(probed > 0 OR reordered > 0), 0) AS working,
              COALESCE(SUM(probed), 0)    AS probed,
              COALESCE(SUM(dead), 0)      AS dead,
              COALESCE(SUM(reordered), 0) AS reordered,
              COALESCE(SUM(error IS NOT NULL), 0) AS failed
       FROM runs WHERE started_at >= ?`,
    ).get(sinceMs) as Record<string, number>;
    return {
      passes: row.passes ?? 0,
      working: row.working ?? 0,
      probed: row.probed ?? 0,
      dead: row.dead ?? 0,
      reordered: row.reordered ?? 0,
      failed: row.failed ?? 0,
    };
  }

  /**
   * Probes per hour over the recent past, oldest bucket first.
   *
   * Empty hours are filled in rather than omitted: a gap in the chart is the
   * interesting part, and a sparse array would draw as if it never happened.
   */
  activity(hours = 24, now = Date.now()): ActivityBucket[] {
    const start = Math.floor(now / 3_600_000) * 3_600_000 - (hours - 1) * 3_600_000;
    const rows = this.sql(
      // CAST, because a bound JS number arrives as a REAL and float division
      // would give 5.43 rather than the bucket index 5.
      `SELECT CAST((started_at - :start) / 3600000 AS INTEGER) AS bucket,
                COALESCE(SUM(probed), 0) AS probed,
                COALESCE(SUM(dead), 0)   AS dead
         FROM runs WHERE started_at >= :start GROUP BY bucket`,
    ).all({ start }) as Array<{ bucket: number; probed: number; dead: number }>;
    const byBucket = new Map(rows.map((r) => [r.bucket, r]));
    return Array.from({ length: hours }, (_, i) => ({
      from: start + i * 3_600_000,
      probed: byBucket.get(i)?.probed ?? 0,
      dead: byBucket.get(i)?.dead ?? 0,
    }));
  }

  /** Lifetime totals across every recorded run. */
  runTotals(): {
    runs: number;
    failed: number;
    probed: number;
    cached: number;
    dead: number;
    reordered: number;
    assigned: number;
    skipped: number;
  } {
    const row = this.sql(
      `SELECT COUNT(*) AS runs,
              COALESCE(SUM(error IS NOT NULL), 0) AS failed,
              COALESCE(SUM(probed), 0)    AS probed,
              COALESCE(SUM(cached), 0)    AS cached,
              COALESCE(SUM(dead), 0)      AS dead,
              COALESCE(SUM(reordered), 0) AS reordered,
              COALESCE(SUM(assigned), 0)  AS assigned,
              COALESCE(SUM(skipped), 0)   AS skipped
       FROM runs`,
    ).get() as Record<string, number>;
    return {
      runs: row.runs ?? 0,
      failed: row.failed ?? 0,
      probed: row.probed ?? 0,
      cached: row.cached ?? 0,
      dead: row.dead ?? 0,
      reordered: row.reordered ?? 0,
      assigned: row.assigned ?? 0,
      skipped: row.skipped ?? 0,
    };
  }

  /** Who holds the worker lock, and how fresh their heartbeat is. */
  lockState(): { owner: string; heartbeat: number } | null {
    const row = this.sql('SELECT owner, heartbeat FROM worker_lock WHERE id = 1').get() as
      | { owner: string; heartbeat: number }
      | undefined;
    return row ?? null;
  }

  /** Drop cache rows untouched for a month, so the file cannot grow forever. */
  prune(olderThanMs = 30 * 86_400_000): number {
    return this.sql('DELETE FROM probe_cache WHERE probed_at < ?').run(Date.now() - olderThanMs)
      .changes;
  }

  /**
   * Record one settled verdict against the bucket its stream arrived in.
   *
   * Called for every stream a pass probes, alive or dead, because the dead
   * ones are half the signal: a bucket where a third of the streams never
   * answer is a bad bucket however fast the other two thirds run.
   *
   * Writes only -- no read-modify-write, no trim on the hot path. The trim is
   * `trimQuality`, run once per pass, because doing it per sample would turn
   * every probe into a delete against the largest table here for the sake of
   * a row count nobody reads between passes.
   */
  recordQuality(sample: QualitySample): void {
    this.sql(
      `INSERT INTO quality_samples
         (provider_id, provider_name, tier, group_id, group_name,
          channel_group_id, channel_group_name, policy_mode, stream_name,
          audio_only, sampled_at, alive, black, bitrate_kbps, measured, height, fps)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sample.providerId,
      sample.providerName,
      sample.tier,
      sample.groupId,
      sample.groupName,
      sample.channelGroupId,
      sample.channelGroupName,
      sample.policyMode,
      // Bounded rather than trusted. A name is provider-controlled text on the
      // hot path of every probe, and the mining this exists for reads tokens
      // out of the first few words, not the two hundredth.
      sample.streamName.slice(0, MAX_STREAM_NAME),
      sample.audioOnly ? 1 : 0,
      Date.now(),
      sample.alive ? 1 : 0,
      sample.black ? 1 : 0,
      Math.round(sample.bitrateKbps),
      sample.measured ? 1 : 0,
      Math.round(sample.height),
      sample.fps,
    );
  }

  /**
   * Hold each bucket to its most recent `perBucket` samples, and drop samples
   * past `olderThanMs` outright.
   *
   * Two limits rather than one because they fail in opposite directions. The
   * age limit alone lets a provider with thousands of streams write an
   * unbounded table inside the window; the count limit alone keeps a bucket
   * that stopped being probed a year ago answering as though it were current.
   *
   * The bucket includes the policy the sample was probed under, so a provider's
   * event samples cannot be evicted by its VOD ones. Without that the cap and
   * the scope work against each other: a catalogue is mostly not events, so the
   * 400 most recent probes of a (provider, tier) are mostly out of scope, and
   * the gate would then be reading a window the trim had already emptied of
   * everything it wanted.
   */
  trimQuality(perBucket = SAMPLES_PER_BUCKET, olderThanMs = QUALITY_HISTORY_MS): number {
    let removed = this.sql('DELETE FROM quality_samples WHERE sampled_at < ?').run(
      Date.now() - olderThanMs,
    ).changes;
    removed += this.sql(
      `DELETE FROM quality_samples WHERE rowid IN (
         SELECT rowid FROM (
           SELECT rowid,
                  ROW_NUMBER() OVER (
                    PARTITION BY provider_id, tier, policy_mode
                        ORDER BY sampled_at DESC, rowid DESC
                  ) AS rank
             FROM quality_samples
         ) WHERE rank > ?
       )`,
    ).run(perBucket).changes;
    return removed;
  }

  /**
   * The rule set every later pass is checked against.
   *
   * Replaced rather than appended: there is one Teamarr instance and one
   * current answer to "what is it running". History lives in the checks, which
   * carry the date of the rules they used.
   */
  saveTeamarrRules(rules: unknown): void {
    this.sql(
      `INSERT INTO teamarr_rules (id, rules, uploaded_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET rules = excluded.rules, uploaded_at = excluded.uploaded_at`,
    ).run(JSON.stringify(rules), Date.now());
  }

  teamarrRules(): { rules: unknown[]; uploadedAt: number } | null {
    const row = this.sql('SELECT rules, uploaded_at FROM teamarr_rules WHERE id = 1').get() as
      | { rules: string; uploaded_at: number }
      | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.rules) as unknown;
      if (!Array.isArray(parsed)) return null;
      return { rules: parsed, uploadedAt: row.uploaded_at };
    } catch {
      // A row that will not parse is a row that cannot be checked against.
      // Reported as absent rather than thrown: a corrupt rule set must not be
      // able to fail a probing pass.
      return null;
    }
  }

  /** Record one pass's check, summary and misses together. */
  recordRuleCheck(check: StoredRuleCheck): void {
    const checkedAt = check.checkedAt;
    this.db.transaction(() => {
      this.sql(
        `INSERT OR REPLACE INTO rule_checks
           (checked_at, run_id, channels, agreed, disagreed, ambiguous, dead_first,
            gap_kbps, managed_channels, managed_agreed, managed_dead_first,
            managed_gap_kbps, approximate, rules_evaluated, rules_skipped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        checkedAt,
        check.runId,
        check.channels,
        check.agreed,
        check.disagreed,
        check.ambiguous,
        check.deadFirst,
        Math.round(check.gapKbps),
        check.managedChannels,
        check.managedAgreed,
        check.managedDeadFirst,
        Math.round(check.managedGapKbps),
        check.approximate ? 1 : 0,
        check.rulesEvaluated,
        check.rulesSkipped,
      );
      const insert = this.sql(
        `INSERT INTO rule_check_misses
           (checked_at, channel_id, channel_name, managed, teamarr_stream, teamarr_name,
            teamarr_provider, teamarr_points, teamarr_bitrate, teamarr_alive,
            teamarr_black, teamarr_matched, podium_stream, podium_name,
            podium_provider, podium_bitrate, gap_kbps)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const miss of check.misses) {
        insert.run(
          checkedAt,
          miss.channelId,
          miss.channelName,
          miss.managed ? 1 : 0,
          miss.teamarrStream,
          miss.teamarrName,
          miss.teamarrProvider,
          miss.teamarrPoints,
          Math.round(miss.teamarrBitrate),
          miss.teamarrAlive ? 1 : 0,
          miss.teamarrBlack ? 1 : 0,
          JSON.stringify(miss.teamarrMatched),
          miss.podiumStream,
          miss.podiumName,
          miss.podiumProvider,
          Math.round(miss.podiumBitrate),
          Math.round(miss.gapKbps),
        );
      }
    })();
  }

  /** Recent checks, newest first, with the misses of the newest attached. */
  ruleChecks(limit = 30): { history: StoredRuleCheckRow[]; latest: StoredRuleMiss[] } {
    const history = this.sql(
      `SELECT checked_at, run_id, channels, agreed, disagreed, ambiguous, dead_first,
              gap_kbps, managed_channels, managed_agreed, managed_dead_first,
              managed_gap_kbps, approximate, rules_evaluated, rules_skipped
         FROM rule_checks ORDER BY checked_at DESC LIMIT ?`,
    ).all(limit) as Array<Record<string, number | string | null>>;

    const rows = history.map((row) => ({
      checkedAt: Number(row.checked_at),
      runId: (row.run_id as string) ?? null,
      channels: Number(row.channels),
      agreed: Number(row.agreed),
      disagreed: Number(row.disagreed),
      ambiguous: Number(row.ambiguous),
      deadFirst: Number(row.dead_first),
      gapKbps: Number(row.gap_kbps),
      managedChannels: Number(row.managed_channels),
      managedAgreed: Number(row.managed_agreed),
      managedDeadFirst: Number(row.managed_dead_first),
      managedGapKbps: Number(row.managed_gap_kbps),
      approximate: Number(row.approximate) === 1,
      rulesEvaluated: Number(row.rules_evaluated),
      rulesSkipped: Number(row.rules_skipped),
    }));

    if (rows.length === 0) return { history: [], latest: [] };
    const misses = this.sql(
      `SELECT * FROM rule_check_misses WHERE checked_at = ? ORDER BY gap_kbps DESC`,
    ).all(rows[0]!.checkedAt) as Array<Record<string, number | string>>;

    return {
      history: rows,
      latest: misses.map((row) => ({
        channelId: Number(row.channel_id),
        channelName: String(row.channel_name),
        managed: Number(row.managed) === 1,
        teamarrStream: Number(row.teamarr_stream),
        teamarrName: String(row.teamarr_name),
        teamarrProvider: String(row.teamarr_provider),
        teamarrPoints: Number(row.teamarr_points),
        teamarrBitrate: Number(row.teamarr_bitrate),
        teamarrAlive: Number(row.teamarr_alive) === 1,
        teamarrBlack: Number(row.teamarr_black) === 1,
        teamarrMatched: parseMatched(String(row.teamarr_matched ?? '[]')),
        podiumStream: Number(row.podium_stream),
        podiumName: String(row.podium_name),
        podiumProvider: String(row.podium_provider),
        podiumBitrate: Number(row.podium_bitrate),
        gapKbps: Number(row.gap_kbps),
      })),
    };
  }

  /**
   * Every sample still held, newest first.
   *
   * Returned raw rather than pre-aggregated: the summary a caller wants -- a
   * percentile, an alive rate, a points value -- depends on how the export is
   * being scaled, and re-deriving it from samples that were never averaged
   * away means changing the scale does not mean waiting a month for new data.
   * Bounded by `trimQuality`, so "every sample" is thousands, not millions.
   */
  qualitySamples(sinceMs?: number): StoredQualitySample[] {
    const rows = (
      sinceMs === undefined
        ? this.sql(
            `SELECT provider_id, provider_name, tier, group_id, group_name,
                    channel_group_id, channel_group_name, policy_mode, stream_name,
                    audio_only, sampled_at, alive, black, bitrate_kbps, measured, height, fps
               FROM quality_samples ORDER BY sampled_at DESC`,
          ).all()
        : this.sql(
            `SELECT provider_id, provider_name, tier, group_id, group_name,
                    channel_group_id, channel_group_name, policy_mode, stream_name,
                    audio_only, sampled_at, alive, black, bitrate_kbps, measured, height, fps
               FROM quality_samples WHERE sampled_at >= ? ORDER BY sampled_at DESC`,
          ).all(Date.now() - sinceMs)
    ) as Array<{
      provider_id: number;
      provider_name: string;
      tier: string;
      group_id: number | null;
      group_name: string;
      channel_group_id: number | null;
      channel_group_name: string;
      policy_mode: string;
      stream_name: string;
      audio_only: number;
      sampled_at: number;
      alive: number;
      black: number;
      bitrate_kbps: number;
      measured: number;
      height: number;
      fps: number;
    }>;
    return rows.map((row) => ({
      providerId: row.provider_id,
      providerName: row.provider_name,
      tier: row.tier,
      groupId: row.group_id,
      groupName: row.group_name,
      channelGroupId: row.channel_group_id,
      channelGroupName: row.channel_group_name ?? '',
      policyMode: row.policy_mode ?? '',
      streamName: row.stream_name ?? '',
      audioOnly: Boolean(row.audio_only),
      sampledAt: row.sampled_at,
      alive: Boolean(row.alive),
      black: Boolean(row.black),
      bitrateKbps: row.bitrate_kbps,
      measured: Boolean(row.measured),
      height: row.height,
      fps: row.fps,
    }));
  }

  /**
   * Replace the whole catalogue snapshot with the state the last pass fetched.
   *
   * Empty rows write NOTHING, on purpose, for the same reason `pruneOutside`
   * refuses an empty keep set: a truncated channel fetch or a rules file that
   * momentarily parsed short looks identical to "nothing is managed", and wiping
   * a good snapshot on that loses the provider view until the next full pass.
   * A genuinely unmanaged install never writes a snapshot at all, which reads
   * as absent series -- the honest answer for a catalogue that was never built.
   * A snapshot that should have been replaced but was not shows up as a climbing
   * `catalogue_state.written_at`, which is what the staleness gauge reads.
   */
  replaceCatalogue(rows: CatalogueRow[], runId: string | null): void {
    if (rows.length === 0) return;
    this.db.transaction(() => {
      this.sql('DELETE FROM catalogue').run();
      const insert = this.sql(
        `INSERT INTO catalogue
           (channel_id, channel_name, slot, stream_id, provider_id, provider_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        insert.run(r.channelId, r.channelName, r.slot, r.streamId, r.providerId, r.providerName);
      }
      this.sql(
        `INSERT INTO catalogue_state (id, written_at, run_id) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET written_at = excluded.written_at, run_id = excluded.run_id`,
      ).run(Date.now(), runId);
    })();
  }

  /**
   * Rewrite one channel's slots after a successful reorder write-back, so the
   * snapshot reflects what podium just decided rather than what it fetched hours
   * ago at pass start. Only `reorder()` and the apply/unassign routes call this,
   * each with the exact array it handed Dispatcharr.
   */
  updateChannelOrder(channelId: number, rows: CatalogueRow[]): void {
    this.db.transaction(() => {
      this.sql('DELETE FROM catalogue WHERE channel_id = ?').run(channelId);
      const insert = this.sql(
        `INSERT INTO catalogue
           (channel_id, channel_name, slot, stream_id, provider_id, provider_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        insert.run(r.channelId, r.channelName, r.slot, r.streamId, r.providerId, r.providerName);
      }
    })();
  }

  /**
   * Record that a person took this stream off this channel, so no later pass
   * assigns it back. See the `assign_blocks` table.
   */
  blockAssignment(channelId: number, streamId: number): void {
    this.sql(
      `INSERT INTO assign_blocks (channel_id, stream_id, blocked_at) VALUES (?, ?, ?)
       ON CONFLICT(channel_id, stream_id) DO NOTHING`,
    ).run(channelId, streamId, Date.now());
  }

  /** Streams auto-assign must not put back on this channel. */
  assignBlocks(channelId: number): Set<number> {
    const rows = this.sql('SELECT stream_id FROM assign_blocks WHERE channel_id = ?').all(
      channelId,
    ) as Array<{ stream_id: number }>;
    return new Set(rows.map((r) => r.stream_id));
  }

  /** Undo a block, for a stream someone wants back in the running. */
  unblockAssignment(channelId: number, streamId: number): void {
    this.sql('DELETE FROM assign_blocks WHERE channel_id = ? AND stream_id = ?').run(
      channelId,
      streamId,
    );
  }

  /** The catalogue snapshot and when it was last written as a whole. */
  catalogue(): { rows: CatalogueRow[]; writtenAt: number | null } {
    const rows = this.sql(
      `SELECT channel_id, channel_name, slot, stream_id, provider_id, provider_name
       FROM catalogue ORDER BY channel_id, slot`,
    ).all() as Array<{
      channel_id: number;
      channel_name: string;
      slot: number;
      stream_id: number;
      provider_id: number;
      provider_name: string;
    }>;
    const state = this.sql('SELECT written_at FROM catalogue_state WHERE id = 1').get() as
      | { written_at: number }
      | undefined;
    return {
      rows: rows.map((r) => ({
        channelId: r.channel_id,
        channelName: r.channel_name,
        slot: r.slot,
        streamId: r.stream_id,
        providerId: r.provider_id,
        providerName: r.provider_name,
      })),
      writtenAt: state?.written_at ?? null,
    };
  }

  /** Hard reset for all historical and cached data. */
  resetData(): void {
    this.db.transaction(() => {
      this.sql('DELETE FROM probe_cache').run();
      this.sql('DELETE FROM runs').run();
      // A mark against verdicts that no longer exist is a request that has
      // already been granted, and leaving it would keep waking the worker.
      this.sql('DELETE FROM refresh_marks').run();
      this.sql('DELETE FROM catalogue').run();
      this.sql('DELETE FROM catalogue_state').run();
      this.sql('DELETE FROM assign_blocks').run();
      this.sql('DELETE FROM quality_samples').run();
    })();
  }

  /**
   * Drop cache rows for streams no longer managed, so a stream that was probed
   * and then excluded, unmatched, or removed from every lineup does not linger
   * and drag the freshness numbers past the target forever.
   *
   * `keep` is the set of stream ids the worker still manages -- matched by a
   * rule on a channel whose group is not excluded. A row whose stream is not in
   * that set is orphan work the pacer will never redo. Membership is by stream
   * id only; a row carrying a stale `stream_hash` for a still-managed stream is
   * left for `prune()`'s age-based sweep.
   *
   * An empty `keep` deletes nothing: it means no channel is managed at all
   * (no rules, or every group excluded), which is a state to leave alone rather
   * than a request to wipe the cache.
   */
  pruneOutside(
    keep: Set<number>,
    minFraction = 0.2,
    warn: (message: string) => void = () => {},
  ): number {
    if (keep.size === 0) return 0;
    const totalCount =
      (this.sql('SELECT COUNT(*) as cnt FROM probe_cache').get() as { cnt: number })?.cnt ?? 0;
    // A `keep` set suddenly a fraction of the cache is far more likely to be a
    // rules file that momentarily parsed short, or a truncated channel fetch,
    // than a genuine decision to stop managing 80% of the library. Deleting on
    // that costs hours of re-probing and cannot be undone, so refuse -- loudly,
    // because a silent skip is indistinguishable from a prune that found
    // nothing, and if the reduction *was* deliberate the cache never shrinks
    // and nobody is told why.
    if (totalCount > 50 && keep.size < totalCount * minFraction) {
      warn(
        `skipping cache prune: only ${keep.size} of ${totalCount} cached streams are still ` +
          `managed (under ${Math.round(minFraction * 100)}%). If this reduction is intended, ` +
          `the orphans age out via prune() instead.`,
      );
      return 0;
    }
    const run = this.db.transaction((ids: number[]) => {
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS _podium_keep (id INTEGER PRIMARY KEY)');
      this.sql('DELETE FROM _podium_keep').run();
      const insert = this.sql('INSERT INTO _podium_keep (id) VALUES (?)');
      for (const id of ids) insert.run(id);
      return this.sql(
        'DELETE FROM probe_cache WHERE stream_id NOT IN (SELECT id FROM _podium_keep)',
      ).run().changes;
    });
    return run([...keep]);
  }

  /**
   * Drop cache rows for logins that no longer exist, the per-variant companion
   * to `pruneOutside`.
   *
   * A profile deleted or deactivated in Dispatcharr leaves rows nothing will
   * ever refresh, and the readers that speak per stream -- `verdicts`,
   * `cacheStats` -- fold every row for a stream together. An abandoned row is
   * therefore not merely inert: an alive verdict from a login that is gone
   * keeps the stream reading alive on the pages, and its frozen `probed_at`
   * pins `oldestProbedAt` at that moment until the 30-day sweep. Both are
   * wrong the instant the profile goes.
   *
   * `keep` is every login id the catalogue still carries, variant 0 included
   * where any provider still probes the stored URL. Empty deletes nothing: it
   * means the provider fetch came back with nothing to compare against, which
   * is a state to leave alone rather than a request to wipe the cache.
   */
  pruneVariants(keep: Set<number>): number {
    if (keep.size === 0) return 0;
    const holes = [...keep].map(() => '?').join(',');
    return this.db
      .prepare(`DELETE FROM probe_cache WHERE variant_id NOT IN (${holes})`)
      .run(...keep).changes;
  }
}
