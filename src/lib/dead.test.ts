/**
 * `summarizeDead`: the join between verdicts and the catalogue. Channel
 * attribution (where a dead stream sits, who serves it first), provider
 * tallies, orphan accounting and the entry cap are all decided here, against
 * hand-built inputs -- no Dispatcharr, no database.
 */

import { describe, expect, it } from 'vitest';
import type { DeadCatalog, DeadResponse } from './dead';
import { DEAD_ENTRIES_CAP, summarizeDead } from './dead';
import type { ProbeResult } from './probe';
import type { DeadStreamRow } from './store';

function result(alive: boolean, over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    alive,
    width: alive ? 1920 : 0,
    height: alive ? 1080 : 0,
    fps: alive ? 60 : 0,
    videoCodec: alive ? 'h264' : '',
    audioCodec: alive ? 'aac' : '',
    pixelFormat: alive ? 'yuv420p' : '',
    audioChannels: alive ? 2 : 0,
    channelLayout: alive ? 'stereo' : '',
    audioBitrateKbps: alive ? 128 : 0,
    audioSampleRate: alive ? 48_000 : 0,
    bitrateKbps: alive ? 5000 : 0,
    bitrateMeasured: alive,
    elapsedMs: 100,
    error: alive ? '' : 'HTTP 4XX',
    ...over,
  };
}

function row(streamId: number, over: Partial<DeadStreamRow> = {}): DeadStreamRow {
  return {
    streamId,
    probedAt: 1_000,
    deadStreak: 1,
    result: result(false),
    ...over,
  };
}

function summarize(rows: DeadStreamRow[], catalog: DeadCatalog): DeadResponse {
  return summarizeDead(rows, catalog, 1234);
}

const CATALOG: DeadCatalog = {
  providers: [
    { id: 1, name: 'One' },
    { id: 2, name: 'Two' },
  ],
  streams: [
    { id: 10, name: 'One Dead', providerId: 1 },
    { id: 11, name: 'One Black', providerId: 1 },
    { id: 12, name: 'Two Dead', providerId: 2 },
    { id: 13, name: 'Two Live', providerId: 2 },
  ],
  channels: [
    { id: 100, name: 'Serves Dead First', groupId: 5, streams: [10, 12] },
    { id: 101, name: 'Serves Dead Second', groupId: 5, streams: [13, 12] },
    { id: 102, name: 'All Live', groupId: 6, streams: [13] },
  ],
};

const ROWS: DeadStreamRow[] = [
  row(10, { deadStreak: 3 }),
  row(11, { result: result(true, { black: true }) }),
  row(12, { probedAt: 2_000 }),
  row(99), // not in the catalogue: an orphan
];

describe('summarizeDead', () => {
  it('joins names and providers, and counts orphans without listing them', () => {
    const out = summarize(ROWS, CATALOG);

    expect(out.totals.orphans).toBe(1);
    expect(out.entries.map((e) => e.streamId).sort()).toEqual([10, 11, 12]);
    const entry = out.entries.find((e) => e.streamId === 10);
    expect(entry).toMatchObject({ name: 'One Dead', provider: 'One' });
  });

  it('marks a channel serving a dead stream first, and ranks the stream on it', () => {
    const out = summarize(ROWS, CATALOG);

    const first = out.channels.find((c) => c.id === 100);
    expect(first).toMatchObject({ servedFirstDead: true, deadCount: 2, assigned: 2 });
    const second = out.channels.find((c) => c.id === 101);
    expect(second).toMatchObject({ servedFirstDead: false, deadCount: 1, assigned: 2 });

    const dead12 = out.entries.find((e) => e.streamId === 12);
    expect(dead12?.channels).toEqual([
      { id: 100, name: 'Serves Dead First', groupId: 5, rank: 2 },
      { id: 101, name: 'Serves Dead Second', groupId: 5, rank: 2 },
    ]);
  });

  it('omits channels with nothing dead, and lists unassigned dead streams', () => {
    const out = summarize([row(10)], {
      ...CATALOG,
      channels: [{ id: 102, name: 'All Live', groupId: 6, streams: [13] }],
    });

    expect(out.channels).toEqual([]);
    // Dead but on no channel: still listed, because the question is what is
    // dead, not only what is being served.
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.channels).toEqual([]);
  });

  it('tallies providers with catalogue denominators, worst first', () => {
    const out = summarize(ROWS, CATALOG);

    expect(out.providers).toEqual([
      { id: 1, name: 'One', dead: 1, black: 1, streams: 2 },
      { id: 2, name: 'Two', dead: 1, black: 0, streams: 2 },
    ]);
  });

  it('omits providers with nothing dead or black', () => {
    const out = summarize([row(12)], CATALOG);

    expect(out.providers.map((p) => p.id)).toEqual([2]);
  });

  it('totals: dead and black split, channels affected and served-first, worst streak, oldest check', () => {
    const out = summarize(ROWS, CATALOG);

    expect(out.totals).toEqual({
      dead: 2,
      black: 1,
      orphans: 1,
      channelsServedFirst: 1,
      channelsAffected: 2,
      worstStreak: 3,
      oldestProbedAt: 1_000,
    });
    expect(out.fetchedAt).toBe(1234);
    expect(out.truncated).toBe(false);
  });

  it('caps the entry list at the limit with exact totals and a truncated flag', () => {
    const many: DeadStreamRow[] = [];
    const manyStreams: DeadCatalog['streams'] = [];
    for (let i = 0; i < DEAD_ENTRIES_CAP + 1; i++) {
      many.push(row(i));
      manyStreams.push({ id: i, name: `S${i}`, providerId: 1 });
    }
    const out = summarize(many, {
      providers: [{ id: 1, name: 'One' }],
      streams: manyStreams,
      channels: [],
    });

    expect(out.entries).toHaveLength(DEAD_ENTRIES_CAP);
    expect(out.entryTotal).toBe(DEAD_ENTRIES_CAP + 1);
    expect(out.truncated).toBe(true);
    expect(out.totals.dead).toBe(DEAD_ENTRIES_CAP + 1);
    expect(out.providers[0]).toMatchObject({ dead: DEAD_ENTRIES_CAP + 1 });
  });

  it('sorts worst first: longest streak, then longest-standing verdict', () => {
    const out = summarize(
      [
        row(10, { deadStreak: 1, probedAt: 5_000 }),
        row(11, { deadStreak: 5, probedAt: 9_000 }),
        row(12, { deadStreak: 5, probedAt: 3_000 }),
      ],
      CATALOG,
    );

    expect(out.entries.map((e) => e.streamId)).toEqual([12, 11, 10]);
  });
});
