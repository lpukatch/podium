/**
 * Groups Podium measures but never writes to.
 *
 * A fixture channel created by another app -- Teamarr -- carries its own idea
 * of stream order and rewrites it on its own schedule, so an order written from
 * here is overwritten and the two applications take turns clobbering the same
 * field. What is worth having from those channels is the measurement: probed
 * after kickoff while nobody is watching, they are the only source of what the
 * right order *would* have been, which is what the quality priors are fitted
 * from and what the exported rules hand back.
 *
 * So these pin the split: everything up to the write still happens, and the
 * write does not.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import type { Channel, Stream } from './dispatcharr';
import { AFTER_EPG_START, parseGroupPatterns, parsePolicies } from './eligibility';
import type { ProbeResult } from './probe';
import { RulesSource } from './rules-source';
import { type PlannedChannel, Runner } from './runner';
import { DEFAULT_STRATEGY } from './scoring';
import { Store } from './store';

describe('parsing the flag', () => {
  it('reads measure_only on a group and on a pattern', () => {
    const groups = parsePolicies({
      '7': { mode: AFTER_EPG_START, measure_only: true },
      '8': { mode: AFTER_EPG_START },
    });
    expect(groups.get(7)?.measureOnly).toBe(true);
    expect(groups.get(8)?.measureOnly).toBe(false);

    const patterns = parseGroupPatterns([
      { pattern: 'Auto | *', mode: AFTER_EPG_START, measure_only: true },
    ]);
    expect(patterns[0]?.measureOnly).toBe(true);
  });

  it('is off unless asked for, on every path', () => {
    // A flag that suppresses writes must never arrive by accident: an install
    // that has not asked for it would silently stop ordering its channels.
    expect(parsePolicies({ '7': 'never' }).get(7)?.measureOnly).toBe(false);
    expect(parseGroupPatterns([{ pattern: '*', mode: 'always' }])[0]?.measureOnly).toBe(false);
  });
});

describe('the pass', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;

  const result: ProbeResult = {
    alive: true,
    width: 1920,
    height: 1080,
    fps: 50,
    bitrateKbps: 6000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    pixelFormat: 'yuv420p',
    audioChannels: 2,
    channelLayout: 'stereo',
    audioBitrateKbps: 128,
    audioSampleRate: 48_000,
    bitrateMeasured: true,
    black: false,
    blackSeconds: 0,
    elapsedMs: 1000,
    error: '',
  };

  const stream = (id: number): Stream => ({
    id,
    name: `EPL0${id}: Home vs Away`,
    url: `u${id}`,
    providerId: 5,
    streamHash: 'h',
    currentViewers: 0,
    groupId: 100,
  });

  /**
   * A channel carrying two streams, the second measurably better than the
   * first, so a pass that is allowed to write has something to write.
   */
  const channel: Channel = { id: 1, name: 'EPL01', tvgId: 'epl.id', streams: [1, 2], groupId: 100 };

  const plannedFor = (measureOnly: boolean): PlannedChannel => ({
    channel,
    hits: channel.streams.map((id, i) => [id, i] as [number, number]),
    fresh: new Map([
      [1, new Map([[0, { ...result, bitrateKbps: 2000 }]])],
      [2, new Map([[0, { ...result, bitrateKbps: 9000 }]])],
    ]),
    settled: new Set(channel.streams),
    cacheComplete: true,
    measureOnly,
  });

  /** Records every method a write path reaches for. */
  const spyClient = (touched: string[]) =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          touched.push(String(prop));
          return () => Promise.resolve(null);
        },
      },
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-measure-'));
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

  /** reorderCachedOnly is private; reach it rather than faking a whole pass. */
  async function writeBack(planned: PlannedChannel[], client: unknown) {
    const counters = { reordered: 0, unchanged: 0, assigned: 0, measured: 0 };
    await (
      runner as unknown as {
        reorderCachedOnly: (...args: unknown[]) => Promise<void>;
      }
    ).reorderCachedOnly.call(
      runner,
      client,
      planned,
      counters,
      DEFAULT_STRATEGY,
      new Map([
        [1, stream(1)],
        [2, stream(2)],
      ]),
      new Map([[5, 'Provider A']]),
    );
    return counters;
  }

  it('writes nothing at all for a measure-only channel', async () => {
    // Not "writes the same order back" -- Dispatcharr is never asked. A write
    // another app immediately overwrites is load on both of them and a race on
    // the field a viewer actually reads.
    const touched: string[] = [];
    const counters = await writeBack([plannedFor(true)], spyClient(touched));

    expect(touched).toEqual([]);
    expect(counters.reordered).toBe(0);
    // Counted, not silent: an install whose fixture groups are all
    // measure-only would otherwise read as doing nothing every pass.
    expect(counters.measured).toBe(1);
  });

  it('still writes a channel that did not ask to be measured only', async () => {
    // The control. Without it this feature is indistinguishable from a reorder
    // path that quietly stopped working.
    const touched: string[] = [];
    const counters = await writeBack([plannedFor(false)], spyClient(touched));

    expect(touched.length).toBeGreaterThan(0);
    expect(counters.measured).toBe(0);
  });
});
