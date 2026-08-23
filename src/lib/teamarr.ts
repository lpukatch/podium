/**
 * Teamarr's scorer, run against Podium's measurements.
 *
 * The export in `quality.ts` sends rules one way and hears nothing back. That
 * is a problem, because a scoring rule is unfalsifiable from the outside: a
 * `+20` that matches nothing, a regex pinned to the wrong end of a name and a
 * rule that works are all the same two characters in a JSON file, and the only
 * visible consequence is which stream a viewer gets three weeks later.
 *
 * This closes the loop. Teamarr orders a channel's streams by summing the rules
 * each one matches; Podium has probed those same streams and knows which is
 * actually best. Running both orderings over the same channel turns "are my
 * rules right" into a question with an answer -- and, where they disagree, says
 * which rule did it.
 *
 * The simulation is honest about its limits rather than complete. `epg_match`
 * and `stream_type` are Teamarr's own state, unknowable from here, and a rule
 * set carrying them is reported as approximate rather than silently scored as
 * though those rules were absent.
 */

import type { ProbeResult } from './probe';
import { type RankEntry, type RankStrategy, rank } from './scoring';
import { statsPayload } from './stats';

/** A rule as it appears in `stream-ordering-rules.json`. */
export interface RuleInput {
  type?: unknown;
  value?: unknown;
  mode?: unknown;
  points?: unknown;
  priority?: unknown;
}

/** One rule, parsed into something that can be evaluated against a stream. */
interface CompiledRule {
  type: string;
  value: string;
  points: number;
  test: (facts: StreamFacts) => boolean;
}

/** Why a rule could not be simulated. */
export interface SkippedRule {
  type: string;
  value: string;
  reason: string;
}

/** Everything a rule can ask about one stream. */
export interface StreamFacts {
  streamId: number;
  name: string;
  providerName: string;
  groupName: string;
  /**
   * The stats Teamarr reads, exactly as Dispatcharr holds them.
   *
   * Built with `statsPayload` -- the same function that publishes them -- and
   * not a second reading of the same `ProbeResult`. A `stats_metric` rule is
   * evaluated against whatever is in Dispatcharr's `stream_stats`, so a
   * simulation that computed its own numbers could agree with the probe and
   * still disagree with Teamarr, which is the one outcome that would make this
   * whole report misleading rather than merely incomplete.
   */
  stats: Record<string, unknown>;
  result: ProbeResult;
}

