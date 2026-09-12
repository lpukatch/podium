/**
 * Teamarr's stream-ordering rules, over HTTP.
 *
 * The one thing Podium has never had. `quality.ts` fits the rules and
 * `mergeTeamarrRules` folds them into a set somebody already has, but getting
 * the result into Teamarr meant a human downloading a file, carrying it across
 * and clicking Import -- four steps, which is three more than anyone repeats
 * monthly, and the reason a rule set found in the field was six days stale
 * against an install that re-fits every pass.
 *
 * Deliberately thin, and it does not interpret what it carries:
 * `mergeTeamarrRules` owns what a merged set should contain, `teamarr-match.ts`
 * owns what a channel read is for, and a second opinion here could only
 * disagree with them.
 */

import { normaliseBaseUrl } from './base-url';

/** Teamarr's settings API, as of its v1 routes. */
const RULES_PATH = '/api/v1/settings/stream-ordering';

/** Teamarr's managed channels, and the streams attached to each. */
const CHANNELS_PATH = '/api/v1/channels/managed';

/** How long a call may hang before it is treated as a failure. */
const TIMEOUT_MS = 15_000;

export interface TeamarrRuleRow {
  type: string;
  value: string;
  priority?: number;
  mode?: string;
  points?: number;
}

/** One channel Teamarr manages, in the two ids it takes to find it twice. */
export interface ManagedChannelRow {
  /** Teamarr's own id -- what its per-channel endpoints take. */
  id: number;
  /** The Dispatcharr channel it created, which is what Podium calls a channel. */
  dispatcharrChannelId: number;
}

/** One stream attached to a managed channel, in the terms only Teamarr knows. */
export interface ChannelStreamRow {
  dispatcharrStreamId: number;
  /**
   * How Teamarr attached this stream: `epg` for one matched from programme
   * data, a name-matching method (`cache`, `alias`, `pattern`, `fuzzy`,
   * `user_corrected`) otherwise, null when it recorded none.
   */
  matchMethod: string | null;
  /** `event` or `team`, the two values a `stream_type` rule compares against. */
  matchType: string | null;
  /** Whether Teamarr's own stats cache holds a reading for this stream. */
  hasStats: boolean;
}

/**
 * Rejected before anything is sent, on the shape Teamarr's own importer
 * enforces.
 *
 * Its `PUT` replaces the entire rule set, so a request it rejects halfway is
 * not a no-op -- and a 400 that arrives after the write would leave an install
 * with whatever survived. Checking here means a malformed set is refused while
 * the old one is still in place.
 */
const VALID_TYPES = new Set([
  'm3u',
  'group',
  'regex',
  'stream_type',
  'team_feed',
  'not_team_feed',
  'epg_match',
  'dispatcharr_group',
  'home_feed',
  'away_feed',
  'stats_metric',
  'catch_all',
]);

/** Types Teamarr allows an empty value on -- they carry no argument. */
const NO_VALUE_TYPES = new Set([
  'team_feed',
  'not_team_feed',
  'epg_match',
  'home_feed',
  'away_feed',
  'catch_all',
]);

export function validateRules(rules: TeamarrRuleRow[]): string[] {
  const problems: string[] = [];
  rules.forEach((rule, index) => {
    const at = `rule ${index + 1} (${rule.type} ${rule.value})`;
    if (!VALID_TYPES.has(rule.type)) problems.push(`${at}: Teamarr has no type "${rule.type}"`);
    if (!NO_VALUE_TYPES.has(rule.type) && !String(rule.value ?? '').trim()) {
      problems.push(`${at}: value cannot be empty for this type`);
    }
    const priority = Number(rule.priority ?? 0);
    if (!Number.isFinite(priority) || priority < 1 || priority > 99) {
      problems.push(`${at}: priority must be 1-99, got ${rule.priority}`);
    }
    if (rule.type === 'stream_type') {
      const base = String(rule.value ?? '')
        .split('|')[0]
        ?.trim();
      if (base !== 'event' && base !== 'team') {
        problems.push(`${at}: stream_type must be "event" or "team"`);
      }
    }
  });
  return problems;
}

export interface RulesSummary {
  total: number;
  /** How many of each rule type, for showing that the right instance answered. */
  byType: Record<string, number>;
  scoring: number;
  priority: number;
}

