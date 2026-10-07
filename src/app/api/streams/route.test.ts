import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  snapshot: vi.fn(),
  index: vi.fn(),
  matcher: vi.fn(),
  policies: () => new Map(),
  groupPatterns: () => [],
}));
vi.mock('@/lib/server/state', () => state);

import { GET } from './route';

describe('stream search ownership', () => {
  beforeEach(() => {
    state.snapshot.mockResolvedValue({
      providers: [
        { id: 1, name: 'Provider C' },
        { id: 2, name: 'Provider D' },
      ],
      channels: [
        { id: 71795, groupId: 4273 },
        { id: 12, groupId: 4273 },
      ],
      groups: [{ id: 4273, name: 'TV' }],
      streams: [
        { id: 1, providerId: 1, name: 'NBC HD' },
        { id: 2, providerId: 2, name: 'NBC SD' },
      ],
    });
    state.index.mockResolvedValue({
      normalized: new Map([
        [1, { name: 'NBC', prefixes: [] }],
        [2, { name: 'NBC', prefixes: [] }],
      ]),
    });
  });

  async function search(rules: Array<[number, { name: string; streams: number[] }]>) {
    state.matcher.mockReturnValue({
      rules: new Map(rules),
      match: (rule: { streams: number[] }) => new Map(rule.streams.map((id) => [id, true])),
      key: (name: string) => name.toLowerCase(),
    });
    const response = await GET(new Request('http://localhost/api/streams?q=NBC'));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  }

  it('returns a stable channel ID even when the rule has a display name', async () => {
    const body = await search([[71795, { name: 'NBC channel', streams: [1, 2] }]]);
    expect(body.groups[0]).toMatchObject({
      count: 2,
      claimedBy: 'NBC channel',
      claimedByChannelIds: [71795],
    });
  });

  it('retains every owner, including when another rule claims the same stream first', async () => {
    const body = await search([
      [12, { name: 'Other NBC', streams: [1] }],
      [71795, { name: '', streams: [1, 2] }],
    ]);
    expect(body.groups[0].claimedBy).toBe('Other NBC');
    expect(body.groups[0].claimedByChannelIds).toEqual([12, 71795]);
  });

  it('returns no owners for unclaimed results', async () => {
    const body = await search([]);
    expect(body.groups[0].claimedBy).toBeNull();
    expect(body.groups[0].claimedByChannelIds).toEqual([]);
  });
});
