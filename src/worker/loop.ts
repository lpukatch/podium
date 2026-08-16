/**
 * The paced loop, as a library rather than a CLI.
 *
 * Each tick asks whether there is spare provider capacity and how far behind
 * the freshness target we are, then does that much work. When someone is
 * watching it does nothing and comes back later; when the house is asleep it
 * runs as hard as the provider limits allow.
 *
 * Split out from the CLI entrypoint so the single-container start path can run
 * it in-process alongside the web server, and so it can be tested without
 * spawning a process.
 */

import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { type Config, loadConfig } from '../lib/config';
import { RulesSource } from '../lib/rules-source';
import { Runner, type RunSummary } from '../lib/runner';
import { resolveEnv } from '../lib/settings';
import { Store } from '../lib/store';

export type Log = (message: string) => void;

export interface WorkerHandle {
  stop: () => void;
  runner: Runner;
  store: Store;
}

/** Local wall-clock time, which is how a run is identified in the UI and logs. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/**
 * Whether anything the pass held back could become eligible on its own.
 *
 * An excluded group stays excluded until someone changes it, so it is no
 * reason to come back early. Everything else the eligibility check reports --
 * waiting for kickoff, waiting for EPG, between events -- turns eligible with
 * the clock, so a pass that only held those back must keep the normal cadence.
 */
function heldBackByTime(heldBack: Record<string, number>): boolean {
  return Object.keys(heldBack).some((reason) => reason !== 'group excluded');
}

/**
 * How long to wait before the next pass.
 *
 * A pass fetches every channel and stream from Dispatcharr -- seconds of work
 * against a live install -- so running one every minute when every verdict is
 * cached and nothing has expired is load that can only ever report "nothing to
 * do". When that is the case, sleep until the earliest verdict actually falls
 * due instead, bounded by the idle cap so a stream the provider added in the
 * meantime is still picked up.
 */
export function nextWait(
  config: Config,
  summary: RunSummary | null,
  nextDueAt: number | null,
  now = Date.now(),
): { waitMs: number; idle: boolean } {
  const base = Math.max(config.PODIUM_TICK_MS, 1_000);
  if (!summary || summary.paused) return { waitMs: base, idle: false };
  const worked = summary.probed > 0 || summary.reordered > 0 || summary.deferred > 0;
  if (worked || heldBackByTime(summary.heldBack)) return { waitMs: base, idle: false };
  if (nextDueAt === null) return { waitMs: base, idle: false };

  const cap = Math.max(config.PODIUM_IDLE_MAX_MS, base);
  const waitMs = Math.min(Math.max(nextDueAt - now, base), cap);
  return { waitMs, idle: waitMs > base };
}

export function buildRunner(
  config: Config,
  log: Log,
): { runner: Runner; store: Store; liveConfig: () => Config } {
  const rules = new RulesSource(config.rulesPath, log);
  const loaded = rules.get();
  if (!loaded.present) {
    log(`no rules file at ${config.rulesPath} yet -- nothing to check until one exists`);
  }

  const store = new Store(config.dbPath);
  const pruned = store.prune();
  if (pruned > 0) log(`pruned ${pruned} stale cache rows`);

  // Resolved per run against the settings table, so an edit in the UI takes
  // effect on the next pass. Paths are deliberately not settable, so reading
  // dbPath/rulesPath from the boot config stays correct.
  let lastVersion = -1;
  const liveConfig = (): Config => {
    const version = store.settingsVersion();
    if (version !== lastVersion) {
      lastVersion = version;
      if (version > 0) log('settings changed; reloaded');
    }
    return loadConfig(resolveEnv(process.env, store.settings()));
  };

  return { store, liveConfig, runner: new Runner({ config: liveConfig, store, rules, log }) };
}

/**
 * Identity for the worker lock. Must be unique per process, forever.
 *
 * This used to be `${pid}@${process.env.HOSTNAME}`, which is neither unique nor
 * the hostname. Next's standalone server sets HOSTNAME to the address it binds
 * -- `0.0.0.0` -- so in the single-container image every container reports the
 * same host, and PIDs restart low inside each one. Two containers landing on
 * the same PID (7 is routine) produced *identical* owner strings, and
 * `Store.acquireLock` skips its held-by-someone-else check when the owner
 * matches: the second worker would take a live lock believing it already held
 * it, and then both would probe every stream twice and race each other's
 * reorders into Dispatcharr -- the exact outcome the lock exists to prevent.
 *
 * `os.hostname()` is the real container hostname whatever the web server did to
 * the environment, and the random suffix separates two processes on one host
 * even when the PID has been reused.
 */
export function lockOwner(): string {
  return `${hostname()}/${process.pid}/${randomUUID().slice(0, 8)}`;
}

/**
 * How often to retry a lock somebody else holds.
 *
 * Comfortably inside the 120s staleness window `acquireLock` uses, so a worker
 * waiting on a dead holder takes over within a tick or so of the lock going
 * stale rather than at some arbitrary later point.
 */
const LOCK_RETRY_MS = 30_000;

