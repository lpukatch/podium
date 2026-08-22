import { describe, expect, it } from 'vitest';
import {
  buildProfile,
  mergeTeamarrRules,
  type TeamarrRule,
  teamarrRules,
  tierOf,
  tierPattern,
} from './quality';
import { Store, type StoredQualitySample } from './store';

function sample(over: Partial<StoredQualitySample> = {}): StoredQualitySample {
  return {
    providerId: 1,
    providerName: 'Provider A',
    tier: 'fhd',
    groupId: 1,
    groupName: 'Group One',
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

  it('does not export a group rule', () => {
    // Group is a confounder held constant, not a product. Teamarr can only
    // match a group on channel-source streams, so a group rule would be inert
    // across most of the catalogue.
    const profile = buildProfile(
      [
        ...many(100, { groupId: 1, groupName: 'Good group', bitrateKbps: 8000 }),
        ...many(100, { groupId: 2, groupName: 'Bad group', bitrateKbps: 1000 }),
      ],
      { minSamples: 20 },
    );
    expect(profile.groups).toHaveLength(2);
    for (const rule of teamarrRules(profile).rules) {
      expect(rule.value).not.toContain('group');
    }
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
    const tenfold = teamarrRules(profile, { pointsPerMbps: 100 });
    const base = teamarrRules(profile, { pointsPerMbps: 10 });
    const top = (result: { rules: TeamarrRule[] }): number =>
      result.rules.find((rule) => rule.value === 'Premium IPTV')!.points;
    expect(top(tenfold)).toBeCloseTo(top(base) * 10, -1);
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

describe('store', () => {
  it('keeps samples after the streams they came from are gone', () => {
    // The whole point: pruneOutside sweeps probe_cache for streams no longer
    // in the catalogue, which on an event install is most of them.
    const store = new Store(':memory:');
    store.recordQuality({
      providerId: 7,
      providerName: 'Provider A',
      tier: 'fhd',
      groupId: 3,
      groupName: 'Group One',
      audioOnly: false,
      alive: true,
      black: false,
      bitrateKbps: 6000,
      measured: true,
      height: 1080,
      fps: 50,
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
        groupId: 3,
        groupName: 'Group One',
        audioOnly: false,
        alive: true,
        black: false,
        bitrateKbps: 1000 + i,
        measured: true,
        height: 1080,
        fps: 50,
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
          groupId: 3,
          groupName: 'Group One',
          audioOnly: false,
          alive: true,
          black: false,
          bitrateKbps: 1000,
          measured: true,
          height: 1080,
          fps: 50,
        });
      }
    }
    store.trimQuality(3);

    // Three each, not three in total -- a busy bucket must not evict a quiet
    // one, or the quiet one never reaches minSamples and never gets a rule.
    expect(store.qualitySamples()).toHaveLength(6);
    store.close();
  });
});
