import { describe, expect, it } from 'vitest';
import {
  buildProfile,
  inScope,
  mergeTeamarrRules,
  parseGlobs,
  type QualityScope,
  scopeFromConfig,
  type TeamarrRule,
  teamarrPattern,
  teamarrRules,
  tierOf,
  tierPattern,
} from './quality';
import { MAX_STREAM_NAME, Store, type StoredQualitySample } from './store';

function sample(over: Partial<StoredQualitySample> = {}): StoredQualitySample {
  return {
    providerId: 1,
    providerName: 'Provider A',
    tier: 'fhd',
    streamName: 'Sports Alpha FHD',
    groupId: 1,
    groupName: 'Group One',
    channelGroupId: 10,
    channelGroupName: 'Entertainment',
    policyMode: 'always',
    audioOnly: false,
    sampledAt: 1_700_000_000_000,
    alive: true,
    black: false,
    bitrateKbps: 5000,
    measured: true,
    height: 1080,
    fps: 50,
    videoCodec: 'h264',
    ...over,
  };
}

function many(count: number, over: Partial<StoredQualitySample> = {}): StoredQualitySample[] {
  return Array.from({ length: count }, () => sample(over));
}

describe('tierOf', () => {
  it('reads the token wherever the provider put it', () => {
    // normalize() only scans the tail; the export's regex searches the whole
    // name, so this has to as well or the two disagree about the same stream.
    expect(tierOf('MLB | Dodgers at Cubs 1080p')).toBe('fhd');
    expect(tierOf('FHD | MLB Dodgers at Cubs')).toBe('fhd');
  });

  it('does not read HD out of the middle of FHD or UHD', () => {
    // The bug this exists to prevent: a substring match puts every 1080p and
    // 2160p stream on the install into the hd bucket, and then ships Teamarr
    // a rule that repeats the mistake.
    expect(tierOf('Sports Alpha FHD')).toBe('fhd');
    expect(tierOf('Sports Alpha UHD')).toBe('uhd');
    expect(tierOf('Sports Alpha HD')).toBe('hd');
  });

  it('takes the highest tier a name carries', () => {
    expect(tierOf('Sports HD 1080p')).toBe('fhd');
  });

  it('is unknown when the name advertises nothing', () => {
    expect(tierOf('MLB 19 | Dodgers at Cubs AWAY')).toBe('unknown');
  });

  it('emits a pattern Python and JS both read the same way', () => {
    const pattern = new RegExp(tierPattern('hd'), 'i');
    expect(pattern.test('Sports HD')).toBe(true);
    expect(pattern.test('Sports FHD')).toBe(false);
    expect(pattern.test('Sports 720p')).toBe(true);
  });

  it('reads a token a provider has numbered', () => {
    // Real names from one provider's EPL group:
    //   EPL01: Hull 12:30 Man Utd 22/08
    //   EPL05: Brentford 17:30 Spurs 22/08
    // A symmetric (?![A-Za-z0-9]) boundary rejects both -- the trailing digit
    // trips it -- so a rule written that way scores a third of the group and
    // looks correct while doing it. Providers number resolutions the same way.
    const pattern = new RegExp(tierPattern('fhd'), 'i');
    expect(pattern.test('Sports Alpha 1080p60')).toBe(true);
    // A letter still terminates, which is the case the boundary is for.
    expect(new RegExp(tierPattern('hd'), 'i').test('Sports HDR')).toBe(false);
  });
});

describe('teamarrPattern', () => {
  it('anchors nothing and survives every way Teamarr might call it', () => {
    // JS cannot evaluate the inline flag, so the wrapper is asserted as text
    // and the predicate inside it is what the tests above exercise.
    expect(teamarrPattern(tierPattern('uhd'))).toBe(`(?i).*${tierPattern('uhd')}.*`);
  });
});

