/**
 * The name miner, and the properties that make its output safe to export.
 *
 * The cases here are the ones the live catalogue argued for: a provider marker
 * that must produce no candidate at all, a fixture token that must not survive
 * the guards, a consolidation whose sign disagrees across accounts, a codec
 * token that clears every guard and must still be withheld, and -- the one
 * correctness property the whole export rests on -- that a consolidating regex
 * plus its residual group rules score exactly what the group rules scored
 * alone.
 */

import { describe, expect, it } from 'vitest';
import {
  candidateTokens,
  mineNames,
  minePassA,
  minePassB,
  namesCodec,
  plausibleToken,
  tokenPattern,
} from './miner';
import { buildProfile, teamarrPattern, teamarrRules } from './quality';
import type { StoredQualitySample } from './store';

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);

function sample(over: Partial<StoredQualitySample> = {}): StoredQualitySample {
  return {
    providerId: 1,
    providerName: 'Provider A',
    tier: 'fhd',
    streamName: 'Sports Alpha',
    groupId: 1,
    groupName: 'Group One',
    channelGroupId: 10,
    channelGroupName: 'Auto | Soccer | EPL',
    policyMode: 'after_epg_start',
    audioOnly: false,
    alive: true,
    black: false,
    bitrateKbps: 5000,
    measured: true,
    height: 1080,
    fps: 50,
    videoCodec: 'h264',
    sampledAt: START,
    ...over,
  };
}

/** `count` samples of one name, spread evenly across `days`. */
function run(count: number, over: Partial<StoredQualitySample>, days = 10): StoredQualitySample[] {
  return Array.from({ length: count }, (_, i) =>
    sample({ ...over, sampledAt: START + Math.round((i / Math.max(1, count - 1)) * days * DAY) }),
  );
}

describe('candidates', () => {
  it('reads bracket bodies, prefix segments and numbered stems', () => {
    expect(candidateTokens('UK: TNT SPORTS 4 [H265] [720p]')).toEqual(
      expect.arrayContaining(['H265', '720P', 'UK:', 'TNT']),
    );
    const stems = candidateTokens('PRIME: FEED2 RAW');
    expect(stems).toContain('PRIME:');
    expect(stems).toContain('FEED2');
    expect(stems).toContain('FEED\\d*');
    expect(stems).toContain('RAW');
  });

  it('stops a stem whose stem word is stopped', () => {
    // `SPORTS4` is a specific feed and survives; `SPORTS\d*` does not, because
    // `\d*` matches zero digits, so it also matches the bare stop word and is
    // the same claim the stop list already rejected.
    const tokens = candidateTokens('UK: SPORTS4 [1080p]');
    expect(tokens).toContain('SPORTS4');
    expect(tokens).not.toContain('SPORTS\\d*');
    expect(tokens).not.toContain('SPORTS');
  });

  it('seeds tokens a word split would eat', () => {
    // `5.1` and `DD+` survive only because they are seeded; a plain split on
    // non-alphanumerics would have lost the punctuation that identifies them.
    expect(candidateTokens('Movie Channel DD+ 5.1')).toEqual(
      expect.arrayContaining(['DD+', '5.1']),
    );
  });

  it('drops numerics, clock times, dates and channel words', () => {
    expect(plausibleToken('1080')).toBe(false);
    expect(plausibleToken('7:30')).toBe(false);
    expect(plausibleToken('AUG')).toBe(false);
    expect(plausibleToken('PM')).toBe(false);
    expect(plausibleToken('SPORTS')).toBe(false);
    expect(plausibleToken('VS.')).toBe(false);
    expect(plausibleToken('H265')).toBe(true);
    expect(plausibleToken('PRIME:')).toBe(true);
  });

  it('never offers a fixture title as a token', () => {
    // The colon here belongs to a fixture, not to a provider prefix, and the
    // length bound is what tells them apart.
    const tokens = candidateTokens('Live: Tigers at Royals: all:  : CAN: SOCCER [PPV EVENTS]');
    expect(tokens).not.toContain('LIVE: TIGERS AT ROYALS:');
    expect(tokens.some((token) => token.includes(' '))).toBe(false);
  });
});

