/**
 * Unassigning a stream that has been dead for long enough.
 *
 * Ranking sinks a dead stream, which is enough while the channel has something
 * better -- but nothing ever clears one, so a channel whose lineup died months
 * ago goes on carrying streams nobody can watch. This removes them after N
 * consecutive dead checks.
 *
 * Removal has no undo, so most of what follows is about what it must *not*
 * take: a provider having an outage (the failure that made unmatched removal
 * dangerous, arriving without the `is_stale` flag to read), a stale stream, a
 * black screen or thin stream -- both of which are alive -- and the last stream
 * on a channel.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import type { Channel, DispatcharrClient, Stream } from './dispatcharr';
import type { ProbeResult } from './probe';
import { RulesSource } from './rules-source';
import {
  type DeadRemoval,
  deadRemovalPlan,
  dropDeadStreams,
  type PlannedChannel,
  providersInOutage,
  Runner,
} from './runner';
import { DEFAULT_STRATEGY } from './scoring';
import type { DeadStreamRow } from './store';
import { Store } from './store';

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    alive: true,
    width: 1920,
    height: 1080,
    fps: 50,
    bitrateKbps: 8000,
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
  };
}

const alive = probe();
const dead = probe({ alive: false, width: 0, height: 0, bitrateKbps: 0, error: 'timeout' });
const black = probe({ black: true });

const stream = (id: number, over: Partial<Stream> = {}): Stream => ({
  id,
  name: `Feed ${id}`,
  url: `u${id}`,
  providerId: 5,
  streamHash: 'h',
  currentViewers: 0,
  groupId: 100,
  ...over,
});

const deadRow = (streamId: number, deadStreak: number, result = dead): DeadStreamRow => ({
  streamId,
  probedAt: Date.now(),
  deadStreak,
  result,
});

/** Three streams on one provider, all catalogued and none stale. */
const catalogue = new Map([1, 2, 3].map((id) => [id, stream(id)]));

/** A catalogue Podium manages in full -- the small-install case. */
const allProbed = (byId: Map<number, Stream>) => new Set(byId.keys());

const planFor = (rows: DeadStreamRow[], after = 3, byId = catalogue, probed = allProbed(byId)) =>
  deadRemovalPlan(after, rows, byId, probed) as DeadRemoval;

/** The streak map a pass reads per channel, built the way `Store.deadStreaks` does. */
const streaksOf = (rows: DeadStreamRow[]) =>
  new Map(rows.filter((r) => !r.result.alive).map((r) => [r.streamId, r.deadStreak]));

const drop = (
  order: number[],
  byId: Map<number, Stream>,
  plan: DeadRemoval | undefined,
  rows: DeadStreamRow[] = [],
  alive = new Set<number>(),
) => dropDeadStreams(order, byId, plan, streaksOf(rows), alive);

describe('reading the plan', () => {
  it('is off unless asked for', () => {
    // The default. Removal is destructive, so nothing about it may arrive by
    // accident.
    expect(deadRemovalPlan(0, [deadRow(1, 99)], catalogue, allProbed(catalogue))).toBeUndefined();
    expect(
      deadRemovalPlan(Number.NaN, [deadRow(1, 99)], catalogue, allProbed(catalogue)),
    ).toBeUndefined();
  });

  it('refuses a fractional threshold rather than flooring it to zero', () => {
    // `num()` takes any finite number and the settings form will persist one.
    // Floored after an `after <= 0` guard, 0.5 becomes a threshold of zero --
    // which condemns every dead stream on its first dead verdict. Floor first.
    for (const fraction of [0.5, 0.9, 0.999]) {
      expect(
        deadRemovalPlan(fraction, [deadRow(1, 1)], catalogue, allProbed(catalogue)),
      ).toBeUndefined();
    }
    // And a real threshold still arrives whole.
    expect(deadRemovalPlan(3.7, [], catalogue, allProbed(catalogue))?.after).toBe(3);
  });

  it('counts dead verdicts and nothing else', () => {
    // A black screen is alive: it sinks in the ranking, and any live verdict
    // resets the streak, so it can never accumulate its way to removal.
    const streaks = streaksOf([deadRow(1, 4), deadRow(2, 0, black)]);
    expect(streaks.get(1)).toBe(4);
    expect(streaks.has(2)).toBe(false);
  });
});

