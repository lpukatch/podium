/**
 * Yielding per provider instead of per pass.
 *
 * The plain pause treats "somebody is watching" as a property of the house.
 * It is really a property of one provider account, and the difference is not
 * academic: a single DVR recording, or a stream left running by accident,
 * stopped every check on a live install for nine hours -- 523 passes that
 * fetched the channel list, saw one session, and went back to sleep. The
 * providers nobody was on had spare connections the whole time.
 *
 * The mode's safety rests entirely on knowing which provider a viewer is on,
 * so most of what is tested here is what happens when that is not knowable.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import { type Activity, busyUnknown, Pacer } from './pacer';
import { RulesSource } from './rules-source';
import { Runner } from './runner';
import { Store } from './store';

const idle: Activity = { channelIds: new Set(), idle: true };
const watching: Activity = { channelIds: new Set([5]), idle: false };

const pacer = (over = {}) =>
  new Pacer({
    maxAgeMs: 3_600_000,
    tickMs: 60_000,
    pauseWhenWatching: true,
    probeIdleProviders: true,
    minFreeSlots: 1,
    maxSlice: 400,
    ...over,
  });

/** Two providers, one lane each: 7 is being watched, 8 is not. */
const base = new Map([
  ['7:0', 3],
  ['8:0', 5],
]);
const providerOf = new Map([
  ['7:0', 7],
  ['8:0', 8],
]);

describe('laneLimits with probeIdleProviders', () => {
  it('keeps the unwatched provider open and yields the watched one', () => {
    // 8 keeps 5 - 0 in use - 1 courtesy reserve = 4. 7 is not shrunk to its
    // spare capacity, it is closed: the point is to stay off the account
    // entirely, not to compete politely on it.
    const limits = pacer().laneLimits(base, watching, new Map([['7:0', 1]]), providerOf);
    expect([...limits]).toEqual([['8:0', 4]]);
  });

  it('closes a watched provider’s other logins too', () => {
    // Lanes are per login but a viewer occupies the account, so yielding is
    // decided one level up from the arithmetic. `7:2` carries no viewer of its
    // own and would look free if this were judged lane by lane.
    const limits = pacer().laneLimits(
      new Map([...base, ['7:2', 4]]),
      watching,
      new Map([['7:0', 1]]),
      new Map([...providerOf, ['7:2', 7]]),
    );
    expect([...limits.keys()]).toEqual(['8:0']);
  });

  it('pauses everything when no viewer can be charged to a provider', () => {
    // Dispatcharr named no M3U profile for the session, so every lane reads
    // zero viewers while the read says somebody is watching. The mode cannot
    // avoid a provider it cannot identify, so it does not pretend to.
    expect(pacer().laneLimits(base, watching, new Map(), providerOf).size).toBe(0);
  });

  it('pauses everything when the activity probe itself failed', () => {
    // `busyUnknown` is a viewer nothing can be charged to by construction --
    // the same shape as the case above, which is why the emptiness of the
    // count is the test rather than a flag on the read.
    expect(pacer().laneLimits(base, busyUnknown(), new Map(), providerOf).size).toBe(0);
  });

  it('pauses everything when the lane map cannot be attributed at all', () => {
    expect(pacer().laneLimits(base, watching, new Map([['7:0', 1]])).size).toBe(0);
  });

  it('pauses everything when a lane carrying a viewer names no provider', () => {
    // One unattributable lane is enough. It might be the account being watched.
    const limits = pacer().laneLimits(base, watching, new Map([['7:0', 1]]), new Map([['8:0', 8]]));
    expect(limits.size).toBe(0);
  });

  it('skips a lane whose provider is unknown, while others carry on', () => {
    const limits = pacer().laneLimits(
      new Map([...base, ['9:0', 5]]),
      watching,
      new Map([['7:0', 1]]),
      providerOf,
    );
    expect([...limits.keys()]).toEqual(['8:0']);
  });

  it('is unchanged while nobody is watching', () => {
    // No viewers, so no reserve and no yielding: a max_streams=1 provider must
    // still be checkable.
    const limits = pacer().laneLimits(new Map([['7:0', 1]]), idle, new Map(), providerOf);
    expect(limits.get('7:0')).toBe(1);
  });

  it('does nothing when the pause it relaxes is switched off', () => {
    // Pausing off already means "compete on every lane's own capacity", and
    // this setting only ever relaxes a pause. Provider 7 keeps 3 - 1 - 1 = 1.
    const limits = pacer({ pauseWhenWatching: false }).laneLimits(
      base,
      watching,
      new Map([['7:0', 1]]),
      providerOf,
    );
    expect([...limits]).toEqual([
      ['7:0', 1],
      ['8:0', 4],
    ]);
  });
});

