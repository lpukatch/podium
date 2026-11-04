/**
 * Write routes given a body that is not JSON.
 *
 * Several of them parsed outside any try, so a truncated or empty body threw
 * out of the handler and Next answered with its own bare 500 -- a server error
 * for what was the client's mistake. They answer 400 now, and write nothing.
 *
 * Every route here expects a body, so the guard is `.catch(() => null)` plus
 * an explicit 400 -- not the `.catch(() => ({}))` the optional-body routes
 * use, which would paper over the client's mistake and then fail stranger.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir = '';
let rulesPath = '';
const RULES = JSON.stringify({ schema: 2, channels: [] });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-malformed-json-'));
  rulesPath = join(dir, 'rules.json');
  writeFileSync(rulesPath, RULES, 'utf8');
  process.env.PODIUM_DATA_DIR = dir;
  process.env.PODIUM_RULES = rulesPath;
});

afterAll(() => {
  delete process.env.PODIUM_DATA_DIR;
  delete process.env.PODIUM_RULES;
  rmSync(dir, { recursive: true, force: true });
});

const put = (body: string) =>
  new Request('http://podium/api/x', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

const post = (body: string) =>
  new Request('http://podium/api/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

const expect400 = async (response: Response): Promise<void> => {
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'body is not JSON' });
};

describe('a body that is not JSON', () => {
  it('is a 400 from the channel rule route, and changes nothing', async () => {
    const { PUT } = await import('../app/api/rules/[channelId]/route');
    for (const body of ['{"aliases": [', '']) {
      const response = await PUT(put(body), { params: Promise.resolve({ channelId: '5' }) });
      await expect400(response);
    }
    expect(readFileSync(rulesPath, 'utf8')).toBe(RULES);
  });

  it('is a 400 from the group policy route, and changes nothing', async () => {
    const { PUT } = await import('../app/api/groups/[groupId]/route');
    const response = await PUT(put('{"mode": '), { params: Promise.resolve({ groupId: '7' }) });
    await expect400(response);
    expect(readFileSync(rulesPath, 'utf8')).toBe(RULES);
  });

  it('is a 400 from the group pattern route, and changes nothing', async () => {
    const { PUT } = await import('../app/api/group-patterns/route');
    const response = await PUT(put('not json'));
    await expect400(response);
    expect(readFileSync(rulesPath, 'utf8')).toBe(RULES);
  });

  it('is a 400 from the ordering route, and changes nothing', async () => {
    // The important one to pin: this route replaces the ordering block
    // wholesale, so the old 500 was the *good* outcome -- the bad one is any
    // answer that suggests the fumbled payload was understood.
    const { PUT } = await import('../app/api/ordering/route');
    const response = await PUT(put('{"weights": '));
    await expect400(response);
    expect(readFileSync(rulesPath, 'utf8')).toBe(RULES);
  });

  it('is a 400 from the name-noise route, and changes nothing', async () => {
    const { PUT } = await import('../app/api/name-noise/route');
    const response = await PUT(put(''));
    await expect400(response);
    expect(readFileSync(rulesPath, 'utf8')).toBe(RULES);
  });

  it('is a 400 from the stream-groups route, and changes nothing', async () => {
    const { PUT } = await import('../app/api/stream-groups/route');
    const response = await PUT(put('{"excludeGroups": ['));
    await expect400(response);
    expect(readFileSync(rulesPath, 'utf8')).toBe(RULES);
  });

  it('is a 400 from the settings route, and changes nothing', async () => {
    const { PUT } = await import('../app/api/settings/route');
    const response = await PUT(put('{"PODIUM_'));
    await expect400(response);
    expect(readFileSync(rulesPath, 'utf8')).toBe(RULES);
  });

  it('is a 400 from the quality-profile merge route', async () => {
    const { POST } = await import('../app/api/quality-profile/route');
    await expect400(await POST(post('{"rules": ')));
  });

  it('is a 400 from the rule-check route', async () => {
    const { POST } = await import('../app/api/rule-check/route');
    await expect400(await POST(post('[')));
  });

  it('is a 400 from the unassign route', async () => {
    const { POST } = await import('../app/api/unassign/[channelId]/route');
    const response = await POST(post(''), { params: Promise.resolve({ channelId: '5' }) });
    await expect400(response);
  });

  it('is a 400 from the apply route', async () => {
    // The route that writes a channel's order, whose own documentation calls
    // the write un-undoable: a truncated body here must never read as a
    // server fault -- or as permission to proceed with defaults.
    const { POST } = await import('../app/api/apply/[channelId]/route');
    const response = await POST(post('{"order": '), {
      params: Promise.resolve({ channelId: '5' }),
    });
    await expect400(response);
  });
});
