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

/**
 * Two tiers of genuinely different quality, both present inside each account
 * *and* inside each group.
 *
 * A tier carried by only one account is collinear with it; a tier carried by
 * only one group is collinear with that. Either way the broader factor is
 * fitted first and takes the signal, leaving the tier at 0 -- the right
 * answer, and a useless fixture. To say anything about a tier effect it has
 * to be the only thing varying.
 */
const spread = () =>
  buildProfile(
    [
      ...many(30, { providerId: 1, providerName: 'One', tier: 'fhd', bitrateKbps: 9000 }),
      ...many(30, {
        providerId: 1,
        providerName: 'One',
        tier: 'unknown',
        streamName: 'Sports Alpha',
        bitrateKbps: 3000,
      }),
      ...many(30, {
        providerId: 2,
        providerName: 'Two',
        tier: 'fhd',
        streamName: 'Sports Beta 1080p',
        groupId: 2,
        groupName: 'Group Two',
        bitrateKbps: 9000,
      }),
      ...many(30, {
        providerId: 2,
        providerName: 'Two',
        tier: 'unknown',
        streamName: 'Sports Beta',
        groupId: 2,
        groupName: 'Group Two',
        bitrateKbps: 3000,
      }),
    ],
    { minSamples: 20 },
  );

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

describe('the unlabelled reference level', () => {
  it('pins unknown at zero, because that is what an unlabelled stream scores', () => {
    // The fit re-centres tiers on their weighted mean, so `unknown` carries a
    // delta of its own against the baseline. Teamarr writes no rule for an
    // unlabelled stream, so on export that level *is* zero -- and a screen
    // showing the reference level as a non-zero number is describing a
    // different model from the one the file implements.
    const tiers = spread().tiers;
    const unknown = tiers.find((tier) => tier.key === 'unknown');
    expect(unknown?.deltaKbps).not.toBe(0);
    expect(unknown?.vsReferenceKbps).toBe(0);
  });

  it('quotes every other tier as its distance from unlabelled', () => {
    const tiers = spread().tiers;
    const fhd = tiers.find((tier) => tier.key === 'fhd');
    const unknown = tiers.find((tier) => tier.key === 'unknown');
    expect(fhd?.vsReferenceKbps).toBe((fhd?.deltaKbps ?? 0) - (unknown?.deltaKbps ?? 0));
  });

  it('scores the export from that distance, not from the baseline', () => {
    // The bug this fixes, in the arithmetic that caused it: against the
    // baseline the two numbers straddle zero, so each is smaller than the gap
    // an operator can see between the rows.
    const profile = spread();
    const fhd = profile.tiers.find((tier) => tier.key === 'fhd')!;
    const { rules } = teamarrRules(profile, { minSamples: 20, pointsPerMbps: 5, maxPoints: 100 });
    const regex = rules.find((rule) => rule.type === 'regex');
    expect(regex?.points).toBe(Math.round((fhd.vsReferenceKbps! / 1000) * 5));
    expect(regex?.points).not.toBe(Math.round((fhd.deltaKbps / 1000) * 5));
  });

  it('leaves accounts and groups on the baseline, which has no reference level', () => {
    const profile = spread();
    expect(profile.accounts.every((effect) => effect.vsReferenceKbps === null)).toBe(true);
    expect(profile.groups.every((effect) => effect.vsReferenceKbps === null)).toBe(true);
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
        // Labelled, and dying half the time -- the live shape.
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
        // Same account, same group, no label, healthy: the contrast that makes
        // the tier effect identifiable rather than the account's in disguise.
        ...many(30, {
          providerId: 1,
          providerName: 'Labeller',
          tier: 'unknown',
          streamName: 'Sports Alpha',
        }),
        ...many(30, {
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
    // across two accounts -- varying inside each, so the effect is the tier's
    // and not its account's -- and the rule is allowed to travel again.
    const { rules, podium } = teamarrRules(spread(), { minSamples: 20 });
    expect(podium.confoundedTiers).toEqual([]);
    expect(rules.some((rule) => rule.type === 'regex')).toBe(true);
  });

  it('sends perfectly collinear signal to the account, not the tier', () => {
    // The regression this ordering exists for. When account, group and tier
    // move together, every split that sums the same predicts the same, so the
    // fit cannot choose -- whichever is estimated first absorbs it and the rest
    // re-centre to zero. Fitting the broadest first puts it on the account,
    // which is the only one of the three that can carry it honestly: a `regex`
    // on `1080p` is run against every provider's streams, so charging one
    // account's deficit to a token other accounts also use is wrong in a way
    // charging it to the account never is.
    //
    // Before the reorder this fixture produced a large `fhd` effect and four
    // accounts reading exactly 0 -- which looks like "provider identity does
    // not matter here" and means "provider identity is in the next column,
    // mislabelled". On the live install it was -2937kbps sitting on `fhd`.
    const profile = buildProfile(
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
    expect(profile.accounts.find((a) => a.key === 'Labeller')?.deltaKbps).toBeLessThan(-500);
    expect(profile.accounts.find((a) => a.key === 'Silent')?.deltaKbps).toBeGreaterThan(500);
    expect(profile.tiers.every((t) => t.deltaKbps === 0)).toBe(true);
    expect(profile.groups.every((g) => g.deltaKbps === 0)).toBe(true);
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
