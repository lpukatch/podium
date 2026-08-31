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
import { syncToTeamarr } from '../lib/teamarr-sync';

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
 * How long to wait before the next pass.
 *
 * A pass fetches every channel and stream from Dispatcharr -- seconds of work
 * against a live install -- so running one every minute when every verdict is
 * cached and nothing has expired is load that can only ever report "nothing to
 * do". When that is the case, sleep until the earliest moment the answer could
 * actually differ, bounded by the idle cap so a stream the provider added in
 * the meantime is still picked up.
 *
 * Two things can change that answer without anybody touching the install, and
 * both are known to the millisecond by the pass that just ran:
 *
 *   - `nextDueAt`  -- the earliest cached verdict falling due for a re-probe.
 *   - `nextEligibleAt` -- the earliest channel the gate held back turning
 *     eligible: a kickoff arriving where the clock alone decides it, and
 *     otherwise the next EPG grid landing, which is the only thing that can
 *     change the rest. See `AllowResult.eligibleAt`.
 *
 * This used to ask a much blunter question -- "did the pass hold anything back
 * for a reason the clock could clear?" -- and if so kept the base cadence. That
 * is true on any install with event channels in it essentially all the time,
 * which meant the idle sleep never once ran: measured on a live install, 450
 * consecutive passes, 378 of them (84%) fetching 22,486 streams to do nothing,
 * and not a single one of them sleeping. Waiting until the specific instant
 * something turns eligible holds the same guarantee -- no channel is probed
 * later than it would have been -- without the once-a-minute crawl.
 *
 * The cadence is only kept when the pass did work, when work is still pending,
 * or when there is genuinely nothing to aim at -- no cached verdict and no grid
 * to refresh, which is a fresh install rather than a settled one.
 */
