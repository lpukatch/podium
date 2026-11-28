import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { STALE_LOCK_MS, Store } from '@/lib/store';
import { VERSION } from '@/lib/version';

export const dynamic = 'force-dynamic';

/** Detailed worker heartbeat for operators. Do not use this route for probes. */
export function GET() {
  let store: Store | null = null;
  try {
    const config = loadConfig();
    store = new Store(config.dbPath);
    const lock = store.lockState();
    const heartbeatAge = lock ? Date.now() - lock.heartbeat : null;
    const workerEnabled = process.env.PODIUM_ENABLE_WORKER !== 'false';

    return NextResponse.json({
      status: 'ok',
      version: VERSION,
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
    return NextResponse.json({ status: 'ok', version: VERSION, worker: 'unknown' });
  } finally {
    store?.close();
  }
}
