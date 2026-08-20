/** The scheduler is the reason this project exists, so it gets the real tests. */

import { describe, expect, it } from 'vitest';
import { AbortFlag, type ProbeJob, runLanes } from './scheduler';

const job = (
  streamId: number,
  channelId: number,
  providerId: number,
  stepOrder = 0,
  profileId = 0,
): ProbeJob => ({
  streamId,
  channelId,
  url: `http://example/${streamId}`,
  providerId,
  profileId,
  stepOrder,
});

const noop = async (): Promise<void> => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('provider lanes', () => {
  it('never exceeds a lane limit', async () => {
    const live = new Map([
      [1, 0],
      [2, 0],
    ]);
    const peak = new Map([
      [1, 0],
      [2, 0],
    ]);

    await runLanes(
      [
        ...Array.from({ length: 10 }, (_, i) => job(i, i, 1)),
        ...Array.from({ length: 10 }, (_, i) => job(100 + i, 100 + i, 2)),
      ],
      {
        limits: new Map([
          ['1:0', 2],
          ['2:0', 5],
        ]),
        probe: async (j) => {
          live.set(j.providerId, live.get(j.providerId)! + 1);
          peak.set(j.providerId, Math.max(peak.get(j.providerId)!, live.get(j.providerId)!));
          await sleep(20);
          live.set(j.providerId, live.get(j.providerId)! - 1);
          return 'ok';
        },
        onChannelComplete: noop,
      },
    );

    expect(peak.get(1)).toBeLessThanOrEqual(2);
    expect(peak.get(2)).toBeLessThanOrEqual(5);
  });

  it('never exceeds a login lane limit, per login of one provider', async () => {
    // Provider 5 with two logins: the default capped at 1, a second at 2. The
    // logins are separate lanes -- neither's traffic counts against the
    // other's cap, and together they may use both caps at once.
    const live = new Map([
      ['5:0', 0],
      ['5:9', 0],
    ]);
    const peak = new Map([
      ['5:0', 0],
      ['5:9', 0],
    ]);

    await runLanes(
      [
        ...Array.from({ length: 8 }, (_, i) => job(i, i, 5, 0, 0)),
        ...Array.from({ length: 8 }, (_, i) => job(100 + i, 100 + i, 5, 0, 9)),
      ],
      {
        limits: new Map([
          ['5:0', 1],
          ['5:9', 2],
        ]),
        probe: async (j) => {
          const key = `${j.providerId}:${j.profileId}`;
          live.set(key, live.get(key)! + 1);
          peak.set(key, Math.max(peak.get(key)!, live.get(key)!));
          await sleep(20);
          live.set(key, live.get(key)! - 1);
          return 'ok';
        },
        onChannelComplete: noop,
      },
    );

    expect(peak.get('5:0')).toBeLessThanOrEqual(1);
    expect(peak.get('5:9')).toBeLessThanOrEqual(2);
  });

  it('completes a channel only after both logins of a stream land', async () => {
    // The same stream through its default login and its second one: two jobs,
    // one channel, and the completion carries both results.
    const completions: Array<[number, number]> = [];
    await runLanes([job(1, 7, 5, 0, 0), job(1, 7, 5, 0, 9), job(2, 8, 5)], {
      limits: new Map([
        ['5:0', 1],
        ['5:9', 1],
      ]),
      probe: async (j) => {
        await sleep(10);
        return j.profileId;
      },
      onChannelComplete: async (channelId, results) => {
        completions.push([channelId, results.length]);
      },
    });

    expect(completions.sort((a, b) => a[0] - b[0])).toEqual([
      [7, 2],
      [8, 1],
    ]);
  });

  it('holds a ceiling across every lane at once', async () => {
    // The lane limits protect the providers and say nothing about the machine:
    // peak concurrency is their sum, so three providers here would put nine
    // ffmpeg decodes in flight -- enough to OOM-kill a small container.
    let live = 0;
    let peak = 0;
    let done = 0;

    await runLanes(
      [
        ...Array.from({ length: 6 }, (_, i) => job(i, i, 1)),
        ...Array.from({ length: 6 }, (_, i) => job(100 + i, 100 + i, 2)),
        ...Array.from({ length: 6 }, (_, i) => job(200 + i, 200 + i, 3)),
      ],
      {
        limits: new Map([
          ['1:0', 3],
          ['2:0', 3],
          ['3:0', 3],
        ]),
        maxConcurrent: 2,
        probe: async () => {
          live += 1;
          peak = Math.max(peak, live);
          await sleep(5);
          live -= 1;
          done += 1;
          return 'ok';
        },
        onChannelComplete: noop,
      },
    );

    expect(peak).toBe(2);
    // Every job still lands: a cap slows the run down, it does not drop work.
    expect(done).toBe(18);
  });

  it('leaves concurrency to the lanes when the cap is zero', async () => {
    let live = 0;
    let peak = 0;
    await runLanes(
      Array.from({ length: 8 }, (_, i) => job(i, i, 1)),
      {
        limits: new Map([['1:0', 4]]),
        maxConcurrent: 0,
        probe: async () => {
          live += 1;
          peak = Math.max(peak, live);
          await sleep(5);
          live -= 1;
          return 'ok';
        },
        onChannelComplete: noop,
      },
    );
    expect(peak).toBe(4);
  });

  it('does not let a slow lane block a fast one', async () => {
    // The head-of-line blocking regression this project was built to remove.
    const finished = new Map<number, number>();

    const slow = Array.from({ length: 6 }, (_, i) => job(i, i, 1));
    const fast = Array.from({ length: 8 }, (_, i) => job(100 + i, 100 + i, 2));

    await runLanes([...slow, ...fast], {
      limits: new Map([
        ['1:0', 1],
        ['2:0', 4],
      ]),
      probe: async (j) => {
        await sleep(j.providerId === 1 ? 50 : 10);
        finished.set(j.streamId, Date.now());
        return 'ok';
      },
      onChannelComplete: noop,
    });

    const lastFast = Math.max(...Array.from({ length: 8 }, (_, i) => finished.get(100 + i)!));
    const lastSlow = Math.max(...Array.from({ length: 6 }, (_, i) => finished.get(i)!));
    expect(lastFast).toBeLessThan(lastSlow);
  });

  it('completes a channel only after all of its streams land', async () => {
    const completions: Array<[number, number]> = [];
    // channel 7 spans both providers; it must not complete until both land.
    await runLanes([job(1, 7, 1), job(2, 7, 2), job(3, 8, 2)], {
      limits: new Map([
        ['1:0', 1],
        ['2:0', 2],
      ]),
      probe: async (j) => {
        await sleep(10);
        return j.streamId;
      },
      onChannelComplete: async (channelId, results) => {
        completions.push([channelId, results.length]);
      },
    });

    expect(completions.sort((a, b) => a[0] - b[0])).toEqual([
      [7, 2],
      [8, 1],
    ]);
  });

  it('does not strand a channel when a probe throws', async () => {
    const seen: Array<[number, number]> = [];
    const stats = await runLanes([job(1, 5, 1), job(2, 5, 1)], {
      limits: new Map([['1:0', 2]]),
      probe: async (j) => {
        if (j.streamId === 2) throw new Error('boom');
        return 'ok';
      },
      onChannelComplete: async (channelId, results) => {
        seen.push([channelId, results.length]);
      },
    });

    expect(seen).toEqual([[5, 2]]);
    expect(stats.lanes.get('1:0')?.failed).toBe(1);
    expect(stats.lanes.get('1:0')?.done).toBe(1);
  });

  it('gives an unknown provider a conservative limit', async () => {
    let live = 0;
    let peak = 0;
    // Provider 99 has no configured limit -- must fall back to 1, not unbounded.
    await runLanes(
      Array.from({ length: 5 }, (_, i) => job(i, i, 99)),
      {
        limits: new Map(),
        probe: async () => {
          live += 1;
          peak = Math.max(peak, live);
          await sleep(10);
          live -= 1;
          return 'ok';
        },
        onChannelComplete: noop,
      },
    );
    expect(peak).toBe(1);
  });

  it('treats an empty job list as a no-op', async () => {
    const stats = await runLanes([], {
      limits: new Map([['1:0', 1]]),
      probe: async () => {
        throw new Error('probe called for empty run');
      },
      onChannelComplete: async () => {
        throw new Error('completion called for empty run');
      },
    });
    expect(stats.channelsTotal).toBe(0);
  });

  it.each([1, 3, 8])('runs every job exactly once at limit %i', async (limit) => {
    const calls: number[] = [];
    const jobs = Array.from({ length: 20 }, (_, i) => job(i, i % 4, 1));
    await runLanes(jobs, {
      limits: new Map([[`1:0`, limit]]),
      probe: async (j) => {
        calls.push(j.streamId);
        return 'ok';
      },
      onChannelComplete: noop,
    });
    expect(calls.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('stops dispatch on abort but still settles every channel', async () => {
    const abort = new AbortFlag();
    let started = 0;

    const jobs = Array.from({ length: 20 }, (_, i) => job(i, i, 1));
    const stats = await runLanes(jobs, {
      limits: new Map([['1:0', 1]]),
      abort,
      probe: async () => {
        started += 1;
        if (started === 2) abort.abort();
        await sleep(5);
        return 'ok';
      },
      onChannelComplete: noop,
    });

    expect(started).toBeLessThan(20);
    expect(stats.skipped).toBeGreaterThan(0);
    // Nothing is left permanently outstanding.
    expect(stats.channelsDone).toBe(20);
  });
});
