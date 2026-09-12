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

const planFor = (rows: DeadStreamRow[], after = 3, byId = catalogue) =>
  deadRemovalPlan(after, rows, byId) as DeadRemoval;

describe('reading the plan', () => {
  it('is off unless asked for', () => {
    // The default. Removal is destructive, so nothing about it may arrive by
    // accident.
    expect(deadRemovalPlan(0, [deadRow(1, 99)], catalogue)).toBeUndefined();
    expect(deadRemovalPlan(Number.NaN, [deadRow(1, 99)], catalogue)).toBeUndefined();
  });

  it('counts dead verdicts and nothing else', () => {
    // A black screen is alive: it sinks in the ranking, and any live verdict
    // resets the streak, so it can never accumulate its way to removal.
    const plan = planFor([deadRow(1, 4), deadRow(2, 0, black)]);
    expect(plan.streaks.get(1)).toBe(4);
    expect(plan.streaks.has(2)).toBe(false);
  });
});

describe('spotting a provider outage', () => {
  it('flags a provider whose catalogue has mostly gone dead', () => {
    const streaks = new Map([
      [1, 6],
      [2, 6],
    ]);
    expect(providersInOutage(catalogue, streaks)).toEqual(new Set([5]));
  });

  it('leaves a provider that is merely half dead alone', () => {
    // Half is not more than half: a genuinely dead half of a catalogue is the
    // case this feature is meant to clean up.
    const byId = new Map([1, 2, 3, 4].map((id) => [id, stream(id)]));
    const streaks = new Map([
      [1, 6],
      [2, 6],
    ]);
    expect(providersInOutage(byId, streaks).has(5)).toBe(false);
  });

  it('judges each provider on its own streams', () => {
    const byId = new Map([
      [1, stream(1, { providerId: 5 })],
      [2, stream(2, { providerId: 5 })],
      [3, stream(3, { providerId: 9 })],
    ]);
    const streaks = new Map([
      [1, 6],
      [2, 6],
    ]);
    const outages = providersInOutage(byId, streaks);
    expect(outages.has(5)).toBe(true);
    expect(outages.has(9)).toBe(false);
  });
});

describe('dropping the long-dead from an order', () => {
  it('waits for the count', () => {
    expect(dropDeadStreams([1, 2], catalogue, planFor([deadRow(2, 2)])).order).toEqual([1, 2]);
    expect(dropDeadStreams([1, 2], catalogue, planFor([deadRow(2, 3)])).order).toEqual([1]);
  });

  it('does nothing at all when the setting is off', () => {
    const order = [1, 2];
    const result = dropDeadStreams(order, catalogue, undefined);
    expect(result.order).toBe(order);
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
    expect(dropDeadStreams([1, 2], byId, planFor([deadRow(2, 9)], 3, byId)).order).toEqual([1, 2]);
  });

  it('will not touch a stream the catalogue no longer carries', () => {
    expect(dropDeadStreams([1, 77], catalogue, planFor([deadRow(77, 9)])).order).toEqual([1, 77]);
  });

  it('leaves a provider in outage entirely alone', () => {
    // Every stream on the account is long dead, which is what being down looks
    // like from here. Removing them would survive the outage; the streams
    // would not come back to the channels they were on.
    const plan = planFor([deadRow(1, 9), deadRow(2, 9), deadRow(3, 9)]);
    expect(plan.outages.has(5)).toBe(true);
    expect(dropDeadStreams([1, 2, 3], catalogue, plan).order).toEqual([1, 2, 3]);
  });

  it('never empties a channel, and keeps the best-ranked of a dead lineup', () => {
    // The order is ranked, so the survivor is the least-bad stream. A channel
    // carrying nothing serves nothing and explains nothing -- and one ranked
    // off its own assignment could never get a stream back.
    //
    // Six streams on the provider and two of them dead: this channel's lineup
    // is gone, the provider is fine, and the outage guard stays out of it.
    const byId = new Map([1, 2, 3, 4, 5, 6].map((id) => [id, stream(id)]));
    const plan = planFor([deadRow(1, 5), deadRow(2, 5)], 3, byId);
    const result = dropDeadStreams([1, 2], byId, plan);
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

  it('takes the stream off once the streak reaches the threshold', async () => {
    // Built through the real cache: three dead probes in a row is what a
    // streak of three actually is.
    for (let i = 0; i < 3; i += 1) store.put(2, 'h', dead);
    store.put(1, 'h', alive);

    const writes: number[][] = [];
    const counters = await writeBack(
      spyClient(writes),
      deadRemovalPlan(3, store.deadStreams(), byId),
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
      deadRemovalPlan(3, store.deadStreams(), byId),
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
      deadRemovalPlan(3, store.deadStreams(), byId),
    );

    expect(writes).toEqual([]);
    expect(counters.removed).toBe(0);
  });
});
