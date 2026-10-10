'use client';

import { useEffect, useState } from 'react';
import type { ConnectStatusResponse } from '@/lib/connect-status';

function timestamp(at: number | null): string {
  return at === null ? 'None yet' : new Date(at).toLocaleString();
}

const LABELS = {
  disabled: 'Disabled',
  blocked: 'Configuration incomplete',
  pending: 'Waiting for subscription check',
  error: 'Subscription check failed',
  listening: 'Subscriptions configured',
};

export function ConnectActivityPanel() {
  const [data, setData] = useState<ConnectStatusResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch('/api/connect/status', {
          cache: 'no-store',
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (!stopped) {
          setData(body);
          setError('');
        }
      } catch {
        if (!stopped)
          setError(
            'Cannot refresh Connect activity. Any figures below are from the last successful refresh.',
          );
      } finally {
        if (!stopped) timer = setTimeout(() => void load(), 10_000);
      }
    };
    void load();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  return (
    <section
      className="mt-6 rounded-lg border border-[var(--color-line)] p-4"
      aria-labelledby="connect-activity-title"
    >
      <h4 id="connect-activity-title" className="font-semibold">
        Dispatcharr live event activity
      </h4>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Refreshes every 10 seconds. Receiving an event is separate from applying it to the stability
        ledger.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--color-bad)]">
          {error}
        </p>
      )}
      {!data && !error && (
        <p className="mt-3 text-sm text-[var(--color-muted)]">Loading activity…</p>
      )}
      {data && (
        <>
          <p
            className={`mt-3 text-sm font-medium ${data.state === 'error' || data.state === 'blocked' ? 'text-[var(--color-bad)]' : ''}`}
          >
            {LABELS[data.state]}
          </p>
          {data.enabled && !data.stabilityEnabled && (
            <p className="mt-1 text-sm">Enable stability recording to use live events.</p>
          )}
          {data.enabled && !data.callbackUrl.trim() && (
            <p className="mt-1 text-sm">Set the address Dispatcharr should call.</p>
          )}
          {data.state === 'listening' && data.summary.lastReceivedAt === null && (
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Waiting for the first accepted event since tracking began. Quiet playback does not
              mean delivery is broken.
            </p>
          )}
          {data.callbackUrl && (
            <p className="mt-1 break-all text-sm text-[var(--color-muted)]">
              Callback: {data.callbackUrl}
            </p>
          )}
          <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            {[
              ['Accepted deliveries', data.summary.accepted.toLocaleString()],
              ['Receiver errors', data.summary.rejected.toLocaleString()],
              ['Subscription sync errors', data.summary.syncErrors.toLocaleString()],
              ['Last accepted event', timestamp(data.summary.lastReceivedAt)],
              ['Last successful subscription check', timestamp(data.summary.lastSyncSuccessAt)],
              ['Pending in queue', data.pending.toLocaleString()],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-[var(--color-muted)]">{label}</dt>
                <dd className="mt-1 font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          {data.summary.syncError && (
            <p className="mt-3 text-sm text-[var(--color-bad)]">
              Last sync error ({timestamp(data.summary.lastSyncAt)}): {data.summary.syncError}
            </p>
          )}
          {data.summary.lastRejection && (
            <p className="mt-3 text-sm text-[var(--color-bad)]">
              Last receiver error ({timestamp(data.summary.lastRejectedAt)}):{' '}
              {data.summary.lastRejection}
            </p>
          )}
          <p className="mt-4 text-xs text-[var(--color-muted)]">
            Totals since {timestamp(data.summary.trackingSince)}. Requests blocked before reaching
            the receiver are not counted. Earlier deliveries cannot be reconstructed.
          </p>
          <details className="mt-4" open>
            <summary className="cursor-pointer text-sm font-medium">Recent deliveries</summary>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Latest 25 of up to 500 deliveries retained for 14 days, even after the queue is
              drained. Accepted does not guarantee a usable stream id or a recorded failure.
            </p>
            {data.recent.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--color-muted)]">
                No deliveries in retained history.
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-[var(--color-muted)]">
                      {['Received', 'Event', 'Channel', 'Streams', 'Reason / error', 'Result'].map(
                        (label) => (
                          <th key={label} scope="col" className="p-2 font-medium">
                            {label}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((row) => (
                      <tr key={row.id} className="border-t border-[var(--color-line)]">
                        <td className="whitespace-nowrap p-2">{timestamp(row.receivedAt)}</td>
                        <td className="whitespace-nowrap p-2">
                          {row.event === 'stream_switch' ? 'Stream switch' : 'Channel error'}
                        </td>
                        <td className="p-2 break-all" title={row.channelKey ?? undefined}>
                          {row.channelName || row.channelKey || '—'}
                        </td>
                        <td className="whitespace-nowrap p-2">
                          {row.previousStreamId !== null ? `${row.previousStreamId} → ` : ''}
                          {row.streamId ?? 'unknown'}
                        </td>
                        <td className="p-2 break-all">{row.error ?? (row.reason || '—')}</td>
                        <td
                          className={`whitespace-nowrap p-2 ${row.status !== 204 ? 'text-[var(--color-bad)]' : ''}`}
                        >
                          {row.status === 204 ? 'Accepted' : `Error ${row.status}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </>
      )}
    </section>
  );
}