describe('buildProfile', () => {
  it('discounts a bucket by how often it fails to deliver', () => {
    // Same 5000kbps when it works, dead a third of the time. The bucket is
    // worth two thirds of that to somebody picking without a probe.
    const samples = [...many(20), ...many(10, { alive: false, bitrateKbps: 0, height: 0 })];
    const profile = buildProfile(samples, { minSamples: 5 });

    const bucket = profile.buckets[0]!;
    expect(bucket.medianBitrateKbps).toBe(5000);
    expect(bucket.aliveRate).toBeCloseTo(2 / 3, 5);
    expect(bucket.effectiveKbps).toBe(3333);
  });

  it('ignores declared bitrates and black screens in the median', () => {
    const samples = [
      ...many(10, { bitrateKbps: 5000, measured: true }),
      // A container that declares an absurd number, and a slate that measures
      // a real one. Neither describes what a viewer receives.
      ...many(10, { bitrateKbps: 90_000, measured: false }),
      ...many(10, { bitrateKbps: 300, black: true }),
    ];
    const profile = buildProfile(samples, { minSamples: 5 });

    const bucket = profile.buckets[0]!;
    expect(bucket.medianBitrateKbps).toBe(5000);
    expect(bucket.measuredSamples).toBe(10);
    expect(bucket.blackRate).toBeCloseTo(1 / 3, 5);
  });

  it('holds back a bucket with too few samples', () => {
    const samples = [
      ...many(30, { providerId: 1, providerName: 'Busy' }),
      ...many(3, { providerId: 2, providerName: 'Barely seen', bitrateKbps: 40_000 }),
    ];
    const profile = buildProfile(samples, { minSamples: 20 });

    // Still visible as a bucket -- it was measured -- but it contributes no
    // effect, so a 40Mbps reading off three streams cannot move an account.
    expect(profile.buckets).toHaveLength(2);
    expect(profile.accounts.map((effect) => effect.key)).toEqual(['Busy']);
  });

  it('does not credit an account merely for shipping more 1080p', () => {
    // Both accounts run identical encoders; one just sells more FHD. The tier
    // rule already pays for the tier, so crediting the account too would count
    // the same fact twice and rank the two apart when nothing separates them.
    const samples = [
      ...many(300, { providerId: 1, providerName: 'Mostly FHD', tier: 'fhd', bitrateKbps: 6000 }),
      ...many(30, { providerId: 1, providerName: 'Mostly FHD', tier: 'sd', bitrateKbps: 1000 }),
      ...many(30, { providerId: 2, providerName: 'Mostly SD', tier: 'fhd', bitrateKbps: 6000 }),
      ...many(300, { providerId: 2, providerName: 'Mostly SD', tier: 'sd', bitrateKbps: 1000 }),
    ];
    const profile = buildProfile(samples, { minSamples: 10 });

    const [a, b] = profile.accounts;
    expect(Math.abs(a!.deltaKbps - b!.deltaKbps)).toBeLessThan(100);
  });

  it('credits an account for being better within a tier', () => {
    // The signal a marginal average destroys. Same mix, different encoders:
    // this is the comparison that has to survive.
    const samples = [
      ...many(100, { providerId: 1, providerName: 'Good', tier: 'fhd', bitrateKbps: 8000 }),
      ...many(100, { providerId: 1, providerName: 'Good', tier: 'sd', bitrateKbps: 2000 }),
      ...many(100, { providerId: 2, providerName: 'Poor', tier: 'fhd', bitrateKbps: 3000 }),
      ...many(100, { providerId: 2, providerName: 'Poor', tier: 'sd', bitrateKbps: 800 }),
    ];
    const profile = buildProfile(samples, { minSamples: 10 });

    const good = profile.accounts.find((effect) => effect.key === 'Good')!;
    const poor = profile.accounts.find((effect) => effect.key === 'Poor')!;
    expect(good.deltaKbps - poor.deltaKbps).toBeGreaterThan(2000);
  });

  it("does not let one account's bad group drag down its account effect", () => {
    // The sign-flip found on a live install, reduced. Both accounts run the
    // same encoders in the shared group; one additionally carries a radio-like
    // package nobody would judge a video provider by. Without group in the
    // model that package is charged to the account.
    const samples = [
      ...many(100, {
        providerId: 1,
        providerName: 'Has extra group',
        groupId: 1,
        groupName: 'Shared',
        bitrateKbps: 6000,
      }),
      ...many(100, {
        providerId: 1,
        providerName: 'Has extra group',
        groupId: 2,
        groupName: 'Junk package',
        bitrateKbps: 300,
      }),
      ...many(100, {
        providerId: 2,
        providerName: 'Clean',
        groupId: 1,
        groupName: 'Shared',
        bitrateKbps: 6000,
      }),
    ];
    const profile = buildProfile(samples, { minSamples: 20 });

    const dirty = profile.accounts.find((effect) => effect.key === 'Has extra group')!;
    const clean = profile.accounts.find((effect) => effect.key === 'Clean')!;
    // Same quality where they overlap, so the accounts must land together and
    // the junk must be charged to the group instead.
    expect(Math.abs(dirty.deltaKbps - clean.deltaKbps)).toBeLessThan(600);
    const junk = profile.groups.find((effect) => effect.key === 'Junk package')!;
    const shared = profile.groups.find((effect) => effect.key === 'Shared')!;
    expect(shared.deltaKbps - junk.deltaKbps).toBeGreaterThan(3000);
  });

  it('keeps audio-only streams out of the video model', () => {
    // Radio measures a few hundred kbps because it has no video track. Pooled
    // in, it reads as a catastrophic provider.
    const video = many(100, { providerName: 'Mixed', bitrateKbps: 6000 });
    const radio = many(100, {
      providerName: 'Mixed',
      groupId: 9,
      groupName: 'SiriusXM',
      tier: 'unknown',
      audioOnly: true,
      bitrateKbps: 200,
    });
    const profile = buildProfile([...video, ...radio], { minSamples: 20 });

    expect(profile.audioOnlySamples).toBe(100);
    // Still summarised so the numbers are visible...
    expect(profile.buckets.some((bucket) => bucket.audioOnly)).toBe(true);
    // ...but the baseline is the video one, untouched by 200kbps audio.
    expect(profile.baselineKbps).toBeGreaterThan(5000);
    expect(profile.groups.some((effect) => effect.key === 'SiriusXM')).toBe(false);
  });

  it('exports a group as the wholesale rule Teamarr matches it with', () => {
    // The strongest effect Podium fits, and the one it withheld longest. A
    // group is matched by name, exactly as the provider writes it -- the same
    // key the samples were bucketed on, so the rule selects the population its
    // number was measured over.
    const profile = buildProfile(
      [
        ...many(100, { groupId: 1, groupName: 'Sports | EPL', bitrateKbps: 8000 }),
        ...many(100, { groupId: 2, groupName: 'VOD | Movies', bitrateKbps: 1000 }),
      ],
      { minSamples: 20 },
    );
    expect(profile.groups).toHaveLength(2);

    const groups = teamarrRules(profile).rules.filter((rule) => rule.type === 'group');
    expect(groups.map((rule) => rule.value)).toEqual(['Sports | EPL', 'VOD | Movies']);
    expect(groups[0]!.points).toBeGreaterThan(0);
    expect(groups[1]!.points).toBeLessThan(0);
  });

  it('predicts a bucket from the sum of its fitted effects', () => {
    // The property the whole export rests on: a consumer adds the effects
    // together, so if that sum does not approximate the bucket Podium
    // measured, the numbers describe a model nobody evaluates.
    const samples = [
      ...many(100, {
        providerId: 1,
        providerName: 'A',
        groupId: 1,
        groupName: 'G1',
        tier: 'fhd',
        bitrateKbps: 8000,
      }),
      ...many(100, {
        providerId: 1,
        providerName: 'A',
        groupId: 1,
        groupName: 'G1',
        tier: 'hd',
        bitrateKbps: 5000,
      }),
      ...many(100, {
        providerId: 1,
        providerName: 'A',
        groupId: 2,
        groupName: 'G2',
        tier: 'fhd',
        bitrateKbps: 5500,
      }),
      ...many(100, {
        providerId: 2,
        providerName: 'B',
        groupId: 1,
        groupName: 'G1',
        tier: 'fhd',
        bitrateKbps: 4000,
      }),
      ...many(100, {
        providerId: 2,
        providerName: 'B',
        groupId: 1,
        groupName: 'G1',
        tier: 'hd',
        bitrateKbps: 2000,
      }),
      ...many(100, {
        providerId: 2,
        providerName: 'B',
        groupId: 2,
        groupName: 'G2',
        tier: 'fhd',
        bitrateKbps: 1800,
      }),
    ];
    const profile = buildProfile(samples, { minSamples: 20 });

    for (const bucket of profile.buckets) {
      const account = profile.accounts.find((effect) => effect.key === bucket.providerName)!;
      const tier = profile.tiers.find((effect) => effect.key === bucket.tier)!;
      const group = profile.groups.find((effect) => effect.key === bucket.groupName)!;
      const predicted = profile.baselineKbps + account.deltaKbps + tier.deltaKbps + group.deltaKbps;
      expect(Math.abs(predicted - bucket.effectiveKbps)).toBeLessThan(900);
    }
  });
});

