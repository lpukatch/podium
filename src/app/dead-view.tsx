'use client';

/**
 * The dead list. Until this view existed, a stream's status was reachable
 * only by opening its channel -- fine for one channel, useless for "what is
 * dead right now?" across a catalogue. The data arrives folded and joined
 * from `/api/dead`; this file is presentation only.
 */

import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeadEntry, DeadResponse } from '@/lib/dead';
import { orderToApply } from './check-panel';

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
  className = '',
}: {
  label: string;
  value?: number;
  text?: string;
  sub?: string;
  tone?: 'bad';
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-[var(--color-line)] p-3 ${className}`}>
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
      className={`${pill} max-w-full truncate align-middle ${
        c.rank === 1
          ? 'bg-[var(--color-bad)] text-[var(--color-on-bad)]'
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
  onChanged,
}: {
  onOpenChannel?: (channelId: number, groupId: number | null) => void;
  onChanged?: () => Promise<void> | void;
}) {
  const [data, setData] = useState<DeadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Probing state for dead-first channels
  const [probing, setProbing] = useState(false);
  const [probeProgress, setProbeProgress] = useState<{
    current: number;
    total: number;
    channelName: string;
    probed: number;
    dead: number;
    applied: number;
  } | null>(null);
  const [probeResultNote, setProbeResultNote] = useState<{ text: string; bad: boolean } | null>(
    null,
  );
  const [autoApply, setAutoApply] = useState(true);
  const probeAbortRef = useRef<AbortController | null>(null);

  // Soaking state for dead-first channels
  const [soaking, setSoaking] = useState(false);
  const [soakNote, setSoakNote] = useState<string | null>(null);

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

  useEffect(() => {
    return () => {
      if (probeAbortRef.current) {
        probeAbortRef.current.abort();
      }
    };
  }, []);

  const cancelProbe = useCallback(() => {
    if (probeAbortRef.current) {
      probeAbortRef.current.abort();
    }
  }, []);

  const startProbeDeadFirst = async () => {
    if (!data) return;
    const targets = data.channels.filter((c) => c.servedFirstDead);
    if (targets.length === 0) return;

    const controller = new AbortController();
    probeAbortRef.current = controller;
    setProbing(true);
    setProbeResultNote(null);
    setSoakNote(null);

    let totalProbed = 0;
    let totalDead = 0;
    let totalApplied = 0;
    let completed = 0;
    let errors = 0;

    try {
      for (const [i, chan] of targets.entries()) {
        if (controller.signal.aborted) break;
        setProbeProgress({
          current: i + 1,
          total: targets.length,
          channelName: chan.name || `Channel ${chan.id}`,
          probed: totalProbed,
          dead: totalDead,
          applied: totalApplied,
        });

        try {
          const resp = await fetch(`/api/check/${chan.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
          });
          const checkData = (await resp.json()) as {
            probed?: number;
            dead?: number;
            error?: string;
            identical?: boolean;
            allowed?: boolean;
            workerOrder?: number[];
            kept?: number[];
            dropOrder?: number[];
            pruned?: number[];
          };

          if (resp.ok && !checkData.error) {
            totalProbed += checkData.probed ?? 0;
            totalDead += checkData.dead ?? 0;
            completed++;

            if (autoApply && !checkData.identical && checkData.workerOrder) {
              const targetOrder = orderToApply(
                {
                  dropOrder: checkData.dropOrder ?? [],
                  kept: checkData.kept ?? [],
                  workerOrder: checkData.workerOrder,
                },
                false,
              );
              if (targetOrder.length > 0) {
                const applyResp = await fetch(`/api/apply/${chan.id}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  signal: controller.signal,
                  body: JSON.stringify({
                    order: targetOrder,
                    removeUnmatched: false,
                    force: checkData.allowed === false,
                    allowAssign: true,
                    pruned: checkData.pruned ?? [],
                  }),
                });
                if (applyResp.ok) {
                  totalApplied++;
                }
              }
            }
          } else {
            errors++;
          }
        } catch {
          if (controller.signal.aborted) break;
          errors++;
        }
      }

      if (controller.signal.aborted) {
        setProbeResultNote({
          text: `Probe cancelled after ${completed} of ${targets.length} channel(s) (${totalProbed} streams probed, ${totalDead} dead${
            totalApplied > 0 ? `, ${totalApplied} applied` : ''
          }).`,
          bad: false,
        });
      } else {
        setProbeResultNote({
          text: `Finished probing ${completed} channel(s) (${totalProbed} streams probed, ${totalDead} dead)${
            totalApplied > 0 ? ` · ${totalApplied} applied` : ''
          }${errors > 0 ? ` · ${errors} skipped or failed` : ''}.`,
          bad: errors > 0 && completed === 0,
        });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setProbeResultNote({
          text: `Probe error: ${err instanceof Error ? err.message : String(err)}`,
          bad: true,
        });
      }
    } finally {
      setProbing(false);
      setProbeProgress(null);
      probeAbortRef.current = null;
      await load();
      if (onChanged) await onChanged();
    }
  };

  const queueSoakDeadFirst = async () => {
    if (!data) return;
    const targets = data.channels.filter((c) => c.servedFirstDead);
    if (targets.length === 0) return;
    setSoaking(true);
    setSoakNote(null);
    setProbeResultNote(null);

    try {
      const resp = await fetch('/api/soak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'channels',
          id: targets.map((c) => c.id),
        }),
      });
      const body = (await resp.json()) as {
        queued?: number;
        skippedDead?: number;
        error?: string;
      };
      if (!resp.ok || body.error) {
        setSoakNote(`Cannot queue soak: ${body.error ?? `HTTP ${resp.status}`}`);
        return;
      }
      setSoakNote(
        `Queued ${body.queued} stream(s) to soak` +
          ((body.skippedDead ?? 0) > 0
            ? `; left out ${body.skippedDead} that were dead at their last probe`
            : '') +
          ` (runs when worker has spare capacity).`,
      );
    } catch (e) {
      setSoakNote(`Cannot queue soak: ${String(e)}`);
    } finally {
      setSoaking(false);
    }
  };

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
            {loading && (
              <LoaderCircle className="mr-1 inline h-4 w-4 animate-spin" aria-hidden="true" />
            )}
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
            <Stat
              label="Orphaned verdicts"
              value={totals.orphans}
              sub="streams gone from the catalogue"
            />
            {/* Five tiles in a grid of two or three leave a hole; the last one
                takes up the slack until the row is wide enough for all five. */}
            <Stat
              className="col-span-2 lg:col-span-1"
              label="Worst streak"
              value={totals.worstStreak}
              sub={
                totals.oldestProbedAt ? `oldest checked ${ago(totals.oldestProbedAt)}` : undefined
              }
            />
          </div>

          <div className={`${card} mt-4 p-5`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className={heading}>Dead-first channels ({totals.channelsServedFirst})</h3>
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  {totals.channelsServedFirst > 0
                    ? 'Channels currently serving a dead or black-screened stream to viewers.'
                    : 'No channels are currently serving dead streams first.'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {probing ? (
                  <>
                    <button
                      type="button"
                      onClick={cancelProbe}
                      className={`${btn} border-[var(--color-bad)] text-[var(--color-bad)]`}
                    >
                      Cancel probe
                    </button>
                    <span className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
                      <LoaderCircle
                        className="h-4 w-4 animate-spin text-[var(--color-accent)]"
                        aria-hidden="true"
                      />
                      {probeProgress
                        ? `Probing channel ${probeProgress.current} of ${probeProgress.total}: ${probeProgress.channelName} (${probeProgress.probed} probed${probeProgress.dead > 0 ? `, ${probeProgress.dead} dead` : ''}${probeProgress.applied > 0 ? `, ${probeProgress.applied} applied` : ''})…`
                        : 'Preparing to probe…'}
                    </span>
                  </>
                ) : (
                  <>
                    <label className="flex cursor-pointer items-center gap-1.5 text-sm text-[var(--color-muted)]">
                      <input
                        type="checkbox"
                        checked={autoApply}
                        onChange={(e) => setAutoApply(e.target.checked)}
                        className="contrast-checkbox h-4 w-4 shrink-0"
                      />
                      Apply reorders
                    </label>
                    <button
                      type="button"
                      disabled={totals.channelsServedFirst === 0 || soaking}
                      onClick={() => void startProbeDeadFirst()}
                      className={btn}
                      title={
                        totals.channelsServedFirst === 0
                          ? 'No channels currently have a dead first stream'
                          : `Probe all ${totals.channelsServedFirst} channel(s) with dead first streams`
                      }
                    >
                      Probe all ({totals.channelsServedFirst})
                    </button>
                    <button
                      type="button"
                      disabled={totals.channelsServedFirst === 0 || soaking}
                      onClick={() => void queueSoakDeadFirst()}
                      className={btn}
                      title={
                        totals.channelsServedFirst === 0
                          ? 'No channels currently have a dead first stream'
                          : `Queue soaks for streams on ${totals.channelsServedFirst} channel(s)`
                      }
                    >
                      {soaking && (
                        <LoaderCircle
                          className="mr-1 inline h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      )}
                      {soaking ? 'Queueing soak…' : `Soak all (${totals.channelsServedFirst})`}
                    </button>
                  </>
                )}
              </div>
            </div>
            {probeResultNote && (
              <p
                className={`mt-2 text-sm ${
                  probeResultNote.bad ? 'text-[var(--color-bad)]' : 'text-[var(--color-accent)]'
                }`}
              >
                {probeResultNote.text}
              </p>
            )}
            {soakNote && <p className="mt-2 text-sm text-[var(--color-accent)]">{soakNote}</p>}
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
                  {/* Not flex-none: the row wraps this onto its own line on a
                      phone, and at its unshrinkable max-content width -- every
                      chip side by side -- it pushed the page 240px sideways. */}
                  <span className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1">
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