export function summarise(rules: TeamarrRuleRow[]): RulesSummary {
  const byType: Record<string, number> = {};
  let scoring = 0;
  for (const rule of rules) {
    byType[rule.type] = (byType[rule.type] ?? 0) + 1;
    if (rule.mode === 'score') scoring += 1;
  }
  return { total: rules.length, byType, scoring, priority: rules.length - scoring };
}

const identity = (rule: TeamarrRuleRow): string =>
  [rule.type, rule.value, rule.mode ?? 'priority', rule.points ?? 0, rule.priority ?? 0].join('\0');

/**
 * How the live rule set differs from the one Podium last pushed.
 *
 * Null when they match. The order check is not pedantry: a scoring rule's
 * position is irrelevant, because points are summed, but the *first* priority
 * rule a stream matches sets its band -- so a reordered set with a priority rule
 * in it can rank differently while containing exactly the same rules. Saying
 * "same rules, different order" rather than "identical" leaves that visible,
 * and says which case it is rather than making the operator guess.
 */
export function compareRules(live: TeamarrRuleRow[], pushed: TeamarrRuleRow[]): string | null {
  const liveIds = live.map(identity);
  const pushedIds = pushed.map(identity);
  if (liveIds.length === pushedIds.length && liveIds.every((id, i) => id === pushedIds[i])) {
    return null;
  }

  const liveSet = new Set(liveIds);
  const pushedSet = new Set(pushedIds);
  const added = liveIds.filter((id) => !pushedSet.has(id)).length;
  const removed = pushedIds.filter((id) => !liveSet.has(id)).length;
  if (added === 0 && removed === 0) {
    return `the same ${live.length} rules, in a different order`;
  }

  const parts: string[] = [];
  if (added > 0) parts.push(`${added} rule(s) Podium did not push`);
  if (removed > 0) parts.push(`${removed} rule(s) Podium pushed are gone`);
  return `${parts.join(', ')} (${live.length} live, ${pushed.length} pushed)`;
}

export class TeamarrClient {
  private readonly base: string;

  constructor(url: string) {
    // Not merely trimmed: see `base-url.ts`. The URL reaches here from the
    // settings table, which is writable through the API, so a base that
    // truncates the API path off the end of the request is input this has to
    // refuse rather than a typo it can assume away.
    this.base = normaliseBaseUrl(url, 'Teamarr');
  }

