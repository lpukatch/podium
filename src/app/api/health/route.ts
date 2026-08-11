import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { STALE_LOCK_MS, Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Liveness and readiness for the container.
 *
 * **This must reflect the web process, not the worker.** It is wired to
 * `livenessProbe`, `readinessProbe` and `startupProbe` in the deployment, so
 * anything that makes it fail restarts the pod and pulls it out of the service.
 *
 * It used to answer from the progress row, which is only written *during* a
 * pass. A settled install sleeps up to PODIUM_IDLE_MAX_MS (15 minutes) between
 * passes writing nothing, so progress goes stale inside five minutes as a
 * matter of routine -- and the endpoint 503'd, which took the UI out of the
 * service and then restarted the pod, on a loop, precisely when everything was
 * working. Progress age is a *pass* signal and says nothing about health.
 *
 * The worker's liveness signal is the lock heartbeat, which `startWorker`
 * refreshes every 30s regardless of what a pass is doing. That is reported here
 * for observability, but it deliberately does **not** fail the probe: a wedged
 * worker is not a reason to restart the web server, and killing the container
 * takes the settings page down with it. Alert on `podium_worker_running` from
 * `/api/metrics` instead.
 */
export function GET() {
  let store: Store | null = null;
  try {
    const config = loadConfig();
    store = new Store(config.dbPath);
    const lock = store.lockState();
    const heartbeatAge = lock ? Date.now() - lock.heartbeat : null;
    const workerEnabled = process.env.PODIUM_ENABLE_WORKER !== 'false';

    // Never a 503: the web process answered, which is what the probe asks.
    return NextResponse.json({
      status: 'ok',
      worker: !workerEnabled
        ? 'disabled'
        : heartbeatAge === null
          ? 'absent'
          : heartbeatAge < STALE_LOCK_MS
            ? 'active'
            : 'stale',
      heartbeatAgeSeconds: heartbeatAge === null ? null : Math.round(heartbeatAge / 1000),
    });
  } catch {
    // No database yet, or it is unreadable. The web process is still up, and a
    // fresh install must be able to reach the settings page to fix exactly this.
    return NextResponse.json({ status: 'ok', worker: 'unknown' });
  } finally {
    store?.close();
  }
}
