import { describe, expect, it } from 'vitest';
import {
  commitAliasEdit,
  needsCatalogue,
  probeableChannelsForGroup,
  renameFilterKey,
} from './page';

describe('initial catalogue fetch', () => {
  it('defers it for independently backed monitoring and settings pages', () => {
    expect(needsCatalogue('progress')).toBe(false);
    expect(needsCatalogue('settings')).toBe(false);
    expect(needsCatalogue('stats')).toBe(false);
    expect(needsCatalogue('groups')).toBe(true);
    expect(needsCatalogue('dead')).toBe(true);
    expect(needsCatalogue('quality')).toBe(true);
  });
});

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

describe('commitAliasEdit', () => {
  const aliases = 'alpha\nbravo';

  it('keeps the alias when the blurred draft is empty', () => {
    expect(commitAliasEdit(aliases, 'alpha', '')).toEqual({ action: 'keep' });
  });

  it('keeps the alias when the blurred draft is only whitespace', () => {
    expect(commitAliasEdit(aliases, 'alpha', '   ')).toEqual({ action: 'keep' });
  });

  it('keeps the alias when the blurred draft collides with another alias', () => {
    expect(commitAliasEdit(aliases, 'alpha', 'bravo')).toEqual({ action: 'keep' });
  });

  it('collides on the trimmed draft, not the raw text', () => {
    expect(commitAliasEdit(aliases, 'alpha', ' bravo ')).toEqual({ action: 'keep' });
  });

  it('renames to the trimmed draft when the name is free', () => {
    expect(commitAliasEdit(aliases, 'alpha', '  charlie  ')).toEqual({
      action: 'rename',
      next: 'charlie',
    });
  });

  it('lets a draft restate the alias it started from', () => {
    expect(commitAliasEdit(aliases, 'alpha', 'alpha')).toEqual({ action: 'rename', next: 'alpha' });
  });
});

describe('renameFilterKey', () => {
  it('carries the entry from the old key to the new one', () => {
    expect(renameFilterKey({ alpha: ['g1'], bravo: ['g2'] }, 'alpha', 'charlie')).toEqual({
      bravo: ['g2'],
      charlie: ['g1'],
    });
  });

  it('overwrites an entry already sitting on the new key', () => {
    expect(renameFilterKey({ alpha: ['g1'], charlie: ['g9'] }, 'alpha', 'charlie')).toEqual({
      charlie: ['g1'],
    });
  });

  it('returns the same filters when the old key is absent', () => {
    const filters = { bravo: ['g2'] };
    expect(renameFilterKey(filters, 'alpha', 'charlie')).toBe(filters);
  });
});
