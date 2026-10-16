/**
 * The lane arithmetic behind a manual check.
 *
 * `checkLaneLimits` answers one question: which logins may this on-demand
 * check open right now, and how wide. It has to agree with the worker's pacer
 * about what an account is -- lanes per login, caps per lane, viewers charged
 * to the lane Dispatcharr named -- or the check and the pass will disagree
 * about who is occupying a connection.
 */

import { describe, expect, it } from 'vitest';
import type { ProviderLogin } from './variants';
import { checkLaneLimits } from './variants';

const login = (
  id: number,
  maxStreams: number,
  over: Partial<ProviderLogin> = {},
): ProviderLogin => ({
  id,
  dispatcharrProfileId: id === 0 ? null : id,
  name: `login ${id}`,
  rewrite: null,
  maxStreams,
  currentViewers: 0,
  isDefault: id === 0,
  xtreamCodes: false,
  ...over,
});

const logins = (providerId: number, ...of: ProviderLogin[]) => new Map([[providerId, of]]);

describe('checkLaneLimits', () => {
  it('the spare login of a two-login account stays checkable while one is watched', () => {
    // The report behind this: one provider selling two connections, one of
    // them in use, and a manual check told there were no free connections.
    // The old arithmetic read caps alone -- no viewer subtraction, a flat
    // per-lane yield while the pass ran -- so a pair of 1-connection logins
    // was zero either way.
    const limits = checkLaneLimits(
      logins(7, login(0, 1), login(1, 1)),
      new Map([['7:0', 1]]),
      () => 0,
      false,
    );
    expect([...limits]).toEqual([
      ['7:0', 0],
      ['7:1', 1],
    ]);
  });

  it('yields one slot of surplus to a running pass, never the last one', () => {
    // A fat lane can spare the pass a slot. A single free connection cannot:
    // yielding it would strand the provider for as long as the pass runs, and
    // a probe that collides with the pass only costs a retry.
    const lane = logins(7, login(0, 5));
    const noViewers = new Map<string, number>();
    const reserve = () => 0;
    expect([...checkLaneLimits(lane, noViewers, reserve, false)]).toEqual([['7:0', 5]]);
    expect([...checkLaneLimits(lane, noViewers, reserve, true)]).toEqual([['7:0', 4]]);
    const capped = logins(7, login(0, 1), login(1, 1));
    expect([...checkLaneLimits(capped, new Map([['7:0', 1]]), reserve, true)]).toEqual([
      ['7:0', 0],
      ['7:1', 1],
    ]);
  });

  it('takes the reserve once per provider and deals what is left by headroom', () => {
    // A 3-connection login beside a 2-connection one: two reserved slots come
    // off the account's five once, and the remaining three split 2:1 across
    // the lanes' own headroom.
    const limits = checkLaneLimits(logins(7, login(0, 3), login(1, 2)), new Map(), () => 2, false);
    expect([...limits]).toEqual([
      ['7:0', 2],
      ['7:1', 1],
    ]);
  });

  it('a lane whose viewers reach its cap contributes nothing, not a negative', () => {
    const limits = checkLaneLimits(
      logins(7, login(0, 3), login(1, 2)),
      new Map([
        ['7:0', 5],
        ['7:1', 2],
      ]),
      () => 0,
      false,
    );
    expect([...limits]).toEqual([
      ['7:0', 0],
      ['7:1', 0],
    ]);
  });

  it('an account with no profiles probes on its single stored-URL lane', () => {
    const limits = checkLaneLimits(logins(7, login(0, 2)), new Map(), () => 1, false);
    expect([...limits]).toEqual([['7:0', 1]]);
  });
});
