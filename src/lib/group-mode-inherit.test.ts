/**
 * The mode a group inherits from a name pattern survives a partial save.
 *
 * Every control on a group row posts only the thing it changes; the rest is
 * resolved against a baseline -- the stored entry, or the first name pattern
 * that matches the group. `mode` was resolved from the request alone, so a
 * chip saved against a group a pattern holds in `never` quietly reset it to
 * `always` -- un-excluding the group while appearing to change nothing. What
 * is pinned here is that the baseline's mode is inherited like every other
 * baseline field, and that the request still wins when it names one.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEVER, parsePolicies } from './eligibility';

// Matching a pattern needs the group's name, which lives in the Dispatcharr
// snapshot. The route never touches anything else on it, so only that part is
// faked, against a catalogue a test can set.
let groups: Array<{ id: number; name: string }> = [];
vi.mock('@/lib/server/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/state')>();
  return {
    ...actual,
    snapshot: async () => ({ groups, channels: [], streams: [], providers: [] }),
    userGroups: () => [],
  };
});

let dir = '';
let rulesPath = '';

interface Doc {
  groups: Record<string, Record<string, unknown>>;
  group_patterns?: Array<Record<string, unknown>>;
}

const doc = () => JSON.parse(readFileSync(rulesPath, 'utf8')) as Doc;
const write = (value: unknown) => writeFileSync(rulesPath, JSON.stringify(value), 'utf8');

const put = async (body: unknown) => {
  const { PUT } = await import('../app/api/groups/[groupId]/route');
  const request = new Request('http://local/api', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return PUT(request, { params: Promise.resolve({ groupId: '42' }) });
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-mode-inherit-'));
  rulesPath = join(dir, 'rules.json');
  process.env.PODIUM_DATA_DIR = dir;
  process.env.PODIUM_RULES = rulesPath;
});

beforeEach(() => {
  groups = [{ id: 42, name: 'Sports HD' }];
  write({
    schema: 2,
    channels: [],
    groups: {},
    group_patterns: [{ pattern: 'Sports *', mode: NEVER }],
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PODIUM_DATA_DIR;
  delete process.env.PODIUM_RULES;
});

describe('PUT /api/groups/[groupId] inherits the baseline mode', () => {
  it('a chip save without a mode keeps the pattern mode', async () => {
    const response = await put({ graceMinutes: 2 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mode: string };
    expect(body.mode).toBe(NEVER);
    expect(parsePolicies(doc().groups).get(42)?.mode).toBe(NEVER);
    expect(parsePolicies(doc().groups).get(42)?.graceMinutes).toBe(2);
  });

  it('the pattern mode does not fall back to a default entry that erases it', async () => {
    // mode `never` is not the default, so the entry has to stay written --
    // deleting it as "nothing but defaults" would hand the group straight
    // back to the pattern, which is fine here but wrong for a group the
    // pattern holds in `always` while another pattern below it says otherwise.
    await put({ graceMinutes: 2 });
    expect(doc().groups['42']).toBeDefined();
    expect(doc().groups['42']!.mode).toBe(NEVER);
  });

  it('an explicit mode still wins', async () => {
    await put({ mode: 'always', graceMinutes: 2 });
    expect(parsePolicies(doc().groups).get(42)?.mode).toBe('always');
  });

  it('a stored entry is the baseline over the pattern', async () => {
    write({
      schema: 2,
      channels: [],
      groups: { '42': { mode: 'after_epg_start' } },
      group_patterns: [{ pattern: 'Sports *', mode: NEVER }],
    });
    await put({ audioOnly: true });
    expect(parsePolicies(doc().groups).get(42)?.mode).toBe('after_epg_start');
  });
});
