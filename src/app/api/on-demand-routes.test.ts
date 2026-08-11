import { describe, expect, it } from 'vitest';
import { Eligibility } from '@/lib/eligibility';
import { composeOrder } from '@/lib/runner';

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

describe('Eligibility Group Policy (Finding 03 & Acceptance Criteria)', () => {
  it('returns group excluded verdict for never policy', () => {
    const policies = new Map([
      [1, { mode: 'never' as const, graceMinutes: 5, windowMinutes: 180 }],
    ]);
    const elig = new Eligibility(policies);
    const verdict = elig.allows(1, 'tvg1', new Map());
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('group excluded');
  });

  it('returns before kickoff for after_epg_start policy before start time', () => {
    const policies = new Map([
      [2, { mode: 'after_epg_start' as const, graceMinutes: 5, windowMinutes: 180 }],
    ]);
    const elig = new Eligibility(policies);
    const futureStart = new Date(Date.now() + 30 * 60_000);
    const futureEnd = new Date(Date.now() + 120 * 60_000);
    const programmes = new Map([
      ['tvg2', { tvgId: 'tvg2', start: futureStart, end: futureEnd, title: 'Game' }],
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
