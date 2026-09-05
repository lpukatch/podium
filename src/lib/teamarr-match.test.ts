/**
 * Reading Teamarr's attach-time state, and what it costs to.
 *
 * The client is stubbed rather than mocked over `fetch`, because what is worth
 * pinning here is the read *policy* -- how many channels get called, in what
 * order, and what happens when one of them fails -- not the JSON parsing, which
 * `teamarr-client.test.ts` already owns.
 */

import { describe, expect, it } from 'vitest';
import type { ChannelStreamRow, ManagedChannelRow, TeamarrClient } from './teamarr-client';
import { describeSkew, matchKey, readMatches, tryReadMatches } from './teamarr-match';

/** A stand-in for the client, recording what was asked of it. */
function stub(
  managed: ManagedChannelRow[],
  streams: Record<number, ChannelStreamRow[]>,
  options: { failOn?: Set<number>; failList?: boolean } = {},
) {
  const asked: number[] = [];
  const client = {
    async managedChannels() {
      if (options.failList) throw new Error('Could not reach Teamarr at http://teamarr:9195');
      return managed;
    },
    async channelStreams(channelId: number) {
      asked.push(channelId);
      if (options.failOn?.has(channelId)) throw new Error('Teamarr GET 404: Channel not found');
      return streams[channelId] ?? [];
    },
  } as unknown as TeamarrClient;
  return { client, asked };
}

const row = (id: number, matchMethod: string | null, hasStats: boolean): ChannelStreamRow => ({
  dispatcharrStreamId: id,
  matchMethod,
  matchType: matchMethod === null ? null : 'event',
  hasStats,
});

describe('readMatches', () => {
  it('keys by channel and stream, not by stream alone', async () => {
    // An EPG-matched stream is a linear channel sitting on every fixture that
    // airs on it, and it can be an `epg` match on one and a name match on
    // another. Keying by stream would collapse the two into whichever was read
    // last, which is a wrong answer rather than a missing one.
    const { client } = stub(
      [
        { id: 10, dispatcharrChannelId: 1 },
        { id: 20, dispatcharrChannelId: 2 },
      ],
      { 10: [row(500, 'epg', true)], 20: [row(500, 'fuzzy', true)] },
    );
    const { index } = await readMatches(client, [1, 2]);

    expect(index.get(matchKey(1, 500))?.matchMethod).toBe('epg');
    expect(index.get(matchKey(2, 500))?.matchMethod).toBe('fuzzy');
  });

  it('asks only about the channels it was given', async () => {
    // Every call can make Teamarr refresh its stats cache from Dispatcharr, so
    // sweeping the whole catalogue because a rule check ran is a write on
    // somebody else's database dressed as a read.
    const { client, asked } = stub(
      [
        { id: 10, dispatcharrChannelId: 1 },
        { id: 20, dispatcharrChannelId: 2 },
        { id: 30, dispatcharrChannelId: 3 },
      ],
      {},
    );
    await readMatches(client, [1, 3]);
    expect(asked.sort()).toEqual([10, 30]);
  });

  it('counts a channel Teamarr does not manage rather than calling about it', async () => {
    // The ordinary case: Podium probes far more channels than Teamarr creates.
    const { client, asked } = stub([{ id: 10, dispatcharrChannelId: 1 }], {
      10: [row(500, 'epg', true)],
    });
    const { coverage } = await readMatches(client, [1, 2, 3]);

    expect(asked).toEqual([10]);
    expect(coverage.unmatched).toBe(2);
    expect(coverage.channels).toBe(1);
  });

  it('caps the read and says how much it left', async () => {
    const managed = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i,
      dispatcharrChannelId: i + 1,
    }));
    const { client, asked } = stub(managed, {});
    const { coverage } = await readMatches(client, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1], {
      maxChannels: 3,
      concurrency: 1,
    });

    expect(asked).toHaveLength(3);
    expect(coverage.skipped).toBe(7);
    // Lowest channel id first, so a capped read is the same read twice running.
    // A coverage figure that moves because the sample moved is not a
    // measurement of anything.
    expect(asked).toEqual([100, 101, 102]);
  });

  it('drops one channel that fails rather than the whole read', async () => {
    // A fixture deleted between the list and the read is a race, not a fault.
    const { client } = stub(
      [
        { id: 10, dispatcharrChannelId: 1 },
        { id: 20, dispatcharrChannelId: 2 },
      ],
      { 20: [row(500, 'epg', true)] },
      { failOn: new Set([10]) },
    );
    const { index, coverage } = await readMatches(client, [1, 2]);

    expect(coverage.channels).toBe(1);
    expect(index.get(matchKey(2, 500))?.matchMethod).toBe('epg');
  });

  it('splits stats coverage by how the stream was attached', async () => {
    // The number this whole feature exists to produce.
    const { client } = stub([{ id: 10, dispatcharrChannelId: 1 }], {
      10: [
        row(1, 'epg', true),
        row(2, 'epg', true),
        row(3, 'fuzzy', false),
        row(4, 'fuzzy', false),
        row(5, null, false),
      ],
    });
    const { coverage } = await readMatches(client, [1]);

    expect(coverage.streams).toBe(5);
    expect(coverage.withStats).toBe(2);
    expect(coverage.byMethod.epg).toEqual({ streams: 2, withStats: 2 });
    expect(coverage.byMethod.fuzzy).toEqual({ streams: 2, withStats: 0 });
    expect(coverage.byMethod.unknown).toEqual({ streams: 1, withStats: 0 });
  });

  it('costs nothing when there is nothing to score', async () => {
    const { client, asked } = stub([{ id: 10, dispatcharrChannelId: 1 }], {});
    const { coverage } = await readMatches(client, []);
    expect(asked).toEqual([]);
    expect(coverage.channels).toBe(0);
  });
});