describe('teamarrRules', () => {
  const profile = buildProfile(
    [
      ...many(100, { providerId: 1, providerName: 'Premium IPTV', tier: 'fhd', bitrateKbps: 8000 }),
      ...many(100, { providerId: 1, providerName: 'Premium IPTV', tier: 'hd', bitrateKbps: 4000 }),
      ...many(100, { providerId: 2, providerName: 'Budget IPTV', tier: 'fhd', bitrateKbps: 3000 }),
      ...many(100, { providerId: 2, providerName: 'Budget IPTV', tier: 'hd', bitrateKbps: 1500 }),
    ],
    { minSamples: 20 },
  );

  it('ranks the accounts and tiers it measured', () => {
    const { rules } = teamarrRules(profile, { minSamples: 20 });

    const accounts = rules.filter((rule) => rule.type === 'm3u');
    expect(accounts.map((rule) => rule.value)).toEqual(['Premium IPTV', 'Budget IPTV']);
    expect(accounts[0]!.points).toBeGreaterThan(accounts[1]!.points);

    const tiers = rules.filter((rule) => rule.type === 'regex');
    expect(tiers).toHaveLength(2);
    expect(tiers[0]!.points).toBeGreaterThan(tiers[1]!.points);
  });

  it('emits only what Teamarr will accept on import', () => {
    const { rules } = teamarrRules(profile);
    for (const rule of rules) {
      expect(rule.mode).toBe('score');
      expect(Number.isInteger(rule.points)).toBe(true);
      expect(Math.abs(rule.points)).toBeLessThanOrEqual(100_000);
      expect(Number.isInteger(rule.priority)).toBe(true);
      expect(rule.priority).toBeGreaterThanOrEqual(1);
      expect(rule.priority).toBeLessThanOrEqual(99);
      expect(rule.value.trim()).not.toBe('');
    }
  });

  it('leaves the unnamed tier as the reference level', () => {
    // A stream whose name says nothing scores its account's effect alone.
    // Giving `unknown` a rule would mean writing a regex for the absence of
    // every token, which is both fragile and the wrong model.
    const withUnknown = buildProfile(
      [...many(100, { tier: 'unknown' }), ...many(100, { tier: 'fhd', bitrateKbps: 9000 })],
      { minSamples: 20 },
    );
    const { rules } = teamarrRules(withUnknown);
    expect(rules.some((rule) => rule.value.includes('unknown'))).toBe(false);
  });

  it('scales points by the knob, not by the raw kbps', () => {
    const top = (result: { rules: TeamarrRule[] }): number =>
      result.rules.find((rule) => rule.value === 'Premium IPTV')!.points;
    // Raised out of the cap's way: the point of this is the ratio.
    const tenfold = teamarrRules(profile, { pointsPerMbps: 100, maxPoints: 100_000 });
    const base = teamarrRules(profile, { pointsPerMbps: 10, maxPoints: 100_000 });
    expect(top(tenfold)).toBeCloseTo(top(base) * 10, -1);
  });

  it('keeps a prior below a measured stream, whatever it fitted', () => {
    // Teamarr scores a probed stream from stats_metric rules reading the
    // stream_stats Podium published -- a reading of that stream. The other
    // three types are inferences about streams like it, and the cap is what
    // stops an inference outranking a measurement however extreme its fit.
    // Distinct providerIds, or both halves land in one cell and the fit has no
    // account contrast to find -- which emits no prior at all and makes the
    // assertion below vacuous.
    const extreme = buildProfile(
      [
        ...many(100, { providerId: 1, providerName: 'Ludicrous', bitrateKbps: 200_000 }),
        ...many(100, { providerId: 2, providerName: 'Dire', bitrateKbps: 100 }),
      ],
      { minSamples: 20 },
    );
    const priors = teamarrRules(extreme).rules.filter((rule) => rule.type !== 'stats_metric');
    expect(priors.length).toBeGreaterThan(0);
    for (const rule of priors) {
      expect(Math.abs(rule.points)).toBeLessThanOrEqual(15);
    }
  });

  it('sinks a dead stream below every prior it could possibly carry', () => {
    // The other half of the same invariant, and the reason the liveness rules
    // sit outside the cap: a stream measured dead has to lose to a working one
    // even when it holds a full hand of favourable priors.
    const extreme = buildProfile(
      [
        ...many(100, { providerId: 1, providerName: 'Ludicrous', bitrateKbps: 200_000 }),
        ...many(100, { providerId: 2, providerName: 'Dire', bitrateKbps: 100 }),
      ],
      { minSamples: 20 },
    );
    const { rules } = teamarrRules(extreme);
    const dead = rules.find((rule) => rule.value === 'alive|=|0')!;
    const bestCase = rules
      .filter((rule) => rule.type !== 'stats_metric' && rule.points > 0)
      .reduce((sum, rule) => sum + rule.points, 0);
    expect(dead.points + bestCase).toBeLessThan(0);
  });

  it('emits a regex Teamarr reads the same way Podium did', () => {
    const tier = teamarrRules(profile).rules.find((rule) => rule.type === 'regex')!;
    // The flag, because the exported copy carries none of its own and every
    // token here is uppercase -- without it a rule for 1080P misses the 1080p
    // providers actually write. The wrapping, because a rules file cannot say
    // whether Teamarr calls search, match or fullmatch, and under match an
    // unanchored pattern is pinned to offset 0.
    expect(tier.value.startsWith('(?i).*')).toBe(true);
    expect(tier.value.endsWith('.*')).toBe(true);
  });
});