describe('token patterns', () => {
  it('escapes metacharacters rather than matching through them', () => {
    // `5.1` unescaped matches `521`, which is a bitrate, a channel number, or
    // anything else with three digits.
    const pattern = new RegExp(tokenPattern('5.1'), 'i');
    expect(pattern.test('Movie 5.1')).toBe(true);
    expect(pattern.test('Movie 521')).toBe(false);
  });

  it('keeps the tier export boundaries: HD does not match inside FHD', () => {
    const pattern = new RegExp(tokenPattern('HD'), 'i');
    expect(pattern.test('Sports HD')).toBe(true);
    expect(pattern.test('Sports FHD')).toBe(false);
    expect(pattern.test('Sports HDR')).toBe(false);
  });

  it('treats a trailing stem as a pattern, not a literal', () => {
    const pattern = new RegExp(tokenPattern('SPORTS\\d*'), 'i');
    expect(pattern.test('EPL SPORTS4')).toBe(true);
    expect(pattern.test('EPL SPORTS')).toBe(true);
  });
});

describe('pass A -- discrimination', () => {
  it('finds a token that varies inside a cell', () => {
    const samples = [
      ...run(30, { streamName: 'Alpha BACKUP', bitrateKbps: 2000 }),
      ...run(30, { streamName: 'Alpha', bitrateKbps: 8000 }),
      // A second cell, so the paired-cells guard can pass.
      ...run(30, { streamName: 'Beta BACKUP', bitrateKbps: 2000, groupId: 2, groupName: 'Two' }),
      ...run(30, { streamName: 'Beta', bitrateKbps: 8000, groupId: 2, groupName: 'Two' }),
    ];
    const found = minePassA(samples).find((c) => c.token === 'BACKUP');
    expect(found).toBeDefined();
    expect(found?.effectKbps).toBeLessThan(-500);
    expect(found?.cells).toBe(2);
    expect(found?.blockedBy).toEqual([]);
  });

  it('produces no candidate at all for a provider marker', () => {
    // The claim the paired contrast exists to make good on. `PRIMEX` is carried
    // by every stream of provider 2 and none of provider 1, so it never varies
    // inside a cell -- and must be absent rather than suppressed by a threshold.
    const samples = [
      ...run(40, { providerId: 1, providerName: 'A', streamName: 'Alpha', bitrateKbps: 8000 }),
      ...run(40, {
        providerId: 2,
        providerName: 'B',
        groupId: 2,
        groupName: 'Two',
        streamName: 'PRIMEX Alpha',
        bitrateKbps: 2000,
      }),
    ];
    expect(minePassA(samples).some((c) => c.token === 'PRIMEX')).toBe(false);
  });

  it('blocks a token that has not lasted, and says which guard stopped it', () => {
    const samples = [
      ...run(30, { streamName: 'Alpha BACKUP', bitrateKbps: 2000 }, 1),
      ...run(30, { streamName: 'Alpha', bitrateKbps: 8000 }, 1),
      ...run(30, { streamName: 'Beta BACKUP', bitrateKbps: 2000, groupId: 2, groupName: 'Two' }, 1),
      ...run(30, { streamName: 'Beta', bitrateKbps: 8000, groupId: 2, groupName: 'Two' }, 1),
    ];
    const found = minePassA(samples).find((c) => c.token === 'BACKUP');
    expect(found?.blockedBy).toContain('duration');
  });

  it('penalises a token that predicts a stream being dead', () => {
    // Nothing about the bitrate differs; the token only predicts not arriving.
    const samples = [
      ...run(30, { streamName: 'Alpha BACKUP', alive: false, bitrateKbps: 0, measured: false }),
      ...run(30, { streamName: 'Alpha', bitrateKbps: 6000 }),
      ...run(30, {
        streamName: 'Beta BACKUP',
        alive: false,
        bitrateKbps: 0,
        measured: false,
        groupId: 2,
        groupName: 'Two',
      }),
      ...run(30, { streamName: 'Beta', bitrateKbps: 6000, groupId: 2, groupName: 'Two' }),
    ];
    const found = minePassA(samples).find((c) => c.token === 'BACKUP');
    expect(found?.effectKbps).toBeLessThanOrEqual(-6000);
  });
});

