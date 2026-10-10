import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { type ConnectStatusResponse, connectStatus } from '@/lib/connect-status';
import { resolveEnv } from '@/lib/settings';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

export function GET() {
  let store: Store | null = null;
  try {
    store = new Store(loadConfig().dbPath);
    const config = loadConfig(resolveEnv(process.env, store.settings()));
    const activity = store.connectActivity();
    const body: ConnectStatusResponse = {
      ...activity,
      state: connectStatus(config, activity.summary),
      enabled: config.PODIUM_CONNECT_EVENTS,
      stabilityEnabled: config.PODIUM_STABILITY,
      callbackUrl: config.PODIUM_CONNECT_URL,
    };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Cannot read Connect activity' }, { status: 500 });
  } finally {
    store?.close();
  }
}