describe('spotting a provider outage', () => {
  /** Six managed streams, which is above the minimum sample. */
  const six = new Map([1, 2, 3, 4, 5, 6].map((id) => [id, stream(id)]));

  it('flags a provider whose managed streams have mostly gone dead', () => {
    const streaks = new Map([1, 2, 3, 4].map((id) => [id, 6]));
    expect(providersInOutage(six, streaks, allProbed(six))).toEqual(new Set([5]));
  });

  it('leaves a provider that is merely half dead alone', () => {
    // Half is not more than half: a genuinely dead half of a catalogue is the
    // case this feature is meant to clean up.
    const streaks = new Map([1, 2, 3].map((id) => [id, 6]));
    expect(providersInOutage(six, streaks, allProbed(six)).has(5)).toBe(false);
  });

  it('judges each provider on its own streams', () => {
    const byId = new Map(
      [1, 2, 3, 4, 5, 6, 7, 8].map((id) => [id, stream(id, { providerId: id <= 4 ? 5 : 9 })]),
    );
    const streaks = new Map([1, 2, 3].map((id) => [id, 6]));
    const outages = providersInOutage(byId, streaks, allProbed(byId));
    expect(outages.has(5)).toBe(true);
    expect(outages.has(9)).toBe(false);
  });

  it('measures the share against managed streams, not the provider catalogue', () => {
    // The regression that made this guard useless. `client.streams()` returns
    // every stream on the account; the cache only ever holds the ones Podium
    // manages, because `pruneOutside` deletes the rest. Judged against the
    // catalogue, a provider 100% down reads 2% dead and nothing stops the
    // pass stripping its streams off every channel it served.
    const byId = new Map<number, Stream>();
    for (let id = 1; id <= 20_000; id += 1) byId.set(id, stream(id));

    const managed = new Set<number>();
    const streaks = new Map<number, number>();
    for (let id = 1; id <= 400; id += 1) {
      managed.add(id);
      streaks.set(id, 9);
    }

    expect(providersInOutage(byId, streaks, managed).has(5)).toBe(true);
  });

  it('will not call an outage on too small a sample', () => {
    // One managed stream on a provider reads 1/1 dead, which would lock it in
    // a permanent outage and mean the one thing this feature exists to clean
    // up could never be cleaned up.
    const byId = new Map([[1, stream(1)]]);
    expect(providersInOutage(byId, new Map([[1, 9]]), allProbed(byId)).has(5)).toBe(false);
    const rows = [deadRow(2, 9)];
    expect(drop([1, 2], catalogue, planFor(rows), rows).order).toEqual([1]);
  });
});