export function nextWait(
  config: Config,
  summary: RunSummary | null,
  nextDueAt: number | null,
  now = Date.now(),
): { waitMs: number; idle: boolean } {
  const base = Math.max(config.PODIUM_TICK_MS, 1_000);
  if (!summary || summary.paused) return { waitMs: base, idle: false };
  // `runnableBacklog` is the one that matters when a pass probed nothing but
  // had something to probe: an aborted run, or probes that all failed, leave
  // real work outstanding that no wake-up time above would ever describe.
  const worked =
    summary.probed > 0 ||
    summary.reordered > 0 ||
    summary.deferred > 0 ||
    summary.runnableBacklog > 0;
  if (worked) return { waitMs: base, idle: false };

  const wakes = [nextDueAt, summary.nextEligibleAt].filter((at): at is number => at !== null);
  if (wakes.length === 0) return { waitMs: base, idle: false };

  const cap = Math.max(config.PODIUM_IDLE_MAX_MS, base);
  const waitMs = Math.min(Math.max(Math.min(...wakes) - now, base), cap);
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
  // A pass is in flight. `tick` reschedules itself, so nothing normally
  // re-enters it -- but a re-check request can now arrive mid-pass and ask it
  // to run again, and two concurrent passes would double-probe every stream
  // and race each other's reorders into Dispatcharr, which is the whole reason
  // for the worker lock.
  let running = false;
  let wakeRequested = false;
  let lastMark = 0;
  // Guards re-entry the way `running` does for a pass: the push fetches a
  // catalogue and scores it twice, so two at once would race each other into
  // Teamarr's whole-set replacement.
  let syncing = false;

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
    if (stopping || running) return;
    running = true;
    // Cleared on the way in, so a request that lands *during* this pass is
    // still honoured below even though this pass may already have planned
    // around it. The cost of the extra pass is one catalogue crawl; the cost
    // of dropping it is a button that silently does nothing.
    wakeRequested = false;
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
    // Before the reschedule and with nothing awaited in between, so
    // `checkWake` cannot see a pass that has finished but not yet booked its
    // successor and start a second one on top of it.
    running = false;
    if (!stopping) {
      const live = currentConfig();
      // The pass reports this, not the cache: it is the only place that knows
      // which expiring verdicts belong to a channel a pass would actually probe.
      const { waitMs, idle } = wakeRequested
        ? { waitMs: 0, idle: false }
        : nextWait(live, summary, summary?.nextDueAt ?? null);
      const nextAt = Date.now() + waitMs;
      // Told to the UI as well as the log: "when does it next run" was
      // unanswerable from the progress page before.
      runner.noteNextRun(nextAt);
      log(idle ? `nothing due; sleeping until ${clock(nextAt)}` : `next pass at ${clock(nextAt)}`);
      timer = setTimeout(() => void tick(), waitMs);
    }
  };

  /**
   * Push the fitted rules to Teamarr when one is due.
   *
   * Rides the heartbeat rather than a timer of its own, for the same reason
   * `checkWake` does: the interval is read live, so turning the schedule on in
   * the UI takes effect within 30 seconds instead of on the next restart.
   *
   * Due-ness is measured from the last *attempt*, not the last successful
   * push. A refusal is a completed decision -- the guard did its job -- and
   * retrying it every 30 seconds would fetch a catalogue each time to reach
   * the same conclusion.
   */
  const checkSync = (): void => {
    if (stopping || !holding || syncing) return;
    const live = currentConfig();
    if (!live.PODIUM_TEAMARR_SYNC || !live.PODIUM_TEAMARR_URL.trim()) return;
    let lastAt = 0;
    try {
      lastAt = store.teamarrSync()?.ranAt ?? 0;
    } catch {
      // An unreadable row must not stop the loop; the next beat asks again.
      return;
    }
    if (Date.now() - lastAt < live.PODIUM_TEAMARR_SYNC_MS) return;

    syncing = true;
    void (async () => {
      try {
        const outcome = await syncToTeamarr(store, live);
        store.saveTeamarrSync(outcome);
        if (outcome.pushed) {
          log(
            `pushed ${outcome.rules?.total ?? 0} rules to Teamarr ` +
              `(${outcome.rules?.replaced ?? 0} updated in place); agreement ` +
              `${outcome.before?.agreed}/${outcome.before?.channels} -> ` +
              `${outcome.after?.agreed}/${outcome.after?.channels}`,
          );
        } else {
          log(
            `Teamarr push did not write: ${outcome.error ?? outcome.reason ?? 'no reason given'}`,
          );
        }
      } catch (error) {
        // Recorded as well as logged, so a push that has been failing all week
        // is visible on the Quality page rather than only in a rotated log.
        try {
          store.saveTeamarrSync({
            at: Date.now(),
            pushed: false,
            error: String(error).slice(0, 300),
          });
        } catch {
          // Nothing further to do; the next beat retries the whole thing.
        }
        log(`Teamarr push failed: ${String(error)}`);
      } finally {
        syncing = false;
      }
    })();
  };

  /**
   * Notice a re-check somebody asked for and bring the next pass forward.
   *
   * The marks are read from SQLite rather than pushed, because the web half and
   * the worker are separate processes in the split deployment and only
   * accidentally the same one in the shipped image -- the database is the only
   * channel that works for both. It rides the heartbeat, which was already
   * paying a write every 30s, so the whole mechanism costs one extra read of a
   * table with at most a handful of rows in it.
   *
   * That 30s is the worst-case latency on the button, and it is the reason this
   * exists at all: a settled install sleeps up to PODIUM_IDLE_MAX_MS between
   * passes, so without it a re-check queued at 9am could sit untouched until
   * whenever the next verdict happened to fall due.
   */
  const checkWake = (): void => {
    if (stopping || !holding) return;
    let mark: number;
    try {
      mark = store.refreshMarksVersion();
    } catch {
      // A transient read failure must not take the loop down; the next beat
      // asks again.
      return;
    }
    if (mark <= lastMark) return;
    lastMark = mark;
    wakeRequested = true;
    // A pass already in flight books the follow-up itself, from the flag above.
    if (running) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    log('re-check requested; starting a pass now');
    void tick();
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
    // Whatever is already on the table is picked up by the first pass below, so
    // it is not a wake-up -- only marks arriving after this are.
    try {
      lastMark = store.refreshMarksVersion();
    } catch {
      lastMark = 0;
    }
    beat = setInterval(() => {
      store.heartbeat(owner);
      checkWake();
      checkSync();
    }, 30_000);
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
