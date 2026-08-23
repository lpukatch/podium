/**
 * Two checks on the tier axis, both prompted by the same live finding.
 *
 * Of four accounts on the install this came from, one labelled 100% of its
 * streams with a resolution and the other three labelled 10-15%. So `fhd` was
 * fitted almost entirely from that one account, and the number it produced --
 * -2196 kbps against the reference level -- was not about resolution at all:
 * its median bitrate was within 700 kbps of the baseline, and what actually
 * differed was that its streams answered 54% of the time against 85%.
 *
 * Worse, the labels were not even true. Streams named `1080p` measured 720 in
 * 60% of cases, while streams naming no tier measured 1080 more often than the
 * labelled ones did.
 */

import { describe, expect, it } from 'vitest';
import { buildProfile, MAX_TIER_ACCOUNT_SHARE, teamarrRules, tierOfHeight } from './quality';
import type { StoredQualitySample } from './store';

function sample(over: Partial<StoredQualitySample> = {}): StoredQualitySample {
  return {
    providerId: 1,
    providerName: 'Labeller',
    tier: 'fhd',
    streamName: 'Sports Alpha 1080p',
    groupId: 1,
    groupName: 'Group One',
    channelGroupId: 10,
    channelGroupName: 'Sports',
    policyMode: 'always',
    audioOnly: false,
    sampledAt: 1_700_000_000_000,
    alive: true,
    black: false,
    bitrateKbps: 5000,
    measured: true,
    height: 1080,
    fps: 50,
    ...over,
  };
}

const many = (count: number, over: Partial<StoredQualitySample> = {}) =>
  Array.from({ length: count }, () => sample(over));

describe('tierOfHeight', () => {
  it('reads the picture, not the name', () => {
    expect(tierOfHeight(2160)).toBe('uhd');
    expect(tierOfHeight(1080)).toBe('fhd');
    expect(tierOfHeight(720)).toBe('hd');
    expect(tierOfHeight(480)).toBe('sd');
    expect(tierOfHeight(0)).toBe('unknown');
  });

  it('does not lose a tier argument over sixteen scan lines', () => {
    // 1088 is a routine encoder artefact of 1080, and 1078 of the same. Both
    // are fhd to every viewer who has ever seen one.
    expect(tierOfHeight(1088)).toBe('fhd');
    expect(tierOfHeight(1078)).toBe('fhd');
  });
});

describe('an effect knows how many accounts it rests on', () => {
  it('reports one account when only one labels', () => {
    const profile = buildProfile(
      [
        ...many(40, { providerId: 1, providerName: 'Labeller', tier: 'fhd' }),
        ...many(40, { providerId: 2, providerName: 'Silent', tier: 'unknown' }),
      ],
      { minSamples: 20 },
    );
    const fhd = profile.tiers.find((tier) => tier.key === 'fhd');
    expect(fhd?.accounts).toBe(1);
    expect(fhd?.topAccountShare).toBe(1);
  });

  it('reports the spread when several do', () => {
    const profile = buildProfile(
      [
        ...many(30, { providerId: 1, providerName: 'One', tier: 'fhd' }),
        ...many(30, { providerId: 2, providerName: 'Two', tier: 'fhd' }),
        ...many(30, { providerId: 3, providerName: 'Three', tier: 'unknown' }),
      ],
      { minSamples: 20 },
    );
    const fhd = profile.tiers.find((tier) => tier.key === 'fhd');
    expect(fhd?.accounts).toBe(2);
    expect(fhd?.topAccountShare).toBeCloseTo(0.5, 2);
  });
});

