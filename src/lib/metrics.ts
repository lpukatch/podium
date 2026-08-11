/**
 * Prometheus exposition, derived from SQLite rather than in-process counters.
 *
 * Reading the database means the numbers are the same whether the worker shares
 * a process with the web server (the default) or runs on its own — an
 * in-process counter would silently report zeros in a split deployment.
 *
 * Hand-rolled rather than pulling in a client library: the text format is a
 * dozen lines, and everything here is a gauge computed at scrape time, so a
 * registry buys nothing.
 */

import { type Progress, STALE_LOCK_MS, type Store } from './store';

type Labels = Record<string, string>;

/** Label values may contain a backslash, quote or newline; all three escape. */
function renderLabels(labels: Labels): string {
  const parts = Object.entries(labels).map(
    ([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
  );
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

class Exposition {
  private readonly lines: string[] = [];
  private readonly declared = new Set<string>();

  add(name: string, help: string, type: 'gauge' | 'counter', value: number, labels: Labels = {}) {
    if (!Number.isFinite(value)) return; // never emit NaN; Prometheus rejects it
    if (!this.declared.has(name)) {
      this.declared.add(name);
      this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    }
    this.lines.push(`${name}${renderLabels(labels)} ${value}`);
  }

  toString(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

const PHASES: Array<Progress['phase']> = [
  'idle',
  'fetching',
  'planning',
  'probing',
  'paused',
  'done',
  'failed',
];

export interface MetricsOptions {
  /** Freshness target, so compliance can be expressed as a ratio. */
  maxAgeMs: number;
  /** Beyond this with no heartbeat, the worker is considered absent. */
  staleLockMs?: number;
  now?: number;
}

export function renderMetrics(store: Store, options: MetricsOptions): string {
  const now = options.now ?? Date.now();
  const staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
  const out = new Exposition();

  out.add('podium_up', 'Always 1; presence of this series means the API answered.', 'gauge', 1);

  // --- worker liveness -----------------------------------------------------
  // The question this whole endpoint exists to answer: is anything still
  // running? A stale ordering looks identical to a correct one from outside.
  const lock = store.lockState();
  const heartbeatAge = lock ? now - lock.heartbeat : null;
  out.add(
    'podium_worker_running',
    'Whether a worker holds the lock with a fresh heartbeat.',
    'gauge',
    heartbeatAge !== null && heartbeatAge < staleLockMs ? 1 : 0,
  );
  if (heartbeatAge !== null) {
    out.add(
      'podium_worker_heartbeat_age_seconds',
      'Seconds since the worker last touched its lock.',
      'gauge',
      Math.round(heartbeatAge / 1000),
    );
  }

  // --- current run ---------------------------------------------------------
  const progress = store.getProgress();
  for (const phase of PHASES) {
    out.add(
      'podium_run_phase',
      'Current run phase, one series per phase, 1 on the active one.',
      'gauge',
      progress.phase === phase ? 1 : 0,
      { phase },
    );
  }
  out.add('podium_run_probed', 'Streams probed in the current run.', 'gauge', progress.probed);
  out.add('podium_run_total', 'Streams selected for the current run.', 'gauge', progress.total);
  out.add('podium_run_dead', 'Dead streams found in the current run.', 'gauge', progress.dead);
  out.add(
    'podium_run_deferred',
    'Streams deferred because a provider had no spare capacity.',
    'gauge',
    progress.deferred,
  );
  if (progress.updatedAt > 0) {
    out.add(
      'podium_progress_age_seconds',
      'Seconds since progress was last written.',
      'gauge',
      Math.round((now - progress.updatedAt) / 1000),
    );
  }

  // --- provider lanes ------------------------------------------------------
  // Per provider, because the whole scheduling design is per provider: a lane
  // pinned at its limit while others idle is the signal worth alerting on.
  for (const lane of progress.lanes) {
    const labels = { provider: lane.name };
    out.add(
      'podium_lane_limit',
      'Concurrency limit for this provider.',
      'gauge',
      lane.limit,
      labels,
    );
    out.add('podium_lane_queued', 'Streams queued on this lane.', 'gauge', lane.queued, labels);
    out.add('podium_lane_done', 'Streams completed on this lane.', 'gauge', lane.done, labels);
    out.add(
      'podium_lane_dead',
      'Streams found dead on this lane.',
      'gauge',
      lane.dead ?? 0,
      labels,
    );
    out.add(
      'podium_lane_failed',
      'Streams whose probe errored on this lane.',
      'gauge',
      lane.failed,
      labels,
    );
    out.add(
      'podium_lane_in_flight',
      'Streams being probed on this lane right now.',
      'gauge',
      lane.current?.length ?? 0,
      labels,
    );
  }

  // --- lifetime totals -----------------------------------------------------
  const totals = store.runTotals();
  out.add('podium_runs_total', 'Runs recorded.', 'counter', totals.runs);
  out.add('podium_runs_failed_total', 'Runs that ended in an error.', 'counter', totals.failed);
  out.add('podium_streams_probed_total', 'Streams probed, all runs.', 'counter', totals.probed);
  out.add('podium_streams_cached_total', 'Probes served from cache.', 'counter', totals.cached);
  out.add('podium_streams_dead_total', 'Dead verdicts recorded.', 'counter', totals.dead);
  out.add('podium_channels_reordered_total', 'Channels reordered.', 'counter', totals.reordered);
  out.add('podium_probes_skipped_total', 'Probes skipped by an abort.', 'counter', totals.skipped);

  const lastRun = store.recentRuns(1)[0];
  if (lastRun) {
    out.add(
      'podium_last_run_start_timestamp_seconds',
      'Unix time the most recent run started.',
      'gauge',
      Math.round(lastRun.started_at / 1000),
    );
    if (lastRun.finished_at) {
      out.add(
        'podium_last_run_duration_seconds',
        'Duration of the most recent completed run.',
        'gauge',
        Math.round((lastRun.finished_at - lastRun.started_at) / 1000),
      );
    }
    out.add(
      'podium_last_run_failed',
      'Whether the most recent run ended in an error.',
      'gauge',
      lastRun.error ? 1 : 0,
    );
  }

  // --- freshness -----------------------------------------------------------
  const cache = store.cacheStats();
  out.add('podium_cache_entries', 'Streams with a cached verdict.', 'gauge', cache.total);
  out.add('podium_cache_alive', 'Cached verdicts that were alive.', 'gauge', cache.alive);
  out.add('podium_cache_dead', 'Cached verdicts that were dead.', 'gauge', cache.dead);
  // Prefer the worker's managed-oldest over the cache-wide MIN: the cache counts
  // verdicts on excluded, unmatched, and removed streams the pacer never
  // rechecks, which would flag a breach that is not real. Falls back to the
  // cache before the first pass (or from an older worker).
  const oldestAt = progress.oldestManagedProbedAt ?? cache.oldestProbedAt;
  if (oldestAt !== null) {
    const oldest = Math.round((now - oldestAt) / 1000);
    out.add(
      'podium_oldest_probe_age_seconds',
      'Age of the least recently probed stream the worker manages.',
      'gauge',
      oldest,
    );
    out.add(
      'podium_freshness_target_seconds',
      'The freshness target the pacer works towards.',
      'gauge',
      Math.round(options.maxAgeMs / 1000),
    );
    out.add(
      'podium_freshness_breaching',
      'Whether the oldest managed probe is past the freshness target.',
      'gauge',
      now - oldestAt > options.maxAgeMs ? 1 : 0,
    );
  }

  return out.toString();
}
