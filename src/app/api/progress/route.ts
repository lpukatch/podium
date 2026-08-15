import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { resolveEnv } from '@/lib/settings';
import { IDLE_PROGRESS, STALE_LOCK_MS, Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;

/**
 * Live worker progress, recent run history, and the state of the library.
 *
 * The worker is a separate process, so this reads the shared SQLite database
 * rather than any in-process state. Opened per request and closed immediately:
 * the UI polls this a few times a second at most, and holding a handle open
 * would keep a WAL reader alive for the life of the web process.
 *
 * The stats block exists because "what is this pass doing" is a dull question
 * on a settled install -- the answer is "nothing, everything is cached". What
 * is still worth knowing is how much of the library is alive, how stale it is
 * getting, and when anything next falls due.
 */
export function GET() {
  let store: Store | null = null;
  try {
    // Resolved against stored settings, not just the environment: the TTLs
    // decide what counts as due, and a value changed in the UI has to move
    // these numbers too or the page contradicts the settings page.
    const boot = loadConfig();
    store = new Store(boot.dbPath);
    const config = loadConfig(resolveEnv(process.env, store.settings()));

    const progress = store.getProgress();
    const runs = store.recentRuns(30);

    // Whether a worker is running is the lock heartbeat's question, not
    // progress age's.
    //
    // This used to key off `progress.updatedAt` being older than five minutes,
    // and the page then said the worker was not running and to go start it.
    // Both halves were wrong. Progress is only written *during* a pass, and a
    // settled install deliberately sleeps up to PODIUM_IDLE_MAX_MS -- fifteen
    // minutes -- between passes that write nothing, so a *correctly idle*
    // worker got reported dead after five, routinely. `/api/health` was fixed
    // for exactly this reason and the page never caught up.
    //
    // The heartbeat is the honest signal: `startWorker` refreshes it every 30s
    // whatever a pass is or is not doing.
    const lock = store.lockState();
    const heartbeatAge = lock ? Date.now() - lock.heartbeat : null;
    const workerEnabled = process.env.PODIUM_ENABLE_WORKER !== 'false';
    const running = heartbeatAge !== null && heartbeatAge < STALE_LOCK_MS;
    const worker = !workerEnabled
      ? 'disabled'
      : running
        ? 'active'
        : heartbeatAge === null
          ? 'absent'
          : 'stale';

    // Blank the progress row only when nothing is there to own it. A sleeping
    // worker's last pass is still the truth about what happened, and clearing
    // it took the schedule line ("next pass in ...") down with it.
    const stale = worker === 'absent' || worker === 'stale';

    return NextResponse.json({
      progress: stale ? { ...IDLE_PROGRESS, updatedAt: progress.updatedAt } : progress,
      stale,
      worker,
      heartbeatAgeSeconds: heartbeatAge === null ? null : Math.round(heartbeatAge / 1000),
      runs,
      stats: {
        cache: store.cacheHealth(
          config.PODIUM_LIVE_TTL_MS,
          config.PODIUM_DEAD_TTL_MS,
          Date.now(),
          config.PODIUM_DEAD_TTL_MAX_MS,
          config.PODIUM_UNKNOWN_BITRATE_TTL_MS,
        ),
        day: store.runStats(Date.now() - DAY_MS),
        activity: store.activity(24),
        liveTtlMs: config.PODIUM_LIVE_TTL_MS,
        deadTtlMs: config.PODIUM_DEAD_TTL_MS,
        deadTtlMaxMs: config.PODIUM_DEAD_TTL_MAX_MS,
        maxAgeMs: config.PODIUM_MAX_AGE_MS,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Cannot read progress', detail: String(error).slice(0, 300) },
      { status: 500 },
    );
  } finally {
    store?.close();
  }
}
