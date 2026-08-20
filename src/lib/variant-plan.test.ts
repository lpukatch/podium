/**
 * Planning and settling with several logins per provider.
 *
 * The logins are a pool: a stream is drawn by one of them per pass, cached
 * against the stream rather than the login that fetched it, and counted once
 * everywhere a person reads it. These pin that -- the draw's proportions, and
 * that a second login adds capacity without adding work.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import type { Channel, Provider, Stream } from './dispatcharr';
import type { ProbeResult } from './probe';
import { RulesSource } from './rules-source';
import { laneBudgets, makeStreamSettler, Runner } from './runner';
import { laneKey, type ProbeJob } from './scheduler';
import { DEFAULT_WEIGHTS } from './scoring';
import { Store } from './store';
import {
  buildVariants,
  drawVariant,
  POOLED_VARIANT,
  type ProviderLogin,
  providerLogins,
} from './variants';

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
  accountType: 'STD',
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

  /** The one target the pool draws for stream 10, as the runner would. */
  const drawn = (slots: Map<string, number>, seq = 0) =>
    new Map([[10, [drawVariant(buildVariants(URL, providerLogins(provider())), 5, slots, seq)]]]);

  const bothOpen = new Map([
    [laneKey(5, 0), 3],
    [laneKey(5, 9), 2],
  ]);

  it('queues one job for the stream, through the login that drew it', () => {
    const { rules, runner } = build();
    // Seq 3 lands past the default login's three slots, so the second login
    // draws this one -- and the job carries that login's rewritten URL.
    const variantsByStream = drawn(bothOpen, 3);

    let planned = plan(runner, rules, variantsByStream);
    expect(planned.jobs.map((job) => job.profileId)).toEqual([9]);
    expect(planned.jobs[0]?.url).toBe('http://crx.watch/live/coffee2/secret/1234.ts');

    // One verdict settles the stream, whichever login fetched it: the cache is
    // keyed on the stream, so the next pass has nothing to do.
    store.put(10, 'h', result(), POOLED_VARIANT);
    const counters = { cached: 0 };
    planned = plan(runner, rules, variantsByStream, counters);
    expect(planned.jobs).toHaveLength(0);
    expect(counters.cached).toBe(1);
    expect(planned.planned[0]?.cacheComplete).toBe(true);
  });

  it('does not re-probe because a different login drew the stream last time', () => {
    // The point of pooling: a verdict fetched through the default login is a
    // verdict for the stream, so a pass that would have drawn the second login
    // still finds nothing due. Keying the cache per login is what made a
    // second profile double the work.
    const { rules, runner } = build();
    store.put(10, 'h', result(), POOLED_VARIANT);
    for (const seq of [0, 1, 2, 3, 4]) {
      expect(plan(runner, rules, drawn(bothOpen, seq)).jobs).toHaveLength(0);
    }
  });

  it('re-probes the stream once its verdict expires', () => {
    const { rules, runner } = build();
    const stale = Date.now() - 25 * 3_600_000; // past the live TTL
    // Stamped by raw SQL: put() always writes "now", and the age is the point.
    (
      store as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
      }
    ).db
      .prepare(
        `INSERT INTO probe_cache (stream_id, stream_hash, variant_id, probed_at, alive, result, dead_streak)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(10, 'h', POOLED_VARIANT, stale, 1, JSON.stringify(result()));

    const planned = plan(runner, rules, drawn(bothOpen));
    expect(planned.jobs.map((job) => job.streamId)).toEqual([10]);
  });

  it('counts a marked stream once, and clears it on one verdict', () => {
    const { rules, runner } = build();
    // Probed a minute before the request, stamped explicitly: a tie with
    // `Date.now()` would make the outcome depend on the clock.
    const before = Date.now() - 60_000;
    (
      store as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
      }
    ).db
      .prepare(
        `INSERT INTO probe_cache (stream_id, stream_hash, variant_id, probed_at, alive, result, dead_streak)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(10, 'h', POOLED_VARIANT, before, 1, JSON.stringify(result()));
    // Stamped between the verdict and the re-probe below, rather than at
    // `Date.now()`: `put` writes the current instant, and on a fast machine it
    // can tie with the mark -- which reads as "measured before I asked" and
    // leaves the mark open regardless of what this is testing.
    store.setRefreshMark(100, before + 30_000);

    let planned = plan(runner, rules, drawn(bothOpen));
    expect(planned.outstandingMarks[0]?.remaining).toBe(1);

    // A single fresh verdict is the whole of the stream's re-check.
    store.put(10, 'h', result(), POOLED_VARIANT);
    planned = plan(runner, rules, drawn(bothOpen));
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

  it('settles the streams an abort left half-probed, on what did land', () => {
    // The scheduler skips a queued job outright once the run aborts, without
    // ever calling the probe -- so nothing lands for it and nothing ever
    // will. Draining settles the stream on its other login rather than
    // leaving a cached verdict uncounted and unpublished.
    const settled: Array<[number, ProbeResult | null]> = [];
    const settler = makeStreamSettler([job(10, 0), job(10, 9), job(11, 0)], {
      weights: DEFAULT_WEIGHTS,
      onSettled: (streamId, best) => settled.push([streamId, best]),
    });

    settler.landed(job(10, 0), result({ height: 720 }));
    expect(settled).toHaveLength(0);

    settler.drain();
    expect(settled.map(([streamId]) => streamId)).toEqual([10, 11]);
    expect(settled[0]?.[1]?.height).toBe(720);
    // Stream 11 never got a probe in at all, so it has no verdict to report.
    expect(settled[1]?.[1]).toBeNull();
  });

  it('drains only once, so a settled stream is never counted twice', () => {
    const settled: number[] = [];
    const settler = makeStreamSettler([job(10, 0)], {
      weights: DEFAULT_WEIGHTS,
      onSettled: (streamId) => settled.push(streamId),
    });
    settler.landed(job(10, 0), result());
    settler.drain();
    settler.drain();
    expect(settled).toEqual([10]);
  });
});

