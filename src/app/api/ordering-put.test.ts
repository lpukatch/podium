/**
 * What the ordering PUT does with a payload it can read but not trust.
 *
 * PUT replaces the `ordering` block wholesale -- that is the feature, so a
 * partial payload legitimately resets what it leaves out. The line this file
 * draws is between *absent*, which falls back, and *present but wrong*, which
 * used to be folded into a plausible-looking answer and written with a 200:
 * the string "false" turned the h265 preference ON, a non-object `weights`
 * read as all-defaults, and a non-array `providerPreference` did not even
 * survive the handler. A fumbled save must not be indistinguishable from a
 * deliberate reset.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir = '';
let rulesPath = '';
const RULES = JSON.stringify({ schema: 2, channels: [] });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-ordering-put-'));
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

const put = (body: unknown) =>
  new Request('http://podium/api/ordering', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const savedOrdering = async (): Promise<Record<string, unknown>> => {
  const { readRulesDoc } = await import('@/lib/server/state');
  return readRulesDoc().ordering as Record<string, unknown>;
};

describe('the ordering PUT', () => {
  it('reads "false" as off, not as the truthy string it is', async () => {
    const { PUT } = await import('./ordering/route');
    const response = await PUT(put({ weights: { preferH265: 'false' } }));
    expect(response.status).toBe(200);
    const weights = (await savedOrdering()).weights as Record<string, unknown>;
    expect(weights.prefer_h265).toBe(false);
  });

  it('still takes a boolean as what it says', async () => {
    const { PUT } = await import('./ordering/route');
    await PUT(put({ weights: { preferH265: true } }));
    const weights = (await savedOrdering()).weights as Record<string, unknown>;
    expect(weights.prefer_h265).toBe(true);
  });

  it('refuses a weights value that is not an object, and writes nothing', async () => {
    // `"weights": "nope"` used to pass the `?? {}` read and write an
    // all-defaults block, answering 200 for a payload nobody could have
    // meant. A bare array would do the same; `null` would too.
    const { PUT } = await import('./ordering/route');
    for (const weights of ['nope', [1, 2], null]) {
      const response = await PUT(put({ weights }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'weights must be an object' });
    }
    // The last good write from the earlier tests is still what is on disk:
    // the refusals changed nothing.
    const weights = (await savedOrdering()).weights as Record<string, unknown>;
    expect(weights.prefer_h265).toBe(true);
  });

  it('refuses a providerPreference that is not a list of names', async () => {
    const { PUT } = await import('./ordering/route');
    // A bare string used to throw on `.map` and surface as a bare 500; a
    // list of numbers used to be String()-coerced into "preferences".
    for (const providerPreference of ['sports', [3, 7]]) {
      const response = await PUT(put({ providerPreference }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'providerPreference must be a list of names',
      });
    }
  });

  it('keeps the documented fallbacks for absent fields and for wrong-typed numbers', async () => {
    // Absent fields are how an older client talks, and `num()` folding a
    // wrong-typed number to 0 is documented behaviour -- a string where a
    // weight belongs is a value-level mistake, not a shape one.
    const { PUT } = await import('./ordering/route');
    const response = await PUT(put({ weights: { resolution: 'high' } }));
    expect(response.status).toBe(200);
    const ordering = await savedOrdering();
    const weights = ordering.weights as Record<string, unknown>;
    expect(weights.resolution).toBe(0);
    expect(ordering.mode).toBe('quality');
    expect(ordering.provider_preference).toEqual([]);
    expect(weights.prefer_h265).toBe(false);
  });
});
