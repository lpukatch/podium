'use client';

/**
 * The dead list. Until this view existed, a stream's status was reachable
 * only by opening its channel -- fine for one channel, useless for "what is
 * dead right now?" across a catalogue. The data arrives folded and joined
 * from `/api/dead`; this file is presentation only.
 */

import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DeadEntry, DeadResponse } from '@/lib/dead';

const card = 'rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]';
const btn =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-[15px] hover:border-[var(--color-accent)] disabled:opacity-50';
const pill = 'inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap';
const heading = 'text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]';

function ago(ms: number): string {
  const s = Math.max(Math.round((Date.now() - ms) / 1000), 0);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

const n = (value: number) => value.toLocaleString();

function Stat({
  label,
  value,
  text,
  sub,
  tone,
}: {
  label: string;
  value?: number;
  text?: string;
  sub?: string;
  tone?: 'bad';
}) {
  return (
    <div className="rounded-lg border border-[var(--color-line)] p-3">
      <div
        className={`text-2xl font-semibold tabular-nums ${
          tone === 'bad' ? 'text-[var(--color-bad)]' : ''
        }`}
      >
        {text ?? n(value ?? 0)}
      </div>
      <div className="text-sm text-[var(--color-muted)]">{label}</div>
      {sub && <div className="text-xs tabular-nums text-[var(--color-muted)]">{sub}</div>}
    </div>
  );
}

function ChannelChip({ c }: { c: DeadEntry['channels'][number] }) {
  return (
    <span
      className={`${pill} ${
        c.rank === 1
          ? 'bg-[var(--color-bad)] text-white'
          : 'border border-[var(--color-line)] text-[var(--color-muted)]'
      }`}
      title={`Serves this ${c.rank === 1 ? 'first' : `#${c.rank}`} on ${c.name}`}
    >
      {c.name} #{c.rank}
    </span>
  );
}

export function DeadView({
  onOpenChannel,
}: {
  onOpenChannel?: (channelId: number, groupId: number | null) => void;
}) {
  const [data, setData] = useState<DeadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // No polling: verdicts turn over on the worker's cadence (minutes to hours,
  // with the dead backoff stretching the dead ones further), not second by
  // second. A Refresh button answers "did the pass that is running change
  // anything" without a ticker running against a number that never moves.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/dead');
      const body = (await resp.json()) as DeadResponse & { error?: string };
      if (!resp.ok || body.error) {
        setError(body.error ?? 'Cannot read dead streams');
      } else {
        setError(null);
        setData(body);
      }
    } catch {
      setError('Cannot reach Podium');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className={`${card} m-5 border-[var(--color-bad)] p-5`}>
        <h3 className="font-semibold text-[var(--color-bad)]">Cannot read dead streams</h3>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">{error}</p>
        <button type="button" className={`${btn} mt-4`} onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="m-5 flex items-center gap-3 p-5 text-[var(--color-muted)]">
        <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
        Reading the probe cache…
      </div>
    );
  }

  const { totals } = data;
  const nothing = totals.dead === 0 && totals.black === 0 && totals.orphans === 0;

  return (
    <div className="p-5">
      <div className={`${card} p-5`}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-semibold">Dead</h2>
          <span className="text-sm text-[var(--color-muted)]">
            channel data as of {ago(data.fetchedAt)}
          </span>
          <span className="flex-1" />
          <button type="button" className={btn} disabled={loading} onClick={() => void load()}>
            {loading && <LoaderCircle className="mr-1 inline h-4 w-4 animate-spin" aria-hidden="true" />}
            {loading ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">
          Streams whose last probe came back dead or a black screen — the same verdict the channel
          editor shows, collected across the catalogue. Dead streams are rechecked on the backoff
          schedule, so a stream dead for many checks is waiting longer between looks on purpose.
        </p>
        {data.cacheUnavailable && (
          <p className="mt-2 text-sm text-[var(--color-warn)]">
            The probe cache could not be read: nothing is listed because nothing is known.
          </p>
        )}
      </div>

      {nothing ? (
        <div className={`${card} mt-4 p-5`}>
          <h3 className={heading}>Nothing is dead</h3>
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">
            Every verdict in the cache reads live. The worker keeps rechecking on its usual
            schedule.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Dead" value={totals.dead} tone={totals.dead > 0 ? 'bad' : undefined} />
            <Stat label="Black screen" value={totals.black} />
            <Stat
              label="Served first"
              value={totals.channelsServedFirst}
              tone={totals.channelsServedFirst > 0 ? 'bad' : undefined}
              sub={`of ${n(totals.channelsAffected)} channels with dead streams`}
            />
            <Stat label="Orphaned verdicts" value={totals.orphans} sub="streams gone from the catalogue" />
            <Stat
              label="Worst streak"
              value={totals.worstStreak}
              sub={totals.oldestProbedAt ? `oldest checked ${ago(totals.oldestProbedAt)}` : undefined}
            />
          </div>

          {data.providers.length > 0 && (
            <div className={`${card} mt-4 p-5`}>
              <h3 className={heading}>By provider</h3>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[var(--color-muted)]">
                      <th className="py-1 pr-4 font-medium">Provider</th>
                      <th className="py-1 pr-4 text-right font-medium">Dead</th>
                      <th className="py-1 pr-4 text-right font-medium">Black</th>
                      <th className="py-1 text-right font-medium">Streams</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.providers.map((p) => (
                      <tr key={p.id} className="border-t border-[var(--color-line)]">
                        <td className="py-1.5 pr-4">{p.name}</td>
                        <td className="py-1.5 pr-4 text-right tabular-nums">
                          {p.dead > 0 ? (
                            <span className="text-[var(--color-bad)]">{n(p.dead)}</span>
                          ) : (
                            0
                          )}
                        </td>
                        <td className="py-1.5 pr-4 text-right tabular-nums">{n(p.black)}</td>
                        <td className="py-1.5 text-right tabular-nums text-[var(--color-muted)]">
                          {n(p.streams)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className={`${card} mt-4 p-5`}>
            <h3 className={heading}>
              Streams{' '}
              <span className="ml-1 font-normal normal-case tracking-normal text-[var(--color-muted)]">
                {n(data.entryTotal)} dead or black
                {data.truncated ? ` · showing the worst ${n(data.entries.length)}` : ''}
              </span>
            </h3>
            <ul className="mt-2">
              {data.entries.map((e) => (
                <li
                  key={e.streamId}
                  className="flex flex-wrap items-start gap-3 border-b border-[var(--color-line)] py-3 last:border-0"
                >
                  <span className="min-w-0 flex-1">
                    <span className="mono block break-all text-sm">{e.name}</span>
                    <span className="mt-1 block text-sm text-[var(--color-muted)]">
                      {e.provider} ·{' '}
                      <span className="text-[var(--color-bad)]">
                        {e.status === 'black' ? 'black screen' : 'dead'}
                      </span>
                      {e.status === 'black' && e.height > 0 ? ` · ${e.height}p` : ''}
                      {` · checked ${ago(e.probedAt)}`}
                      {e.status === 'dead' && e.deadStreak >= 2
                        ? ` · dead for ${n(e.deadStreak)} checks`
                        : ''}
                    </span>
                    {e.error && (
                      <span className="mono mt-0.5 block truncate text-xs text-[var(--color-muted)]">
                        {e.error}
                      </span>
                    )}
                  </span>
                  <span className="flex flex-none flex-wrap items-center justify-end gap-1">
                    {e.channels.map((c) =>
                      onOpenChannel ? (
                        <button
                          key={`${e.streamId}-${c.id}`}
                          type="button"
                          className="max-w-[220px] truncate"
                          onClick={() => onOpenChannel(c.id, c.groupId)}
                        >
                          <ChannelChip c={c} />
                        </button>
                      ) : (
                        <span key={`${e.streamId}-${c.id}`} className="max-w-[220px] truncate">
                          <ChannelChip c={c} />
                        </span>
                      ),
                    )}
                    {e.channels.length === 0 && (
                      <span className="text-xs text-[var(--color-muted)]">on no channel</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