describe('mergeTeamarrRules', () => {
  const generated: TeamarrRule[] = [
    { type: 'm3u', value: 'Premium IPTV', priority: 50, mode: 'score', points: 40 },
    {
      type: 'regex',
      value: '(?<![A-Za-z0-9])(?:FHD)(?![A-Za-z0-9])',
      priority: 50,
      mode: 'score',
      points: 15,
    },
  ];

  it('keeps rules Podium knows nothing about', () => {
    // Teamarr's import replaces the whole set, so anything dropped here is
    // deleted from the instance.
    const existing = [
      { type: 'stream_type', value: 'epg', priority: 99, mode: 'score', points: -100000 },
      { type: 'home_feed', value: '', priority: 1, mode: 'priority', points: 0 },
    ];
    const merged = mergeTeamarrRules(existing, generated);
    expect(merged).toHaveLength(4);
    expect(merged.slice(0, 2)).toEqual(existing);
  });

  it('updates its own rule in place rather than stacking a second one', () => {
    const existing = [
      { type: 'm3u', value: 'premium iptv', priority: 50, mode: 'score', points: 10 },
    ];
    const merged = mergeTeamarrRules(existing, generated);

    // One m3u rule, carrying the new measurement. Two would double-count on
    // every re-import.
    const accounts = merged.filter((rule) => rule.type === 'm3u');
    expect(accounts).toHaveLength(1);
    expect((accounts[0] as TeamarrRule).points).toBe(40);
  });

  it('does not touch a hand-written rule that only looks similar', () => {
    // Same value, different mode: a hard priority band is an operator's
    // absolute, not an opinion about bitrate, and replacing it would quietly
    // demote it to a score.
    const existing = [
      { type: 'm3u', value: 'Premium IPTV', priority: 1, mode: 'priority', points: 0 },
    ];
    const merged = mergeTeamarrRules(existing, generated);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toEqual(existing[0]);
  });
});

