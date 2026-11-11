'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConsensusReport } from '@/lib/consensus';

interface Row {
  id: number;
  name: string;
  provider: string;
  alive: boolean | null;
  usable: boolean;
  /** Plays at all. True while `usable` is false means below the resolution floor. */
  healthy?: boolean;
  /** ...unless this is set, which means over the resolution ceiling instead. */
  overResolution?: boolean;
  black: boolean;
  height: number;
  /** Beside `height` so a row can tell "no picture" from "a small one". */
  width: number;
  /** The rate the ranking used: halved when ffprobe reported a field rate. */
  fps: number;
  /** What ffprobe said, when that differs -- see `interlaced`. */
  reportedFps: number;
  interlaced: boolean;
  bitrateKbps: number;
  videoCodec: string;
  error: string;
  score: number;
  currentRank: number | null;
  proposedRank: number | null;
  /** One line from the passive ledger, already worded. See `describeStability`. */
  stability?: string;
  /** True when the drops-per-hour health check is sinking this stream. */
  unstable?: boolean;
  /** Flagged when audio fingerprint does not match consensus broadcast feeds. */
  outlier?: boolean;
  outlierReason?: string;
  /** True when audio fingerprint matches the consensus broadcast cluster. */
  consensusMatch?: boolean;
}

/**
 * Where this row's stream is in the soak queue.
 *
 * `done` is not "the result is on screen" -- it is "the queue no longer holds
 * it", which is the most this panel can know without re-probing the channel.
 * Saying that plainly, and pointing at the button that would show the result,
 * beats either silence or a claim the panel cannot substantiate.
 */
type SoakPhase = 'queueing' | 'queued' | 'done' | 'error';

export interface SoakState {
  phase: SoakPhase;
  error: string;
}

/**
 * Fold the queue the worker can see into the rows this panel is showing.
 *
 * Pure and exported so the three cases that made the button feel broken can be
 * pinned: a row that was waiting and has now been measured, a row queued by
 * something else entirely, and a row mid-request that the queue has no opinion
 * about yet.
 *
 * Returns the same object when nothing moved, so the caller can skip a render.
 */
export function reconcileSoaks(
  prev: Record<number, SoakState>,
  waiting: Set<number>,
): Record<number, SoakState> {
  const next: Record<number, SoakState> = {};
  let changed = false;
  for (const [key, state] of Object.entries(prev)) {
    const id = Number(key);
    // A row that was waiting and no longer is has been measured. Anything
    // mid-request or errored is this panel's own business, not the queue's,
    // and is left alone -- a `queueing` row has not reached the table yet, so
    // its absence from the queue means nothing.
    const phase: SoakPhase = state.phase === 'queued' && !waiting.has(id) ? 'done' : state.phase;
    if (phase !== state.phase) changed = true;
    next[id] = { ...state, phase };
  }
  // Rows queued by something else -- the channel button, a group, another tab
  // -- so the panel reports the queue rather than only its own clicks.
  for (const id of waiting) {
    if (next[id] === undefined) {
      next[id] = { phase: 'queued', error: '' };
      changed = true;
    }
  }
  return changed ? next : prev;
}

interface CheckResult {
  channelName: string;
  probed: number;
  dead: number;
  workerBusy: boolean;
  allowed?: boolean;
  heldBack?: string | null;
  identical: boolean;
  current: number[];
  proposed: number[];
  kept: number[];
  dropOrder: number[];
  workerOrder?: number[];
  /** Streams the check's per-provider prune left out; an apply skips these
   * when restoring its tail, so applying does not put them straight back. */
  pruned?: number[];
  truncated?: boolean;
  totalHits?: number;
  probeLimit?: number;
  minBitrateKbps: number;
  /** The channel's resolution floor, from its rule or its group; null for none. */
  minResolution?: string | null;
  /** The channel's resolution ceiling, resolved the same way. */
  maxResolution?: string | null;
  /** The channel taken as a whole -- see `channelStability`. */
  channelStability?: {
    total: number;
    measured: number;
    unstable: number;
    allBad: boolean;
  };
  consensus?: ConsensusReport;
  rows: Row[];
  unclaimed: Row[];
  unprobed?: Row[];
}