describe('pass B -- consolidation', () => {
  /** Three groups that all carry `NOWTV`, plus one that does not. */
  function catalogue(over: Partial<StoredQualitySample> = {}): StoredQualitySample[] {
    return [
      ...run(25, { groupId: 1, groupName: 'UK One', streamName: 'NOWTV Alpha', ...over }),
      ...run(25, { groupId: 2, groupName: 'UK Two', streamName: 'NOWTV Beta', ...over }),
      ...run(25, { groupId: 3, groupName: 'UK Three', streamName: 'NOWTV Gamma', ...over }),
      ...run(25, { groupId: 4, groupName: 'Other', streamName: 'Delta', ...over }),
    ];
  }

  function groupsOf(samples: StoredQualitySample[]) {
    return buildProfile(samples, {
      minSamples: 20,
      scope: { eventOnly: false, include: [], exclude: [] },
    }).groups;
  }

  it('consolidates three carrier groups into one regex', () => {
    const samples = catalogue();
    // Make the three carriers consistently worse than the fourth group.
    for (const s of samples) if (s.groupName !== 'Other') s.bitrateKbps = 2000;
    const result = minePassB(samples, groupsOf(samples));
    const token = result.consolidated.find((t) => t.token === 'NOWTV');
    expect(token).toBeDefined();
    expect(token?.carriers).toHaveLength(3);
    expect(token?.pattern).toBe(teamarrPattern(tokenPattern('NOWTV')));
  });

  it('rejects a token whose carriers disagree in sign', () => {
    // The live `MILB` case: four groups carry it at 100%, and one of them is a
    // different account sitting the other side of the baseline. What the regex
    // would be scoring is the account.
    const samples = catalogue();
    for (const s of samples) {
      if (s.groupName === 'UK One') s.bitrateKbps = 9000;
      else if (s.groupName !== 'Other') s.bitrateKbps = 2000;
    }
    const result = minePassB(samples, groupsOf(samples));
    expect(result.consolidated.some((t) => t.token === 'NOWTV')).toBe(false);
    expect(result.rejected.find((r) => r.token === 'NOWTV')?.reason).toBe('inconsistent');
  });

  it('rejects a token a group carries only halfway', () => {
    const samples = catalogue();
    for (const s of samples) if (s.groupName !== 'Other') s.bitrateKbps = 2000;
    // Half of `Other` now carries the token: neither pass's business.
    const other = samples.filter((s) => s.groupName === 'Other');
    for (const s of other.slice(0, Math.floor(other.length / 2))) s.streamName = 'NOWTV Delta';
    const result = minePassB(samples, groupsOf(samples));
    expect(result.consolidated.some((t) => t.token === 'NOWTV')).toBe(false);
    expect(result.rejected.find((r) => r.token === 'NOWTV')?.reason).toBe('contaminated');
  });

  it('withholds a codec token that cleared every guard', () => {
    const samples = [
      ...run(25, { groupId: 1, groupName: 'UK One', streamName: 'Alpha [HEVC]' }),
      ...run(25, { groupId: 2, groupName: 'UK Two', streamName: 'Beta [HEVC]' }),
      ...run(25, { groupId: 3, groupName: 'UK Three', streamName: 'Gamma [HEVC]' }),
      ...run(25, { groupId: 4, groupName: 'Other', streamName: 'Delta' }),
    ];
    for (const s of samples) if (s.groupName !== 'Other') s.bitrateKbps = 2000;
    const result = minePassB(samples, groupsOf(samples));
    expect(result.consolidated.some((t) => t.token === 'HEVC')).toBe(false);
    // Withheld, not dropped: the number is still reported.
    const withheld = result.confoundedCodecs.find((t) => t.token === 'HEVC');
    expect(withheld).toBeDefined();
    expect(withheld?.carriers).toHaveLength(3);
    expect(namesCodec('HEVC')).toBe(true);
  });
});