describe('scope', () => {
  const events: QualityScope = { eventOnly: true, include: [], exclude: [] };

  it('admits a probe run for a channel an operator gated on kickoff', () => {
    expect(inScope(sample({ policyMode: 'after_epg_start' }), events)).toBe(true);
    expect(inScope(sample({ policyMode: 'assigned' }), events)).toBe(true);
  });

  it('leaves out a probe run for a channel in an ungated group', () => {
    // The whole point: a film library's bitrate must not become the baseline a
    // fixture's rule is quoted against.
    expect(inScope(sample({ policyMode: 'always' }), events)).toBe(false);
    expect(inScope(sample({ policyMode: 'never' }), events)).toBe(false);
  });

  it('cannot judge a sample recorded before the policy was', () => {
    // Not the same as rejecting it -- the row never carried the field. The
    // summary counts these apart so an upgrade does not read as a wrong prior.
    const profile = buildProfile([sample({ policyMode: '' })], { minSamples: 1, scope: events });
    expect(profile.scope.unrecorded).toBe(1);
    expect(profile.scope.notEvent).toBe(0);
    expect(profile.totalSamples).toBe(0);
  });

  it('lets a name pattern reach the history a policy cannot', () => {
    const legacy = sample({ policyMode: '', groupName: 'USA | SPORTS FHD' });
    expect(inScope(legacy, events)).toBe(false);
    expect(inScope(legacy, { ...events, include: ['*SPORTS*'] })).toBe(true);
  });

  it('matches a pattern against either group name', () => {
    // The stream's own group and the group of the channel it was probed for are
    // different questions, and an operator naming "sports" means either.
    const byChannel = sample({ groupName: 'Provider Feed 3', channelGroupName: 'Auto | SPORT' });
    expect(inScope(byChannel, { eventOnly: false, include: ['Auto | *'], exclude: [] })).toBe(true);
  });

  it('lets an exclude veto whatever admitted the sample', () => {
    const admitted = sample({ policyMode: 'after_epg_start', groupName: 'VOD | MOVIES' });
    expect(inScope(admitted, events)).toBe(true);
    expect(inScope(admitted, { ...events, exclude: ['*VOD*'] })).toBe(false);
    expect(inScope(admitted, { eventOnly: true, include: ['*MOVIES*'], exclude: ['*VOD*'] })).toBe(
      false,
    );
  });

  it('treats an include list with no policy gate as a whitelist', () => {
    const scope: QualityScope = { eventOnly: false, include: ['*SPORT*'], exclude: [] };
    expect(inScope(sample({ groupName: 'USA | SPORT' }), scope)).toBe(true);
    expect(inScope(sample({ groupName: 'USA | MOVIES' }), scope)).toBe(false);
  });

  it('admits everything when nothing is configured', () => {
    const profile = buildProfile(many(3, { policyMode: '' }), { minSamples: 1 });
    expect(profile.totalSamples).toBe(3);
    expect(profile.scope.inScope).toBe(3);
  });

  it('fits and exports only what it admitted', () => {
    // Two accounts, one probed for fixtures and one for a film library. The
    // gated fit must describe the first and say nothing at all about the second.
    const samples = [
      ...many(30, {
        providerName: 'Events Co',
        providerId: 1,
        policyMode: 'after_epg_start',
        bitrateKbps: 8000,
      }),
      ...many(30, {
        providerName: 'Films Co',
        providerId: 2,
        policyMode: 'always',
        bitrateKbps: 2000,
      }),
    ];

    const open = buildProfile(samples, { minSamples: 10 });
    expect(open.accounts.map((a) => a.key).sort()).toEqual(['Events Co', 'Films Co']);

    const gated = buildProfile(samples, { minSamples: 10, scope: events });
    expect(gated.accounts.map((a) => a.key)).toEqual(['Events Co']);
    expect(gated.baselineKbps).toBe(8000);
    expect(gated.recordedSamples).toBe(60);
    expect(gated.totalSamples).toBe(30);
    expect(gated.scope.notEvent).toBe(30);
    // Nothing to say about an account with no in-scope samples beats guessing.
    expect(teamarrRules(gated).rules.some((rule) => rule.value === 'Films Co')).toBe(false);
  });

  it('carries the scope into the exported file', () => {
    // The points are unfalsifiable once they leave: +40 fitted on fixtures and
    // +40 fitted on a film library are the same two characters.
    const exported = teamarrRules(
      buildProfile(many(30, { policyMode: 'after_epg_start' }), { minSamples: 10, scope: events }),
    );
    expect(exported.podium.scope.eventOnly).toBe(true);
    expect(exported.podium.scope.inScope).toBe(30);
  });
});

