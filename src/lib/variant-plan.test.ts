/**
 * Planning and settling with several logins per provider.
 *
 * A stream with two logins is two probe targets and one of everything a person
 * reads: one backlog entry, one cache verdict combined from the best login,
 * one stats write when its last queued probe lands. These pin that collapse.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import type { Channel, Provider, Stream } from './dispatcharr';
import type { ProbeResult } from './probe';
import { RulesSource } from './rules-source';
import { makeStreamSettler, Runner } from './runner';
import type { ProbeJob } from './scheduler';
import { DEFAULT_WEIGHTS } from './scoring';
import { Store } from './store';
import { buildVariants } from './variants';

const result = (over: Partial<ProbeResult> = {}): ProbeResult => ({
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
  bitrateMeasured: true,
  elapsedMs: 100,
  error: '',
  ...over,
});

const URL = 'http://crx.watch/live/coffee/684540451/1234.ts';

/** Provider 5 carrying a second, active login (profile 9). */
const provider = (over: Partial<Provider> = {}): Provider => ({
  id: 5,
  name: 'Provider A',
  maxStreams: 3,
  profiles: [
    {
      id: 5,
      name: 'Default',
      isDefault: true,
      isActive: true,
      maxStreams: 3,
      currentViewers: 0,
      searchPattern: '^(.*)$',
      replacePattern: '$1',
    },
    {
      id: 9,
      name: 'Second login',
      isDefault: false,
      isActive: true,
      maxStreams: 2,
      currentViewers: 0,
      searchPattern: 'coffee/684540451',
      replacePattern: 'coffee2/secret',
    },
  ],
  ...over,
});

