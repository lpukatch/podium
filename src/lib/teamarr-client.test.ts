import { describe, expect, it } from 'vitest';
import { compareRules, summarise, type TeamarrRuleRow, validateRules } from './teamarr-client';

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

describe('summarise — proving which instance answered', () => {
  it('counts rules by type and by class', () => {
    const summary = summarise([
      { type: 'group', value: 'A', mode: 'score', points: 5 },
      { type: 'group', value: 'B', mode: 'score', points: -2 },
      { type: 'stats_metric', value: 'alive|=|0', mode: 'score', points: -100 },
      { type: 'catch_all', value: '', priority: 99 },
    ]);
    expect(summary.total).toBe(4);
    expect(summary.byType).toEqual({ group: 2, stats_metric: 1, catch_all: 1 });
    expect(summary.scoring).toBe(3);
    expect(summary.priority).toBe(1);
  });

  it('reports an empty instance without dividing by anything', () => {
    expect(summarise([])).toEqual({ total: 0, byType: {}, scoring: 0, priority: 0 });
  });
});

describe('compareRules — has the push stayed put', () => {
  const set = (): Array<{ type: string; value: string; mode: string; points: number }> => [
    { type: 'group', value: 'A', mode: 'score', points: 5 },
    { type: 'm3u', value: 'P', mode: 'score', points: 3 },
  ];

  it('says nothing when the live set is what was pushed', () => {
    expect(compareRules(set(), set())).toBeNull();
  });

  it('notices a rule that is no longer there', () => {
    expect(compareRules([set()[0]!], set())).toContain('1 rule(s) Podium pushed are gone');
  });

  it('notices a rule nobody pushed', () => {
    const extra = [...set(), { type: 'regex', value: 'x', mode: 'score', points: 1 }];
    expect(compareRules(extra, set())).toContain('1 rule(s) Podium did not push');
  });

  it('notices a repointed rule as both a loss and an addition', () => {
    // Points are part of a rule's identity here: the same group at +5 and at
    // -11 are not the same rule, and reporting "identical" for a set somebody
    // has retuned in Teamarr's UI would hide exactly the edit that matters.
    const edited = [{ ...set()[0]!, points: -11 }, set()[1]!];
    const drift = compareRules(edited, set());
    expect(drift).toContain('did not push');
    expect(drift).toContain('are gone');
  });

  it('distinguishes a reorder from a change', () => {
    // Scoring rules sum, so order is cosmetic -- but the first *priority* rule a
    // stream matches sets its band, so a reordered set is not provably the same
    // ordering. Say which case it is rather than calling it identical.
    const reordered = [set()[1]!, set()[0]!];
    expect(compareRules(reordered, set())).toBe('the same 2 rules, in a different order');
  });
});