describe('names on samples', () => {
  it('keeps the provider name and counts how many samples carry one', () => {
    // Nothing reads names yet -- they are for mining name patterns, which needs
    // enough of them first. This count is what says when that is true, so it
    // has to describe the scoped population the mining would run over.
    const profile = buildProfile(
      [...many(3, { streamName: 'EPL01: Hull vs Man Utd' }), ...many(2, { streamName: '' })],
      { minSamples: 1 },
    );
    expect(profile.namedSamples).toBe(3);
    expect(profile.totalSamples).toBe(5);
  });

  it('bounds what a provider can write into the table', () => {
    // Provider-controlled text on the hot path of every probe.
    const store = new Store(':memory:');
    store.recordQuality({
      providerId: 1,
      providerName: 'Provider A',
      tier: 'fhd',
      streamName: 'x'.repeat(MAX_STREAM_NAME + 500),
      groupId: 3,
      groupName: 'Group One',
      channelGroupId: 10,
      channelGroupName: 'Entertainment',
      policyMode: 'after_epg_start',
      audioOnly: false,
      alive: true,
      black: false,
      bitrateKbps: 6000,
      measured: true,
      height: 1080,
      fps: 50,
      videoCodec: 'h264',
    });
    expect(store.qualitySamples()[0]!.streamName).toHaveLength(MAX_STREAM_NAME);
    store.close();
  });
});

describe('parseGlobs', () => {
  it('reads a list written either way round', () => {
    // The same string is typed one-per-line into settings and passed
    // comma-separated as a query parameter.
    expect(parseGlobs('*SPORT*, *PPV*')).toEqual(['*SPORT*', '*PPV*']);
    expect(parseGlobs('*SPORT*\n*PPV*\n')).toEqual(['*SPORT*', '*PPV*']);
    expect(parseGlobs('')).toEqual([]);
    expect(parseGlobs(undefined)).toEqual([]);
  });
});

describe('scopeFromConfig', () => {
  it('reads the three settings as one scope', () => {
    expect(
      scopeFromConfig({
        PODIUM_QUALITY_EVENT_ONLY: true,
        PODIUM_QUALITY_INCLUDE_GROUPS: '*SPORT*',
        PODIUM_QUALITY_EXCLUDE_GROUPS: '*VOD*, *24/7*',
      }),
    ).toEqual({ eventOnly: true, include: ['*SPORT*'], exclude: ['*VOD*', '*24/7*'] });
  });
});