describe('pausedByActivity with probeIdleProviders', () => {
  it('no longer settles the pass on the activity read alone', () => {
    // Which providers to avoid is derived from per-lane viewer counts, and
    // those come from the stream catalogue the shortcut exists to skip. The
    // mode gives that saving up on purpose.
    expect(pacer().pausedByActivity(watching)).toBe(false);
    expect(pacer({ probeIdleProviders: false }).pausedByActivity(watching)).toBe(true);
  });

  it('still says no when nobody is watching', () => {
    expect(pacer().pausedByActivity(idle)).toBe(false);
  });
});

describe('a watching pass, end to end', () => {
  let dir: string;
  let store: Store;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-idle-providers-'));
    store = new Store(join(dir, 'idle.db'));
    const tmp = join(dir, 'rules.json.tmp');
    writeFileSync(tmp, JSON.stringify({ schema: 2, defaults: {}, channels: [] }), 'utf8');
    renameSync(tmp, join(dir, 'rules.json'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * One viewer, on provider 5's default profile. Provider 6 is untouched.
   * `profileId` of null is the unattributable session.
   */
  function stubDispatcharr(profileId: number | null) {
    const paths: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      paths.push(new URL(url).pathname);
      const session: Record<string, unknown> = { channel_id: 1 };
      if (profileId !== null) session.m3u_profile_id = profileId;
      const body = url.includes('/accounts/token/')
        ? { access: 'a', refresh: 'r' }
        : url.includes('/proxy/ts/status')
          ? { channels: [session], count: 1 }
          : url.includes('/m3u/accounts/')
            ? {
                count: 2,
                next: null,
                results: [
                  {
                    id: 5,
                    name: 'Watched',
                    max_streams: 3,
                    profiles: [{ id: 12, name: 'Default', is_default: true, is_active: true }],
                  },
                  {
                    id: 6,
                    name: 'Spare',
                    max_streams: 3,
                    profiles: [{ id: 13, name: 'Default', is_default: true, is_active: true }],
                  },
                ],
              }
            : { count: 0, next: null, results: [] };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as unknown as typeof fetch;
    return paths;
  }

  const runner = (env: Record<string, string> = {}, log?: (m: string) => void) =>
    new Runner({
      log,
      config: () =>
        loadConfig({
          PODIUM_DATA_DIR: dir,
          DISPATCHARR_API_KEY: 'k',
          PODIUM_PROBE_IDLE_PROVIDERS: 'true',
          ...env,
        }),
      store,
      rules: new RulesSource(join(dir, 'rules.json')),
    });

  it('carries on, and pays the catalogue fetch it used to skip', async () => {
    const paths = stubDispatcharr(12);
    const summary = await runner().runOnce();

    expect(summary.paused).toBe(false);
    // The saving the plain pause makes, deliberately given up: the lanes to
    // leave alone cannot be worked out without these.
    expect(paths).toContain('/api/channels/streams/');
    expect(paths).toContain('/proxy/ts/status');
  });

  it('pauses, and says why, when the session names no profile', async () => {
    const messages: string[] = [];
    const paths = stubDispatcharr(null);
    const summary = await runner({}, (m) => messages.push(m)).runOnce();

    expect(summary.paused).toBe(true);
    // "No spare provider capacity" would send an operator to look at
    // max_streams, which is not the problem and cannot be the fix.
    expect(messages.join('\n')).toContain('did not say which provider');
    expect(paths).toContain('/api/channels/streams/');
  });

  it('still short-circuits when the lever is off', async () => {
    const paths = stubDispatcharr(12);
    const summary = await runner({ PODIUM_PROBE_IDLE_PROVIDERS: 'false' }).runOnce();

    expect(summary.paused).toBe(true);
    expect(paths).not.toContain('/api/channels/streams/');
  });
});
