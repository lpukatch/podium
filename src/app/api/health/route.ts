import { NextResponse } from 'next/server';
import { VERSION } from '@/lib/version';

export const dynamic = 'force-dynamic';

/**
 * Liveness and readiness for the web process.
 *
 * **This must reflect the web process, not the worker.** It is wired to
 * `livenessProbe`, `readinessProbe` and `startupProbe` in the deployment, so
 * anything that makes it fail restarts the pod and pulls it out of the service.
 *
 * This endpoint must not read the data directory or SQLite. A blocked database
 * can otherwise keep the synchronous route from answering before the probe
 * timeout. The worker heartbeat remains available at `/api/health/worker`.
 */
export function GET() {
  return NextResponse.json({ status: 'ok', version: VERSION });
}
