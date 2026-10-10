import type { Config } from './config';
import type { ConnectEventName } from './connect-events';

/** Receiver totals survive queue drains and history retention. No payloads or headers are kept. */
export interface ConnectSummary {
  trackingSince: number;
  accepted: number;
  rejected: number;
  lastReceivedAt: number | null;
  lastRejectedAt: number | null;
  lastRejection: string | null;
  syncErrors: number;
  lastSyncAt: number | null;
  lastSyncSuccessAt: number | null;
  syncError: string | null;
  syncWanted: boolean;
  syncPodiumUrl: string;
  syncDispatcharrUrl: string;
}

export interface ConnectDelivery {
  id: number;
  event: ConnectEventName;
  channelKey: string | null;
  channelName: string | null;
  streamId: number | null;
  previousStreamId: number | null;
  reason: string;
  receivedAt: number;
  status: number;
  error: string | null;
}

export interface ConnectActivity {
  summary: ConnectSummary;
  pending: number;
  recent: ConnectDelivery[];
}

export function connectStatus(
  config: Pick<
    Config,
    'PODIUM_CONNECT_EVENTS' | 'PODIUM_STABILITY' | 'PODIUM_CONNECT_URL' | 'DISPATCHARR_URL'
  >,
  summary: ConnectSummary,
): 'disabled' | 'blocked' | 'pending' | 'error' | 'listening' {
  if (!config.PODIUM_CONNECT_EVENTS) return 'disabled';
  if (!config.PODIUM_STABILITY || !config.PODIUM_CONNECT_URL.trim()) return 'blocked';
  if (
    !summary.lastSyncAt ||
    !summary.syncWanted ||
    summary.syncPodiumUrl !== config.PODIUM_CONNECT_URL.trim().replace(/\/+$/, '') ||
    summary.syncDispatcharrUrl !== config.DISPATCHARR_URL
  )
    return 'pending';
  return summary.syncError ? 'error' : 'listening';
}

export interface ConnectStatusResponse extends ConnectActivity {
  state: ReturnType<typeof connectStatus>;
  enabled: boolean;
  stabilityEnabled: boolean;
  callbackUrl: string;
}