describe('store', () => {
  it('keeps samples after the streams they came from are gone', () => {
    // The whole point: pruneOutside sweeps probe_cache for streams no longer
    // in the catalogue, which on an event install is most of them.
    const store = new Store(':memory:');
    store.recordQuality({
      providerId: 7,
      providerName: 'Provider A',
      tier: 'fhd',
      streamName: 'Sports Alpha FHD',
      groupId: 3,
      groupName: 'Group One',
      channelGroupId: 10,
      channelGroupName: 'Entertainment',
      policyMode: 'always',
      audioOnly: false,
      alive: true,
      black: false,
      bitrateKbps: 6000,
      measured: true,
      height: 1080,
      fps: 50,
      videoCodec: 'h264',
    });
    store.pruneOutside(new Set([1, 2, 3]));
    store.prune(-1);

    expect(store.qualitySamples()).toHaveLength(1);
    store.close();
  });

  it('holds a bucket to its most recent samples', () => {
    const store = new Store(':memory:');
    for (let i = 0; i < 30; i += 1) {
      store.recordQuality({
        providerId: 1,
        providerName: 'Provider A',
        tier: 'fhd',
        streamName: 'Sports Alpha FHD',
        groupId: 3,
        groupName: 'Group One',
        channelGroupId: 10,
        channelGroupName: 'Entertainment',
        policyMode: 'always',
        audioOnly: false,
        alive: true,
        black: false,
        bitrateKbps: 1000 + i,
        measured: true,
        height: 1080,
        fps: 50,
        videoCodec: 'h264',
      });
    }
    store.trimQuality(10);

    const kept = store.qualitySamples();
    expect(kept).toHaveLength(10);
    // Newest, not an arbitrary ten: a bucket has to track the encoder the
    // provider is running now.
    expect(Math.min(...kept.map((entry) => entry.bitrateKbps))).toBe(1020);
    store.close();
  });

  it('trims each bucket separately', () => {
    const store = new Store(':memory:');
    for (const tier of ['fhd', 'hd']) {
      for (let i = 0; i < 5; i += 1) {
        store.recordQuality({
          providerId: 1,
          providerName: 'Provider A',
          tier,
          streamName: 'Sports Alpha FHD',
          groupId: 3,
          groupName: 'Group One',
          channelGroupId: 10,
          channelGroupName: 'Entertainment',
          policyMode: 'always',
          audioOnly: false,
          alive: true,
          black: false,
          bitrateKbps: 1000,
          measured: true,
          height: 1080,
          fps: 50,
          videoCodec: 'h264',
        });
      }
    }
    store.trimQuality(3);

    // Three each, not three in total -- a busy bucket must not evict a quiet
    // one, or the quiet one never reaches minSamples and never gets a rule.
    expect(store.qualitySamples()).toHaveLength(6);
    store.close();
  });

  it('does not let a provider VOD probes evict its event ones', () => {
    // The trim window and the scope work against each other otherwise: a
    // catalogue is mostly not events, so the most recent 400 probes of a
    // (provider, tier) are mostly out of scope, and the gate would be reading a
    // window the trim had already emptied of everything it wanted.
    const store = new Store(':memory:');
    const write = (policyMode: string) =>
      store.recordQuality({
        providerId: 1,
        providerName: 'Provider A',
        tier: 'fhd',
        streamName: 'Sports Alpha FHD',
        groupId: 3,
        groupName: 'Group One',
        channelGroupId: 10,
        channelGroupName: 'Entertainment',
        policyMode,
        audioOnly: false,
        alive: true,
        black: false,
        bitrateKbps: 1000,
        measured: true,
        height: 1080,
        fps: 50,
        videoCodec: 'h264',
      });

    for (let i = 0; i < 3; i += 1) write('after_epg_start');
    for (let i = 0; i < 20; i += 1) write('always');
    store.trimQuality(5);

    const kept = store.qualitySamples();
    expect(kept.filter((s) => s.policyMode === 'after_epg_start')).toHaveLength(3);
    expect(kept.filter((s) => s.policyMode === 'always')).toHaveLength(5);
    store.close();
  });
});

describe('teamarrRules stats_metric export', () => {
  const watchable = (count: number, kbps: number) =>
    many(count, { policyMode: 'always', bitrateKbps: kbps, measured: true });

  it('reads the ladder off this catalogue rather than a hand-picked number', () => {
    // 100 streams evenly spread 1000..10000. The rungs have to land inside
    // that, not at somebody else's 10000/15000.
    const spread = Array.from({ length: 100 }, (_, i) =>
      sample({ bitrateKbps: 1000 + i * 91, measured: true }),
    );
    const profile = buildProfile(spread, { minSamples: 20 });
    const rungs = profile.bitrateLadder.rungsKbps;

    expect(rungs).toHaveLength(3);
    expect(rungs[0]).toBeLessThan(rungs[1]!);
    expect(rungs[1]).toBeLessThan(rungs[2]!);
    for (const rung of rungs) {
      expect(rung).toBeGreaterThanOrEqual(1000);
      expect(rung).toBeLessThanOrEqual(10_000);
    }

    const ladder = teamarrRules(profile).rules.filter((rule) =>
      rule.value.startsWith('ffmpeg_output_bitrate'),
    );
    expect(ladder.map((rule) => rule.value)).toEqual(
      rungs.map((rung) => `ffmpeg_output_bitrate|>=|${rung}`),
    );
  });

  it('excludes dead and black streams from the ladder', () => {
    // Otherwise the bottom rung is cleared by a black screen, and the rule
    // meant to reward a good picture rewards the absence of one.
    const profile = buildProfile(
      [
        ...watchable(50, 8000),
        ...many(50, { alive: false, bitrateKbps: 0, height: 0 }),
        ...many(50, { black: true, bitrateKbps: 200 }),
      ],
      { minSamples: 20 },
    );
    expect(profile.bitrateLadder.samples).toBe(50);
    expect(profile.bitrateLadder.rungsKbps.every((rung) => rung === 8000)).toBe(true);
  });

  it('emits one rung when the quartiles collapse onto one number', () => {
    // A uniform catalogue puts p50, p75 and p90 on the same value; emitting it
    // three times would silently triple what that rung is worth.
    const profile = buildProfile(watchable(60, 6000), { minSamples: 20 });
    const ladder = teamarrRules(profile).rules.filter((rule) =>
      rule.value.startsWith('ffmpeg_output_bitrate'),
    );
    expect(ladder).toHaveLength(1);
  });

  it('demotes a measured-dead stream and says nothing about an unprobed one', () => {
    const profile = buildProfile(watchable(60, 6000), { minSamples: 20 });
    const { rules } = teamarrRules(profile);

    const dead = rules.find((rule) => rule.value === 'alive|=|0')!;
    const black = rules.find((rule) => rule.value === 'blank_detected|=|1')!;
    expect(dead.points).toBeLessThan(0);
    expect(black.points).toBeLessThan(0);
    // No rule rewards being alive: a stream nobody has probed carries no
    // `alive` key, so a positive rule would sink every unprobed stream beneath
    // every probed one, and at kickoff the unprobed are most of them.
    expect(rules.some((rule) => rule.value === 'alive|=|1')).toBe(false);
  });

  it('can be turned off without disturbing the priors', () => {
    const profile = buildProfile(watchable(60, 6000), { minSamples: 20 });
    const { rules } = teamarrRules(profile, { deadPoints: 0, bitratePoints: 0 });
    expect(rules.some((rule) => rule.type === 'stats_metric')).toBe(false);
  });

  it('records the percentiles the rungs came from', () => {
    // The thresholds are the one thing here that will look arbitrary later.
    const profile = buildProfile(watchable(60, 6000), { minSamples: 20 });
    const { podium } = teamarrRules(profile);
    expect(podium.measured.ladder.percentiles).toEqual([0.5, 0.75, 0.9]);
    expect(podium.measured.ladder.samples).toBe(60);
    expect(podium.measured.deadPoints).toBeLessThan(0);
  });
});

