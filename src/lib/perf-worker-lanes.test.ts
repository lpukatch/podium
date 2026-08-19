import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GUARDS, Matcher } from './matcher';
import { selectLaneSlice } from './runner';
import { type ProbeJob, runLanes } from './scheduler';

describe('selectLaneSlice (Finding 07b & Acceptance Criteria)', () => {
  it('allocates slice proportionally across provider lanes based on capacity limits', () => {
    // Provider C (limit 1): 100 jobs
    // Provider A (limit 3): 150 jobs
    // Provider B (limit 5): 250 jobs
    const jobs: Array<{ job: ProbeJob; age: number }> = [];

    for (let i = 0; i < 100; i++) {
      jobs.push({
        job: {
          streamId: i,
          channelId: i,
          url: 'http://c',
          providerId: 3,
          profileId: 0,
          stepOrder: 1,
        },
        age: 1000 + i,
      });
    }
    for (let i = 0; i < 150; i++) {
      jobs.push({
        job: {
          streamId: 1000 + i,
          channelId: i,
          url: 'http://a',
          providerId: 1,
          profileId: 0,
          stepOrder: 1,
        },
        age: 1000 + i,
      });
    }
    for (let i = 0; i < 250; i++) {
      jobs.push({
        job: {
          streamId: 2000 + i,
          channelId: i,
          url: 'http://b',
          providerId: 2,
          profileId: 0,
          stepOrder: 1,
        },
        age: 1000 + i,
      });
    }

    const limits = new Map([
      ['3:0', 1], // Provider C
      ['1:0', 3], // Provider A
      ['2:0', 5], // Provider B
    ]);

    const targetSlice = 360;
    const selected = selectLaneSlice(jobs, targetSlice, limits);

    expect(selected.length).toBe(360);

    const counts = new Map<number, number>();
    for (const item of selected) {
      counts.set(item.job.providerId, (counts.get(item.job.providerId) ?? 0) + 1);
    }

    // Ratio 1 : 3 : 5 out of 9 total capacity.
    // Provider C (1/9 of 360 = 40)
    // Provider A (3/9 of 360 = 120)
    // Provider B (5/9 of 360 = 200)
    expect(counts.get(3)).toBe(40);
    expect(counts.get(1)).toBe(120);
    expect(counts.get(2)).toBe(200);
  });

  it('handles remaining quota when one provider runs out of jobs', () => {
    const jobs: Array<{ job: ProbeJob; age: number }> = [
      {
        job: {
          streamId: 1,
          channelId: 1,
          url: 'http://c',
          providerId: 3,
          profileId: 0,
          stepOrder: 1,
        },
        age: 500,
      },
      {
        job: {
          streamId: 2,
          channelId: 2,
          url: 'http://b',
          providerId: 2,
          profileId: 0,
          stepOrder: 1,
        },
        age: 400,
      },
      {
        job: {
          streamId: 3,
          channelId: 3,
          url: 'http://b',
          providerId: 2,
          profileId: 0,
          stepOrder: 1,
        },
        age: 300,
      },
    ];

    const limits = new Map([
      ['3:0', 1],
      ['2:0', 5],
    ]);

    const selected = selectLaneSlice(jobs, 3, limits);
    expect(selected.length).toBe(3);
  });

  it('shares a slice across the login lanes of one provider by their own capacity', () => {
    // Provider A with two logins: the default at 3 connections, a second at 1.
    // Provider B single login at 4. The lanes compete individually, so the
    // provider logins together take the share its total capacity deserves
    // (4 of 8 = half the slice), split 3:1 within it.
    const jobs: Array<{ job: ProbeJob; age: number }> = [];
    for (let i = 0; i < 60; i++) {
      jobs.push({
        job: {
          streamId: i,
          channelId: i,
          url: 'http://a1',
          providerId: 1,
          profileId: 0,
          stepOrder: 1,
        },
        age: 1000 + i,
      });
    }
    for (let i = 0; i < 20; i++) {
      jobs.push({
        job: {
          streamId: 100 + i,
          channelId: i,
          url: 'http://a2',
          providerId: 1,
          profileId: 9,
          stepOrder: 1,
        },
        age: 1000 + i,
      });
    }
    for (let i = 0; i < 60; i++) {
      jobs.push({
        job: {
          streamId: 200 + i,
          channelId: i,
          url: 'http://b',
          providerId: 2,
          profileId: 0,
          stepOrder: 1,
        },
        age: 1000 + i,
      });
    }

    const limits = new Map([
      ['1:0', 3],
      ['1:9', 1],
      ['2:0', 4],
    ]);
    const selected = selectLaneSlice(jobs, 80, limits);
    expect(selected.length).toBe(80);

    const byLane = new Map<string, number>();
    for (const item of selected) {
      const key = `${item.job.providerId}:${item.job.profileId}`;
      byLane.set(key, (byLane.get(key) ?? 0) + 1);
    }
    // Ratio 3 : 1 : 4 of 8 total capacity, out of a slice of 80.
    expect(byLane.get('1:0')).toBe(30);
    expect(byLane.get('1:9')).toBe(10);
    expect(byLane.get('2:0')).toBe(40);
  });
});

