import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { applyMatches, checkInputs, scoredChannelIds } from '@/lib/rule-check-inputs';
import { snapshot } from '@/lib/server/state';
import { Store } from '@/lib/store';
import { checkRules, type RuleInput } from '@/lib/teamarr';
import { TeamarrClient } from '@/lib/teamarr-client';
import { describeSkew, tryReadMatches } from '@/lib/teamarr-match';

export const dynamic = 'force-dynamic';

/**
 * What the passes have found, and against which rules.
 *
 * The stored history is the half that survives a fixture: a live check can only
 * see channels whose streams still exist, and an event channel's do not outlast
 * the afternoon.
 */
export function GET() {
  let store: Store | null = null;
  try {
    store = new Store(loadConfig().dbPath);
    const stored = store.teamarrRules();
    const { history, latest } = store.ruleChecks();
    return NextResponse.json({
      rulesUploadedAt: stored?.uploadedAt ?? null,
      ruleCount: stored?.rules.length ?? 0,
      history,
      latest,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}

/**
 * Score a Teamarr rule set against what Podium has measured.
 *
 * POST the file Teamarr's Export button produced -- a bare array or a
 * `{rules: [...]}` envelope, the same shape the quality-profile merge takes --
 * and get back, per channel, the stream those rules put first and the stream
 * the measurements say should be first.
 *
 * Read-only and probe-free: every verdict it reads is already cached, so this
 * costs a Dispatcharr snapshot and nothing else. That matters for how it is
 * meant to be used -- edit a rule, run it again, see whether the disagreements
 * went down -- which nobody does if each run costs a probing pass.
 */
export async function POST(request: Request) {
  let store: Store | null = null;
  try {
    const parsed = (await request.json()) as unknown;
    const container = parsed as { rules?: unknown };
    const raw = Array.isArray(parsed) ? parsed : container?.rules;
    if (!Array.isArray(raw)) {
      return NextResponse.json(
        { error: 'expected a rules array, or a {"rules": [...]} envelope' },
        { status: 400 },
      );
    }
    const rules = raw.filter(
      (rule): rule is RuleInput => Boolean(rule) && typeof rule === 'object',
    );

    const snap = await snapshot();
    const config = loadConfig();
    store = new Store(config.dbPath);
    // Shared with the Teamarr push, which scores two rule sets over this same
    // assembly -- see `checkInputs`. Two copies would compare two populations.
    const { channels, strategy } = checkInputs(snap, store);

    // `epg_match` and `stream_type` are Teamarr's own attach-time state. With a
    // URL configured they can be read and scored; without one the check runs
    // exactly as it always has, and says so through `approximate`. A rules file
    // posted here is often somebody else's, so this is also the case where the
    // two rule types are most likely to turn up.
    const url = config.PODIUM_TEAMARR_URL.trim();
    const match = url
      ? await tryReadMatches(new TeamarrClient(url), scoredChannelIds(channels))
      : null;
    if (match?.known) applyMatches(channels, match.index);

    // Kept, so every later pass re-runs this without anybody being present. A
    // check that only runs when somebody is at the keyboard cannot see a
    // Saturday fixture at all.
    store.saveTeamarrRules(rules);

    const check = checkRules(channels, rules, strategy, { matchKnown: Boolean(match?.known) });
    return NextResponse.json({
      ...check,
      coverage: match?.known ? match.coverage : undefined,
      skew: match?.known ? (describeSkew(match.coverage) ?? undefined) : undefined,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}