describe('the planner with several logins', () => {
  let dir: string;
  let store: Store;
  let rulesPath: string;

  const streams: Stream[] = [
    {
      id: 10,
      name: 'ESPN',
      url: URL,
      providerId: 5,
      streamHash: 'h',
      currentViewers: 0,
      groupId: 100,
    },
  ];
  const channels: Channel[] = [
    { id: 1, name: 'ESPN', tvgId: 'espn.id', streams: [10], groupId: 100 },
  ];
  const groupNames = new Map([[100, 'sports']]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-variant-plan-'));
    rulesPath = join(dir, 'rules.json');
    const doc = JSON.stringify({
      schema: 2,
      channels: [{ channel_id: 1, aliases: ['ESPN'] }],
    });
    const tmp = `${rulesPath}.tmp`;
    writeFileSync(tmp, doc, 'utf8');
    renameSync(tmp, rulesPath);
    store = new Store(join(dir, 'podium.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** plan() is private; reach it directly rather than faking Dispatcharr. */
  function plan(
    runner: Runner,
    rules: RulesSource,
    variantsByStream: Map<number, ReturnType<typeof buildVariants>>,
    counters: { cached: number } = { cached: 0 },
  ) {
    return (
      runner as unknown as {
        plan: (...args: unknown[]) => {
          jobs: ProbeJob[];
          ages: number[];
          planned: Array<{
            channel: { id: number };
            fresh: Map<number, Map<number, ProbeResult>>;
            cacheComplete: boolean;
          }>;
          outstandingMarks: Array<{ groupId: number; forcedAt: number; remaining: number }>;
        };
      }
    ).plan.call(
      runner,
      channels,
      streams,
      new Map(),
      rules.get().eligibility,
      counters,
      {},
      groupNames,
      { next: new Map(), nextLive: new Map() },
      null,
      undefined,
      undefined,
      variantsByStream,
    );
  }

  function build() {
    const rules = new RulesSource(rulesPath);
    const runner = new Runner({
      config: () => loadConfig({ DISPATCHARR_API_KEY: 'k', PODIUM_DATA_DIR: dir }),
      store,
      rules,
    });
    return { rules, runner };
  }

  it('queues one job per login that lacks a fresh verdict, and only those', () => {
    const { rules, runner } = build();
    const variantsByStream = new Map([[10, buildVariants(URL, provider())]]);

    // Never probed at all: both logins.
    let planned = plan(runner, rules, variantsByStream);
    expect(planned.jobs.map((job) => job.profileId).sort()).toEqual([0, 9]);
    expect(planned.jobs.find((job) => job.profileId === 9)?.url).toBe(
      'http://crx.watch/live/coffee2/secret/1234.ts',
    );

    // The default login fresh, the second one missing: only the second is due.
    store.put(10, 'h', result(), 0);
    planned = plan(runner, rules, variantsByStream);
    expect(planned.jobs.map((job) => job.profileId)).toEqual([9]);

    // Both fresh: nothing to probe, the stream served from cache whole.
    store.put(10, 'h', result(), 9);
    const counters = { cached: 0 };
    planned = plan(runner, rules, variantsByStream, counters);
    expect(planned.jobs).toHaveLength(0);
    expect(counters.cached).toBe(1);
    expect(planned.planned[0]?.cacheComplete).toBe(true);
    expect([...(planned.planned[0]?.fresh.get(10) ?? [])].map(([id]) => id).sort()).toEqual([0, 9]);
  });

  it('re-probes only the login whose verdict expired', () => {
    const { rules, runner } = build();
    const variantsByStream = new Map([[10, buildVariants(URL, provider())]]);

    const stale = Date.now() - 25 * 3_600_000; // past the live TTL
    // Write both variants with the second one aged out, via a raw SQL stamp --
    // put() always writes "now", and the point here is the age.
    const raw = (
      store as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
      }
    ).db;
    for (const [variantId, probedAt] of [
      [0, Date.now()],
      [9, stale],
    ] as Array<[number, number]>) {
      raw
        .prepare(
          `INSERT INTO probe_cache (stream_id, stream_hash, variant_id, probed_at, alive, result, dead_streak)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(10, 'h', variantId, probedAt, 1, JSON.stringify(result()));
    }

    const planned = plan(runner, rules, variantsByStream);
    expect(planned.jobs.map((job) => job.profileId)).toEqual([9]);
  });

  it('counts a marked stream once, however many logins hold verdicts', () => {
    const { rules, runner } = build();
    const variantsByStream = new Map([[10, buildVariants(URL, provider())]]);

    // Both logins probed a minute before the request, stamped explicitly: a
    // tie with `Date.now()` would make the outcome depend on the clock.
    const before = Date.now() - 60_000;
    const raw = (
      store as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
      }
    ).db;
    for (const variantId of [0, 9]) {
      raw
        .prepare(
          `INSERT INTO probe_cache (stream_id, stream_hash, variant_id, probed_at, alive, result, dead_streak)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(10, 'h', variantId, before, 1, JSON.stringify(result()));
    }
    store.setRefreshMark(100, Date.now());
    // One stream still to go -- not one per login.
    let planned = plan(runner, rules, variantsByStream);
    expect(planned.outstandingMarks[0]?.remaining).toBe(1);

    // Replacing one login's verdict is not replacing the stream's re-check.
    store.put(10, 'h', result(), 0);
    planned = plan(runner, rules, variantsByStream);
    expect(planned.outstandingMarks[0]?.remaining).toBe(1);

    // The second login landing is what empties it.
    store.put(10, 'h', result(), 9);
    planned = plan(runner, rules, variantsByStream);
    expect(planned.outstandingMarks[0]?.remaining).toBe(0);
  });
});

describe('the stream settler', () => {
  const job = (streamId: number, profileId: number): ProbeJob => ({
    streamId,
    channelId: 1,
    url: `http://x/${profileId}`,
    providerId: 5,
    profileId,
    stepOrder: 0,
  });

  it('fires once, when the last queued login lands -- not per probe', () => {
    const settled: Array<[number, ProbeResult | null]> = [];
    const settler = makeStreamSettler([job(10, 0), job(10, 9)], {
      weights: DEFAULT_WEIGHTS,
      onSettled: (streamId, best) => settled.push([streamId, best]),
    });

    settler.landed(job(10, 0), result({ height: 720 }));
    expect(settled).toHaveLength(0);
    settler.landed(job(10, 9), result({ height: 1080 }));
    expect(settled).toHaveLength(1);
    // The verdict is the stream's best login, not the last to land.
    expect(settled[0]?.[1]?.height).toBe(1080);
  });

  it('settles a single-login stream the moment its probe returns', () => {
    const settled: Array<[number, ProbeResult | null]> = [];
    const settler = makeStreamSettler([job(10, 0)], {
      weights: DEFAULT_WEIGHTS,
      onSettled: (streamId, best) => settled.push([streamId, best]),
    });
    settler.landed(job(10, 0), result());
    expect(settled).toHaveLength(1);
  });

  it('counts a stream alive when any login is, and dead only when all are', () => {
    const settled: Array<[number, ProbeResult | null]> = [];
    const settler = makeStreamSettler([job(10, 0), job(10, 9)], {
      weights: DEFAULT_WEIGHTS,
      onSettled: (streamId, best) => settled.push([streamId, best]),
    });
    settler.landed(job(10, 0), result({ alive: false, bitrateKbps: 0, error: 'banned' }));
    settler.landed(job(10, 9), result());
    expect(settled[0]?.[1]?.alive).toBe(true);
  });

  it('settles with no verdict when every queued probe failed or was skipped', () => {
    const settled: Array<[number, ProbeResult | null]> = [];
    const settler = makeStreamSettler([job(10, 0), job(10, 9)], {
      weights: DEFAULT_WEIGHTS,
      onSettled: (streamId, best) => settled.push([streamId, best]),
    });
    settler.landed(job(10, 0), null);
    settler.landed(job(10, 9), null);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.[1]).toBeNull();
  });
});
