'use client';

import { useCallback, useEffect, useState } from 'react';

interface Lane {
  id: number;
  name: string;
  limit: number;
  /** Every probe that returned a verdict, alive or dead. */
  done: number;
  /**
   * The subset of `done` that came back dead. Absent on a row from an older
   * worker. Surfaced separately because a dead stream is information, not a
   * failure -- but it is *already counted* in `done`.
   */
  dead?: number;
  /** Probes that threw. Disjoint from `done`, which never reached its counter. */
  failed: number;
  queued: number;
  current: string[];
}

/**
 * How many of a lane's queued probes have settled.
 *
 * `dead` is a breakdown of `done`, not a sibling of it, so adding the two
 * counts every dead stream twice -- a lane that probed 44 streams and found 20
 * dead reported "64/44". Only `failed` is genuinely separate: it is incremented
 * on the throw path, before `done` is ever reached.
 */
export function laneCompleted(lane: Pick<Lane, 'done' | 'failed'> & { dead?: number }): number {
  return lane.done + (lane.failed ?? 0);
}

interface Progress {
  runId: string | null;
  phase: 'idle' | 'fetching' | 'planning' | 'probing' | 'paused' | 'done' | 'failed';
  startedAt: number | null;
  probed: number;
  total: number;
  dead: number;
  reordered: number;
  /** Optional: a progress row written by an older worker will not have it. */
  unchanged?: number;
  cached: number;
  deferred: number;
  /**
   * Streams actually waiting for a probe, and when the next one falls due.
   *
   * These come from the worker, which is the only side that knows which
   * expiring verdicts belong to a channel it would probe. Optional: a progress
   * row written by an older worker will not have them, so the cache-wide
   * figures stand in until the first pass of the new one.
   */
  backlog?: number;
  /**
   * Verdicts an outstanding re-check retired and nothing has replaced yet.
   * Unlike `backlog` this includes channels the EPG gate is holding back,
   * whose verdicts are retired but cannot be probed until something airs --
   * the difference between "0 still to go" and a request that is not finished.
   */
  retired?: number;
  dueAt?: number | null;
  heldBack: Record<string, number>;
  lanes: Lane[];
  message: string;
  nextRunAt: number | null;
  tickMs: number;
  maxAgeMs: number;
  /** Worker-sourced oldest managed probe; falls back to the cache-wide value. */
  oldestManagedProbedAt?: number | null;
  updatedAt: number;
}

/** Worker liveness as /api/progress reports it, from the lock heartbeat. */
type WorkerState = 'active' | 'stale' | 'absent' | 'disabled';

interface RunRow {
  run_id: string;
  started_at: number;
  finished_at: number | null;
  channels: number;
  probed: number;
  cached: number;
  dead: number;
  reordered: number;
  skipped: number;
  error: string | null;
}

interface Stats {
  cache: {
    total: number;
    alive: number;
    dead: number;
    oldestProbedAt: number | null;
    newestProbedAt: number | null;
    due: number;
    nextDueAt: number | null;
    ages: { hour: number; sixHours: number; day: number; older: number };
  };
  day: {
    passes: number;
    working: number;
    probed: number;
    dead: number;
    reordered: number;
    failed: number;
  };
  activity: Array<{ from: number; probed: number; dead: number }>;
  liveTtlMs: number;
  deadTtlMs: number;
  /** Absent on a response from a worker older than the dead-verdict backoff. */
  deadTtlMaxMs?: number;
  maxAgeMs: number;
}

const card = 'rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]';
const btn =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-[15px] hover:border-[var(--color-accent)] disabled:opacity-50';
const pill = 'inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap';
const heading = 'text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]';