  private async call(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const target = `${this.base}${path}`;
    let response: Response;
    try {
      response = await fetch(target, {
        method,
        signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      // Everything below this line is a message somebody reads while deciding
      // whether they typed the address wrong. `fetch` on its own answers that
      // with "TypeError: fetch failed", which names neither the address nor the
      // reason, and Node hides the cause one level down.
      if (controller.signal.aborted) {
        throw new Error(`Teamarr did not answer ${this.base} within ${TIMEOUT_MS / 1000}s`);
      }
      const cause = (error as { cause?: { code?: string } }).cause;
      const why = cause?.code ? ` (${cause.code})` : '';
      throw new Error(`Could not reach Teamarr at ${this.base}${why}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      // Teamarr answers a rejected rule with a `detail` string; surfacing it
      // verbatim is the difference between "the push failed" and knowing which
      // rule it choked on.
      //
      // Only that field, though. This message is returned to whoever called the
      // test endpoint, and the URL it was fetched from is theirs to choose --
      // so echoing an arbitrary error body would turn "test my Teamarr address"
      // into a way to read 300 bytes off any http service the container can
      // reach and any host that answers it. A JSON `detail` is Teamarr
      // answering in its own terms; anything else gets its status and nothing
      // more, which is all the reader needs to tell a 404 from a 502.
      let detail = 'no JSON detail in the response';
      try {
        const parsed = JSON.parse(text) as { detail?: unknown };
        if (typeof parsed.detail === 'string') detail = parsed.detail.slice(0, 300);
      } catch {
        detail = 'the response was not JSON';
      }
      throw new Error(`Teamarr ${method} ${response.status}: ${detail}`);
    }

    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // The commonest wrong address is another app on the same host, which
      // answers 200 with a login page. Reporting the JSON parser's complaint
      // about a `<` sends the reader looking for a bug in Podium.
      throw new Error(
        `${this.base} answered, but not with Teamarr's rules API — check the URL points at Teamarr`,
      );
    }
  }

  /** The rule set Teamarr is running right now. */
  async rules(): Promise<TeamarrRuleRow[]> {
    const body = (await this.call('GET', RULES_PATH)) as { rules?: unknown };
    const rules = body?.rules;
    if (!Array.isArray(rules)) {
      throw new Error(`${this.base} answered with JSON, but no rules array — is this Teamarr?`);
    }
    return rules.filter(
      (rule): rule is TeamarrRuleRow =>
        Boolean(rule) &&
        typeof (rule as { type?: unknown }).type === 'string' &&
        typeof (rule as { value?: unknown }).value === 'string',
    );
  }

  /**
   * Replace Teamarr's rule set.
   *
   * `PUT` is a full replacement on Teamarr's side, which is why nothing should
   * reach here that has not been through `mergeTeamarrRules` first: a bare
   * export would delete every hand-written rule on the instance.
   */
  async putRules(rules: TeamarrRuleRow[]): Promise<number> {
    const problems = validateRules(rules);
    if (problems.length > 0) {
      throw new Error(`refusing to push an invalid rule set: ${problems.join('; ')}`);
    }
    const body = (await this.call('PUT', RULES_PATH, { rules })) as { rules?: unknown[] };
    return Array.isArray(body?.rules) ? body.rules.length : rules.length;
  }

  /**
   * The channels Teamarr manages, and which Dispatcharr channel each one is.
   *
   * `dispatcharrChannelId` is the join. Podium knows a channel by the id
   * Dispatcharr gave it; Teamarr knows the same channel by its own, and every
   * per-channel call below takes Teamarr's.
   */
  async managedChannels(): Promise<ManagedChannelRow[]> {
    const body = (await this.call('GET', CHANNELS_PATH)) as { channels?: unknown };
    const rows = body?.channels;
    if (!Array.isArray(rows)) {
      throw new Error(`${this.base} answered with JSON, but no channels array — is this Teamarr?`);
    }
    const managed: ManagedChannelRow[] = [];
    for (const row of rows) {
      const record = row as { id?: unknown; dispatcharr_channel_id?: unknown };
      if (typeof record.id !== 'number') continue;
      // A channel Teamarr has created but not yet synced carries no Dispatcharr
      // id, so there is nothing on Podium's side to attach its streams to.
      if (typeof record.dispatcharr_channel_id !== 'number') continue;
      managed.push({ id: record.id, dispatcharrChannelId: record.dispatcharr_channel_id });
    }
    return managed;
  }

  /**
   * One channel's streams, as Teamarr holds them.
   *
   * The fields worth having are the ones Dispatcharr does not carry:
   * `matchMethod` says whether Teamarr attached this stream from EPG programme
   * data or from its name, and `matchType` says whether it matched as an event
   * or a team feed. Both are what `epg_match` and `stream_type` rules read, and
   * neither is derivable from anything Podium can see on its own.
   *
   * `hasStats` rather than the stats themselves: Podium published them and has
   * its own copy, so what is worth carrying back is whether Teamarr's cache
   * actually holds a reading at the moment it scores -- which is the difference
   * between a `stats_metric` rule firing and not existing.
   *
   * Not free. Teamarr refreshes its stats cache from Dispatcharr whenever this
   * is called on a channel holding a stream with absent or hour-old stats, so
   * this is a write on its side dressed as a read, and it is one call per
   * channel with no bulk form. `teamarr-match.ts` owns how many of these to
   * make.
   */
  async channelStreams(channelId: number): Promise<ChannelStreamRow[]> {
    const body = (await this.call('GET', `${CHANNELS_PATH}/${channelId}/streams`)) as {
      streams?: unknown;
    };
    const rows = body?.streams;
    if (!Array.isArray(rows)) return [];
    const streams: ChannelStreamRow[] = [];
    for (const row of rows) {
      const record = row as {
        dispatcharr_stream_id?: unknown;
        match_method?: unknown;
        match_type?: unknown;
        stream_stats?: unknown;
      };
      if (typeof record.dispatcharr_stream_id !== 'number') continue;
      streams.push({
        dispatcharrStreamId: record.dispatcharr_stream_id,
        matchMethod: typeof record.match_method === 'string' ? record.match_method : null,
        matchType: typeof record.match_type === 'string' ? record.match_type : null,
        hasStats:
          Boolean(record.stream_stats) &&
          Object.keys(record.stream_stats as Record<string, unknown>).length > 0,
      });
    }
    return streams;
  }
}
