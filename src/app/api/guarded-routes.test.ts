/**
 * The rules-writing routes fail as JSON.
 *
 * Four handlers read and rewrite the rules file with no guard of their own;
 * a read or write failure used to escape the handler and surface as the
 * framework's generic 500, which the settings page cannot show. What is
 * asserted here is the shape: a 500 whose body names the reason.
 */

import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  readRulesDoc: vi.fn(),
  writeRulesDoc: vi.fn(),
  snapshot: vi.fn(),
  userGroups: vi.fn(),
}));
vi.mock('@/lib/server/state', () => state);

import { DELETE as deleteGroupPattern } from '@/app/api/group-patterns/route';
import { PUT as putChannelRule } from '@/app/api/rules/[channelId]/route';

const broken = () =>
  state.readRulesDoc.mockImplementation(() => {
    throw new Error('rules file vanished');
  });

describe('rules-file failures reach the client as a reason', () => {
  it('the channel rule route', async () => {
    broken();
    const response = await putChannelRule(
      new Request('http://podium:3456/api/rules/12', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aliases: ['x'] }),
      }),
      { params: Promise.resolve({ channelId: '12' }) },
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('rules file vanished');
  });

  it('the group pattern route', async () => {
    broken();
    const response = await deleteGroupPattern(
      new Request('http://podium:3456/api/group-patterns?pattern=sports', { method: 'DELETE' }),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('rules file vanished');
  });
});
