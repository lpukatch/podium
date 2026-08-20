import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { renderMetrics } from '@/lib/metrics';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Prometheus scrape endpoint.
 *
 * Opened and closed per request: a scrape is infrequent and cheap, and holding
 * a handle would keep a WAL reader alive for the life of the web process.
 */
export function GET() {
  let store: Store | null = null;
  try {
    const config = loadConfig();
    store = new Store(config.dbPath);
    const body = renderMetrics(store, {
      maxAgeMs: config.PODIUM_MAX_AGE_MS,
      channelMetrics: config.PODIUM_METRICS_CHANNELS,
    });
    return new NextResponse(body, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
    });
  } catch (error) {
    // Return a scrapeable body rather than a 500: podium_up 0 is a far more
    // useful alert than a failed scrape, which looks the same as the pod being
    // gone.
    return new NextResponse(
      `# HELP podium_up Always 1; presence of this series means the API answered.\n` +
        `# TYPE podium_up gauge\npodium_up 0\n` +
        `# error: ${String(error).slice(0, 200).replace(/\n/g, ' ')}\n`,
      { status: 200, headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' } },
    );
  } finally {
    store?.close();
  }
}
