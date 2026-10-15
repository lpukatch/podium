/**
 * What the shared Probe-all loop does with the checks' answers.
 *
 * Pins the three rules the per-tab copies used to miss: an order composed
 * from partial verdicts is never applied, a refused apply is reported rather
 * than swallowed, and two capacity refusals in a row stop the run instead of
 * grinding through every remaining channel.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeChannels, probeNote } from '../app/probe-loop';

const respond =
  (body: unknown, status = 200) =>
  () => {
    const resp = {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    };
    return Promise.resolve(resp as Response);
  };

/** A check whose whole claim was probed, so its order is safe to write. */
const completeCheck = {
  probed: 2,
  dead: 0,
  identical: false,
  workerOrder: [7],
  kept: [],
  dropOrder: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeChannels', () => {
  it('does not apply an order composed from partial verdicts', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return respond({
        probed: 4,
        dead: 2,
        identical: false,
        workerOrder: [1, 2],
        kept: [],
        dropOrder: [],
        unprobed: [{ streamId: 9 }, { streamId: 8 }],
      })();
    });
    const out = await probeChannels([{ id: 5, name: null }], {
      signal: new AbortController().signal,
      autoApply: true,
    });
    expect(out.applied).toBe(0);
    expect(out.partial).toBe(1);
    expect(calls).toEqual(['/api/check/5']);
    expect(probeNote(out).text).toContain('1 not applied (partial verdicts)');
  });

  it('treats a truncated check the same as an unprobed one', async () => {
    vi.stubGlobal('fetch', async () => respond({ ...completeCheck, truncated: true })());
    const out = await probeChannels([{ id: 5, name: null }], {
      signal: new AbortController().signal,
      autoApply: true,
    });
    expect(out.partial).toBe(1);
    expect(out.applied).toBe(0);
  });

  it('reports a refused apply instead of swallowing it', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('/api/check/')
        ? respond(completeCheck)()
        : respond({ error: 'PODIUM_DRY_RUN is set; refusing to write' }, 409)(),
    );
    const out = await probeChannels([{ id: 5, name: 'A' }], {
      signal: new AbortController().signal,
      autoApply: true,
    });
    expect(out.completed).toBe(1);
    expect(out.applied).toBe(0);
    expect(out.applyFailed).toBe(1);
    const note = probeNote(out);
    expect(note.text).toContain('1 apply failed');
    expect(note.bad).toBe(true);
  });

  it('stops after two capacity refusals in a row', async () => {
    let checks = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/api/check/')) {
        checks++;
        return respond({ error: 'Someone is watching and no provider has a spare slot' }, 503)();
      }
      return respond({})();
    });
    const out = await probeChannels(
      [1, 2, 3, 4].map((id) => ({ id, name: null })),
      { signal: new AbortController().signal },
    );
    expect(checks).toBe(2);
    expect(out.capacityStopped).toBe(true);
    expect(out.completed).toBe(0);
    expect(probeNote(out).text).toContain('no spare provider capacity');
  });

  it('keeps going when a capacity refusal is a one-off', async () => {
    const statuses = [503, 200, 503];
    let i = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/api/check/')) {
        const status = statuses[Math.min(i++, statuses.length - 1)];
        return status === 503
          ? respond({ error: 'no spare provider capacity' }, 503)()
          : respond({ probed: 1, dead: 0 })();
      }
      return respond({})();
    });
    const out = await probeChannels(
      [1, 2, 3].map((id) => ({ id, name: null })),
      { signal: new AbortController().signal },
    );
    expect(out.capacityStopped).toBe(false);
    expect(out.completed).toBe(1);
    expect(out.errors).toBe(2);
  });
});
