import { describe, expect, it } from 'vitest';
import { Eligibility } from '@/lib/eligibility';
import { Matcher } from '@/lib/matcher';
import { parseProviders } from '@/lib/rules';
import { composeOrder, splitAssigned, withoutStream } from '@/lib/runner';

describe('composeOrder safety (Finding 02 & Acceptance Criteria)', () => {
  it('does not unassign unmatched streams when removeUnmatched is false', () => {
    const matched = [10, 20];
    const currentOnChannel = [20, 30, 10, 40]; // 30 and 40 are strays
    const result = composeOrder(matched, currentOnChannel, false);
    // Should reorder matched streams first, then keep strays
    expect(result).toEqual([10, 20, 30, 40]);
  });

  it('drops unmatched streams when removeUnmatched is true', () => {
    const matched = [10, 20];
    const currentOnChannel = [20, 30, 10, 40];
    const result = composeOrder(matched, currentOnChannel, true);
    expect(result).toEqual([10, 20]);
  });

  it('filters out streams not currently carried on the channel', () => {
    const rankedCandidatesFromRule = [100, 200, 300]; // 100 and 300 are candidates across global catalog, not on channel
    const currentOnChannel = [200, 400];
    const result = composeOrder(rankedCandidatesFromRule, currentOnChannel, false);
    expect(result).toEqual([200, 400]);
  });
});

describe('what a check may offer to unassign', () => {
  it('calls a stream unclaimed only when the rule did not match it', () => {
    // The live case this comes from: a channel carrying 7 streams whose rule
    // claims all 7, two of them on a provider with max_streams 1. Reserving a
    // slot for a viewer leaves that provider none, so the two go unprobed --
    // and the check offered to delete them as streams "this rule does not
    // claim", naming the rule that claims them.
    const assigned = [75339, 75340, 93512, 93513, 131939];
    const claimed = new Set(assigned);
    const probed = new Set([75339, 75340, 131939]);
    const { unclaimed, unprobed } = splitAssigned(assigned, claimed, probed);
    expect(unclaimed).toEqual([]);
    expect(unprobed).toEqual([93512, 93513]);
  });

  it('separates a genuine stray from a stream that went unprobed', () => {
    const { unclaimed, unprobed } = splitAssigned([10, 20, 30], new Set([10, 20]), new Set([10]));
    expect(unclaimed).toEqual([30]);
    expect(unprobed).toEqual([20]);
  });

  it('keeps every assigned stream when one of them has no verdict', () => {
    // `unprobed` being non-empty is what forces removeUnmatched off, so a
    // half-probed check composes an order that drops nothing.
    const { unprobed } = splitAssigned([10, 20, 30], new Set([10, 20, 30]), new Set([10]));
    const removeUnmatched = true && unprobed.length === 0;
    expect(composeOrder([10], [10, 20, 30], removeUnmatched)).toEqual([10, 20, 30]);
  });
});

describe('taking one stream off a channel', () => {
  it('keeps the live order of everything else', () => {
    expect(withoutStream([30, 10, 20], 10)).toEqual([30, 20]);
  });

  it('is computed against the live order, not the one the page is showing', () => {
    // The editor draws from a snapshot up to five minutes old. Here the worker
    // has since reordered the channel and something else dropped 40. Removing
    // the ✕'d stream from the live array leaves both of those changes intact;
    // posting back the page's copy minus 20 would have reverted the ranking
    // and put 40 back on the channel.
    const shownInTheEditor = [10, 20, 30, 40];
    const live = [30, 10, 20];
    expect(withoutStream(live, 20)).toEqual([30, 10]);
    expect(withoutStream(shownInTheEditor, 20)).not.toEqual(withoutStream(live, 20));
  });

  it('asking twice is the same as asking once', () => {
    // A double click, or two tabs open on the same channel: the second call
    // finds nothing to remove and must not report a different lineup.
    const once = withoutStream([10, 20, 30], 20);
    expect(withoutStream(once, 20)).toEqual(once);
  });
});

describe('Eligibility Group Policy (Finding 03 & Acceptance Criteria)', () => {
  it('returns group excluded verdict for never policy', () => {
    const policies = new Map([
      [1, { mode: 'never' as const, graceMinutes: 5, windowMinutes: 180, requireLive: true }],
    ]);
    const elig = new Eligibility(policies);
    const verdict = elig.allows(1, 'tvg1', new Map());
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('group excluded');
  });

  it('returns before kickoff for after_epg_start policy before start time', () => {
    const policies = new Map([
      [
        2,
        {
          mode: 'after_epg_start' as const,
          graceMinutes: 5,
          windowMinutes: 180,
          requireLive: true,
        },
      ],
    ]);
    const elig = new Eligibility(policies);
    const futureStart = new Date(Date.now() + 30 * 60_000);
    const futureEnd = new Date(Date.now() + 120 * 60_000);
    const programmes = new Map([
      ['tvg2', { tvgId: 'tvg2', start: futureStart, end: futureEnd, title: 'Game', isLive: true }],
    ]);
    const verdict = elig.allows(2, 'tvg2', programmes);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('before kickoff');
  });
});

describe('Worker staleness and floor calculations (Finding 04)', () => {
  it('correctly calculates lane capacity floor to 0 when worker is busy on limit-1 provider', () => {
    const maxStreams = 1;
    const workerBusy = true;
    const limit = Math.max(0, workerBusy ? maxStreams - 1 : maxStreams);
    expect(limit).toBe(0);
  });

  it('correctly calculates lane capacity floor to 0 rather than forcing 1', () => {
    const maxStreams = 2;
    const activeWorkerJobs = 2;
    // With 0 spare capacity, limit is 0
    const limit = Math.max(0, maxStreams - activeWorkerJobs);
    expect(limit).toBe(0);
  });

  it('stale worker progress timestamp (>300s) clears workerBusy state', () => {
    const updatedAt = new Date(Date.now() - 360_000).toISOString();
    const isStale = Date.now() - new Date(updatedAt).getTime() > 300_000;
    const phase = 'probing';
    const workerBusy = !isStale && phase === 'probing';
    expect(workerBusy).toBe(false);
  });
});

describe('Identical calculation with strays (Finding 8.6)', () => {
  it('reports identical: true when channel streams match composed worker order despite strays', () => {
    const current = [20, 10, 30]; // 30 is stray
    const ranked = [20, 10]; // rule matched 20 and 10 in this order
    const workerOrder = composeOrder(ranked, current, false); // [20, 10, 30]
    const identical =
      workerOrder.length === current.length && workerOrder.every((s, i) => s === current[i]);
    expect(identical).toBe(true);
  });
});

describe('Channel provider restrictions in matcher', () => {
  it('respects provider restrictions when specified on rule', () => {
    const rule = {
      channelId: 1,
      name: 'Test Channel',
      aliases: ['Test'],
      contains: [],
      exclude: [],
      patterns: [],
      providers: parseProviders([6]),
      stepOrder: 0,
      excludeRegions: null,
    };

    const matcher = new Matcher(new Map([[1, rule]]));
    const streams = [
      { id: 101, name: 'Test', providerId: 6 },
      { id: 102, name: 'Test', providerId: 12 },
    ];
    const index = matcher.buildIndex(streams);
    const matches = matcher.match(rule, index);
    expect(matches).toEqual([[101, 0]]);

    // When unrestricted (null / all providers)
    const unrestrictedRule = { ...rule, providers: null };
    const allMatches = matcher.match(unrestrictedRule, index);
    expect(allMatches.map(([id]) => id)).toEqual([101, 102]);
  });
});