const PHASES: Record<Progress['phase'], { label: string; tone: string }> = {
  idle: { label: 'Idle', tone: 'bg-[var(--color-line)] text-[var(--color-muted)]' },
  fetching: { label: 'Fetching', tone: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' },
  planning: { label: 'Planning', tone: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' },
  probing: { label: 'Probing', tone: 'bg-[var(--color-accent)] text-white' },
  paused: { label: 'Paused', tone: 'bg-[var(--color-warn)] text-white' },
  done: { label: 'Done', tone: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' },
  failed: { label: 'Failed', tone: 'bg-[var(--color-bad)] text-white' },
};

/** Phases where the numbers move second by second and a fast poll earns itself. */
const BUSY: Array<Progress['phase']> = ['fetching', 'planning', 'probing'];

function ago(ms: number): string {
  const s = Math.max(Math.round((Date.now() - ms) / 1000), 0);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/**
 * Wall-clock time of day. A run is identified by when it happened, not by a
 * generated id -- "run-1754308800000-a3f9k2" told nobody anything.
 */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A gap, coarse enough to read at a glance: "45s", "2m 30s", "24h". */
function duration(ms: number): string {
  const s = Math.max(Math.round(ms / 1000), 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const rest = s % 60;
    // A round value drops the remainder: "every 1m 0s" is noise.
    return rest ? `${Math.floor(s / 60)}m ${rest}s` : `${Math.floor(s / 60)}m`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s - h * 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

const n = (value: number) => value.toLocaleString();

/**
 * Consecutive passes that changed nothing, folded into one row.
 *
 * On a settled install almost every pass is one of these, and fifteen
 * identical "0 probed · 0 dead" lines say less than one line saying there were
 * fifteen. The passes that did something stay on their own row.
 */
type Entry =
  | { kind: 'run'; run: RunRow }
  | { kind: 'quiet'; count: number; from: number; to: number };

export function collapseRuns(runs: RunRow[]): Entry[] {
  const out: Entry[] = [];
  for (const run of runs) {
    const quiet = !run.error && run.probed === 0 && run.reordered === 0;
    const last = out[out.length - 1];
    if (!quiet) {
      out.push({ kind: 'run', run });
    } else if (last?.kind === 'quiet') {
      last.count += 1;
      // Newest first, so each further row extends the window backwards.
      last.to = run.started_at;
    } else {
      out.push({ kind: 'quiet', count: 1, from: run.started_at, to: run.started_at });
    }
  }
  return out;
}

export function ProgressView() {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [stale, setStale] = useState(false);
  // From the lock heartbeat, not from progress age. See /api/progress.
  const [worker, setWorker] = useState<WorkerState>('active');
  const [heartbeatAge, setHeartbeatAge] = useState<number | null>(null);
  const [error, setError] = useState('');
  // Outstanding re-check requests: when the whole catalogue was queued, and how
  // many groups were queued on their own.
  const [refresh, setRefresh] = useState<{ all: number | null; groups: number }>({
    all: null,
    groups: 0,
  });
  // Re-checking everything is hours of provider work on a large catalogue, so
  // it asks first -- and asks with the real number in front of it.
  const [confirming, setConfirming] = useState(false);
  // Its own second-by-second clock: the countdown to the next pass has to move
  // between polls, or it looks frozen.
  const [now, setNow] = useState(() => Date.now());

  const poll = useCallback(async () => {
    try {
      const resp = await fetch('/api/progress');
      const body = await resp.json();
      if (!resp.ok || body.error) {
        setError(body.detail || body.error || `HTTP ${resp.status}`);
        return;
      }
      setError('');
      setProgress(body.progress as Progress);
      setRuns(body.runs as RunRow[]);
      setStats(body.stats as Stats);
      setStale(Boolean(body.stale));
      // Defaults keep an older server (which sends neither) reading as healthy
      // rather than flashing a worker warning this page cannot substantiate.
      setWorker((body.worker as WorkerState) ?? 'active');
      setHeartbeatAge(
        typeof body.heartbeatAgeSeconds === 'number' ? body.heartbeatAgeSeconds : null,
      );
      setRefresh(
        (body.refresh as { all: number | null; groups: number }) ?? { all: null, groups: 0 },
      );
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const queueAll = async () => {
    await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'all' }),
    });
    setConfirming(false);
    await poll();
  };

  const cancelAll = async () => {
    await fetch('/api/refresh?scope=all', { method: 'DELETE' });
    await poll();
  };

  const busy = progress ? BUSY.includes(progress.phase) : false;

  useEffect(() => {
    void poll();
    // Fast while something is actually happening, slow otherwise: between
    // passes this page is a dashboard, and polling a settled install twice a
    // second is the same waste as running a pass that has nothing to do.
    const timer = setInterval(() => void poll(), busy ? 2000 : 10_000);
    return () => clearInterval(timer);
  }, [poll, busy]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (error) {
    return (
      <div className={`${card} m-5 border-[var(--color-bad)] p-5`}>
        <h3 className="font-semibold text-[var(--color-bad)]">Cannot read progress</h3>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">{error}</p>
      </div>
    );
  }

  const p = progress;
  const phase = PHASES[p?.phase ?? 'idle'];
  const pct = p && p.total > 0 ? Math.min(Math.round((p.probed / p.total) * 100), 100) : 0;
  const cache = stats?.cache;
  const entries = collapseRuns(runs);
  // The worker's numbers when it has published them, the cache-wide ones only
  // as a stand-in. They differ: a verdict on an excluded channel expires and is
  // never refreshed, so the cache would report a backlog nothing will ever work
  // through.
  //
  // Except right after a catalogue-wide re-check is queued: the last pass ran
  // before the request existed, so its backlog is a number about a different
  // question and reads as "0 streams to go" on work that has not started. Until
  // a pass has run since, the cache's own count -- which does account for the
  // mark -- is the honest one.
  const backlogPredatesRequest = refresh.all !== null && (p?.updatedAt ?? 0) < refresh.all;
  const waiting = backlogPredatesRequest ? (cache?.due ?? 0) : (p?.backlog ?? cache?.due ?? 0);
  // What the re-check itself still has outstanding, with the same stand-in
  // structure as `waiting`. Deliberately a separate number: `backlog` counts
  // only what a pass could probe right now, so verdicts on channels the EPG
  // gate holds back -- retired, waiting for something to air -- are invisible
  // to it, and reading "0 streams are still to go" off it is how a request
  // that never finishes looked finished two hours in.
  const stillToGo = backlogPredatesRequest ? (cache?.due ?? 0) : (p?.retired ?? 0);
  const dueAt = p?.dueAt ?? cache?.nextDueAt ?? null;
  // The same orphan problem applies to the oldest probe: the cache-wide MIN
  // counts verdicts on excluded, unmatched, or removed streams the pacer never
  // rechecks, so it drifts past the target whatever the real freshness.
  const oldestAt = p?.oldestManagedProbedAt ?? cache?.oldestProbedAt ?? null;

  return (
    <div className="p-5">
      <div className={`${card} p-5`}>
        <div className="flex flex-wrap items-center gap-3">
          <span className={`${pill} ${phase.tone}`}>{phase.label}</span>
          {p?.startedAt && (
            <span className="text-sm text-[var(--color-muted)]">
              this pass started {clock(p.startedAt)}
            </span>
          )}
          <span className="flex-1" />
          {p && p.updatedAt > 0 && (
            <span className="text-sm text-[var(--color-muted)]">{ago(p.updatedAt)}</span>
          )}
        </div>

        {/* Only ever shown when the lock heartbeat says so -- a worker asleep
            between passes is running, and used to be reported dead here. The
            advice is deliberately not "run npm run worker": in the shipped
            image the worker is in-process with this page, so if you can read
            this, that command is not the thing to run. */}
        {worker === 'stale' && (
          <p className="mt-3 text-sm text-[var(--color-muted)]">
            The worker has not sent a heartbeat
            {heartbeatAge === null ? '' : ` for ${duration(heartbeatAge * 1000)}`} and is no longer
            running passes. Check the container logs; a restart picks the lock back up.
          </p>
        )}
        {worker === 'absent' && (
          <p className="mt-3 text-sm text-[var(--color-muted)]">
            No worker has claimed the lock yet. That is normal for a few seconds after a start; if
            it persists, the worker failed to come up — check the container logs.
          </p>
        )}
        {worker === 'disabled' && (
          <p className="mt-3 text-sm text-[var(--color-muted)]">
            The worker is disabled here (<code className="mono">PODIUM_ENABLE_WORKER=false</code>).
            This page is read-only until something else runs the passes.
          </p>
        )}

        {/* The headline: what state the library is in, not what this pass is
            doing. On a caught-up install every pass is a no-op, and saying so
            plainly beats four counters that all read zero. */}
        {!stale && cache && (
          <p className="mt-3">
            {p?.phase === 'probing' ? (
              <b>
                Probing {n(p.total)} {p.total === 1 ? 'stream' : 'streams'}.
              </b>
            ) : waiting > 0 ? (
              <b>
                {n(waiting)} {waiting === 1 ? 'stream is' : 'streams are'} waiting to be checked —
                the next pass picks {waiting === 1 ? 'it' : 'them'} up.
              </b>
            ) : cache.total === 0 ? (
              <b>Nothing checked yet.</b>
            ) : (
              <b>Everything is checked.</b>
            )}{' '}
            <span className="text-[var(--color-muted)]">
              {dueAt !== null && waiting === 0 && <>Nothing falls due until {clock(dueAt)}. </>}
              {p?.nextRunAt && p.nextRunAt > now ? (
                <>Next pass in {duration(p.nextRunAt - now)}.</>
              ) : p && (p.phase === 'idle' || p.phase === 'done') ? (
                <>Next pass due now.</>
              ) : null}
            </span>
          </p>
        )}

        {p && p.phase === 'probing' && (
          <>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--color-line)]">
              <div
                className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-2 text-sm tabular-nums text-[var(--color-muted)]">
              {n(p.probed)} / {n(p.total)} probed · {pct}%
            </p>
          </>
        )}

        {/* This pass, in one line. It matters while a pass is running and is
            noise the rest of the time, so it no longer gets the big tiles. */}
        {p && !stale && (
          <p className="mt-2 text-sm tabular-nums text-[var(--color-muted)]">
            This pass: {n(p.probed)} probed · {n(p.dead)} dead · {n(p.reordered)} reordered ·{' '}
            {n(p.unchanged ?? 0)} already in order · {n(p.cached)} from cache
          </p>
        )}

        {p?.message && (
          <p className="mono mt-2 truncate text-sm text-[var(--color-muted)]">{p.message}</p>
        )}

        {p && p.deferred > 0 && (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {n(p.deferred)} streams deferred — provider had no spare capacity this pass.
          </p>
        )}

        {p && Object.keys(p.heldBack).length > 0 && (
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Held back:{' '}
            {Object.entries(p.heldBack)
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .map(([why, count]) => `${n(count)} ${why}`)
              .join(', ')}
          </p>
        )}

        {/* Re-check everything.

            The freshness target is a floor, not a schedule: "nothing older than
            24 hours" is satisfied by a library measured at four this morning,
            which is not the same as being ready for something on tonight. This
            retires every verdict as of now and lets the ordinary pass work
            through them, so nothing here bypasses the provider limits or the
            pause while somebody is watching -- it just stops the cache
            answering for them.

            Which is also why it asks first. On a large catalogue this is hours
            of probing, and on the day you would most want it -- a house full of
            people with the TV on -- it is hours that keep yielding to viewers. */}
        <div className="mt-4 border-t border-[var(--color-line)] pt-4">
          {refresh.all !== null ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm">
                <b>Re-checking everything</b>{' '}
                <span className="text-[var(--color-muted)]">
                  — queued {ago(refresh.all)}. Every verdict older than that has been retired;{' '}
                  {n(stillToGo)} {stillToGo === 1 ? 'stream is' : 'streams are'} still to go.
                </span>
              </span>
              <span className="flex-1" />
              <button type="button" onClick={() => void cancelAll()} className={btn}>
                Cancel
              </button>
            </div>
          ) : confirming ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm">
                Measure all {n(cache?.total ?? 0)} streams again, however fresh they are?{' '}
                <span className="text-[var(--color-muted)]">
                  It runs at the provider limits and pauses whenever anyone is watching, so on a
                  busy evening it can take a long time. Cancelling puts the current verdicts back in
                  service — nothing is thrown away.
                </span>
              </span>
              <span className="flex-1" />
              <button type="button" onClick={() => setConfirming(false)} className={btn}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void queueAll()}
                className={`${btn} border-[var(--color-accent)] text-[var(--color-accent)]`}
              >
                Re-check everything
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-[var(--color-muted)]">
                Something on tonight? Re-check the library now rather than waiting for the freshness
                target to expire it.
                {refresh.groups > 0 && (
                  <>
                    {' '}
                    {n(refresh.groups)} {refresh.groups === 1 ? 'group is' : 'groups are'} already
                    queued on {refresh.groups === 1 ? 'its' : 'their'} own.
                  </>
                )}
              </span>
              <span className="flex-1" />
              <button type="button" onClick={() => setConfirming(true)} className={btn}>
                Re-check everything
              </button>
            </div>
          )}
        </div>
      </div>

      {cache && cache.total > 0 && stats && (
        <div className={`${card} mt-4 p-5`}>
          <h3 className={heading}>Library</h3>
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">
            Every stream a rule claims, as the last probe left it. Live verdicts are rechecked after{' '}
            {duration(stats.liveTtlMs)}, dead ones after {duration(stats.deadTtlMs)}
            {stats.deadTtlMaxMs !== undefined && stats.deadTtlMaxMs > stats.deadTtlMs ? (
              <>
                {' '}
                — doubling each time a stream is dead again, up to {duration(stats.deadTtlMaxMs)}
              </>
            ) : null}
            .
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Live"
              value={cache.alive}
              sub={`${Math.round((100 * cache.alive) / cache.total)}% of ${n(cache.total)}`}
            />
            <Stat
              label="Dead"
              value={cache.dead}
              tone={cache.dead > 0 ? 'bad' : undefined}
              sub={`${Math.round((100 * cache.dead) / cache.total)}% of ${n(cache.total)}`}
            />
            <Stat
              label="Waiting"
              value={waiting}
              sub={
                waiting === 0 && dueAt !== null ? `next due ${clock(dueAt)}` : 'for the next pass'
              }
            />
            <Stat
              label="Oldest check"
              text={oldestAt === null ? '—' : duration(now - oldestAt)}
              tone={oldestAt !== null && now - oldestAt > stats.maxAgeMs ? 'bad' : undefined}
              sub={`target ${duration(stats.maxAgeMs)}`}
            />
          </div>
          <Freshness ages={cache.ages} total={cache.total} />
        </div>
      )}

      {stats && (
        <div className={`${card} mt-4 p-5`}>
          <h3 className={heading}>Last 24 hours</h3>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Probed" value={stats.day.probed} sub="streams checked" />
            <Stat
              label="Dead found"
              value={stats.day.dead}
              tone={stats.day.dead > 0 ? 'bad' : undefined}
              sub={
                stats.day.probed > 0
                  ? `${Math.round((100 * stats.day.dead) / stats.day.probed)}% of probes`
                  : undefined
              }
            />
            <Stat
              label="Reorders written"
              value={stats.day.reordered}
              sub="channels actually changed"
            />
            <Stat
              label="Passes"
              value={stats.day.passes}
              sub={`${n(stats.day.working)} did work`}
            />
          </div>
          <Activity buckets={stats.activity} />
          {stats.day.failed > 0 && (
            <p className="mt-2 text-sm text-[var(--color-bad)]">
              {n(stats.day.failed)} {stats.day.failed === 1 ? 'pass' : 'passes'} failed.
            </p>
          )}
        </div>
      )}

      {p && p.lanes.length > 0 && (
        <div className={`${card} mt-4 p-5`}>
          <h3 className={heading}>Provider lanes</h3>
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">
            Each provider drains independently. A slow lane no longer blocks the others.
          </p>
          <ul className="mt-3">
            {p.lanes.map((lane) => {
              const completed = laneCompleted(lane);
              const width =
                lane.queued > 0 ? Math.min(Math.round((completed / lane.queued) * 100), 100) : 0;
              return (
                <li
                  key={lane.id}
                  className="border-b border-[var(--color-line)] py-3 last:border-0"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span>{lane.name}</span>
                    <span className="text-sm tabular-nums text-[var(--color-muted)]">
                      {completed}/{lane.queued} · limit {lane.limit}
                      {lane.dead ? ` · ${lane.dead} dead` : ''}
                      {lane.failed ? ` · ${lane.failed} failed` : ''}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-line)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500"
                      style={{ width: `${width}%` }}
                    />
                  </div>
                  {(lane.current ?? []).length > 0 && (
                    <ul className="mt-2">
                      {(lane.current ?? []).map((name) => (
                        <li
                          key={name}
                          className="truncate text-sm text-[var(--color-muted)] before:mr-1.5 before:text-[var(--color-accent)] before:content-['▸']"
                        >
                          {name}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className={`${card} mt-4 p-5`}>
        <h3 className={heading}>Recent passes</h3>
        <ul className="mt-2">
          {entries.length === 0 ? (
            <li className="py-3 text-[var(--color-muted)]">No passes recorded yet.</li>
          ) : (
            entries.map((entry) =>
              entry.kind === 'quiet' ? (
                <li
                  key={`quiet-${entry.from}`}
                  className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-line)] py-3 text-sm text-[var(--color-muted)] last:border-0"
                >
                  <span className="tabular-nums">
                    {entry.count === 1
                      ? `1 quiet pass at ${clock(entry.from)}`
                      : `${entry.count} quiet passes · ${clock(entry.to)}–${clock(entry.from)}`}
                  </span>
                  <span>nothing was due</span>
                </li>
              ) : (
                <li
                  key={entry.run.run_id}
                  className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-line)] py-3 last:border-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm tabular-nums">
                      {clock(entry.run.started_at)}
                      <span className="text-[var(--color-muted)]">
                        {' '}
                        · {ago(entry.run.started_at)}
                      </span>
                    </span>
                    <span className="text-sm text-[var(--color-muted)]">
                      {entry.run.finished_at
                        ? `took ${((entry.run.finished_at - entry.run.started_at) / 1000).toFixed(1)}s`
                        : 'running'}
                    </span>
                  </span>
                  <span className="text-sm tabular-nums text-[var(--color-muted)]">
                    {entry.run.error ? (
                      <span className="text-[var(--color-bad)]">
                        {entry.run.error.slice(0, 60)}
                      </span>
                    ) : (
                      <>
                        {n(entry.run.probed)} probed · {n(entry.run.dead)} dead ·{' '}
                        {n(entry.run.reordered)} reordered
                      </>
                    )}
                  </span>
                </li>
              ),
            )
          )}
        </ul>
      </div>
    </div>
  );
}

/**
 * Verdict age as a distribution rather than a single "oldest" number.
 *
 * One hue getting lighter as the age grows, with the past-target bucket in the
 * warning colour because that one is a breach rather than another step. Every
 * segment is labelled below, so nothing is carried by colour alone.
 */
function Freshness({
  ages,
  total,
}: {
  ages: { hour: number; sixHours: number; day: number; older: number };
  total: number;
}) {
  const segments = [
    { label: 'under 1h', count: ages.hour, fill: 'var(--color-accent)', opacity: 1 },
    { label: '1–6h', count: ages.sixHours, fill: 'var(--color-accent)', opacity: 0.62 },
    { label: '6–24h', count: ages.day, fill: 'var(--color-accent)', opacity: 0.34 },
    { label: 'over 24h', count: ages.older, fill: 'var(--color-warn)', opacity: 1 },
  ].filter((s) => s.count > 0);
  if (total === 0) return null;

  return (
    <div className="mt-4">
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full">
        {segments.map((s) => (
          <div
            key={s.label}
            title={`${s.label}: ${n(s.count)}`}
            style={{
              width: `${(100 * s.count) / total}%`,
              background: s.fill,
              opacity: s.opacity,
            }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--color-muted)]">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5 tabular-nums">
            <span
              className="h-2 w-2 flex-none rounded-full"
              style={{ background: s.fill, opacity: s.opacity }}
              aria-hidden="true"
            />
            {s.label} · {n(s.count)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Probes per hour over the last day: what it has actually been doing. */
function Activity({ buckets }: { buckets: Array<{ from: number; probed: number; dead: number }> }) {
  const peak = Math.max(...buckets.map((b) => b.probed), 1);
  if (buckets.every((b) => b.probed === 0)) {
    return (
      <p className="mt-3 text-sm text-[var(--color-muted)]">
        No probes in the last 24 hours — every verdict was still inside its TTL.
      </p>
    );
  }
  return (
    <div className="mt-4">
      <div className="flex h-12 items-end gap-[2px]">
        {buckets.map((b) => (
          <div
            key={b.from}
            title={`${clock(b.from)} — ${n(b.probed)} probed, ${n(b.dead)} dead`}
            className="flex-1 rounded-t-[3px] bg-[var(--color-accent)]"
            style={{
              height: `${Math.max((100 * b.probed) / peak, b.probed > 0 ? 6 : 2)}%`,
              opacity: b.probed > 0 ? 1 : 0.25,
              background: b.probed > 0 ? undefined : 'var(--color-line)',
            }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-sm text-[var(--color-muted)]">
        <span>24h ago</span>
        <span className="tabular-nums">peak {n(peak)}/h</span>
        <span>now</span>
      </div>
    </div>
  );
}

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
