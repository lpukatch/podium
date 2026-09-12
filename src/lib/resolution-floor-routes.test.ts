/**
 * The write paths for a resolution floor.
 *
 * These endpoints are the only place the `none` sentinel is produced, and the
 * difference between "no floor here" and "no floor, and I mean it" is the whole
 * mechanism by which a channel overrides its group and a group overrides a name
 * rule. A round trip through the rules file is the only thing that proves the
 * sentinel survives being written and read back.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALWAYS, Eligibility, parseGroupPatterns, parsePolicies } from './eligibility';
import { loadRules } from './rules';

let dir = '';
let rulesPath = '';

const put = async <P extends Record<string, string>>(
  handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>,
  body: unknown,
  params: P,
) => {
  const request = new Request('http://local/api', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handler(request, { params: Promise.resolve(params) });
};

interface Doc {
  channels: Array<Record<string, unknown>>;
  groups: Record<string, Record<string, unknown>>;
  group_patterns?: Array<Record<string, unknown>>;
}

const doc = () => JSON.parse(readFileSync(rulesPath, 'utf8')) as Doc;

const write = (value: unknown) => writeFileSync(rulesPath, JSON.stringify(value), 'utf8');

// One directory for the file, not one per test: `server/state` holds its
// settings store open across calls, so a directory removed between tests leaves
// it pointing at a database that is no longer there.
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-floor-routes-'));
  rulesPath = join(dir, 'rules.json');
  process.env.PODIUM_DATA_DIR = dir;
  process.env.PODIUM_RULES = rulesPath;
});

beforeEach(() => {
  write({ schema: 2, channels: [], groups: {} });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PODIUM_DATA_DIR;
  delete process.env.PODIUM_RULES;
});

describe('PUT /api/rules/[channelId]', () => {
  it('writes a floor, and writes `none` down rather than omitting it', async () => {
    const { PUT } = await import('../app/api/rules/[channelId]/route');

    await put(PUT, { aliases: ['BBC One'], minResolution: '1080p' }, { channelId: '812' });
    expect(doc().channels[0]!.min_resolution).toBe('1080p');
    expect(loadRules(doc()).channelFloors.get(812)).toBe('1080p');

    // Omitting it is how a channel says "use my group's", which is the opposite
    // of what `none` means -- so `none` has to survive as a written value.
    await put(PUT, { aliases: ['BBC One'], minResolution: 'none' }, { channelId: '812' });
    expect(doc().channels[0]!.min_resolution).toBe('none');
    expect(loadRules(doc()).channelFloors.get(812)).toBeNull();
  });

  it('treats null, "" and "inherit" alike, as a reset rather than an error', async () => {
    const { PUT } = await import('../app/api/rules/[channelId]/route');

    for (const value of [null, '', 'inherit']) {
      await put(PUT, { aliases: ['A'], minResolution: '1080p' }, { channelId: '5' });
      const response = await put(PUT, { aliases: ['A'], minResolution: value }, { channelId: '5' });
      // A client clearing a field sends one of these. Rejecting them made
      // "clear this" the one edit the API refused.
      expect(response.status).toBe(200);
      expect(doc().channels[0]!.min_resolution).toBeUndefined();
      expect(loadRules(doc()).channelFloors.has(5)).toBe(false);
    }
  });

  it('still refuses a floor it cannot read', async () => {
    const { PUT } = await import('../app/api/rules/[channelId]/route');
    const response = await put(PUT, { aliases: ['A'], minResolution: '1440p' }, { channelId: '5' });
    expect(response.status).toBe(400);
  });

  it('accepts an interlaced label', async () => {
    const { PUT } = await import('../app/api/rules/[channelId]/route');
    await put(PUT, { aliases: ['A'], minResolution: '1080i' }, { channelId: '5' });
    expect(doc().channels[0]!.min_resolution).toBe('1080p');
  });
});

describe('PUT /api/groups/[groupId]', () => {
  it('keeps the entry alive when a group pins itself to no floor', async () => {
    const { PUT } = await import('../app/api/groups/[groupId]/route');
    write({
      schema: 2,
      channels: [],
      groups: {},
      group_patterns: [{ pattern: 'Sports *', mode: ALWAYS, min_resolution: '1080p' }],
    });

    await put(PUT, { mode: ALWAYS, minResolution: 'none' }, { groupId: '42' });

    // Deleting the entry as "nothing but defaults" would hand the group
    // straight back to the pattern floor it was just told to ignore, and the
    // menu would snap back to 1080p with no way to shift it.
    expect(doc().groups['42']!.min_resolution).toBe('none');

    const elig = new Eligibility(
      parsePolicies(doc().groups),
      undefined,
      parseGroupPatterns(doc().group_patterns),
    );
    expect(elig.policyFor(42, 'Sports SD').minResolution).toBeUndefined();
  });

  it('still cleans up a group that holds nothing at all', async () => {
    const { PUT } = await import('../app/api/groups/[groupId]/route');
    write({ schema: 2, channels: [], groups: { '42': { mode: ALWAYS, min_resolution: '1080p' } } });
    await put(PUT, { mode: ALWAYS, audioOnly: false }, { groupId: '42' });
    expect(doc().groups['42']!.min_resolution).toBe('1080p');
  });

  it('does not reset a hand-tuned window when a chip changes the floor', async () => {
    const { PUT } = await import('../app/api/groups/[groupId]/route');
    write({
      schema: 2,
      channels: [],
      groups: { '42': { mode: ALWAYS, grace_minutes: 20, window_minutes: 30 } },
    });

    await put(PUT, { mode: ALWAYS, minResolution: '1080p' }, { groupId: '42' });

    // The floor menu posts only the floor. Neither of these has a control in
    // this UI, so a value in the file was put there by hand.
    const group = doc().groups['42']!;
    expect(group.window_minutes).toBe(30);
    expect(group.grace_minutes).toBe(20);
  });
});

// The group-pattern route is not driven here: it answers with the groups the
// pattern would hit, which means a Dispatcharr snapshot and credentials. Its
// floor handling is the same `cleared`/`requestedFloor` pair the group route
// above exercises, and `parseMinResolution` covers the values themselves.
