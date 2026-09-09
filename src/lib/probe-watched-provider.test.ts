/**
 * Probing the account somebody is watching, on the connections it has spare.
 *
 * `probeIdleProviders` treats a viewer as a fact about one account rather than
 * the house, and then stays off that account entirely. The account it stays
 * off is rarely a random one: the provider sorted to the top is the one being
 * watched *because* it is the best, so the whole-account yield gives up
 * ranking on the provider that matters most for as long as a game lasts, while
 * four of its five connections sit idle.
 *
 * The safety argument this rests on is arithmetic rather than configuration.
 * Nothing here names a provider as safe to share -- an account with one or two
 * connections has nothing left once a viewer and the reserve come out, so it
 * goes on yielding exactly as before without anyone having to say so.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import type { ActiveSession } from './dispatcharr';
import { type Activity, busyUnknown, Pacer } from './pacer';
import { RulesSource } from './rules-source';
import { blockingSession, Runner, type ViewerGuard } from './runner';
import { Store } from './store';

const idle: Activity = { channelIds: new Set(), idle: true };
const watching: Activity = { channelIds: new Set([5]), idle: false };

const pacer = (over = {}) =>
  new Pacer({
    maxAgeMs: 3_600_000,
    tickMs: 60_000,
    pauseWhenWatching: true,
    probeIdleProviders: true,
    probeWatchedProvider: true,
    watchedFreeSlots: 2,
    minFreeSlots: 1,
    maxSlice: 400,
    ...over,
  });

/** Provider 7 is watched and sells five connections; 8 is untouched. */
const base = new Map([
  ['7:0', 5],
  ['8:0', 5],
]);
const providerOf = new Map([
  ['7:0', 7],
  ['8:0', 8],
]);

const yielding = (
  attributed: Array<[string, number]>,
  providers = providerOf,
  allSessionsPlaced = true,
) => ({ providerOf: providers, attributedByLane: new Map(attributed), allSessionsPlaced });

describe('laneLimits with probeWatchedProvider', () => {
  it('trims the watched account instead of closing it', () => {
    // 7 keeps 5 - 1 viewer - 2 reserve = 2. 8 is untouched by this and stays
    // on the ordinary arithmetic, reserve of 1 and all.
    const limits = pacer().laneLimits(
      base,
      watching,
      new Map([['7:0', 1]]),
      yielding([['7:0', 1]]),
    );
    expect([...limits]).toEqual([
      ['8:0', 4],
      ['7:0', 2],
    ]);
  });

  it('leaves a small account yielded without being told to', () => {
    // Two connections and a viewer is nothing to spare, and a provider like
    // that is the one the whole-account yield was right about. No per-provider
    // flag decides this: the subtraction does.
    const limits = pacer().laneLimits(
      new Map([['7:0', 2]]),
      watching,
      new Map([['7:0', 1]]),
      yielding([['7:0', 1]], new Map([['7:0', 7]])),
    );
    expect(limits.size).toBe(0);
  });

  it('closes the watched account when the setting is off', () => {
    const limits = pacer({ probeWatchedProvider: false }).laneLimits(
      base,
      watching,
      new Map([['7:0', 1]]),
      yielding([['7:0', 1]]),
    );
    expect([...limits]).toEqual([['8:0', 4]]);
  });

  it('takes the reserve once per account, not once per login', () => {
    // Two logins with max_streams 5 are one account with five connections far
    // more often than two accounts with five each. Read per lane this would
    // reserve two twice and still open six probes against the five slots the
    // viewer is sitting in, so capacity is the largest single login's cap and
    // the reserve comes off once: 5 - 1 - 2 = 2, dealt across the two lanes.
    const limits = pacer().laneLimits(
      new Map([
        ['7:0', 5],
        ['7:1', 5],
      ]),
      watching,
      new Map([['7:0', 1]]),
      yielding(
        [['7:0', 1]],
        new Map([
          ['7:0', 7],
          ['7:1', 7],
        ]),
      ),
    );
    expect([...limits].reduce((sum, [, free]) => sum + free, 0)).toBe(2);
    expect(limits.get('7:0')).toBe(1);
    expect(limits.get('7:1')).toBe(1);
  });

  it('never deals a login more than its own cap has left', () => {
    // The account can spare three, but the second login sells one connection
    // and its own viewer is in it. Spreading the work evenly must not mean
    // handing that lane capacity that does not exist.
    const limits = pacer({ watchedFreeSlots: 0 }).laneLimits(
      new Map([
        ['7:0', 5],
        ['7:1', 1],
      ]),
      watching,
      new Map([['7:0', 1]]),
      yielding(
        [
          ['7:0', 1],
          ['7:1', 1],
        ],
        new Map([
          ['7:0', 7],
          ['7:1', 7],
        ]),
      ),
    );
    expect([...limits]).toEqual([['7:0', 3]]);
  });

  it('still pauses everything when a viewer cannot be placed', () => {
    // The relaxation is narrower than the mode it relaxes, never wider. An
    // unplaceable session means the account being watched is unknown, and
    // "share the watched account's spare slots" is meaningless without it.
    expect(
      pacer().laneLimits(
        base,
        watching,
        new Map([['7:0', 1]]),
        yielding([['7:0', 1]], providerOf, false),
      ).size,
    ).toBe(0);
    expect(pacer().laneLimits(base, busyUnknown(), new Map(), yielding([])).size).toBe(0);
  });

  it('does nothing on its own when per-provider yielding is off', () => {
    // There is no "watched provider" to single out without it, so the plain
    // pause still settles the pass.
    const plain = pacer({ probeIdleProviders: false });
    expect(plain.pausedByActivity(watching)).toBe(true);
    expect(
      plain.laneLimits(base, watching, new Map([['7:0', 1]]), yielding([['7:0', 1]])).size,
    ).toBe(0);
  });

  it('changes nothing while the house is idle', () => {
    // No viewers, no yielding, no reserve -- including on a provider that
    // sells one connection, which must stay checkable.
    const limits = pacer().laneLimits(new Map([['7:0', 1]]), idle, new Map(), yielding([]));
    expect(limits.get('7:0')).toBe(1);
  });
});