/**
 * Start the paced loop. Returns a stop function.
 *
 * Only one worker may hold the lock -- two would double-probe every stream and
 * race each other's reorders into Dispatcharr. A lock whose heartbeat has gone
 * stale is taken over, so a SIGKILLed worker does not wedge the next start.
 *
 * A worker that finds the lock held **waits for it rather than giving up**. It
 * used to return null and never retry, which is a silent total loss of function
 * in the one case that matters: a pod killed rather than shut down (OOM, node
 * failure) leaves its lock behind with a heartbeat under a minute old, so the
 * replacement -- which boots in seconds -- finds the lock fresh, declines, and
 * then serves the UI forever without ever probing anything. `/api/health` still
 * answers `ok`, because the web half genuinely is fine. Retrying costs one
 * SQLite read every 30s and turns that into a pause of at most the staleness
 * window.
 */
export async function startWorker(config: Config, log: Log): Promise<() => void> {
  const { runner, store, liveConfig } = buildRunner(config, log);

  const owner = lockOwner();
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  let holding = false;
  let waited = false;

  /**
   * Read live, so changing the check interval in the UI takes effect on the
   * next pass. Falls back to the boot value if settings are momentarily
   * unloadable -- an unreadable config must not stop the loop.
   */
  const currentConfig = (): Config => {
    try {
      return liveConfig();
    } catch {
      return config;
    }
  };

  const tick = async (): Promise<void> => {
    if (stopping) return;
    const startedAt = Date.now();
    let summary: RunSummary | null = null;
    try {
      summary = await runner.runOnce();
      if (!summary.paused) {
        log(
          `pass at ${clock(startedAt)} took ${(summary.elapsedMs / 1000).toFixed(1)}s: ` +
            `${summary.probed} probed, ${summary.cached} cached, ${summary.dead} dead, ` +
            `${summary.reordered} reordered, ${summary.unchanged} already in order, ` +
            `${summary.skipped} skipped`,
        );
        // Biggest bucket first, ties by name: the same order the progress page
        // uses, and it keeps the line stable between passes so a diff in the
        // log is a real change rather than a reshuffle.
        const held = Object.entries(summary.heldBack).sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        );
        if (held.length > 0) {
          log(`held back: ${held.map(([why, n]) => `${n} ${why}`).join(', ')}`);
        }
      }
    } catch (error) {
      // A failed pass must not kill the loop -- the next tick retries.
      log(`pass at ${clock(startedAt)} failed: ${String(error)}`);
    }
    if (!stopping) {
      const live = currentConfig();
      // The pass reports this, not the cache: it is the only place that knows
      // which expiring verdicts belong to a channel a pass would actually probe.
      const { waitMs, idle } = nextWait(live, summary, summary?.nextDueAt ?? null);
      const nextAt = Date.now() + waitMs;
      // Told to the UI as well as the log: "when does it next run" was
      // unanswerable from the progress page before.
      runner.noteNextRun(nextAt);
      log(idle ? `nothing due; sleeping until ${clock(nextAt)}` : `next pass at ${clock(nextAt)}`);
      timer = setTimeout(() => void tick(), waitMs);
    }
  };

  /** Take the lock and start passing, or come back in `LOCK_RETRY_MS`. */
  const acquire = (): void => {
    if (stopping) return;
    const lock = store.acquireLock(owner);
    if (!lock.ok) {
      // Logged on the way in and again on the way out, not every retry: a
      // worker can legitimately wait minutes here and the wait is not an error.
      if (!waited) {
        waited = true;
        log(`another worker holds the lock (${lock.heldBy}); waiting for it to finish or go stale`);
      }
      // Deliberately *not* unref'd, unlike the heartbeat. While a worker is
      // waiting this is the only thing on the event loop, and the standalone
      // `npm run worker` process has nothing else holding it open -- unref here
      // and it exits instead of waiting, which is the bug this path exists to
      // fix. It mirrors the pass timer, which is not unref'd for the same reason.
      retry = setTimeout(acquire, LOCK_RETRY_MS);
      return;
    }

    holding = true;
    beat = setInterval(() => store.heartbeat(owner), 30_000);
    beat.unref?.();

    // The *effective* dry run, not the booted one. `startWorker` is handed the
    // environment-only config and `PODIUM_DRY_RUN` defaults to on, so an
    // install that turned it off in Settings -- where the value is stored
    // rather than exported -- announced a dry run on every boot and then
    // reordered channels anyway. A banner promising nothing will be written, on
    // a worker that writes, is worse than no banner at all: reordering has no
    // undo, and this line is what someone reads to check before walking away.
    if (currentConfig().PODIUM_DRY_RUN) log('DRY RUN: nothing will be written to Dispatcharr');

    void tick();
    log(
      `paced loop started${waited ? ' (lock acquired)' : ''}, considering a pass every ` +
        `${Math.round(currentConfig().PODIUM_TICK_MS / 1000)}s`,
    );
  };

  acquire();

  return () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    if (retry) clearTimeout(retry);
    if (beat) clearInterval(beat);
    try {
      // Only ours to release: a worker still waiting on someone else's lock
      // must not delete it on the way out.
      if (holding) store.releaseLock(owner);
      store.close();
    } catch {
      // Shutting down anyway.
    }
  };
}