describe('the export withholds a confounded tier', () => {
  /**
   * One account labels and dies half the time; another never labels and is
   * healthy. The tier effect is large, and it is entirely the first account's.
   */
  const lopsided = () =>
    buildProfile(
      [
        ...many(30, { providerId: 1, providerName: 'Labeller', tier: 'fhd' }),
        ...many(30, {
          providerId: 1,
          providerName: 'Labeller',
          tier: 'fhd',
          alive: false,
          bitrateKbps: 0,
          height: 0,
          measured: false,
        }),
        ...many(60, {
          providerId: 2,
          providerName: 'Silent',
          tier: 'unknown',
          streamName: 'Sports Beta',
          groupId: 2,
          groupName: 'Group Two',
        }),
      ],
      { minSamples: 20 },
    );

  it('still shows the number, so the operator can see the judgement', () => {
    const fhd = lopsided().tiers.find((tier) => tier.key === 'fhd');
    expect(fhd?.topAccountShare).toBeGreaterThan(MAX_TIER_ACCOUNT_SHARE);
    expect(fhd?.deltaKbps).not.toBe(0);
  });

  it('writes no regex rule for it', () => {
    const { rules } = teamarrRules(lopsided(), { minSamples: 20 });
    expect(rules.filter((rule) => rule.type === 'regex')).toEqual([]);
  });

  it('says so in the file rather than dropping it silently', () => {
    // A rule that simply fails to appear is indistinguishable from one nobody
    // thought to write, which is the reading an operator must not be left with.
    const { podium } = teamarrRules(lopsided(), { minSamples: 20 });
    expect(podium.confoundedTiers).toHaveLength(1);
    expect(podium.confoundedTiers[0]?.tier).toBe('fhd');
    expect(podium.confoundedTiers[0]?.accounts).toBe(1);
    expect(podium.confoundedTiers[0]?.wouldHaveScored).not.toBe(0);
    expect(podium.note).toContain('withheld');
  });

  it('exports the tier once a second account supplies enough of it', () => {
    // The guard is about evidence, not about the tier: spread the same label
    // across two accounts and the rule is allowed to travel again.
    const profile = buildProfile(
      [
        ...many(30, { providerId: 1, providerName: 'One', tier: 'fhd', bitrateKbps: 9000 }),
        ...many(30, {
          providerId: 2,
          providerName: 'Two',
          tier: 'fhd',
          bitrateKbps: 9000,
          groupId: 2,
          groupName: 'Group Two',
        }),
        ...many(30, {
          providerId: 3,
          providerName: 'Three',
          tier: 'unknown',
          streamName: 'Sports Gamma',
          groupId: 3,
          groupName: 'Group Three',
          bitrateKbps: 2000,
        }),
      ],
      { minSamples: 20 },
    );
    const { rules, podium } = teamarrRules(profile, { minSamples: 20 });
    expect(podium.confoundedTiers).toEqual([]);
    expect(rules.some((rule) => rule.type === 'regex')).toBe(true);
  });

  it('is where the collinear signal ends up, which is why the guard exists', () => {
    // Backfitting cannot split factors that move together, and this one does
    // not split them evenly: fitting tier first each round lets it absorb the
    // whole residual, after which group and account find nothing left and
    // re-centring pins them at zero.
    //
    // So a perfectly confounded install does not produce three modest effects
    // that an operator might notice adding up. It produces one large tier
    // effect and two dimensions reading exactly 0 -- which looks like "provider
    // identity does not matter here" and is really "provider identity is in the
    // next column, mislabelled".
    const profile = lopsided();
    expect(profile.accounts.map((a) => a.deltaKbps)).toEqual([0, 0]);
    expect(profile.groups.map((g) => g.deltaKbps)).toEqual([0, 0]);
    expect(profile.tiers.find((t) => t.key === 'fhd')?.deltaKbps).toBeLessThan(-500);
  });

  it('leaves account rules alone when the account has its own signal', () => {
    // The guard is aimed at one dimension. Give the accounts something the
    // tier does not explain -- here each one spans both groups, so `m3u` is no
    // longer collinear with anything -- and its rule exports as it always did
    // while the single-account tier stays withheld.
    const profile = buildProfile(
      [
        ...many(30, { providerId: 1, providerName: 'Labeller', tier: 'fhd', bitrateKbps: 9000 }),
        // The labelled half also dies half the time -- the live shape, and what
        // gives the tier an apparent effect of its own to be judged on.
        ...many(30, {
          providerId: 1,
          providerName: 'Labeller',
          tier: 'fhd',
          alive: false,
          bitrateKbps: 0,
          height: 0,
          measured: false,
        }),
        ...many(30, {
          providerId: 1,
          providerName: 'Labeller',
          tier: 'unknown',
          streamName: 'Sports Alpha',
          groupId: 2,
          groupName: 'Group Two',
          bitrateKbps: 9000,
        }),
        ...many(30, {
          providerId: 2,
          providerName: 'Silent',
          tier: 'unknown',
          streamName: 'Sports Beta',
          bitrateKbps: 2000,
        }),
        ...many(30, {
          providerId: 2,
          providerName: 'Silent',
          tier: 'unknown',
          streamName: 'Sports Beta',
          groupId: 2,
          groupName: 'Group Two',
          bitrateKbps: 2000,
        }),
      ],
      { minSamples: 20 },
    );
    const { rules, podium } = teamarrRules(profile, { minSamples: 20 });
    expect(profile.tiers.find((t) => t.key === 'fhd')?.topAccountShare).toBe(1);
    expect(podium.confoundedTiers.map((c) => c.tier)).toEqual(['fhd']);
    expect(rules.some((rule) => rule.type === 'm3u')).toBe(true);
    expect(rules.some((rule) => rule.type === 'regex')).toBe(false);
  });
});