const COMPARATORS: Record<string, (a: number, b: number) => boolean> = {
  '>=': (a, b) => a >= b,
  '>': (a, b) => a > b,
  '<=': (a, b) => a <= b,
  '<': (a, b) => a < b,
  '==': (a, b) => a === b,
  '=': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

/**
 * A Python pattern as JavaScript reads it.
 *
 * Teamarr's rules are Python `re`, and the two dialects differ in exactly two
 * ways that turn up in a rules file. Inline flags -- `(?i)` -- are a syntax
 * error in JavaScript and have to become real flags, and Python's named-group
 * spelling `(?P<x>...)` is written `(?<x>...)` here.
 *
 * Evaluated with `search` semantics, which is what a hand-written `^NFL Game
 * Pass.*` already assumes: it anchors itself, which would be pointless under
 * `match`. Where the two readings differ, this takes the permissive one, so a
 * rule reported as matching might not fire under `match` -- the opposite error
 * would be worse, since a rule silently dropped from the simulation reads as
 * "your rules are fine".
 */
export function toJsRegExp(pattern: string): RegExp {
  let flags = '';
  let source = pattern;
  const inline = /^\(\?([aiLmsux]+)\)/.exec(source);
  if (inline) {
    for (const flag of inline[1]!) {
      if (flag === 'i' || flag === 's' || flag === 'm') flags += flag;
    }
    source = source.slice(inline[0].length);
  }
  source = source.replace(/\(\?P</g, '(?<').replace(/\(\?P=(\w+)\)/g, '\\k<$1>');
  return new RegExp(source, flags);
}

/**
 * Parse a rule set into what can be simulated, and what cannot.
 *
 * Only `score` rules. Teamarr's `priority` mode sorts into bands rather than
 * summing, so mixing the two here would produce a number that is not the one
 * Teamarr computes -- reported as skipped instead.
 */
export function compileRules(rules: RuleInput[]): {
  compiled: CompiledRule[];
  skipped: SkippedRule[];
} {
  const compiled: CompiledRule[] = [];
  const skipped: SkippedRule[] = [];

  for (const rule of rules) {
    const type = String(rule.type ?? '');
    const value = String(rule.value ?? '');
    const points = Number(rule.points ?? 0);
    const mode = String(rule.mode ?? 'priority');
    const skip = (reason: string) => skipped.push({ type, value, reason });

    if (mode !== 'score') {
      skip('priority-mode rule: sorts into bands rather than adding points');
      continue;
    }
    if (!Number.isFinite(points)) {
      skip('points is not a number');
      continue;
    }

    if (type === 'm3u') {
      const wanted = value.trim().toLowerCase();
      compiled.push({
        type,
        value,
        points,
        test: (facts) => facts.providerName.trim().toLowerCase() === wanted,
      });
    } else if (type === 'group') {
      const wanted = value.trim().toLowerCase();
      compiled.push({
        type,
        value,
        points,
        test: (facts) => facts.groupName.trim().toLowerCase() === wanted,
      });
    } else if (type === 'regex') {
      try {
        const re = toJsRegExp(value);
        compiled.push({ type, value, points, test: (facts) => re.test(facts.name) });
      } catch (error) {
        skip(`regex JavaScript cannot evaluate: ${String(error).slice(0, 80)}`);
      }
    } else if (type === 'stats_metric') {
      const [metric, op, threshold] = value.split('|').map((part) => part.trim());
      const compare = COMPARATORS[op ?? ''];
      const target = Number(threshold);
      if (!metric || !compare || !Number.isFinite(target)) {
        skip('stats_metric is not `metric|comparator|number`');
        continue;
      }
      compiled.push({
        type,
        value,
        points,
        test: (facts) => {
          const actual = Number(facts.stats[metric]);
          return Number.isFinite(actual) && compare(actual, target);
        },
      });
    } else {
      // `epg_match` and `stream_type` are Teamarr's own state. Guessing at them
      // would be worse than declaring them: a wrong guess moves a channel's
      // verdict without saying it did.
      skip('Teamarr-side state Podium cannot see');
    }
  }
  return { compiled, skipped };
}

export interface MatchedRule {
  type: string;
  value: string;
  points: number;
}

export interface Score {
  points: number;
  matched: MatchedRule[];
}

export function scoreStream(facts: StreamFacts, compiled: CompiledRule[]): Score {
  let points = 0;
  const matched: MatchedRule[] = [];
  for (const rule of compiled) {
    if (!rule.test(facts)) continue;
    points += rule.points;
    matched.push({ type: rule.type, value: rule.value, points: rule.points });
  }
  return { points, matched };
}

/** One stream as the report shows it: who it is, what it scored, what it measured. */
export interface PickView {
  streamId: number;
  name: string;
  providerName: string;
  groupName: string;
  points: number;
  matched: MatchedRule[];
  bitrateKbps: number;
  height: number;
  alive: boolean;
  black: boolean;
}

export interface ChannelCheck {
  channelId: number;
  channelName: string;
  streams: number;
  /**
   * Teamarr orders this channel.
   *
   * Its stream-priority rules apply to the channels it manages, so a
   * disagreement on anything else is a comparison against a population those
   * rules will never be evaluated on -- the same mistake the quality scope
   * exists to prevent, and it dominates: measured on a live install, 540
   * channels carried enough verdicts to check and only 224 sat in a managed
   * group. Both are reported, with the managed set as the headline, because a
   * rule set aimed wider than its fixtures is somebody's legitimate setup.
   */
  managed: boolean;
  /** Teamarr's first pick is the one the measurements would have chosen. */
  agree: boolean;
  /**
   * Two or more streams tie at the top of Teamarr's ordering.
   *
   * The rules do not decide the channel, so whatever Teamarr does next -- its
   * own tiebreak, the order the streams arrived in -- decides it, and this
   * report cannot say the outcome is right or wrong. Worth reporting rather
   * than counting as agreement: a tie that happens to fall the right way is
   * not a working rule set.
   */
  ambiguous: boolean;
  teamarr: PickView;
  podium: PickView;
  /** What the measurements say is lost by taking Teamarr's pick, in kbps. */
  gapKbps: number;
}

export interface RuleCheck {
  generatedAt: number;
  rules: { evaluated: number; skipped: SkippedRule[] };
  summary: {
    channels: number;
    agreed: number;
    disagreed: number;
    ambiguous: number;
    /**
     * Channels whose rules put a dead or black stream first *when a working one
     * was available*.
     *
     * The qualifier is the whole number. A channel where every stream is dead
     * also leads with a dead stream, and counting those says "your rules are
     * broken" about a channel no rule could have saved -- the operator then
     * goes looking for a rule to fix and finds a provider outage.
     */
    deadFirst: number;
    /** The same, over the channels Teamarr actually orders. */
    managedChannels: number;
    managedAgreed: number;
    managedDeadFirst: number;
    managedGapKbps: number;
    /** Total measured bitrate given up across every disagreement. */
    gapKbps: number;
    /**
     * Whether unevaluable rules could have changed any of this.
     *
     * True whenever the set carries a rule this cannot simulate. It does not
     * mean the report is wrong -- a `stream_type` rule that applies to every
     * stream on a channel cancels out and changes no ordering -- only that it
     * cannot be shown to be right.
     */
    approximate: boolean;
  };
  /** Disagreements first, then the widest gaps: the rows worth reading. */
  channels: ChannelCheck[];
}

export interface ChannelInput {
  channelId: number;
  channelName: string;
  audioOnly?: boolean;
  /** Another app owns this channel's ordering -- see `ChannelCheck.managed`. */
  managed?: boolean;
  streams: Array<{ facts: StreamFacts; stepOrder: number }>;
}

/**
 * Compare the order Teamarr's rules produce against the order the measurements
 * justify, channel by channel.
 *
 * Podium's side is `rank()` -- the same function that decides what a pass would
 * write -- rather than a second opinion assembled here. If the two disagreed,
 * the report would be measuring this file rather than the rules.
 */
export function checkRules(
  channels: ChannelInput[],
  rules: RuleInput[],
  strategy: RankStrategy,
): RuleCheck {
  const { compiled, skipped } = compileRules(rules);
  const rows: ChannelCheck[] = [];

  for (const channel of channels) {
    // A channel carrying one stream has no ordering to get wrong.
    if (channel.streams.length < 2) continue;

    const scores = new Map<number, Score>();
    for (const { facts } of channel.streams) {
      scores.set(facts.streamId, scoreStream(facts, compiled));
    }

    // Ties broken by the channel's existing order, which is the only thing
    // known about what Teamarr would do next.
    const byPoints = [...channel.streams].sort(
      (a, b) =>
        (scores.get(b.facts.streamId)?.points ?? 0) - (scores.get(a.facts.streamId)?.points ?? 0) ||
        a.stepOrder - b.stepOrder,
    );
    const entries: RankEntry[] = channel.streams.map(({ facts, stepOrder }) => ({
      streamId: facts.streamId,
      stepOrder,
      providerId: 0,
      result: facts.result,
    }));
    const measured = rank(entries, strategy, channel.audioOnly);

    const factsById = new Map(channel.streams.map(({ facts }) => [facts.streamId, facts]));
    const view = (streamId: number): PickView => {
      const facts = factsById.get(streamId)!;
      const score = scores.get(streamId) ?? { points: 0, matched: [] };
      return {
        streamId,
        name: facts.name,
        providerName: facts.providerName,
        groupName: facts.groupName,
        points: score.points,
        matched: score.matched,
        bitrateKbps: Math.round(facts.result.bitrateKbps),
        height: facts.result.height,
        alive: facts.result.alive,
        black: Boolean(facts.result.black),
      };
    };

    const teamarrPick = byPoints[0]!.facts.streamId;
    const podiumPick = measured[0]!;
    const top = scores.get(teamarrPick)?.points ?? 0;
    const runnerUp = scores.get(byPoints[1]!.facts.streamId)?.points ?? 0;
    const teamarr = view(teamarrPick);
    const podium = view(podiumPick);

    rows.push({
      channelId: channel.channelId,
      channelName: channel.channelName,
      streams: channel.streams.length,
      managed: Boolean(channel.managed),
      agree: teamarrPick === podiumPick,
      ambiguous: top === runnerUp,
      teamarr,
      podium,
      gapKbps: teamarrPick === podiumPick ? 0 : podium.bitrateKbps - teamarr.bitrateKbps,
    });
  }

  rows.sort(
    (a, b) =>
      Number(b.managed) - Number(a.managed) ||
      Number(a.agree) - Number(b.agree) ||
      b.gapKbps - a.gapKbps ||
      a.channelId - b.channelId,
  );

  const disagreed = rows.filter((row) => !row.agree);
  // Dead first only counts where the measurements found something watchable to
  // have chosen instead. Everything else is a provider outage wearing a rule's
  // clothes.
  const avoidablyDead = (row: ChannelCheck): boolean =>
    (!row.teamarr.alive || row.teamarr.black) && row.podium.alive && !row.podium.black;
  const managed = rows.filter((row) => row.managed);

  return {
    generatedAt: Date.now(),
    rules: { evaluated: compiled.length, skipped },
    summary: {
      channels: rows.length,
      agreed: rows.length - disagreed.length,
      disagreed: disagreed.length,
      ambiguous: rows.filter((row) => row.ambiguous).length,
      deadFirst: rows.filter(avoidablyDead).length,
      gapKbps: disagreed.reduce((sum, row) => sum + Math.max(0, row.gapKbps), 0),
      managedChannels: managed.length,
      managedAgreed: managed.filter((row) => row.agree).length,
      managedDeadFirst: managed.filter(avoidablyDead).length,
      managedGapKbps: managed.reduce((sum, row) => sum + Math.max(0, row.gapKbps), 0),
      approximate: skipped.length > 0,
    },
    // Managed first, then disagreements, then the widest gaps: the order they
    // are worth reading in.
    channels: rows,
  };
}

/** Build the facts a rule is evaluated against, from what a probe returned. */
export function factsFor(
  stream: { id: number; name: string; providerName: string; groupName: string },
  result: ProbeResult,
  strategy: RankStrategy,
): StreamFacts {
  return {
    streamId: stream.id,
    name: stream.name,
    providerName: stream.providerName,
    groupName: stream.groupName,
    stats: statsPayload(result, strategy.weights) as unknown as Record<string, unknown>,
    result,
  };
}
