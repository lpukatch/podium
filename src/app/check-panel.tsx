'use client';

import { useCallback, useEffect, useState } from 'react';

interface Row {
  id: number;
  name: string;
  provider: string;
  alive: boolean | null;
  usable: boolean;
  /** Plays at all. True while `usable` is false means below the resolution floor. */
  healthy?: boolean;
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
  truncated?: boolean;
  totalHits?: number;
  probeLimit?: number;
  minBitrateKbps: number;
  /** The channel's resolution floor, from its rule or its group; null for none. */
  minResolution?: string | null;
  /** The channel taken as a whole -- see `channelStability`. */
  channelStability?: {
    total: number;
    measured: number;
    unstable: number;
    allBad: boolean;
  };
  rows: Row[];
  unclaimed: Row[];
  unprobed?: Row[];
}

const card = 'rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]';
const btn =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-[15px] hover:border-[var(--color-accent)] disabled:opacity-50';
const pill = 'inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap';

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

/**
 * Probe this channel now and compare the resulting order with what Dispatcharr
 * already has -- the A/B view against whatever produced the current order.
 */
export function CheckPanel({ channelId, onApplied }: { channelId: number; onApplied: () => void }) {
  const [result, setResult] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  // Dropping unclaimed streams is destructive, so it is opt-in per apply.
  const [dropUnclaimed, setDropUnclaimed] = useState(false);
  // Per stream, because a soak is per stream and several can be asked for in
  // turn. Keyed by id rather than held on the row so a re-check does not wipe
  // what the operator just queued.
  const [soaks, setSoaks] = useState<Record<number, SoakState>>({});

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
      const url = force ? `/api/check/${channelId}?force=true` : `/api/check/${channelId}`;
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
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="flex-1 text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Check now
        </h3>
        <button type="button" className={btn} disabled={busy} onClick={() => void check()}>
          {busy ? 'Probing…' : 'Probe this channel'}
        </button>
      </div>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        Probes this channel's streams immediately and shows the order they imply, next to the order
        Dispatcharr has now. Nothing is written until you apply.
      </p>

      {error && <p className="mt-3 text-sm text-[var(--color-bad)]">{error}</p>}
      {note && <p className="mt-3 text-sm text-[var(--color-accent)]">{note}</p>}

      {result && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm tabular-nums">
            {result.heldBack && (
              <span className={`${pill} bg-[var(--color-warn)] text-white`}>
                Group policy: {result.heldBack}
              </span>
            )}
            <span className={`${pill} bg-[var(--color-accent-soft)] text-[var(--color-accent)]`}>
              {result.probed} probed
            </span>
            {result.dead > 0 && (
              <span className={`${pill} bg-[var(--color-bad)] text-white`}>{result.dead} dead</span>
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
                worker was probing, so this ran at one stream per provider
              </span>
            )}
            {result.allowed === false && (
              <button
                type="button"
                className={`${btn} text-xs py-1 px-2`}
                disabled={busy}
                onClick={() => void check(true)}
              >
                Probe anyway (override policy)
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
                        {row.alive && !row.usable && row.healthy && (
                          <span className="ml-1 text-[var(--color-warn)]">
                            {row.height <= 0 && row.width <= 0
                              ? `(no picture measured — cannot clear the ${result.minResolution} floor, so it ranks after every stream that does and is never auto-assigned)`
                              : `(below the ${result.minResolution} floor — ranked after every stream that meets it, and never auto-assigned)`}
                          </span>
                        )}
                        {row.alive && row.usable && !row.black && row.bitrateKbps <= 0 && (
                          <span className="ml-1 text-[var(--color-warn)]">
                            (not measured — ranked below every stream with a reading, and due for
                            another probe)
                          </span>
                        )}
                        {row.unstable && (
                          <span className="ml-1 text-[var(--color-warn)]">
                            (drops too often — ranked after every stream that holds, and never
                            served first)
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
              probed. The ranking above is partial.
            </p>
          )}

          {(result.unprobed?.length ?? 0) > 0 && (
            <p className="mt-3 text-sm text-[var(--color-warn)]">
              {result.unprobed?.length} stream(s) this rule claims went unprobed: no spare provider
              capacity, or past the {result.probeLimit} probe cap (
              {(result.unprobed ?? [])
                .map((u) => `${u.name} · ${u.provider}`)
                .join(', ')
                .slice(0, 120)}
              ). They stay on the channel, ranked after the ones that were probed, and cannot be
              unassigned until a check gets a verdict for them.
            </p>
          )}

          {result.unclaimed.length > 0 && (result.unprobed?.length ?? 0) === 0 && (
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={dropUnclaimed}
                onChange={(e) => setDropUnclaimed(e.target.checked)}
                className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
              />
              <span className="text-[var(--color-warn)]">
                Remove the {result.unclaimed.length} stream(s) this rule does not claim (
                {result.unclaimed
                  .map((u) => u.name)
                  .join(', ')
                  .slice(0, 90)}
                ). Left unchecked they stay on the channel, after the ranked ones.
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
