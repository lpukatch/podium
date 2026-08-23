/**
 * The rule check, against the rule set it was designed from.
 *
 * The fixture is a real Teamarr export -- the point being that the simulation
 * has to survive the shapes people actually write, including the two rule types
 * it cannot evaluate at all.
 */

import { describe, expect, it } from 'vitest';
import type { ProbeResult } from './probe';
import { DEFAULT_STRATEGY } from './scoring';
import { Store } from './store';
import { checkRules, compileRules, factsFor, type RuleInput, toJsRegExp } from './teamarr';

const LIVE_RULES: RuleInput[] = [
  { type: 'stream_type', value: 'team', priority: 99, mode: 'score', points: -50 },
  { type: 'm3u', value: 'Provider A', priority: 99, mode: 'score', points: 20 },
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
  { type: 'epg_match', value: '', priority: 99, mode: 'score', points: 10 },
  { type: 'm3u', value: 'Provider B2', priority: 99, mode: 'score', points: 10 },
  { type: 'regex', value: '^NFL Game Pass.*', priority: 99, mode: 'score', points: 10 },
  { type: 'group', value: 'Sports | DAZN US', priority: 99, mode: 'score', points: 10 },
];

const result = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  alive: true,
  width: 1920,
  height: 1080,
  fps: 50,
  bitrateKbps: 6000,
  videoCodec: 'h264',
  audioCodec: 'aac',
  pixelFormat: 'yuv420p',
  audioChannels: 2,
  channelLayout: 'stereo',
  audioBitrateKbps: 128,
  audioSampleRate: 48_000,
  bitrateMeasured: true,
  black: false,
  blackSeconds: 0,
  elapsedMs: 1000,
  error: '',
  ...over,
});

const facts = (
  id: number,
  over: { name?: string; providerName?: string; groupName?: string } = {},
  probe: Partial<ProbeResult> = {},
) =>
  factsFor(
    {
      id,
      name: over.name ?? `Stream ${id}`,
      providerName: over.providerName ?? 'Provider C',
      groupName: over.groupName ?? 'Sports | EPL',
    },
    result(probe),
    DEFAULT_STRATEGY,
  );

describe('toJsRegExp', () => {
  it('reads the inline flag JavaScript has no syntax for', () => {
    // Podium's own exported rules carry `(?i)`, so failing here would mean the
    // check could not evaluate the rules Podium itself wrote.
    expect(toJsRegExp('(?i)hevc').test('Sports HEVC')).toBe(true);
    expect(toJsRegExp('hevc').test('Sports HEVC')).toBe(false);
  });

  it('evaluates a Podium tier rule against the names it was built for', () => {
    const rule = toJsRegExp('(?i).*(?<![A-Za-z0-9])(?:FHD|1080P|1080I)\\d*(?![A-Za-z]).*');
    expect(rule.test('USA: ESPN fhd')).toBe(true);
    expect(rule.test('Sports Alpha 1080p60')).toBe(true);
    expect(rule.test('Sports Alpha HDR')).toBe(false);
  });

  it('translates the Python named-group spelling', () => {
    expect(toJsRegExp('(?P<tier>4K)').test('Movie 4K')).toBe(true);
  });
});

describe('compileRules', () => {
  it('evaluates what it can and declares what it cannot', () => {
    const { compiled, skipped } = compileRules(LIVE_RULES);
    expect(compiled).toHaveLength(6);
    // Teamarr's own state. Guessing would move a channel's verdict without
    // saying it did, which is worse than reporting the report as partial.
    expect(skipped.map((rule) => rule.type).sort()).toEqual(['epg_match', 'stream_type']);
  });

  it('refuses a priority-mode rule rather than adding its points', () => {
    // Priority sorts into bands; summing it would produce a number Teamarr
    // never computes.
    const { compiled, skipped } = compileRules([
      { type: 'm3u', value: 'Provider A', mode: 'priority', points: 20 },
    ]);
    expect(compiled).toHaveLength(0);
    expect(skipped[0]?.reason).toContain('bands');
  });

  it('reports a regex it cannot compile instead of dropping it', () => {
    const { skipped } = compileRules([
      { type: 'regex', value: '(unclosed', mode: 'score', points: 5 },
    ]);
    expect(skipped[0]?.reason).toContain('regex');
  });
});