describe('dropping the long-dead from an order', () => {
  it('waits for the count', () => {
    const short = [deadRow(2, 2)];
    const long = [deadRow(2, 3)];
    expect(drop([1, 2], catalogue, planFor(short), short).order).toEqual([1, 2]);
    expect(drop([1, 2], catalogue, planFor(long), long).order).toEqual([1]);
  });

  it('does nothing at all when the setting is off', () => {
    const order = [1, 2];
    const result = dropDeadStreams(order, catalogue, undefined);
    expect(result.order).toBe(order);
    expect(result.dropped).toEqual([]);
  });

  it('spares a stream this pass found alive, whatever the cache said', () => {
    // The plan is built once, before the probes run. A stream whose TTL was up
    // and which answered has had its streak reset in the same breath -- and if
    // the two ever disagree, the verdict in hand wins.
    const rows = [deadRow(2, 9)];
    const result = drop([1, 2], catalogue, planFor(rows), rows, new Set([2]));
    expect(result.order).toEqual([1, 2]);
    expect(result.dropped).toEqual([]);
  });

  it('will not touch a stale stream', () => {
    // Dispatcharr marking a stream stale is the provider's business, and says
    // nothing about whether this channel should carry it -- the same rule
    // `protectedFromRemoval` follows.
    const byId = new Map([
      [1, stream(1)],
      [2, stream(2, { is_stale: true })],
    ]);
    const rows = [deadRow(2, 9)];
    expect(drop([1, 2], byId, planFor(rows, 3, byId), rows).order).toEqual([1, 2]);
  });

  it('will not touch a stream the catalogue no longer carries', () => {
    const rows = [deadRow(77, 9)];
    expect(drop([1, 77], catalogue, planFor(rows), rows).order).toEqual([1, 77]);
  });

  it('leaves a provider in outage entirely alone', () => {
    // Every stream on the account is long dead, which is what being down looks
    // like from here. Removing them would survive the outage; the streams
    // would not come back to the channels they were on.
    const byId = new Map([1, 2, 3, 4, 5, 6].map((id) => [id, stream(id)]));
    const rows = [1, 2, 3, 4, 5].map((id) => deadRow(id, 9));
    const plan = planFor(rows, 3, byId);
    expect(plan.outages.has(5)).toBe(true);
    expect(drop([1, 2, 3], byId, plan, rows).order).toEqual([1, 2, 3]);
  });

  it('never empties a channel, and keeps the best-ranked of a dead lineup', () => {
    // The order is ranked, so the survivor is the least-bad stream. A channel
    // carrying nothing serves nothing and explains nothing -- and one ranked
    // off its own assignment could never get a stream back.
    //
    // Six streams on the provider and two of them dead: this channel's lineup
    // is gone, the provider is fine, and the outage guard stays out of it.
    const byId = new Map([1, 2, 3, 4, 5, 6].map((id) => [id, stream(id)]));
    const rows = [deadRow(1, 5), deadRow(2, 5)];
    const result = drop([1, 2], byId, planFor(rows, 3, byId), rows);
    expect(result.order).toEqual([1]);
    expect(result.dropped).toEqual([2]);
  });
});