describe('label accuracy', () => {
  it('catches an account whose labels do not survive measurement', () => {
    const profile = buildProfile(
      [
        // Claims 1080p, delivers 720 -- the live shape, at 60%.
        ...many(6, { providerId: 1, providerName: 'Liar', tier: 'fhd', height: 720 }),
        ...many(4, { providerId: 1, providerName: 'Liar', tier: 'fhd', height: 1080 }),
      ],
      { minSamples: 20 },
    );
    const row = profile.labelAccuracy.find((r) => r.providerId === 1);
    expect(row?.labelled).toBe(10);
    expect(row?.accuracy).toBeCloseTo(0.4, 2);
    expect(row?.labelledShare).toBe(1);
    expect(row?.commonestMiss).toEqual({ claimed: 'fhd', measured: 'hd', count: 6 });
  });

  it('gives an honest account a clean bill', () => {
    const profile = buildProfile(many(10, { tier: 'fhd', height: 1080 }), { minSamples: 20 });
    const row = profile.labelAccuracy[0];
    expect(row?.accuracy).toBe(1);
    expect(row?.commonestMiss).toBeNull();
  });

  it('cannot convict an account that never labels', () => {
    // No claim, no lie. `accuracy` is null rather than 0, because 0 would read
    // as "always wrong" on a screen where the two sit in the same column.
    const profile = buildProfile(many(10, { tier: 'unknown', height: 720 }), { minSamples: 20 });
    const row = profile.labelAccuracy[0];
    expect(row?.labelled).toBe(0);
    expect(row?.accuracy).toBeNull();
    expect(row?.labelledShare).toBe(0);
  });

  it('ignores samples with no picture to disagree with', () => {
    // A dead stream and a radio feed both have nothing to measure; counting
    // either as a failed label would blame a provider for our own blind spot.
    const profile = buildProfile(
      [
        ...many(5, { tier: 'fhd', alive: false, height: 0 }),
        ...many(5, { tier: 'fhd', audioOnly: true, height: 0 }),
        ...many(5, { tier: 'fhd', height: 1080 }),
      ],
      { minSamples: 20 },
    );
    const row = profile.labelAccuracy[0];
    expect(row?.samples).toBe(5);
    expect(row?.accuracy).toBe(1);
  });

  it('reports every account that labels, not just the ones that cleared the fit', () => {
    // Deliberately below `minSamples`: an account whose labels are too sparse
    // to fit is exactly the one whose labels most need looking at.
    const profile = buildProfile(many(3, { tier: 'fhd', height: 720 }), { minSamples: 20 });
    expect(profile.tiers).toEqual([]);
    expect(profile.labelAccuracy[0]?.accuracy).toBe(0);
  });
});