const card = 'rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]';
const btn =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-[15px] hover:border-[var(--color-accent)] disabled:opacity-50';
const pill = 'inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap';

/** A queued instant, coarse enough to read at a glance: "45s ago", "3m ago". */
function ago(ms: number): string {
  const s = Math.max(Math.round((Date.now() - ms) / 1000), 0);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Whether a re-check covers this channel, as far as GET /api/refresh says. */
export interface RecheckState {
  /** When this channel was queued on its own, if it is. */
  queuedAt: number | null;
  /** When the whole catalogue was queued, which includes this channel. */
  allAt: number | null;
}

/**
 * Read this channel's line out of GET /api/refresh.
 *
 * Pure and exported so an older server -- one that answers without a
 * `channels` key -- can be pinned to read as "nothing queued" rather than as an
 * error. Group marks are not consulted: the panel does not know the channel's
 * group, and the group's own page already says when it is queued.
 */
export function recheckStateFor(
  body: { all?: number | null; channels?: Record<string, number> },
  channelId: number,
): RecheckState {
  return { queuedAt: body.channels?.[String(channelId)] ?? null, allAt: body.all ?? null };
}

/** The three orders an apply may send, and which one the tick asks for. */
type OrderChoice = Pick<CheckResult, 'dropOrder' | 'kept' | 'workerOrder'>;

/**
 * Which of the check's orders to send to `/api/apply`.
 *
 * `workerOrder` is what the worker itself would write, so it is the right
 * default -- but the check derives it from the *global* remove-unmatched
 * setting, which is off on a default install. There it equals `kept`: the
 * ranked streams with the unclaimed ones appended. Sending that alongside
 * `removeUnmatched: true` removes nothing, because the server drops only what
 * the order it was handed leaves out, and that one leaves out nothing.
 *
 * So the tick has to be consulted before `workerOrder`, not after it. Written
 * as `workerOrder ?? (drop ? dropOrder : kept)` the tick is unreachable, since
 * `workerOrder` is always present.
 *
 * The drop sends `dropOrder` and never `proposed`. `proposed` is the raw
 * ranking the table is drawn from -- every claimed stream, dead ones included
 * -- and the apply is told not to re-compose what it is handed, so sending it
 * would put the whole list on the channel. `dropOrder` is the same list already
 * composed against the cap, the block list and what is fit to watch.
 */
export function orderToApply(result: OrderChoice, dropUnclaimed: boolean): number[] {
  if (dropUnclaimed) return result.dropOrder;
  return result.workerOrder ?? result.kept;
}

/**
 * Whether an apply would change anything.
 *
 * `identical` compares `workerOrder` with what the channel carries, so on a
 * default install it ignores the unclaimed streams entirely -- a channel whose
 * only outstanding change is the drop reports "nothing to change", which hides
 * the apply button and leaves the tick with no way to take effect.
 */
export function pendingChange(
  result: { identical: boolean; unclaimed: { length: number } },
  dropUnclaimed: boolean,
): { dropPending: boolean; nothingToChange: boolean } {
  const dropPending = dropUnclaimed && result.unclaimed.length > 0;
  return { dropPending, nothingToChange: result.identical && !dropPending };
}

export interface PairwisePair {
  a: number;
  b: number;
  similarity: number;
  /** Canonical "low:high" key, stable for React lists. */
  key: string;
}

/**
 * The report's pairwise map is mirrored (`a:b` and `b:a`) and unordered; the
 * panel wants each pair once, strongest first.
 *
 * The threshold the scores are judged against lives in
 * `lib/consensus.ts` (`MATCH_THRESHOLD`); it is restated here rather than
 * imported because that module also pulls in ffmpeg's child_process, which
 * must not reach the browser bundle.
 */
export function pairwisePairs(pairwise: Record<string, number>): PairwisePair[] {
  const pairs: PairwisePair[] = [];
  const seen = new Set<string>();
  for (const [rawKey, similarity] of Object.entries(pairwise)) {
    const ids = rawKey.split(':').map(Number);
    if (ids.length !== 2 || ids.some((n) => !Number.isInteger(n))) continue;
    const a = Math.min(ids[0]!, ids[1]!);
    const b = Math.max(ids[0]!, ids[1]!);
    const key = `${a}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ a, b, similarity, key });
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

/** A stream's display name from the probed rows, or `Stream #id` when unknown. */
function streamLabel(rows: Row[] | undefined, id: number): string {
  return rows?.find((row) => row.id === id)?.name || `Stream #${id}`;
}

/**
 * Check this channel now and compare the resulting order with what Dispatcharr
 * already has -- the A/B view against whatever produced the current order.
 */
export function CheckPanel({
  channelId,
  onApplied,
  onSoakChannel,
  soakNote,
}: {
  channelId: number;
  onApplied: () => void;
  onSoakChannel?: () => void;
  soakNote?: string | null;
}) {
  const [result, setResult] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  // Dropping unclaimed streams is destructive, so it is opt-in per apply.
  const [dropUnclaimed, setDropUnclaimed] = useState(false);
  const [checkConsensus, setCheckConsensus] = useState(false);
  // Per stream, because a soak is per stream and several can be asked for in
  // turn. Keyed by id rather than held on the row so a re-check does not wipe
  // what the operator just queued.
  const [soaks, setSoaks] = useState<Record<number, SoakState>>({});
  // Tagged with the channel it describes. The panel stays mounted when the page
  // moves from one channel straight to another, and an untagged line would show
  // the last channel's queue -- and its Cancel -- until the next read landed.
  const [recheck, setRecheck] = useState<RecheckState & { channelId: number }>({
    channelId,
    queuedAt: null,
    allAt: null,
  });
  const [recheckBusy, setRecheckBusy] = useState(false);
  const [recheckError, setRecheckError] = useState<{ channelId: number; text: string } | null>(
    null,
  );
  // The channel on screen now, for a response to check itself against before
  // it is allowed to land.
  const shownChannel = useRef(channelId);
  useEffect(() => {
    shownChannel.current = channelId;
  }, [channelId]);

  const check = async (force = false) => {
    setBusy(true);
    setError('');
    setNote('');
    setResult(null);
    // Per check, not per panel: the box is hidden when the new result has
    // unprobed streams, and a tick left over from the previous channel would
    // otherwise still be sent with the apply.
    setDropUnclaimed(false);
    try {
      const query = new URLSearchParams();
      if (force) query.set('force', 'true');
      if (checkConsensus) query.set('consensus', 'true');
      const qs = query.toString() ? `?${query.toString()}` : '';
      const url = `/api/check/${channelId}${qs}`;
      const resp = await fetch(url, { method: 'POST' });
      const body = await resp.json();
      if (!resp.ok || body.error) {
        setError(body.error ?? `HTTP ${resp.status}`);
        return;
      }
      setResult(body as CheckResult);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!result) return;
    setApplying(true);
    setError('');
    try {
      const targetOrder = orderToApply(result, dropUnclaimed);
      const resp = await fetch(`/api/apply/${channelId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order: targetOrder,
          removeUnmatched: dropUnclaimed,
          force: result.allowed === false,
          allowAssign: true,
          pruned: result.pruned ?? [],
        }),
      });
      const body = await resp.json();
      if (!resp.ok || body.error) {
        setError(body.error ?? `HTTP ${resp.status}`);
        return;
      }
      setNote(`Applied. Previous order was ${body.previous.join(', ')}`);
      onApplied();
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  };

  /**
   * Ask for one stream to be soaked.
   *
   * Queues rather than measures. A soak holds a provider connection for
   * minutes, which is both too long for an HTTP request to survive most
   * ingresses and exactly the sort of work that has to go through the pass --
   * where the provider limits and the pause-while-watching rule apply. The
   * result appears on this line the next time the channel is checked.
   */
  const soak = async (streamId: number) => {
    setSoaks((prev) => ({ ...prev, [streamId]: { phase: 'queueing', error: '' } }));
    try {
      const resp = await fetch('/api/soak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'stream', id: streamId }),
      });
      const body = (await resp.json()) as { error?: string };
      const failed = !resp.ok || Boolean(body.error);
      setSoaks((prev) => ({
        ...prev,
        [streamId]: {
          phase: failed ? 'error' : 'queued',
          error: failed ? (body.error ?? `HTTP ${resp.status}`) : '',
        },
      }));
    } catch (e) {
      setSoaks((prev) => ({ ...prev, [streamId]: { phase: 'error', error: String(e) } }));
    }
  };

  /**
   * Reconcile the rows against the queue the worker can actually see.
   *
   * Two things this fixes, both of which made the button feel broken. React
   * state alone is lost on a refresh, so a stream genuinely waiting showed a
   * Soak button as though nothing had been asked -- and pressing it again read
   * as a no-op. And a soak that had *finished* left the row saying "queued"
   * forever, because nothing here was watching for it to leave.
   */
  const syncQueue = useCallback(async () => {
    try {
      const resp = await fetch('/api/soak');
      const body = (await resp.json()) as { streamIds?: number[]; error?: string };
      if (!resp.ok || body.error) return;
      setSoaks((prev) => reconcileSoaks(prev, new Set(body.streamIds ?? [])));
    } catch {
      // A queue that cannot be read leaves the rows as they are; it is a
      // progress hint, not a verdict.
    }
  }, []);

  // On mount, and while anything is waiting. Ten seconds is well inside the
  // minutes a soak takes, and the poll stops entirely once the queue is clear
  // of this panel's rows.
  const waitingHere = Object.values(soaks).some((state) => state.phase === 'queued');
  useEffect(() => {
    void syncQueue();
    if (!waitingHere) return;
    const timer = setInterval(() => void syncQueue(), 10_000);
    return () => clearInterval(timer);
  }, [syncQueue, waitingHere]);

  /** What is queued for this channel now, from the marks themselves. */
  const syncRecheck = useCallback(async () => {
    try {
      const resp = await fetch('/api/refresh');
      const body = await resp.json();
      if (!resp.ok || body.error || shownChannel.current !== channelId) return;
      setRecheck({ channelId, ...recheckStateFor(body, channelId) });
    } catch {
      // As with the soak queue: a progress hint, not a verdict.
    }
  }, [channelId]);

  // On mount, and while this channel is queued, so the line clears once the
  // worker has re-probed it and retired the mark. A re-check runs through the
  // ordinary pass, so ten seconds is well inside how long it takes.
  const queuedAt = recheck.channelId === channelId ? recheck.queuedAt : null;
  const allAt = recheck.channelId === channelId ? recheck.allAt : null;
  const recheckQueued = queuedAt !== null;
  useEffect(() => {
    void syncRecheck();
    if (!recheckQueued) return;
    const timer = setInterval(() => void syncRecheck(), 10_000);
    return () => clearInterval(timer);
  }, [syncRecheck, recheckQueued]);

  /**
   * Queue this channel for a re-check, or call one off.
   *
   * Unlike "Check this channel", this does not probe: it stamps an instant, and
   * the next pass treats every verdict older than it as expired -- at the
   * provider limits, and paused while anyone is watching.
   */
  const changeRecheck = async (queue: boolean) => {
    setRecheckBusy(true);
    setRecheckError(null);
    try {
      const resp = queue
        ? await fetch('/api/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope: 'channel', channelId }),
          })
        : await fetch(`/api/refresh?scope=channel&channelId=${channelId}`, { method: 'DELETE' });
      const body = (await resp.json()) as { error?: string };
      if (!resp.ok || body.error) {
        setRecheckError({ channelId, text: body.error ?? `HTTP ${resp.status}` });
      }
      await syncRecheck();
    } catch (e) {
      setRecheckError({ channelId, text: String(e) });
    } finally {
      setRecheckBusy(false);
    }
  };

  const { dropPending, nothingToChange } = result
    ? pendingChange(result, dropUnclaimed)
    : { dropPending: false, nothingToChange: false };

  const movement = (row: Row): string => {
    if (row.currentRank === null) return 'new';
    if (row.proposedRank === null) return 'dropped';
    const delta = row.currentRank - row.proposedRank;
    if (delta === 0) return '=';
    return delta > 0 ? `▲${delta}` : `▼${-delta}`;
  };

  return (
    <div className={`${card} mt-4 p-5`}>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        Check now
      </h3>
      <div className="mt-2 divide-y divide-[var(--color-line)]">
        <div className="grid gap-2 py-3 sm:grid-cols-[15rem_minmax(0,1fr)] sm:items-center sm:gap-4">
          <button
            type="button"
            className={`${btn} w-full`}
            disabled={busy}
            onClick={() => void check()}
          >
            {busy ? 'Checking…' : 'Check this channel'}
          </button>
          <div>
            <p className="text-sm text-[var(--color-muted)]">
              Checks this channel's streams immediately and shows the order they imply, next to the
              order Dispatcharr has now. Nothing is written until you apply.
            </p>
            <label className="mt-2 flex items-center gap-2 text-xs text-[var(--color-muted)] cursor-pointer">
              <input
                type="checkbox"
                checked={checkConsensus}
                onChange={(e) => setCheckConsensus(e.target.checked)}
              />
              <span>Compare audio across feeds</span>
            </label>
          </div>
        </div>
        {onSoakChannel && (
          <div className="grid gap-2 py-3 sm:grid-cols-[15rem_minmax(0,1fr)] sm:items-center sm:gap-4">
            <button type="button" className={`${btn} w-full`} onClick={onSoakChannel}>
              Soak every stream
            </button>
            <div>
              <p className="text-sm text-[var(--color-muted)]">
                Checks how long each stream on this channel holds, rather than how it looks in five
                seconds.
              </p>
              {soakNote && <p className="mt-1 text-sm text-[var(--color-accent)]">{soakNote}</p>}
            </div>
          </div>
        )}
        <div className="grid gap-2 py-3 sm:grid-cols-[15rem_minmax(0,1fr)] sm:items-center sm:gap-4">
          <button
            type="button"
            className={`${btn} w-full`}
            disabled={recheckBusy}
            onClick={() => void changeRecheck(!recheckQueued)}
          >
            {recheckQueued ? 'Cancel re-check' : 'Re-check this channel'}
          </button>
          <div>
            <p className="text-sm text-[var(--color-muted)]">
              {queuedAt !== null
                ? `Queued for a re-check ${ago(queuedAt)}. The worker works through it at the provider limits, and pauses while anyone is watching.`
                : 'Queues every stream here for the worker, however recently it was checked. Cancelling puts the current verdicts back in service.'}
            </p>
            {allAt !== null && !recheckQueued && (
              <p className="mt-1 text-sm text-[var(--color-accent)]">
                Everything is queued for a re-check — this channel included.
              </p>
            )}
            {recheckError?.channelId === channelId && (
              <p className="mt-1 text-sm text-[var(--color-bad)]">{recheckError.text}</p>
            )}
          </div>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-[var(--color-bad)]">{error}</p>}
      {note && <p className="mt-3 text-sm text-[var(--color-accent)]">{note}</p>}

      {result && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm tabular-nums">
            {result.heldBack && (
              <span className={`${pill} bg-[var(--color-warn)] text-[var(--color-on-warn)]`}>
                Group policy: {result.heldBack}
              </span>
            )}
            <span className={`${pill} bg-[var(--color-accent-soft)] text-[var(--color-accent)]`}>
              {result.probed} checked
            </span>
            {result.dead > 0 && (
              <span className={`${pill} bg-[var(--color-bad)] text-[var(--color-on-bad)]`}>
                {result.dead} dead
              </span>
            )}
            {result.consensus && (
              <span
                className={`${pill} ${
                  result.consensus.outliers.length > 0
                    ? 'bg-[var(--color-bad)] text-[var(--color-on-bad)]'
                    : result.consensus.status === 'partial'
                      ? 'bg-[var(--color-warn)] text-[var(--color-on-warn)]'
                      : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                }`}
              >
                {result.consensus.outliers.length > 0
                  ? `${result.consensus.outliers.length} audio outlier(s)`
                  : result.consensus.status === 'confirmed'
                    ? 'audio consensus confirmed'
                    : result.consensus.status === 'partial'
                      ? `${result.consensus.consensusCluster.length} of ${result.consensus.analyzedCount} feeds share audio`
                      : 'audio comparison inconclusive'}
              </span>
            )}
            {nothingToChange ? (
              <span className="text-[var(--color-muted)]">
                Order already matches — nothing to change.
              </span>
            ) : (
              <span className="text-[var(--color-warn)]">
                {result.identical
                  ? `Order already matches — applying will remove ${result.unclaimed.length} stream(s).`
                  : 'Order differs from Dispatcharr.'}
              </span>
            )}
            {result.workerBusy && (
              <span className="text-[var(--color-muted)]">
                worker was checking, so this ran at one stream per provider
              </span>
            )}
            {result.allowed === false && (
              <button
                type="button"
                className={`${btn} text-xs py-1 px-2`}
                disabled={busy}
                onClick={() => void check(true)}
              >
                Check anyway (override policy)
              </button>
            )}
          </div>

          {result.channelStability && result.channelStability.unstable > 0 && (
            <p
              className={`mt-3 text-sm ${
                result.channelStability.allBad
                  ? 'text-[var(--color-bad)]'
                  : 'text-[var(--color-warn)]'
              }`}
            >
              {result.channelStability.allBad
                ? `Every stream on this channel has been measured and every one of them drops ` +
                  `(${result.channelStability.unstable} of ${result.channelStability.total}). ` +
                  `Reordering cannot fix this — the channel needs another source.`
                : `${result.channelStability.unstable} of the ` +
                  `${result.channelStability.measured} stream(s) measured here drop often ` +
                  `(${result.channelStability.total} on the channel). ` +
                  `Soak the rest to find out whether any of them holds.`}
            </p>
          )}

          {result.consensus && result.consensus.outliers.length > 0 && (
            <div className="mt-3 rounded-lg border border-[var(--color-bad)] bg-[var(--color-panel)] p-3 text-sm">
              <div className="font-semibold text-[var(--color-bad)]">Divergent audio detected</div>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                One or more sampled feeds differ from the majority. Broadcast delays or local ad
                breaks can also cause differences.
              </p>
              <ul className="mt-2 list-disc list-inside text-xs space-y-1">
                {result.consensus.outliers.map((o) => (
                  <li key={o.streamId}>
                    <span className="font-mono">{o.name || `Stream #${o.streamId}`}</span>:
                    similarity score {o.similarityToCluster.toFixed(2)} vs consensus ({o.reason})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.consensus?.status === 'partial' && (
            <div className="mt-3 rounded-lg border border-[var(--color-warn)] bg-[var(--color-panel)] p-3 text-sm">
              <div className="font-semibold text-[var(--color-warn)]">
                Feeds agree without a majority
              </div>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                {result.consensus.consensusCluster.length} of {result.consensus.analyzedCount}{' '}
                sampled feeds carry matching audio. Only those feeds are verified -- the rest are
                not proven to carry the broadcast. Regional playouts, local ad breaks, and delays
                beyond two seconds can all split a channel like this.
              </p>
              <ul className="mt-2 list-disc list-inside text-xs space-y-1">
                {result.consensus.consensusCluster.map((sid) => (
                  <li key={sid}>
                    <span className="font-mono">{streamLabel(result.rows, sid)}</span>: audio
                    matches across the cluster
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.consensus &&
            (result.consensus.status === 'partial' || result.consensus.status === 'inconclusive') &&
            pairwisePairs(result.consensus.pairwise).length > 0 && (
              <div className="mt-3 text-xs">
                <div className="text-[var(--color-muted)]">
                  Audio similarity between sampled feeds -- a match needs &ge; 0.65:
                </div>
                <ul className="mt-1 space-y-0.5">
                  {pairwisePairs(result.consensus.pairwise).map((p) => (
                    <li key={p.key} className="flex items-baseline gap-2">
                      <span className={p.similarity >= 0.65 ? '' : 'text-[var(--color-muted)]'}>
                        {streamLabel(result.rows, p.a)} &harr; {streamLabel(result.rows, p.b)}
                      </span>
                      <span className="ml-auto shrink-0 font-mono tabular-nums">
                        {p.similarity.toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

          {result.consensus && result.consensus.failures.length > 0 && (
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              Audio could not be compared for {result.consensus.failures.length} feed(s). Agreement
              between the remaining feeds does not verify those feeds.
            </p>
          )}

          {result.rows.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-xs uppercase tracking-wide text-[var(--color-muted)]">
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 pr-3">Move</th>
                    <th className="py-2 pr-3">Stream</th>
                    <th className="py-2 pr-3">Provider</th>
                    <th className="py-2 pr-3">Result</th>
                    <th className="py-2">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={row.id} className="border-b border-[var(--color-line)] last:border-0">
                      <td className="py-2 pr-3 tabular-nums">{row.proposedRank}</td>
                      <td
                        className={`py-2 pr-3 tabular-nums ${
                          movement(row).startsWith('▲')
                            ? 'text-[var(--color-accent)]'
                            : movement(row).startsWith('▼')
                              ? 'text-[var(--color-warn)]'
                              : 'text-[var(--color-muted)]'
                        }`}
                      >
                        {movement(row)}
                      </td>
                      <td className="mono max-w-[22rem] truncate py-2 pr-3">{row.name}</td>
                      <td className="py-2 pr-3 text-[var(--color-muted)]">{row.provider}</td>
                      <td className="py-2 pr-3">
                        {row.alive ? (
                          <span className="text-[var(--color-muted)]">
                            {row.height
                              ? `${row.height}${row.interlaced ? 'i' : 'p'} · ${row.fps || '?'}fps${
                                  // Named rather than silently halved: a row
                                  // reading 25fps where every other tool says
                                  // 50 is the surprise this panel exists to
                                  // explain, not one it should create.
                                  row.interlaced && row.reportedFps > row.fps
                                    ? ` (${row.reportedFps}i)`
                                    : ''
                                } · ${
                                  row.bitrateKbps > 0
                                    ? `${Math.round(row.bitrateKbps)}kbps`
                                    : 'bitrate unknown'
                                } · ${row.videoCodec}`
                              : `Audio only · ${
                                  row.bitrateKbps > 0
                                    ? `${Math.round(row.bitrateKbps)}kbps`
                                    : 'bitrate unknown'
                                }`}
                          </span>
                        ) : (
                          <span className="text-[var(--color-bad)]">{row.error || 'dead'}</span>
                        )}
                        {row.alive && row.black && (
                          <span className="ml-1 text-[var(--color-bad)]">(black screen)</span>
                        )}
                        {row.alive && !row.usable && !row.black && !row.healthy && (
                          <span className="ml-1 text-[var(--color-bad)]">
                            (under {result.minBitrateKbps}kbps — treated as dead)
                          </span>
                        )}
                        {row.alive && !row.usable && row.healthy && !row.overResolution && (
                          <span className="ml-1 text-[var(--color-warn)]">
                            {row.height <= 0 && row.width <= 0
                              ? `(no picture measured — cannot clear the ${result.minResolution} floor, so it ranks after every stream that does and is never auto-assigned)`
                              : `(below the ${result.minResolution} floor — ranked after every stream that meets it, and never auto-assigned)`}
                          </span>
                        )}
                        {row.alive && !row.usable && row.healthy && row.overResolution && (
                          <span className="ml-1 text-[var(--color-warn)]">
                            (over the {result.maxResolution} cap — ranked after every stream under
                            it, and never auto-assigned)
                          </span>
                        )}
                        {row.alive && row.usable && !row.black && row.bitrateKbps <= 0 && (
                          <span className="ml-1 text-[var(--color-warn)]">
                            (not measured — ranked below every stream with a reading, and due for
                            another check)
                          </span>
                        )}
                        {row.unstable && (
                          <span className="ml-1 text-[var(--color-warn)]">
                            (drops too often — ranked after every stream that holds, and never
                            served first)
                          </span>
                        )}
                        {row.outlier && (
                          <span
                            title={row.outlierReason}
                            className="ml-1 rounded bg-[var(--color-bad)] px-1.5 py-0.5 text-xs text-[var(--color-on-bad)] font-medium"
                          >
                            audio outlier (mismatched broadcast)
                          </span>
                        )}
                        {row.consensusMatch && (
                          <span className="ml-1 rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-xs text-[var(--color-accent)] font-medium">
                            consensus match
                          </span>
                        )}
                        <StabilityCell
                          row={row}
                          soak={soaks[row.id]}
                          onSoak={() => void soak(row.id)}
                        />
                      </td>
                      <td className="py-2 tabular-nums">{row.score.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result.truncated && (
            <p className="mt-3 text-sm text-[var(--color-warn)]">
              This rule claims {result.totalHits} streams; only the first {result.probeLimit} were
              checked. The ranking above is partial.
            </p>
          )}

          {(result.unprobed?.length ?? 0) > 0 && (
            <p className="mt-3 text-sm text-[var(--color-warn)]">
              {result.unprobed?.length} stream(s) this rule claims went unchecked: no spare provider
              capacity, or past the {result.probeLimit} check cap (
              {(result.unprobed ?? [])
                .map((u) => `${u.name} · ${u.provider}`)
                .join(', ')
                .slice(0, 120)}
              ). They stay on the channel, ranked after the ones that were checked, and cannot be
              unassigned until a check gets a verdict for them.
            </p>
          )}

          {result.unclaimed.length > 0 && (result.unprobed?.length ?? 0) === 0 && (
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={dropUnclaimed}
                onChange={(e) => setDropUnclaimed(e.target.checked)}
                className="contrast-checkbox mt-1 h-4 w-4 shrink-0"
              />
              <span className="text-[var(--color-warn)]">
                Remove the {result.unclaimed.length} stream(s) this rule does not claim (
                {result.unclaimed
                  .map((u) => u.name)
                  .join(', ')
                  .slice(0, 90)}
                ). Left unchecked they stay on the channel, after the ranked ones. A hand check
                skips the wait before removing an unmatched stream (Settings), so this drops them
                immediately rather than starting its clock.
              </span>
            </label>
          )}

          {!nothingToChange && (
            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                className={`${btn} border-[var(--color-warn)]`}
                disabled={applying}
                onClick={() => void apply()}
              >
                {applying ? 'Applying…' : dropPending ? 'Apply and remove' : 'Apply this order'}
              </button>
              <span className="text-sm text-[var(--color-muted)]">
                Overwrites the channel's stream order. There is no undo.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * What the ledger knows about one stream, and the button that finds out more.
 *
 * Both halves of the stability feature meet on this line. The sentence is the
 * passive record -- how long the stream has held for real viewers, which for
 * most streams is "never observed playing", because most streams sit behind
 * slot 0 and nobody has ever been served them. The button is the way out of
 * that: it queues the stream to be held open for a few minutes, and the worker
 * measures it on a pass where there is capacity to spare.
 *
 * Queued rather than measured on the spot, which is why the button says so
 * rather than spinning. A soak takes minutes, and doing it inside this request
 * would be both a second scheduler and an HTTP request most ingresses would cut
 * off before it answered.
 */
function StabilityCell({
  row,
  soak,
  onSoak,
}: {
  row: Row;
  soak: SoakState | undefined;
  onSoak: () => void;
}) {
  // Only for streams that play. Soaking a dead stream re-learns what the probe
  // in the same row already said, at a cost of minutes and a connection.
  const canSoak = row.alive === true;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
      <span>{row.stability ?? 'never observed playing'}</span>
      {canSoak && soak?.phase !== 'queued' && (
        <button
          type="button"
          className="rounded border border-[var(--color-line)] px-1.5 py-0.5 hover:border-[var(--color-accent)] disabled:opacity-50"
          disabled={soak?.phase === 'queueing'}
          onClick={onSoak}
          title="Queue this stream to be held open for a few minutes and measured"
        >
          {soak?.phase === 'queueing'
            ? 'Queueing…'
            : soak?.phase === 'done'
              ? 'Soak again'
              : 'Soak'}
        </button>
      )}
      {soak?.phase === 'queued' && (
        <span className="text-[var(--color-accent)]">
          queued — the worker soaks it when there is spare capacity
        </span>
      )}
      {soak?.phase === 'done' && (
        <span className="text-[var(--color-accent)]">
          soaked — re-check the channel to see what it found
        </span>
      )}
      {soak?.phase === 'error' && <span className="text-[var(--color-bad)]">{soak.error}</span>}
    </div>
  );
}