describe('a pass writing a channel with a long-dead stream', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;

  // The two streams on the channel, plus four more the provider serves
  // elsewhere: one dead stream out of six is a dead stream, not an outage.
  const byId = new Map([1, 2, 3, 4, 5, 6].map((id) => [id, stream(id)]));

  const channel: Channel = {
    id: 1,
    name: 'Channel One',
    tvgId: 'one',
    streams: [1, 2],
    groupId: 100,
  };

  const planned: PlannedChannel = {
    channel,
    hits: [
      [1, 0],
      [2, 1],
    ],
    fresh: new Map([
      [1, new Map([[0, alive]])],
      [2, new Map([[0, dead]])],
    ]),
    settled: new Set([1, 2]),
    cacheComplete: true,
  };

  const spyClient = (writes: number[][]) =>
    ({
      channel: async () => null,
      setStreamOrder: async (_channelId: number, order: number[]) => {
        writes.push(order);
      },
    }) as unknown as DispatcharrClient;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-dead-'));
    const rulesPath = join(dir, 'rules.json');
    const tmp = `${rulesPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ schema: 2, channels: [] }), 'utf8');
    renameSync(tmp, rulesPath);
    store = new Store(join(dir, 'podium.db'));
    runner = new Runner({
      config: () => loadConfig({ DISPATCHARR_API_KEY: 'k', PODIUM_DRY_RUN: 'false' }),
      store,
      rules: new RulesSource(rulesPath),
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function writeBack(client: DispatcharrClient, removal?: DeadRemoval) {
    const counters = { reordered: 0, unchanged: 0, assigned: 0, removed: 0, measured: 0 };
    await (
      runner as unknown as { reorderCachedOnly: (...args: unknown[]) => Promise<void> }
    ).reorderCachedOnly.call(
      runner,
      client,
      [planned],
      counters,
      DEFAULT_STRATEGY,
      byId,
      new Map([[5, 'Provider A']]),
      removal,
    );
    return counters;
  }

  it('spares a stream that came back to life during the pass', async () => {
    // The data-loss case. The plan is built once, at pass start, from the
    // cache as it stood *before* any probe ran. This stream was long dead, so
    // the plan condemns it; then its TTL came up, the pass probed it, and it
    // answered. `put()` has already put the streak back to zero, and the
    // verdict the ranking used is alive. Nothing may take it off the channel.
    for (let i = 0; i < 5; i += 1) store.put(2, 'h', dead);
    store.put(1, 'h', alive);
    const plan = deadRemovalPlan(3, store.deadStreams(), byId, store.probedStreamIds());
    expect(plan).toBeDefined();

    store.put(2, 'h', alive);
    const revived: PlannedChannel = {
      ...planned,
      fresh: new Map([
        [1, new Map([[0, alive]])],
        [2, new Map([[0, alive]])],
      ]),
    };

    const writes: number[][] = [];
    const counters = { reordered: 0, unchanged: 0, assigned: 0, removed: 0, measured: 0 };
    await (
      runner as unknown as { reorderCachedOnly: (...args: unknown[]) => Promise<void> }
    ).reorderCachedOnly.call(
      runner,
      spyClient(writes),
      [revived],
      counters,
      DEFAULT_STRATEGY,
      byId,
      new Map([[5, 'Provider A']]),
      plan,
    );

    expect(counters.removed).toBe(0);
    expect(writes).toEqual([]);
  });

  it('removes a stream that reached the threshold while the pass ran', async () => {
    // The same staleness from the other side. At pass start the streak was one
    // short, so a frozen plan would spare it for another cycle -- up to a day,
    // at the far end of the dead back-off. The count is read when the write is
    // decided, so this pass acts on what it just learned.
    for (let i = 0; i < 2; i += 1) store.put(2, 'h', dead);
    store.put(1, 'h', alive);
    const plan = deadRemovalPlan(3, store.deadStreams(), byId, store.probedStreamIds());

    store.put(2, 'h', dead);

    const writes: number[][] = [];
    const counters = await writeBack(spyClient(writes), plan);

    expect(writes).toEqual([[1]]);
    expect(counters.removed).toBe(1);
  });

  it('re-reads the live order and still drops, counting against what it wrote', async () => {
    // The re-fetch path: a long pass means the pass-start order may be stale,
    // so the write is recomposed against what Dispatcharr holds now. A third
    // stream appeared on the channel meanwhile; the dead one still goes, and
    // the count is measured against the live order rather than the stale one.
    for (let i = 0; i < 4; i += 1) store.put(2, 'h', dead);
    store.put(1, 'h', alive);
    store.put(3, 'h', alive);

    const writes: number[][] = [];
    const client = {
      channel: async () => ({ id: 1, name: 'Channel One', streams: [3, 1, 2], groupId: 100 }),
      setStreamOrder: async (_id: number, order: number[]) => {
        writes.push(order);
      },
    } as unknown as DispatcharrClient;

    const counters = await writeBack(
      client,
      deadRemovalPlan(3, store.deadStreams(), byId, store.probedStreamIds()),
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toContain(2);
    expect(writes[0]).toContain(1);
    expect(counters.removed).toBe(1);
  });

  it('records the removal against the run', async () => {
    // Logs rotate. A pass that quietly removes has to leave something behind
    // that outlives the container.
    for (let i = 0; i < 3; i += 1) store.put(2, 'h', dead);
    store.put(1, 'h', alive);

    const counters = await writeBack(
      spyClient([]),
      deadRemovalPlan(3, store.deadStreams(), byId, store.probedStreamIds()),
    );
    store.startRun('run-1');
    store.finishRun('run-1', { removed: counters.removed });

    expect(store.recentRuns(1)[0]?.removed).toBe(1);
    expect(store.runTotals().removed).toBe(1);
  });

  it('takes the stream off once the streak reaches the threshold', async () => {
    // Built through the real cache: three dead probes in a row is what a
    // streak of three actually is.
    for (let i = 0; i < 3; i += 1) store.put(2, 'h', dead);
    store.put(1, 'h', alive);

    const writes: number[][] = [];
    const counters = await writeBack(
      spyClient(writes),
      deadRemovalPlan(3, store.deadStreams(), byId, store.probedStreamIds()),
    );

    expect(writes).toEqual([[1]]);
    expect(counters.removed).toBe(1);
  });

  it('keeps it while the streak is short of the threshold', async () => {
    store.put(2, 'h', dead);
    store.put(2, 'h', dead);
    store.put(1, 'h', alive);

    const writes: number[][] = [];
    const counters = await writeBack(
      spyClient(writes),
      deadRemovalPlan(3, store.deadStreams(), byId, store.probedStreamIds()),
    );

    // Already in ranked order (the dead stream sinks to the bottom either way),
    // so there is nothing to write at all.
    expect(writes).toEqual([]);
    expect(counters.removed).toBe(0);
    expect(counters.unchanged).toBe(1);
  });

  it('keeps it when the setting is off, however long it has been dead', async () => {
    for (let i = 0; i < 20; i += 1) store.put(2, 'h', dead);
    store.put(1, 'h', alive);

    const writes: number[][] = [];
    const counters = await writeBack(spyClient(writes), undefined);

    expect(writes).toEqual([]);
    expect(counters.removed).toBe(0);
  });

  it('a live verdict puts the count back to zero', async () => {
    // The recovery path: a stream that comes good has no history held against
    // it, so the next outage starts its clock again.
    for (let i = 0; i < 5; i += 1) store.put(2, 'h', dead);
    store.put(2, 'h', alive);
    store.put(2, 'h', dead);
    store.put(1, 'h', alive);

    const writes: number[][] = [];
    const counters = await writeBack(
      spyClient(writes),
      deadRemovalPlan(3, store.deadStreams(), byId, store.probedStreamIds()),
    );

    expect(writes).toEqual([]);
    expect(counters.removed).toBe(0);
  });
});

/**
 * The same two questions asked at the scale an install actually runs at, and
 * wired through the real cache rather than a hand-built plan: the guard has to
 * hold when the numbers are 400 managed streams against a 20,000-stream
 * catalogue, and it has to stay out of the way when the provider is fine.
 */
describe('at the scale of a real provider', () => {
  let dir: string;
  let store: Store;

  /** Provider 5 lists 20,000 streams. Podium manages the first 400. */
  const listed = new Map<number, Stream>();
  for (let id = 1; id <= 20_000; id += 1) listed.set(id, stream(id));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-scale-'));
    store = new Store(join(dir, 'podium.db'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const planNow = () => deadRemovalPlan(3, store.deadStreams(), listed, store.probedStreamIds());

  it('protects every assignment when the whole account goes down', () => {
    for (let id = 1; id <= 400; id += 1) {
      for (let i = 0; i < 5; i += 1) store.put(id, 'h', dead);
    }

    const plan = planNow();
    const order = [1, 2, 3];
    const result = dropDeadStreams(order, listed, plan, store.deadStreaks(order));

    expect(plan?.outages.has(5)).toBe(true);
    expect(result.dropped).toEqual([]);
  });

  it('still clears a channel whose own lineup died on a healthy provider', () => {
    for (let id = 1; id <= 400; id += 1) store.put(id, 'h', alive);
    for (const id of [7, 8]) for (let i = 0; i < 5; i += 1) store.put(id, 'h', dead);

    const plan = planNow();
    const order = [6, 7, 8];
    const result = dropDeadStreams(order, listed, plan, store.deadStreaks(order));

    expect(plan?.outages.has(5)).toBe(false);
    expect(result.order).toEqual([6]);
    expect([...result.dropped].sort()).toEqual([7, 8]);
  });
});