describe('tryReadMatches', () => {
  it('degrades to knowing nothing rather than failing the check', async () => {
    // A rule check that cannot reach Teamarr is the check Podium ran for its
    // whole life before this existed. Failing it would turn a reporting feature
    // into a dependency.
    const { client } = stub([], {}, { failList: true });
    const read = await tryReadMatches(client, [1, 2]);

    expect(read.known).toBe(false);
    expect(read.index.size).toBe(0);
    expect(read.error).toContain('Teamarr');
  });

  it('separates a successful empty read from a failed one', async () => {
    // An install where Teamarr manages nothing knows that `epg_match` matches
    // nothing, which is an answer. An install that could not ask knows neither.
    const { client } = stub([], {});
    const read = await tryReadMatches(client, [1, 2]);

    expect(read.known).toBe(true);
    expect(read.coverage.unmatched).toBe(2);
  });
});

describe('describeSkew', () => {
  it('names the skew when only the EPG-matched streams carry readings', async () => {
    const { client } = stub([{ id: 10, dispatcharrChannelId: 1 }], {
      10: [
        row(1, 'epg', true),
        row(2, 'epg', true),
        row(3, 'fuzzy', false),
        row(4, 'cache', false),
      ],
    });
    const { coverage } = await readMatches(client, [1]);

    const said = describeSkew(coverage)!;
    expect(said).toContain('100% of the streams carrying stats are EPG-matched');
    expect(said).toContain('against 0% of the rest');
  });

  it('says so when Teamarr holds no readings at all', async () => {
    const { client } = stub([{ id: 10, dispatcharrChannelId: 1 }], {
      10: [row(1, 'epg', false), row(2, 'fuzzy', false)],
    });
    const { coverage } = await readMatches(client, [1]);
    expect(describeSkew(coverage)).toContain('stats_metric rules match nothing');
  });

  it('stays quiet where there is no EPG-matched inventory to skew toward', async () => {
    const { client } = stub([{ id: 10, dispatcharrChannelId: 1 }], {
      10: [row(1, 'fuzzy', true), row(2, 'cache', false)],
    });
    const { coverage } = await readMatches(client, [1]);
    expect(describeSkew(coverage)).toBeNull();
  });
});