describe('checkRules', () => {
  const channel = (
    streams: Array<{ facts: ReturnType<typeof facts>; stepOrder: number }>,
    over: { channelId?: number; channelName?: string } = {},
  ) => ({
    channelId: over.channelId ?? 1,
    channelName: over.channelName ?? 'EPL01',
    streams,
  });

  it('finds the channel where the rules pick the worse stream', () => {
    // Provider A carries +20 by name and 2Mbps in fact; Provider C carries no
    // rule and 12Mbps. The rules put the worse stream first, which is the
    // finding this whole endpoint exists to surface.
    const check = checkRules(
      [
        channel([
          { facts: facts(1, { providerName: 'Provider A' }, { bitrateKbps: 2000 }), stepOrder: 0 },
          {
            facts: facts(2, { providerName: 'Provider C' }, { bitrateKbps: 12_000 }),
            stepOrder: 1,
          },
        ]),
      ],
      LIVE_RULES,
      DEFAULT_STRATEGY,
    );

    expect(check.summary.disagreed).toBe(1);
    expect(check.channels[0]!.teamarr.streamId).toBe(1);
    expect(check.channels[0]!.podium.streamId).toBe(2);
    expect(check.channels[0]!.gapKbps).toBe(10_000);
    // The blame: why the rules chose it.
    expect(check.channels[0]!.teamarr.matched.map((rule) => rule.value)).toContain('Provider A');
  });

  it('agrees when the rules and the measurements point the same way', () => {
    const check = checkRules(
      [
        channel([
          {
            facts: facts(1, { providerName: 'Provider A' }, { bitrateKbps: 16_000 }),
            stepOrder: 0,
          },
          { facts: facts(2, { providerName: 'Provider C' }, { bitrateKbps: 3000 }), stepOrder: 1 },
        ]),
      ],
      LIVE_RULES,
      DEFAULT_STRATEGY,
    );
    expect(check.summary.agreed).toBe(1);
    expect(check.summary.gapKbps).toBe(0);
    // Both bitrate rungs, because Teamarr sums rather than picking one.
    expect(check.channels[0]!.teamarr.points).toBe(60);
  });

  it('counts a channel whose rules put a dead stream first', () => {
    // The worst outcome available, and invisible from inside Teamarr: every
    // rule fires on a stream that does not play.
    const check = checkRules(
      [
        channel([
          {
            facts: facts(1, { providerName: 'Provider A' }, { alive: false, bitrateKbps: 0 }),
            stepOrder: 0,
          },
          { facts: facts(2, { providerName: 'Provider C' }, { bitrateKbps: 4000 }), stepOrder: 1 },
        ]),
      ],
      LIVE_RULES,
      DEFAULT_STRATEGY,
    );
    expect(check.summary.deadFirst).toBe(1);
  });

  it('calls a tie ambiguous rather than agreement', () => {
    // Nothing in the rules decides this channel, so whatever Teamarr does next
    // decides it. A tie that happens to fall the right way is not a rule set
    // that works.
    const check = checkRules(
      [
        channel([
          { facts: facts(1, {}, { bitrateKbps: 9000 }), stepOrder: 0 },
          { facts: facts(2, {}, { bitrateKbps: 3000 }), stepOrder: 1 },
        ]),
      ],
      LIVE_RULES,
      DEFAULT_STRATEGY,
    );
    expect(check.channels[0]!.ambiguous).toBe(true);
    expect(check.channels[0]!.agree).toBe(true);
  });

  it('says the report is approximate when it could not read every rule', () => {
    expect(
      checkRules(
        [
          channel([
            { facts: facts(1, {}, { bitrateKbps: 9000 }), stepOrder: 0 },
            { facts: facts(2, {}, { bitrateKbps: 3000 }), stepOrder: 1 },
          ]),
        ],
        LIVE_RULES,
        DEFAULT_STRATEGY,
      ).summary.approximate,
    ).toBe(true);

    const evaluable = LIVE_RULES.filter(
      (rule) => rule.type !== 'epg_match' && rule.type !== 'stream_type',
    );
    expect(
      checkRules(
        [
          channel([
            { facts: facts(1, {}, { bitrateKbps: 9000 }), stepOrder: 0 },
            { facts: facts(2, {}, { bitrateKbps: 3000 }), stepOrder: 1 },
          ]),
        ],
        evaluable,
        DEFAULT_STRATEGY,
      ).summary.approximate,
    ).toBe(false);
  });

  it('ignores a channel with nothing to order', () => {
    const check = checkRules(
      [channel([{ facts: facts(1), stepOrder: 0 }])],
      LIVE_RULES,
      DEFAULT_STRATEGY,
    );
    expect(check.channels).toHaveLength(0);
  });

  it('reads the bitrate under the key Teamarr reads', () => {
    // The rules say `ffmpeg_output_bitrate`, which is Dispatcharr's key rather
    // than Podium's own `video_bitrate`. Reading the wrong one would score
    // every stream as though it had never been measured.
    const { compiled } = compileRules([
      { type: 'stats_metric', value: 'ffmpeg_output_bitrate|>=|10000', mode: 'score', points: 20 },
    ]);
    expect(compiled[0]!.test(facts(1, {}, { bitrateKbps: 12_000 }))).toBe(true);
    expect(compiled[0]!.test(facts(1, {}, { bitrateKbps: 9000 }))).toBe(false);
  });
});

