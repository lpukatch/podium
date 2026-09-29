import { describe, expect, it } from 'vitest';
import { groupAllowed, groupFilter } from './provider-groups';

describe('provider group filters', () => {
  it('applies the editor payload in preview the same way as the saved rule', () => {
    const editor = groupFilter({ excludeGroups: ['UK News'] });
    const saved = groupFilter({ exclude_groups: ['UK News'] });
    expect(editor).toEqual(saved);
    expect(groupAllowed('UK News', editor)).toBe(false);
    expect(groupAllowed('USA News', editor)).toBe(true);
  });

  it('preserves an explicit empty selection in preview', () => {
    const selected = groupFilter({ includeGroups: [] });
    expect(selected).toEqual({ includeGroups: [] });
    expect(groupAllowed('USA News', selected)).toBe(false);
    expect(groupAllowed('USA News', groupFilter({ includeGroups: ['USA News'] }))).toBe(true);
  });
});