describe('lane budgets', () => {
  const login = (over: Partial<ProviderLogin> = {}): ProviderLogin => ({
    id: 0,
    dispatcharrProfileId: 5,
    name: 'Default',
    rewrite: null,
    maxStreams: 3,
    currentViewers: 0,
    isDefault: true,
    xtreamCodes: false,
    ...over,
  });

  it('gives each login its own cap, keyed by lane', () => {
    const budgets = laneBudgets(
      new Map([[5, [login(), login({ id: 9, isDefault: false, maxStreams: 2 })]]]),
      new Map(),
    );
    expect([...budgets.base]).toEqual([
      ['5:0', 3],
      ['5:9', 2],
    ]);
    expect([...budgets.provider.values()]).toEqual([5, 5]);
  });

  it('subtracts the viewers each login reports', () => {
    const budgets = laneBudgets(
      new Map([
        [5, [login({ currentViewers: 1 }), login({ id: 9, isDefault: false, currentViewers: 2 })]],
      ]),
      new Map([[5, 3]]),
    );
    expect([...budgets.viewers]).toEqual([
      ['5:0', 1],
      ['5:9', 2],
    ]);
  });

  it('charges viewers no login claims to the default lane', () => {
    // `current_viewers` is a database column, not Dispatcharr's live
    // connection accounting, so an install where it stays zero would
    // otherwise probe straight through somebody watching. The provider-wide
    // count from the activity probe is the floor.
    const budgets = laneBudgets(
      new Map([[5, [login(), login({ id: 9, isDefault: false })]]]),
      new Map([[5, 2]]),
    );
    expect(budgets.viewers.get('5:0')).toBe(2);
    expect(budgets.viewers.get('5:9')).toBe(0);
  });

  it('charges a viewer to the login they are actually watching through', () => {
    // `/proxy/ts/status` names the profile Dispatcharr picked for each live
    // session. Without it the whole provider-wide count lands on the default
    // lane, and the second login probes at its full cap straight through
    // somebody already using it.
    const budgets = laneBudgets(
      new Map([
        [5, [login(), login({ id: 9, dispatcharrProfileId: 9, isDefault: false, maxStreams: 2 })]],
      ]),
      new Map([[5, 1]]),
      new Map([[9, 1]]),
    );
    expect(budgets.viewers.get('5:0')).toBe(0);
    expect(budgets.viewers.get('5:9')).toBe(1);
  });

  it('charges the default lane by its profile id, which its lane key discards', () => {
    const budgets = laneBudgets(
      new Map([[5, [login(), login({ id: 9, dispatcharrProfileId: 9, isDefault: false })]]]),
      new Map([[5, 1]]),
      // Profile 5 is the default login, whose lane is `5:0`.
      new Map([[5, 1]]),
    );
    expect(budgets.viewers.get('5:0')).toBe(1);
    expect(budgets.viewers.get('5:9')).toBe(0);
  });

  it('still gives the default lane a session no login was named for', () => {
    // Two watching, one of them on a profile the payload named. The other is
    // unattributed and falls to the default, as it always did.
    const budgets = laneBudgets(
      new Map([[5, [login(), login({ id: 9, dispatcharrProfileId: 9, isDefault: false })]]]),
      new Map([[5, 2]]),
      new Map([[9, 1]]),
    );
    expect(budgets.viewers.get('5:0')).toBe(1);
    expect(budgets.viewers.get('5:9')).toBe(1);
  });

  it('takes whichever viewer count is higher, never the lower', () => {
    const budgets = laneBudgets(
      new Map([[5, [login({ currentViewers: 2 })]]]),
      new Map(),
      new Map([[5, 1]]),
    );
    expect(budgets.viewers.get('5:0')).toBe(2);
  });

  it('never charges a lane for viewers already accounted for', () => {
    const budgets = laneBudgets(new Map([[5, [login({ currentViewers: 2 })]]]), new Map([[5, 1]]));
    expect(budgets.viewers.get('5:0')).toBe(2);
  });

  it('spreads unattributed viewers when the account has no default login', () => {
    const budgets = laneBudgets(
      new Map([[5, [login({ id: 8, isDefault: false }), login({ id: 9, isDefault: false })]]]),
      new Map([[5, 3]]),
    );
    expect(budgets.viewers.get('5:8')).toBe(2);
    expect(budgets.viewers.get('5:9')).toBe(2);
  });
});