describe('mergeTeamarrRules and stats_metric families', () => {
  const ladder: TeamarrRule[] = [
    { type: 'stats_metric', value: 'alive|=|0', priority: 99, mode: 'score', points: -100 },
    {
      type: 'stats_metric',
      value: 'ffmpeg_output_bitrate|>=|6000',
      priority: 99,
      mode: 'score',
      points: 8,
    },
    {
      type: 'stats_metric',
      value: 'ffmpeg_output_bitrate|>=|8000',
      priority: 99,
      mode: 'score',
      points: 8,
    },
  ];

  it('supersedes an old ladder instead of stacking a second one on top', () => {
    // The live case: hand-written rungs at 10000/15000, recalibrated to 6000/
    // 8000. Matching by value would keep all four and score the same bitrate
    // twice.
    const existing = [
      {
        type: 'stats_metric',
        value: 'ffmpeg_output_bitrate|>=|10000',
        priority: 99,
        mode: 'score',
        points: 20,
      },
      {
        type: 'stats_metric',
        value: 'ffmpeg_output_bitrate|>=|15000',
        priority: 99,
        mode: 'score',
        points: 20,
      },
    ];
    const merged = mergeTeamarrRules(existing, ladder);

    const bitrate = merged.filter((rule) => rule.value.startsWith('ffmpeg_output_bitrate'));
    expect(bitrate.map((rule) => rule.value)).toEqual([
      'ffmpeg_output_bitrate|>=|6000',
      'ffmpeg_output_bitrate|>=|8000',
    ]);
  });

  it('emits every rung rather than collapsing them to one', () => {
    // A family key shared by three generated rungs must not make them
    // interchangeable -- that would drop two of the three.
    const merged = mergeTeamarrRules([], ladder);
    expect(merged).toHaveLength(3);
  });

  it('leaves a metric Podium has no opinion about alone', () => {
    const existing = [
      { type: 'stats_metric', value: 'source_fps|>=|50', priority: 99, mode: 'score', points: 5 },
    ];
    const merged = mergeTeamarrRules(existing, ladder);
    expect(merged.some((rule) => rule.value === 'source_fps|>=|50')).toBe(true);
    expect(merged).toHaveLength(4);
  });

  it('leaves a compound condition alone', () => {
    // "at least 4Mbps AND at least 50fps" is a different opinion from any rung
    // of a ladder, and replacing it would quietly drop the fps half.
    const existing = [
      {
        type: 'stats_metric',
        value: 'ffmpeg_output_bitrate|>=|4000;source_fps|>=|50',
        priority: 99,
        mode: 'score',
        points: 25,
      },
    ];
    const merged = mergeTeamarrRules(existing, ladder);
    expect(merged.some((rule) => rule.value.includes(';'))).toBe(true);
  });

  it('replaces a liveness rule on the same metric whatever its threshold', () => {
    const existing = [
      { type: 'stats_metric', value: 'alive|=|1', priority: 99, mode: 'score', points: 5 },
    ];
    const merged = mergeTeamarrRules(existing, ladder);
    const liveness = merged.filter((rule) => rule.value.startsWith('alive|'));
    expect(liveness).toHaveLength(1);
    expect(liveness[0]!.value).toBe('alive|=|0');
  });
});