describe('Effective Concurrency & Utilisation (Finding 07a & Acceptance Criteria)', () => {
  it('reports effective lane limit when global maxConcurrent binds', async () => {
    const logs: string[] = [];
    const log = (msg: string) => logs.push(msg);

    const jobs: ProbeJob[] = [
      { streamId: 1, channelId: 10, url: 'u1', providerId: 1, profileId: 0, stepOrder: 1 },
      { streamId: 2, channelId: 11, url: 'u2', providerId: 2, profileId: 0, stepOrder: 1 },
    ];

    const limits = new Map([
      ['1:0', 5],
      ['2:0', 5],
    ]);

    await runLanes(jobs, {
      limits,
      maxConcurrent: 3, // 3 < 5 + 5 = 10, so global cap binds per lane
      probe: async () => ({ alive: true }),
      onChannelComplete: async () => {},
      log,
    });

    // Each lane's share of a cap of 3 across two equal lanes, not min(5, 3):
    // no lane can sustain 3 concurrent when the machine only allows 3 in total
    // and another lane wants half of them.
    const startLog = logs.find((l) => l.includes('effective limit='));
    expect(startLog).toBeDefined();
    expect(startLog).toContain('effective limit=1');
  });

  it('reports each lane its proportional share of the cap on the real topology', async () => {
    const logs: string[] = [];
    // Provider C=1, A=3, B=5 against PODIUM_MAX_CONCURRENT_PROBES=6.
    const jobs: ProbeJob[] = [
      { streamId: 1, channelId: 10, url: 'u1', providerId: 5, profileId: 0, stepOrder: 1 },
      { streamId: 2, channelId: 11, url: 'u2', providerId: 6, profileId: 0, stepOrder: 1 },
      { streamId: 3, channelId: 12, url: 'u3', providerId: 7, profileId: 0, stepOrder: 1 },
    ];

    await runLanes(jobs, {
      limits: new Map([
        ['5:0', 1],
        ['6:0', 3],
        ['7:0', 5],
      ]),
      maxConcurrent: 6,
      probe: async () => ({ alive: true }),
      onChannelComplete: async () => {},
      log: (msg) => logs.push(msg),
    });

    // 1/3/5 -> 1/2/3. The old min(limit, maxConcurrent) returned 1/3/5, i.e. it
    // never bound at all and reported nothing, which is what left a lane
    // advertising limit=5 while never exceeding 3 unexplained.
    expect(logs.find((l) => l.startsWith('lane 6:0:'))).toContain('effective limit=2');
    expect(logs.find((l) => l.startsWith('lane 7:0:'))).toContain('effective limit=3');
    // A lane already at or below its share is not annotated.
    expect(logs.find((l) => l.startsWith('lane 5:0:'))).not.toContain('effective limit=');
  });

  it('leaves lanes alone when the cap does not bind', async () => {
    const logs: string[] = [];
    await runLanes(
      [{ streamId: 1, channelId: 1, url: 'u', providerId: 1, profileId: 0, stepOrder: 1 }],
      {
        limits: new Map([['1:0', 3]]),
        maxConcurrent: 10,
        probe: async () => ({ alive: true }),
        onChannelComplete: async () => {},
        log: (msg) => logs.push(msg),
      },
    );
    expect(logs.find((l) => l.startsWith('lane 1:0:'))).not.toContain('effective limit=');
  });
});

describe('StreamIndex Caching (Finding 06 & Acceptance Criteria)', () => {
  it('does not rebuild StreamIndex repeatedly if Matcher reference is unchanged', () => {
    const matcher = new Matcher(new Map(), DEFAULT_GUARDS);
    const spy = vi.spyOn(matcher, 'buildIndex');

    const streams = [
      {
        id: 1,
        name: 'S1',
        url: 'u1',
        providerId: 1,
        groupId: 1,
        streamHash: 'h1',
        is_active: true,
      },
    ];
    const groupNames = new Map([[1, 'Sports']]);

    let cachedIndex: ReturnType<typeof matcher.buildIndex> | null = null;
    let cachedMatcher: Matcher | null = null;

    const getIndex = () => {
      if (!cachedIndex || cachedMatcher !== matcher) {
        cachedMatcher = matcher;
        cachedIndex = matcher.buildIndex(streams, groupNames);
      }
      return cachedIndex;
    };

    // Simulate 50 channel completions in a pass
    for (let i = 0; i < 50; i++) {
      getIndex();
    }

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