describe('export', () => {
  it('a regex plus its residuals scores exactly what the group rules scored', () => {
    // The double-counting guard. Without residual re-emission a carrier's
    // stream would score its group rule and the regex on top.
    const samples = [
      ...run(25, { groupId: 1, groupName: 'UK One', streamName: 'NOWTV Alpha', bitrateKbps: 2000 }),
      ...run(25, { groupId: 2, groupName: 'UK Two', streamName: 'NOWTV Beta', bitrateKbps: 2200 }),
      ...run(25, {
        groupId: 3,
        groupName: 'UK Three',
        streamName: 'NOWTV Gamma',
        bitrateKbps: 1800,
      }),
      ...run(25, { groupId: 4, groupName: 'Other', streamName: 'Delta', bitrateKbps: 9000 }),
    ];
    const scope = { eventOnly: false, include: [], exclude: [] };
    const profile = buildProfile(samples, { minSamples: 20, scope });
    const { passB } = mineNames(samples, profile.groups);
    expect(passB.consolidated).toHaveLength(1);

    const plain = teamarrRules(profile, { minSamples: 20, pointsPerMbps: 5 });
    const mined = teamarrRules(profile, {
      minSamples: 20,
      pointsPerMbps: 5,
      consolidated: passB.consolidated,
    });

    const scoreFor = (rules: typeof plain.rules, group: string, name: string): number =>
      rules
        .filter(
          (rule) =>
            (rule.type === 'group' && rule.value === group) ||
            (rule.type === 'regex' && new RegExp(rule.value.replace('(?i)', ''), 'i').test(name)),
        )
        .reduce((sum, rule) => sum + rule.points, 0);

    for (const [group, name] of [
      ['UK One', 'NOWTV Alpha'],
      ['UK Two', 'NOWTV Beta'],
      ['UK Three', 'NOWTV Gamma'],
    ] as const) {
      // Within the rounding the points cap already imposes.
      expect(
        Math.abs(scoreFor(mined.rules, group, name) - scoreFor(plain.rules, group, name)),
      ).toBeLessThanOrEqual(1);
    }
  });

  it('records what each mined regex replaced', () => {
    const samples = [
      ...run(25, { groupId: 1, groupName: 'UK One', streamName: 'NOWTV Alpha', bitrateKbps: 2000 }),
      ...run(25, { groupId: 2, groupName: 'UK Two', streamName: 'NOWTV Beta', bitrateKbps: 2200 }),
      ...run(25, {
        groupId: 3,
        groupName: 'UK Three',
        streamName: 'NOWTV Gamma',
        bitrateKbps: 1800,
      }),
      ...run(25, { groupId: 4, groupName: 'Other', streamName: 'Delta', bitrateKbps: 9000 }),
    ];
    const scope = { eventOnly: false, include: [], exclude: [] };
    const profile = buildProfile(samples, { minSamples: 20, scope });
    const { passB } = mineNames(samples, profile.groups);
    const exported = teamarrRules(profile, {
      minSamples: 20,
      pointsPerMbps: 5,
      consolidated: passB.consolidated,
    });
    expect(exported.podium.minedRegex).toHaveLength(1);
    expect(exported.podium.minedRegex[0]?.replacedGroups).toEqual(
      expect.arrayContaining(['UK One', 'UK Two', 'UK Three']),
    );
    expect(exported.podium.note).toContain('REPLACE');
  });

  it('exports nothing mined when the caller did not mine', () => {
    const samples = run(40, {});
    const profile = buildProfile(samples, {
      minSamples: 20,
      scope: { eventOnly: false, include: [], exclude: [] },
    });
    const exported = teamarrRules(profile, { minSamples: 20, pointsPerMbps: 5 });
    expect(exported.podium.minedRegex).toEqual([]);
    expect(exported.rules.every((rule) => rule.type !== 'regex')).toBe(true);
  });
});

describe('readiness report', () => {
  it('says how much window is still missing', () => {
    const samples = run(60, {}, 2);
    const report = mineNames(samples, []);
    expect(report.windowDays).toBeCloseTo(2, 0);
    expect(report.durationShortfallDays).toBeCloseTo(5, 0);
  });
});
