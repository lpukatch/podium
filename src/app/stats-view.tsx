'use client';

import { useEffect, useState } from 'react';

interface Stats {
  worker: 'active' | 'stale' | 'absent' | 'disabled';
  heartbeatAgeSeconds: number | null;
  catalogueWrittenAt: number | null;
  streams: {
    total: number;
    measured: number;
    healthy: number;
    states: { alive: number; dead: number; black: number; low_bitrate: number; unmeasured: number };
  };
  primary: { total: number; healthy: number };
  providers: Array<{ name: string; primary: number; healthy: number }>;
  freshness: { oldestProbeAgeSeconds: number | null; targetSeconds: number; breaching: boolean };
  lastRun: {
    started_at: number;
    finished_at: number | null;
    probed: number;
    dead: number;
    reordered: number;
    error: string | null;
  } | null;
}

const card = 'rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]';
const percent = (value: number, total: number) =>
  total ? `${Math.round((value / total) * 100)}%` : '—';
const duration = (seconds: number) => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
};

export function StatsView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch('/api/stats');
        const body = (await response.json()) as Stats & { error?: string; detail?: string };
        if (!response.ok || body.error) throw new Error(body.detail || body.error);
        if (!cancelled) setStats(body);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (error) return <p className="p-5 text-[var(--color-bad)]">Could not load stats: {error}</p>;
  if (!stats) return <p className="p-5 text-[var(--color-muted)]">Loading library stats…</p>;

  const workerLabel = stats.worker === 'active' ? 'Running' : stats.worker;
  return (
    <div className="space-y-5 p-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <section className={`${card} p-4`}>
          <p className="text-sm text-[var(--color-muted)]">Measured stream health</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums">
            {percent(stats.streams.healthy, stats.streams.measured)}
          </p>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {stats.streams.healthy.toLocaleString()} usable ·{' '}
            {percent(stats.streams.measured, stats.streams.total)} measured
          </p>
        </section>
        <section className={`${card} p-4`}>
          <p className="text-sm text-[var(--color-muted)]">Healthy primary channels</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums">
            {percent(stats.primary.healthy, stats.primary.total)}
          </p>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {stats.primary.healthy.toLocaleString()} usable first-choice streams
          </p>
        </section>
        <section className={`${card} p-4`}>
          <p className="text-sm text-[var(--color-muted)]">Check freshness</p>
          <p
            className={`mt-1 text-3xl font-semibold tabular-nums ${stats.freshness.breaching ? 'text-[var(--color-bad)]' : ''}`}
          >
            {stats.freshness.oldestProbeAgeSeconds === null
              ? '—'
              : duration(stats.freshness.oldestProbeAgeSeconds)}
          </p>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {stats.freshness.oldestProbeAgeSeconds === null
              ? 'No managed check yet'
              : stats.freshness.breaching
                ? `Past ${duration(stats.freshness.targetSeconds)} target`
                : `Within ${duration(stats.freshness.targetSeconds)} target`}
          </p>
        </section>
        <section className={`${card} p-4`}>
          <p className="text-sm text-[var(--color-muted)]">Worker</p>
          <p className="mt-1 text-3xl font-semibold capitalize">{workerLabel}</p>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {stats.heartbeatAgeSeconds === null
              ? 'No heartbeat yet'
              : `Heartbeat ${stats.heartbeatAgeSeconds}s ago`}
          </p>
        </section>
      </div>

      <section
        className={`${card} grid divide-y divide-[var(--color-line)] sm:grid-cols-5 sm:divide-x sm:divide-y-0`}
      >
        {[
          ['Live', stats.streams.states.alive],
          ['Dead', stats.streams.states.dead],
          ['Black screen', stats.streams.states.black],
          ['Low bitrate', stats.streams.states.low_bitrate],
          ['Unmeasured', stats.streams.states.unmeasured],
        ].map(([label, count]) => (
          <div key={String(label)} className="px-4 py-3">
            <p className="text-sm text-[var(--color-muted)]">{label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {Number(count).toLocaleString()}
            </p>
          </div>
        ))}
      </section>

      <section className={card}>
        <div className="border-b border-[var(--color-line)] px-4 py-3">
          <h2 className="font-semibold">Who serves first</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Share of channel slot 0, with the health of each provider’s current primary streams.
          </p>
        </div>
        {stats.primary.total === 0 ? (
          <p className="p-4 text-sm text-[var(--color-muted)]">
            Available after the worker records its first catalogue snapshot.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {stats.providers.map((provider) => (
              <li
                key={provider.name}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{provider.name}</p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-line)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-accent)]"
                      style={{ width: `${(provider.primary / stats.primary.total) * 100}%` }}
                    />
                  </div>
                </div>
                <div className="text-right text-sm tabular-nums">
                  <p>
                    {percent(provider.primary, stats.primary.total)} primary
                    {provider.primary / stats.primary.total > 0.5 ? ' · concentrated' : ''}
                  </p>
                  <p className="mt-1 text-[var(--color-muted)]">
                    {percent(provider.healthy, provider.primary)} healthy
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {stats.lastRun && (
        <section className={`${card} px-4 py-3 text-sm`}>
          <p className="font-semibold">Latest pass</p>
          <p className="mt-1 text-[var(--color-muted)]">
            {stats.lastRun.error
              ? `Failed: ${stats.lastRun.error.slice(0, 120)}`
              : `${stats.lastRun.probed.toLocaleString()} checked · ${stats.lastRun.dead.toLocaleString()} dead · ${stats.lastRun.reordered.toLocaleString()} reordered`}
          </p>
        </section>
      )}
    </div>
  );
}
