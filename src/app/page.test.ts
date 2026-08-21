import { describe, expect, it } from 'vitest';
import { probeableChannelsForGroup } from './page';

describe('probeableChannelsForGroup', () => {
  const makeChannel = (
    overrides: Partial<Parameters<typeof probeableChannelsForGroup>[0]['rows'][0]>,
  ) => ({
    id: 1,
    name: 'Channel 1',
    tvgId: 'ch1',
    assigned: 0,
    matched: 0,
    aliases: [],
    contains: [],
    exclude: [],
    patterns: [],
    regexCount: 0,
    hasRule: false,
    ...overrides,
  });

  it('returns empty list for excluded (never) groups', () => {
    const channels = [makeChannel({ id: 1, hasRule: true }), makeChannel({ id: 2, assigned: 3 })];
    expect(probeableChannelsForGroup({ mode: 'never', rows: channels })).toEqual([]);
  });

  it('only returns channels with rules under "always" mode', () => {
    const channels = [
      makeChannel({ id: 1, hasRule: true }),
      makeChannel({ id: 2, hasRule: false, assigned: 5 }),
      makeChannel({ id: 3, hasRule: true }),
    ];
    const probeable = probeableChannelsForGroup({ mode: 'always', rows: channels });
    expect(probeable.map((c) => c.id)).toEqual([1, 3]);
  });

  it('includes channels with rules or assigned streams under "assigned" mode', () => {
    const channels = [
      makeChannel({ id: 1, hasRule: true, assigned: 0 }),
      makeChannel({ id: 2, hasRule: false, assigned: 2 }),
      makeChannel({ id: 3, hasRule: false, assigned: 0 }),
      makeChannel({ id: 4, hasRule: false, assignmentOnly: true }),
    ];
    const probeable = probeableChannelsForGroup({ mode: 'assigned', rows: channels });
    expect(probeable.map((c) => c.id)).toEqual([1, 2, 4]);
  });

  it('includes channels with rules or assigned streams under "after_epg_start" mode', () => {
    const channels = [
      makeChannel({ id: 1, hasRule: true, assigned: 0 }),
      makeChannel({ id: 2, hasRule: false, assigned: 3 }),
      makeChannel({ id: 3, hasRule: false, assigned: 0 }),
    ];
    const probeable = probeableChannelsForGroup({ mode: 'after_epg_start', rows: channels });
    expect(probeable.map((c) => c.id)).toEqual([1, 2]);
  });
});
