import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderMetrics } from './metrics';
import type { ProbeResult } from './probe';
import { Store } from './store';

const NOW = 1_800_000_000_000;
const alive = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  alive: true,
  width: 1920,
  height: 1080,
  fps: 30,
  bitrateKbps: 5000,
  videoCodec: 'h264',
  audioCodec: 'aac',
  pixelFormat: 'yuv420p',
  audioChannels: 2,
  channelLayout: 'stereo',
  audioBitrateKbps: 128,
  audioSampleRate: 48_000,
  elapsedMs: 100,
  error: '',
  ...over,
});

/** Parse the exposition back into a lookup so assertions read as values. */
function parse(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^(\S+?)(\{.*\})?\s+(-?[\d.eE+]+)$/.exec(line);
    if (match) out.set(`${match[1]}${match[2] ?? ''}`, Number(match[3]));
  }
  return out;
}

describe('renderMetrics', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-metrics-'));
    store = new Store(join(dir, 'm.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is valid exposition even on an untouched database', () => {
    const text = renderMetrics(store, { maxAgeMs: 3600_000, now: NOW });
    expect(parse(text).get('podium_up')).toBe(1);
    // Every series must be preceded by its HELP/TYPE, and declared once only.
    const types = text.split('\n').filter((l) => l.startsWith('# TYPE podium_up'));
    expect(types).toHaveLength(1);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('reports the worker as not running when no lock is held', () => {
    expect(
      parse(renderMetrics(store, { maxAgeMs: 3600_000, now: NOW })).get('podium_worker_running'),
    ).toBe(0);
  });

  it('reports the worker running while its heartbeat is fresh', () => {
    store.acquireLock('w1');
    const m = parse(renderMetrics(store, { maxAgeMs: 3600_000 }));
    expect(m.get('podium_worker_running')).toBe(1);
    expect(m.get('podium_worker_heartbeat_age_seconds')).toBeLessThan(5);
  });

  it('reports the worker stopped once the heartbeat goes stale', () => {
    // The signal the endpoint exists for: a dead worker leaves correct-looking
    // orderings behind, so nothing else reveals it.
    store.acquireLock('w1');
    const m = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: NOW + 10 * 60_000 }));
    expect(m.get('podium_worker_running')).toBe(0);
  });

  it('emits one phase series per phase with exactly one set', () => {
    store.setProgress({
      runId: 'r1',
      phase: 'probing',
      startedAt: NOW,
      probed: 12,
      total: 40,
      dead: 3,
      reordered: 2,
      unchanged: 0,
      cached: 8,
      deferred: 5,
      backlog: 0,
      dueAt: null,
      heldBack: {},
      nextRunAt: null,
      tickMs: 60_000,
      maxAgeMs: 3_600_000,
      lanes: [],
      message: '',
    });
    const m = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: NOW }));
    expect(m.get('podium_run_phase{phase="probing"}')).toBe(1);
    expect(m.get('podium_run_phase{phase="idle"}')).toBe(0);
    expect(m.get('podium_run_probed')).toBe(12);
    expect(m.get('podium_run_deferred')).toBe(5);
  });

  it('labels lane series by provider', () => {
    store.setProgress({
      runId: 'r1',
      phase: 'probing',
      startedAt: NOW,
      probed: 0,
      total: 0,
      dead: 0,
      reordered: 0,
      unchanged: 0,
      cached: 0,
      deferred: 0,
      backlog: 0,
      dueAt: null,
      heldBack: {},
      nextRunAt: null,
      tickMs: 60_000,
      maxAgeMs: 3_600_000,
      lanes: [
        {
          id: 5,
          name: 'Provider C',
          limit: 1,
          done: 3,
          dead: 2,
          failed: 1,
          queued: 20,
          current: ['ESPN'],
        },
        { id: 7, name: 'Provider B', limit: 5, done: 9, failed: 0, queued: 9, current: [] },
      ],
      message: '',
    });
    const m = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: NOW }));
    expect(m.get('podium_lane_limit{provider="Provider C"}')).toBe(1);
    expect(m.get('podium_lane_done{provider="Provider B"}')).toBe(9);
    // Dead streams are their own series; "failed" is now probes that errored.
    expect(m.get('podium_lane_dead{provider="Provider C"}')).toBe(2);
    expect(m.get('podium_lane_failed{provider="Provider C"}')).toBe(1);
    // An older row without `dead` falls back to zero rather than a missing series.
    expect(m.get('podium_lane_dead{provider="Provider B"}')).toBe(0);
    expect(m.get('podium_lane_in_flight{provider="Provider C"}')).toBe(1);
    expect(m.get('podium_lane_in_flight{provider="Provider B"}')).toBe(0);
  });

  it('sums lifetime totals across runs', () => {
    store.startRun('a');
    store.finishRun('a', { probed: 10, dead: 2, cached: 5, reordered: 3 });
    store.startRun('b');
    store.finishRun('b', { probed: 4, dead: 1, error: 'boom' });

    const m = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: NOW }));
    expect(m.get('podium_runs_total')).toBe(2);
    expect(m.get('podium_runs_failed_total')).toBe(1);
    expect(m.get('podium_streams_probed_total')).toBe(14);
    expect(m.get('podium_streams_dead_total')).toBe(3);
    expect(m.get('podium_last_run_failed')).toBe(1);
  });

  it('counts cached verdicts by liveness', () => {
    store.put(1, 'h', alive());
    store.put(2, 'h', alive());
    store.put(3, 'h', alive({ alive: false }));
    const m = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: NOW }));
    expect(m.get('podium_cache_entries')).toBe(3);
    expect(m.get('podium_cache_alive')).toBe(2);
    expect(m.get('podium_cache_dead')).toBe(1);
  });

  it('flags a freshness breach off the oldest probe', () => {
    store.put(1, 'h', alive());
    const fresh = parse(renderMetrics(store, { maxAgeMs: 3600_000 }));
    expect(fresh.get('podium_freshness_breaching')).toBe(0);

    // Same data, scraped a day later.
    const later = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: Date.now() + 86_400_000 }));
    expect(later.get('podium_freshness_breaching')).toBe(1);
    expect(later.get('podium_oldest_probe_age_seconds')).toBeGreaterThan(3600);
  });

  it('prefers the worker managed-oldest over the cache-wide number', () => {
    const scrape = NOW + 2 * 3_600_000;
    // A stale verdict sits in the cache on a stream the pacer never rechecks --
    // removed from every lineup -- so the cache-wide MIN would flag a breach.
    store.put(1, 'h', alive());
    const cacheOnly = parse(renderMetrics(store, { maxAgeMs: 3_600_000, now: scrape }));
    expect(cacheOnly.get('podium_freshness_breaching')).toBe(1);

    // The worker reports the real managed set is fresh (one second old), which
    // wins over the cache-wide number that counts the orphaned verdict.
    store.setProgress({
      runId: 'r1',
      phase: 'done',
      startedAt: NOW,
      probed: 0,
      total: 0,
      dead: 0,
      reordered: 0,
      unchanged: 0,
      cached: 0,
      deferred: 0,
      backlog: 0,
      dueAt: null,
      heldBack: {},
      nextRunAt: null,
      tickMs: 60_000,
      maxAgeMs: 3_600_000,
      lanes: [],
      message: '',
      oldestManagedProbedAt: scrape - 1000,
    });
    const managed = parse(renderMetrics(store, { maxAgeMs: 3_600_000, now: scrape }));
    expect(managed.get('podium_oldest_probe_age_seconds')).toBeLessThan(60);
    expect(managed.get('podium_freshness_breaching')).toBe(0);
  });

  it('escapes label values rather than emitting broken series', () => {
    store.setProgress({
      runId: 'r',
      phase: 'probing',
      startedAt: NOW,
      probed: 0,
      total: 0,
      dead: 0,
      reordered: 0,
      unchanged: 0,
      cached: 0,
      deferred: 0,
      backlog: 0,
      dueAt: null,
      heldBack: {},
      nextRunAt: null,
      tickMs: 60_000,
      maxAgeMs: 3_600_000,
      lanes: [
        { id: 1, name: 'we"ird\\name', limit: 1, done: 0, failed: 0, queued: 1, current: [] },
      ],
      message: '',
    });
    const text = renderMetrics(store, { maxAgeMs: 3600_000, now: NOW });
    expect(text).toContain('provider="we\\"ird\\\\name"');
  });

  it('never emits a non-finite value', () => {
    store.startRun('a');
    const text = renderMetrics(store, { maxAgeMs: Number.NaN, now: NOW });
    expect(text).not.toMatch(/\bNaN\b/);
    expect(text).not.toMatch(/\bInfinity\b/);
  });
});