describe('blockingSession', () => {
  const guard = (open: number[], baseline: Array<[number, number]> = []): ViewerGuard => ({
    providerOfProfile: new Map([
      [70, 7],
      [80, 8],
    ]),
    open: new Set(open),
    baseline: new Map(baseline),
  });
  const session = (channelId: number, profileId: number | null): ActiveSession => ({
    channelId,
    profileId,
  });

  it('lets the pass share a provider with the viewer already on it', () => {
    // The reason the baseline exists. This viewer is why the account was
    // trimmed rather than closed, and they will be there for the whole game --
    // a watcher that read them as an arrival would abort every pass on its
    // first poll and the mode would silently do nothing at all.
    expect(blockingSession([session(1, 70)], guard([7, 8], [[7, 1]]))).toBeNull();
  });

  it('stops the pass when somebody else tunes in to it', () => {
    const found = blockingSession([session(1, 70), session(2, 70)], guard([7, 8], [[7, 1]]));
    expect(found?.channelId).toBe(2);
  });

  it('does not read a channel change as an arrival', () => {
    // Sessions carry no identity -- the same viewer on a new channel is a new
    // row -- so the count is the only handle there is, and it holds steady.
    expect(blockingSession([session(9, 70)], guard([7, 8], [[7, 1]]))).toBeNull();
  });

  it('ignores a viewer on a provider this pass never opened', () => {
    expect(blockingSession([session(1, 80)], guard([7], [[7, 1]]))).toBeNull();
  });

  it('still stops on any viewer where the pass expected none', () => {
    // Every mode but the shared one yields an account the moment it carries a
    // viewer, so an open provider has a baseline of zero and one session is
    // one too many.
    expect(blockingSession([session(1, 70)], guard([7, 8]))?.channelId).toBe(1);
  });

  it('stops on a session that cannot be placed at all', () => {
    // The pacer fails closed on an unattributable viewer, and the run has to
    // agree with it or it carries on under a decision the pacer would not have
    // made. Same for a profile no active login claims.
    expect(blockingSession([session(3, null)], guard([7, 8], [[7, 1]]))?.channelId).toBe(3);
    expect(blockingSession([session(4, 99)], guard([7, 8], [[7, 1]]))?.channelId).toBe(4);
  });
});

describe('a shared pass, end to end', () => {
  let dir: string;
  let store: Store;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-watched-provider-'));
    store = new Store(join(dir, 'watched.db'));
    const tmp = join(dir, 'rules.json.tmp');
    writeFileSync(tmp, JSON.stringify({ schema: 2, defaults: {}, channels: [] }), 'utf8');
    renameSync(tmp, join(dir, 'rules.json'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One viewer on provider 5, which sells five connections. 6 is untouched. */
  function stubDispatcharr() {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/accounts/token/')
        ? { access: 'a', refresh: 'r' }
        : url.includes('/proxy/ts/status')
          ? { channels: [{ channel_id: 1, m3u_profile_id: 12 }], count: 1 }
          : url.includes('/m3u/accounts/')
            ? {
                count: 2,
                next: null,
                results: [
                  {
                    id: 5,
                    name: 'Watched',
                    max_streams: 5,
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
  }

  const runner = (env: Record<string, string>, log: (m: string) => void) =>
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

  it('opens the watched account and says so', async () => {
    const messages: string[] = [];
    stubDispatcharr();
    const summary = await runner({ PODIUM_PROBE_WATCHED_PROVIDER: 'true' }, (m) =>
      messages.push(m),
    ).runOnce();

    expect(summary.paused).toBe(false);
    const lanes = messages.find((m) => m.includes('lanes ')) ?? '';
    // Named, and named as shared rather than yielded: an operator looking into
    // a stream that died mid-game needs to know Podium was on that account.
    expect(lanes).toContain('sharing spare capacity on Watched');
    expect(lanes).toContain('"5:0":2');
  });

  it('yields it, as before, when the setting is off', async () => {
    const messages: string[] = [];
    stubDispatcharr();
    await runner({}, (m) => messages.push(m)).runOnce();

    const lanes = messages.find((m) => m.includes('lanes ')) ?? '';
    expect(lanes).toContain('yielded Watched');
    expect(lanes).not.toContain('"5:0"');
  });
});
