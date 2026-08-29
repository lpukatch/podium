import { describe, expect, it } from 'vitest';
import { type TeamarrRuleRow, validateRules } from './teamarr-client';

const ok: TeamarrRuleRow[] = [
  { type: 'm3u', value: 'Provider A', priority: 99, mode: 'score', points: 6 },
  { type: 'stats_metric', value: 'alive|=|0', priority: 99, mode: 'score', points: -100 },
  { type: 'epg_match', value: '', priority: 99, mode: 'score', points: 10 },
];

describe('validateRules', () => {
  it('passes a set Teamarr would accept', () => {
    expect(validateRules(ok)).toEqual([]);
  });

  it('allows an empty value only where Teamarr does', () => {
    // epg_match carries no argument; m3u without an account matches nothing and
    // Teamarr rejects it outright.
    expect(validateRules([{ type: 'm3u', value: '   ', priority: 99 }])).toHaveLength(1);
    expect(validateRules([{ type: 'epg_match', value: '', priority: 99 }])).toEqual([]);
  });

  it('rejects a type Teamarr has never heard of', () => {
    const problems = validateRules([{ type: 'vibes', value: 'good', priority: 99 }]);
    expect(problems[0]).toContain('no type');
  });

  it('rejects a priority outside 1-99', () => {
    // Teamarr's importer enforces the band range even on score rules, which
    // ignore it — so a 0 here is a rejected PUT, not a harmless field.
    expect(validateRules([{ type: 'm3u', value: 'A', priority: 0 }])[0]).toContain('priority');
    expect(validateRules([{ type: 'm3u', value: 'A', priority: 100 }])[0]).toContain('priority');
  });

  it('rejects a stream_type that is neither event nor team', () => {
    expect(validateRules([{ type: 'stream_type', value: 'epg', priority: 99 }])[0]).toContain(
      'stream_type',
    );
    expect(validateRules([{ type: 'stream_type', value: 'team|nyy,bos', priority: 99 }])).toEqual(
      [],
    );
  });

  it('reports every problem rather than the first', () => {
    // The PUT replaces the whole set, so fixing one rule and being told about
    // the next on the retry is the slowest possible way to learn this.
    const problems = validateRules([
      { type: 'nope', value: '', priority: 0 },
      { type: 'm3u', value: '', priority: 99 },
    ]);
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});
