import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ owners: [] as number[], claimedBy: null as string | null }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (Array.isArray(initial)) {
        return [
          [
            {
              normalized: 'NBC',
              count: 2,
              providers: ['Provider C', 'Provider D'],
              samples: ['NBC HD'],
              claimedBy: fixture.claimedBy,
              claimedByChannelIds: fixture.owners,
              prefixes: [
                { name: 'US', count: 1 },
                { name: 'CA', count: 1 },
              ],
              sections: [],
            },
          ],
          vi.fn(),
        ];
      }
      return [initial, vi.fn()];
    },
  };
});

import { StreamSearch } from './stream-search';

describe('stream search current-channel claims', () => {
  beforeEach(() => {
    fixture.owners = [];
    fixture.claimedBy = null;
  });

  const render = () =>
    renderToStaticMarkup(
      createElement(StreamSearch, {
        channelId: 71795,
        onAdd: vi.fn(),
      }),
    );

  it('marks current-channel claims and disables the alias action', () => {
    fixture.owners = [12, 71795];
    fixture.claimedBy = 'Another channel';
    const html = render();
    expect(html).toContain('claimed by this channel');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Already claimed');
    expect(html).not.toContain('+ alias');
    expect(html).not.toContain('Narrow to a section or region');
  });

  it('keeps the warning and alias action for another channel, even with the same display name', () => {
    fixture.owners = [12];
    fixture.claimedBy = '71795';
    const html = render();
    expect(html).toContain('claimed by 71795');
    expect(html).toContain('+ alias');
    expect(html).not.toContain('disabled=""');
  });

  it('allows aliases for unclaimed results', () => {
    const html = render();
    expect(html).toContain('+ alias');
    expect(html).not.toContain('claimed by');
    expect(html).not.toContain('disabled=""');
  });
});
