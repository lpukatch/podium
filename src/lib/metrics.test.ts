import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderMetrics } from './metrics';
import type { ProbeResult } from './probe';
import { score } from './scoring';
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

  describe('provider quality', () => {
    /** A catalogue row, positional for brevity below. */
    const row = (
      channelId: number,
      channelName: string,
      slot: number,
      streamId: number,
      providerName: string,
    ) => ({
      channelId,
      channelName,
      slot,
      streamId,
      providerId: 0,
      providerName,
    });

    it('emits nothing provider-shaped before the first catalogue write', () => {
      store.put(1, 'h', alive());
      const text = renderMetrics(store, { maxAgeMs: 3600_000, now: NOW });
      expect(text).not.toContain('podium_provider_');
      expect(text).not.toContain('podium_catalogue_age_seconds');
    });

    it('aggregates states, resolutions, measured bitrate and rank-1 per provider', () => {
      // Channel 10: Provider A primary (healthy 1080p, measured 5000),
      // Provider B fallback (dead).
      // Channel 11: Provider B primary, alive but black, declared-only bitrate.
      // Channel 12: Provider A primary, alive but starved (300 kbps measured).
      // Channel 13: Provider C primary, never probed.
      store.replaceCatalogue(
        [
          row(10, 'ESPN', 0, 1, 'Provider A'),
          row(10, 'ESPN', 1, 2, 'Provider B'),
          row(11, 'TNT', 0, 3, 'Provider B'),
          row(12, 'CNN', 0, 4, 'Provider A'),
          row(13, 'MSNBC', 0, 9, 'Provider C'),
        ],
        'r1',
      );
      store.put(1, 'h', alive({ bitrateMeasured: true }));
      store.put(2, 'h', alive({ alive: false, width: 0, height: 0, bitrateKbps: 0 }));
      store.put(3, 'h', alive({ black: true, height: 720, bitrateKbps: 4000 }));
      store.put(4, 'h', alive({ height: 720, bitrateKbps: 300, bitrateMeasured: true }));

      const m = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: Date.now() }));
      // States, one-hot with precedence: dead > black > low_bitrate > alive.
      expect(m.get('podium_provider_streams{provider="Provider A",state="alive"}')).toBe(1);
      expect(m.get('podium_provider_streams{provider="Provider A",state="low_bitrate"}')).toBe(1);
      expect(m.get('podium_provider_streams{provider="Provider B",state="dead"}')).toBe(1);
      expect(m.get('podium_provider_streams{provider="Provider B",state="black"}')).toBe(1);
      expect(m.get('podium_provider_streams{provider="Provider C",state="unmeasured"}')).toBe(1);
      // Zero-filled: A has no dead streams, but the series exists.
      expect(m.get('podium_provider_streams{provider="Provider A",state="dead"}')).toBe(0);
      // Resolutions come from the best verdict's height; dead reads unknown.
      expect(
        m.get('podium_provider_resolution_streams{provider="Provider A",resolution="fhd"}'),
      ).toBe(1);
      expect(
        m.get('podium_provider_resolution_streams{provider="Provider A",resolution="hd"}'),
      ).toBe(1);
      expect(
        m.get('podium_provider_resolution_streams{provider="Provider B",resolution="unknown"}'),
      ).toBe(1);
      // Only measured bitrates count: A is [300, 5000] -> median 2650; B's black
      // stream declared 4000 and is excluded, so B has no median series at all.
      expect(m.get('podium_provider_bitrate_measured{provider="Provider A"}')).toBe(2);
      expect(
        m.get('podium_provider_bitrate_kbps{provider="Provider A",resolution="all",stat="median"}'),
      ).toBe(2650);
      // ...and within a bucket, where the two samples separate: the 1080p one
      // is a healthy 5000 and only the 720p one is starved. The overall median
      // above says neither, which is the whole reason the buckets exist.
      expect(
        m.get('podium_provider_bitrate_kbps{provider="Provider A",resolution="fhd",stat="median"}'),
      ).toBe(5000);
      expect(
        m.get('podium_provider_bitrate_kbps{provider="Provider A",resolution="hd",stat="median"}'),
      ).toBe(300);
      expect(
        m.has('podium_provider_bitrate_kbps{provider="Provider B",resolution="all",stat="median"}'),
      ).toBe(false);
      // Rank-1: A holds ESPN (healthy) and CNN (starved); B holds TNT (black);
      // C holds MSNBC (unmeasured). Healthy counts only usable primaries.
      expect(m.get('podium_provider_rank1_channels{provider="Provider A"}')).toBe(2);
      expect(m.get('podium_provider_rank1_healthy{provider="Provider A"}')).toBe(1);
      expect(m.get('podium_provider_rank1_channels{provider="Provider B"}')).toBe(1);
      expect(m.get('podium_provider_rank1_healthy{provider="Provider B"}')).toBe(0);
      expect(m.get('podium_provider_rank1_channels{provider="Provider C"}')).toBe(1);
      // The snapshot was just written.
      expect(m.get('podium_catalogue_age_seconds')).toBeLessThan(5);
    });

    it('folds stream variants to the best verdict, like the UI', () => {
      store.replaceCatalogue([row(10, 'ESPN', 0, 1, 'Provider A')], 'r1');
      // The default login is dead; a second login on the same stream is alive.
      store.put(1, 'h', alive({ alive: false }), 0);
      store.put(1, 'h', alive({ bitrateMeasured: true }), 7);
      const m = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: Date.now() }));
      expect(m.get('podium_provider_streams{provider="Provider A",state="alive"}')).toBe(1);
      expect(m.get('podium_provider_rank1_healthy{provider="Provider A"}')).toBe(1);
    });

    it('patches one channel without disturbing the rest of the snapshot', () => {
      store.replaceCatalogue(
        [row(10, 'ESPN', 0, 1, 'Provider A'), row(11, 'TNT', 0, 3, 'Provider B')],
        'r1',
      );
      store.updateChannelOrder(10, [row(10, 'ESPN', 0, 5, 'Provider B')]);
      const { rows, writtenAt } = store.catalogue();
      expect(writtenAt).not.toBeNull();
      expect(rows).toEqual([
        row(10, 'ESPN', 0, 5, 'Provider B'),
        row(11, 'TNT', 0, 3, 'Provider B'),
      ]);
    });

    it('refuses to replace a snapshot with an empty one', () => {
      store.replaceCatalogue([row(10, 'ESPN', 0, 1, 'Provider A')], 'r1');
      store.replaceCatalogue([], 'r2');
      expect(store.catalogue().rows).toHaveLength(1);
    });

    it('counts a stream once however many channels carry it', () => {
      // One Provider A stream matched onto three channels, plus one Provider B
      // stream on one. Counted per catalogue row, A would look three times the
      // provider it is; counted per stream, the two are the same size.
      store.replaceCatalogue(
        [
          row(10, 'ESPN', 0, 1, 'Provider A'),
          row(11, 'ESPN HD', 0, 1, 'Provider A'),
          row(12, 'ESPN 2', 0, 1, 'Provider A'),
          row(13, 'TNT', 0, 2, 'Provider B'),
        ],
        'r1',
      );
      store.put(1, 'h', alive({ bitrateMeasured: true }));
      store.put(2, 'h', alive({ bitrateMeasured: true }));

      const m = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: Date.now() }));
      expect(m.get('podium_provider_streams{provider="Provider A",state="alive"}')).toBe(1);
      expect(m.get('podium_provider_streams{provider="Provider B",state="alive"}')).toBe(1);
      expect(m.get('podium_provider_bitrate_measured{provider="Provider A"}')).toBe(1);
      // Rank-1 is the exception, and stays per channel: A really did win three
      // contests. Against `podium_provider_channels` that is a 3/3 win rate,
      // which is the ratio the raw win count on its own cannot express.
      expect(m.get('podium_provider_rank1_channels{provider="Provider A"}')).toBe(3);
      expect(m.get('podium_provider_channels{provider="Provider A"}')).toBe(3);
      expect(m.get('podium_provider_channels{provider="Provider B"}')).toBe(1);
    });

    it('counts a channel once for coverage however many slots a provider fills', () => {
      store.replaceCatalogue(
        [
          row(10, 'ESPN', 0, 1, 'Provider A'),
          row(10, 'ESPN', 1, 2, 'Provider A'),
          row(10, 'ESPN', 2, 3, 'Provider B'),
        ],
        'r1',
      );
      const m = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: Date.now() }));
      expect(m.get('podium_provider_channels{provider="Provider A"}')).toBe(1);
      // B contested ESPN and lost it: coverage 1, wins 0. That is the shape of
      // the comparison, and it is invisible without the denominator.
      expect(m.get('podium_provider_channels{provider="Provider B"}')).toBe(1);
      expect(m.get('podium_provider_rank1_channels{provider="Provider B"}')).toBe(0);
    });

    it('reports the age of the verdicts a provider is judged on', () => {
      store.replaceCatalogue(
        [
          row(10, 'ESPN', 0, 1, 'Provider A'),
          row(11, 'TNT', 0, 2, 'Provider A'),
          row(12, 'CNN', 0, 3, 'Provider A'),
        ],
        'r1',
      );
      store.put(1, 'h', alive());
      store.put(2, 'h', alive());
      store.put(3, 'h', alive());
      const raw = new Database(join(dir, 'm.db'));
      raw
        .prepare('UPDATE probe_cache SET probed_at = ? WHERE stream_id = 1')
        .run(Date.now() - 60_000);
      raw
        .prepare('UPDATE probe_cache SET probed_at = ? WHERE stream_id = 2')
        .run(Date.now() - 600_000);
      raw
        .prepare('UPDATE probe_cache SET probed_at = ? WHERE stream_id = 3')
        .run(Date.now() - 3_600_000);
      raw.close();

      const m = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: Date.now() }));
      expect(
        m.get('podium_provider_verdict_age_seconds{provider="Provider A",stat="median"}'),
      ).toBe(600);
      expect(m.get('podium_provider_verdict_age_seconds{provider="Provider A",stat="max"}')).toBe(
        3600,
      );
    });

    it('leaves the age series off a provider with nothing probed yet', () => {
      store.replaceCatalogue([row(10, 'ESPN', 0, 1, 'Provider A')], 'r1');
      const m = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: Date.now() }));
      expect(m.get('podium_provider_streams{provider="Provider A",state="unmeasured"}')).toBe(1);
      expect(m.has('podium_provider_verdict_age_seconds{provider="Provider A",stat="max"}')).toBe(
        false,
      );
    });

    it('breaks dead streams down by why they died', () => {
      store.replaceCatalogue(
        [
          row(10, 'ESPN', 0, 1, 'Provider A'),
          row(11, 'TNT', 0, 2, 'Provider A'),
          row(12, 'CNN', 0, 3, 'Provider A'),
          row(13, 'MSNBC', 0, 4, 'Provider A'),
        ],
        'r1',
      );
      store.put(1, 'h', alive({ alive: false, error: 'Server returned 404 Not Found' }));
      store.put(2, 'h', alive({ alive: false, error: 'Server returned 403 Forbidden' }));
      store.put(3, 'h', alive({ alive: false, error: 'timeout' }));
      store.put(4, 'h', alive({ alive: false, error: 'spawn failed: ENOENT' }));

      const m = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: Date.now() }));
      expect(m.get('podium_provider_streams{provider="Provider A",state="dead"}')).toBe(4);
      expect(m.get('podium_provider_dead_streams{provider="Provider A",reason="not_found"}')).toBe(
        1,
      );
      expect(m.get('podium_provider_dead_streams{provider="Provider A",reason="auth"}')).toBe(1);
      expect(m.get('podium_provider_dead_streams{provider="Provider A",reason="timeout"}')).toBe(1);
      // Ours, not theirs -- a missing ffprobe must not read as a bad provider.
      expect(
        m.get('podium_provider_dead_streams{provider="Provider A",reason="probe_error"}'),
      ).toBe(1);
      // Zero-filled, like the states.
      expect(
        m.get('podium_provider_dead_streams{provider="Provider A",reason="server_error"}'),
      ).toBe(0);
      // The buckets partition the dead count exactly.
      const reasons = [...m.entries()].filter(([k]) =>
        k.startsWith('podium_provider_dead_streams'),
      );
      expect(reasons.reduce((sum, [, v]) => sum + v, 0)).toBe(4);
    });

    it('scores a provider on the streams that would actually rank', () => {
      store.replaceCatalogue(
        [
          row(10, 'ESPN', 0, 1, 'Provider A'),
          row(11, 'TNT', 0, 2, 'Provider A'),
          row(12, 'CNN', 0, 3, 'Provider B'),
        ],
        'r1',
      );
      store.put(1, 'h', alive());
      // Dead, and therefore not in the median: `score` returns 0 for it, and
      // letting that 0 in would restate the dead count as if it were quality.
      store.put(2, 'h', alive({ alive: false }));
      store.put(3, 'h', alive({ height: 480, width: 640, bitrateKbps: 1200, fps: 25 }));

      const m = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: Date.now() }));
      const a = m.get('podium_provider_score{provider="Provider A",stat="median"}');
      const b = m.get('podium_provider_score{provider="Provider B",stat="median"}');
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      // A's 1080p beats B's 480p, and A's dead stream did not drag it under.
      expect(a).toBeGreaterThan(b as number);
      // The same number the ranker uses, rounded to three places for exposition.
      expect(a).toBe(Math.round(score(alive()) * 1000) / 1000);
      // Every stream dead means no median at all, rather than a misleading 0.
      store.replaceCatalogue([row(11, 'TNT', 0, 2, 'Provider C')], 'r2');
      const only = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: Date.now() }));
      expect(only.has('podium_provider_score{provider="Provider C",stat="median"}')).toBe(false);
    });

    it('exposes per-channel series only when asked', () => {
      store.replaceCatalogue([row(10, 'ESPN', 0, 1, 'Provider A')], 'r1');
      store.put(1, 'h', alive({ bitrateMeasured: true }));

      const off = parse(renderMetrics(store, { maxAgeMs: 3600_000, now: NOW }));
      expect(
        off.has(
          'podium_channel_source_info{channel_id="10",channel_name="ESPN",slot="0",provider="Provider A"}',
        ),
      ).toBe(false);

      const onText = renderMetrics(store, {
        maxAgeMs: 3600_000,
        now: NOW,
        channelMetrics: true,
      });
      const on = parse(onText);
      expect(
        on.get(
          'podium_channel_source_info{channel_id="10",channel_name="ESPN",slot="0",provider="Provider A"}',
        ),
      ).toBe(1);
      // The name rides the info series alone; the value families key on the id.
      expect(on.get('podium_channel_source_state{channel_id="10",slot="0",state="alive"}')).toBe(1);
      expect(on.get('podium_channel_source_height_pixels{channel_id="10",slot="0"}')).toBe(1080);
      expect(on.get('podium_channel_source_bitrate_kbps{channel_id="10",slot="0"}')).toBe(5000);
      expect(onText).not.toContain('podium_channel_source_state{channel_id="10",channel_name');
    });

    it('escapes a provider name in the catalogue series', () => {
      store.replaceCatalogue([row(10, 'ESPN', 0, 1, 'we"ird\\name')], 'r1');
      store.put(1, 'h', alive());
      const text = renderMetrics(store, { maxAgeMs: 3600_000, now: NOW });
      expect(text).toContain('provider="we\\"ird\\\\name"');
    });
  });
});
