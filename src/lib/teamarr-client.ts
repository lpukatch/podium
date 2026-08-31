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
 * Deliberately small. It knows one endpoint, and it does not interpret what it
 * carries: `mergeTeamarrRules` owns what a merged set should contain, and a
 * second opinion here could only disagree with it.
 */

/** Teamarr's settings API, as of its v1 routes. */
const RULES_PATH = '/api/v1/settings/stream-ordering';

/** How long a call may hang before it is treated as a failure. */
const TIMEOUT_MS = 15_000;

export interface TeamarrRuleRow {
  type: string;
  value: string;
  priority?: number;
  mode?: string;
  points?: number;
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

export class TeamarrClient {
  private readonly base: string;

  constructor(url: string) {
    this.base = url.trim().replace(/\/+$/, '');
    if (!this.base) throw new Error('no Teamarr URL configured');
  }

  private async call(method: 'GET' | 'PUT', body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${this.base}${RULES_PATH}`, {
        method,
        signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      if (!response.ok) {
        // Teamarr answers a rejected rule with a `detail` string; surfacing it
        // verbatim is the difference between "the push failed" and knowing
        // which rule it choked on.
        let detail = text.slice(0, 300);
        try {
          const parsed = JSON.parse(text) as { detail?: unknown };
          if (typeof parsed.detail === 'string') detail = parsed.detail;
        } catch {
          // Not JSON; the raw body is the best message available.
        }
        throw new Error(`Teamarr ${method} ${response.status}: ${detail}`);
      }
      return text ? (JSON.parse(text) as unknown) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The rule set Teamarr is running right now. */
  async rules(): Promise<TeamarrRuleRow[]> {
    const body = (await this.call('GET')) as { rules?: unknown };
    const rules = body?.rules;
    if (!Array.isArray(rules)) throw new Error('Teamarr returned no rules array');
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
    const body = (await this.call('PUT', { rules })) as { rules?: unknown[] };
    return Array.isArray(body?.rules) ? body.rules.length : rules.length;
  }
}