describe('scope and blame', () => {
  const pair = (over: { managed?: boolean } = {}) => ({
    channelId: 1,
    channelName: 'MLB | CIN/ARI',
    managed: over.managed,
    streams: [
      {
        facts: facts(1, { providerName: 'Provider A' }, { bitrateKbps: 192 }),
        stepOrder: 0,
      },
      { facts: facts(2, { providerName: 'Provider C' }, { bitrateKbps: 7000 }), stepOrder: 1 },
    ],
  });

  it('counts the channels Teamarr actually orders apart from the rest', () => {
    // Its stream-priority rules apply to the channels it manages. A
    // disagreement anywhere else is a comparison against a population those
    // rules are never evaluated on -- on a live install that was two thirds of
    // everything with enough verdicts to check.
    const check = checkRules(
      [pair({ managed: true }), { ...pair(), channelId: 2, channelName: 'NHK World TV' }],
      LIVE_RULES,
      DEFAULT_STRATEGY,
    );
    expect(check.summary.disagreed).toBe(2);
    expect(check.summary.managedChannels).toBe(1);
    expect(check.summary.managedAgreed).toBe(0);
    // Managed rows first, so the table opens on the channels that matter.
    expect(check.channels[0]!.channelName).toBe('MLB | CIN/ARI');
  });

  it('only calls a dead pick dead when something else was watchable', () => {
    // A channel where everything is dead also leads with a dead stream, and
    // counting it says "your rules are broken" about a provider outage.
    const allDead = checkRules(
      [
        {
          channelId: 3,
          channelName: 'Dead everywhere',
          managed: true,
          streams: [
            { facts: facts(1, {}, { alive: false, bitrateKbps: 0 }), stepOrder: 0 },
            { facts: facts(2, {}, { alive: false, bitrateKbps: 0 }), stepOrder: 1 },
          ],
        },
      ],
      LIVE_RULES,
      DEFAULT_STRATEGY,
    );
    expect(allDead.summary.deadFirst).toBe(0);

    const avoidable = checkRules(
      [
        {
          channelId: 4,
          channelName: 'NHK World TV',
          managed: true,
          streams: [
            {
              facts: facts(1, { providerName: 'Provider A' }, { alive: false, bitrateKbps: 0 }),
              stepOrder: 0,
            },
            { facts: facts(2, {}, { bitrateKbps: 8000 }), stepOrder: 1 },
          ],
        },
      ],
      LIVE_RULES,
      DEFAULT_STRATEGY,
    );
    expect(avoidable.summary.deadFirst).toBe(1);
    expect(avoidable.summary.managedDeadFirst).toBe(1);
  });
});

describe('what a pass keeps', () => {
  it('survives the fixture the check was about', () => {
    // The whole reason checks are stored. A fixture's streams exist for one
    // afternoon and pruneOutside sweeps their verdicts with them, so a check
    // run on Monday cannot see Saturday at all -- but a check run on Saturday
    // and written down can still be read on Monday.
    const store = new Store(':memory:');
    store.saveTeamarrRules(LIVE_RULES);

    store.recordRuleCheck({
      checkedAt: 1_700_000_000_000,
      runId: 'run-1',
      channels: 12,
      agreed: 9,
      disagreed: 3,
      ambiguous: 1,
      deadFirst: 1,
      gapKbps: 14_000,
      managedChannels: 5,
      managedAgreed: 2,
      managedDeadFirst: 1,
      managedGapKbps: 12_000,
      approximate: true,
      rulesEvaluated: 6,
      rulesSkipped: 2,
      misses: [
        {
          channelId: 47,
          channelName: 'EPL01',
          managed: true,
          teamarrStream: 1,
          teamarrName: 'EPL01: Hull 12:30 Man Utd 22/08',
          teamarrProvider: 'Provider A',
          teamarrPoints: 20,
          teamarrBitrate: 2000,
          teamarrAlive: true,
          teamarrBlack: false,
          teamarrMatched: [{ type: 'm3u', value: 'Provider A', points: 20 }],
          podiumStream: 2,
          podiumName: 'EPL01: Hull v Man Utd FHD',
          podiumProvider: 'Provider C',
          podiumBitrate: 12_000,
          gapKbps: 10_000,
        },
      ],
    });

    // Everything the miss described is gone from the catalogue by now.
    store.pruneOutside(new Set([999]));
    store.prune(-1);

    const { history, latest } = store.ruleChecks();
    expect(history[0]?.disagreed).toBe(3);
    expect(history[0]?.approximate).toBe(true);
    // The blame line too: the rule set is editable, so re-deriving why a past
    // miss happened would explain it with a rule that was not in force.
    expect(latest[0]?.teamarrMatched).toEqual([{ type: 'm3u', value: 'Provider A', points: 20 }]);
    expect(latest[0]?.podiumName).toBe('EPL01: Hull v Man Utd FHD');
    store.close();
  });

  it('reads back the rule set every later pass is measured against', () => {
    const store = new Store(':memory:');
    expect(store.teamarrRules()).toBeNull();
    store.saveTeamarrRules(LIVE_RULES);
    expect(store.teamarrRules()?.rules).toHaveLength(LIVE_RULES.length);

    // Replaced, not appended: there is one Teamarr and one current answer to
    // what it is running.
    store.saveTeamarrRules([LIVE_RULES[0]]);
    expect(store.teamarrRules()?.rules).toHaveLength(1);
    store.close();
  });
});
