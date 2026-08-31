import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { mergeForTest, resolveEnv, validateSettings } from '@/lib/settings';
import { Store } from '@/lib/store';
import { compareRules, summarise, TeamarrClient, type TeamarrRuleRow } from '@/lib/teamarr-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Reach Teamarr with the URL as typed, and say what answered.
 *
 * The push already reports what it did, but only after doing it, and only if it
 * got that far -- a URL pointing at nothing produces a failed sync rather than
 * an answer to "is this the right address?". This is the question asked at the
 * moment of typing, which is the moment somebody can still fix it.
 *
 * It reports more than reachability on purpose. Anything can answer 200; what
 * matters is whether *Teamarr's stream-ordering API* answered, so the check is
 * that the response parses as a rules array, and the reply carries the rule
 * count and the type breakdown -- enough to recognise your own instance rather
 * than merely a live one. See the Dispatcharr test route, which reports the
 * provider list for the same reason.
 *
 * Where Podium has pushed before, it also compares what is live against what it
 * last sent, because "did we do it right?" is really two questions: did the
 * write land, and is it still there. A rule set edited in Teamarr's UI since the
 * last push is not an error -- but it is the thing an operator most wants to
 * know before they push again, since the merge will fold their edits in.
 */
export async function POST(request: Request) {
  let store: Store | null = null;
  try {
    const patch = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { values, errors } = validateSettings(patch);
    if (errors.length > 0) {
      return NextResponse.json({ ok: false, error: errors[0]?.message ?? 'invalid' });
    }

    store = new Store(loadConfig().dbPath);
    // Same overlay the Dispatcharr test uses, so a URL typed into the form is
    // tested before it is saved rather than after.
    const { merged } = mergeForTest(store.settings(), values, process.env);

    let config: ReturnType<typeof loadConfig>;
    try {
      config = loadConfig(resolveEnv(process.env, merged));
    } catch (error) {
      return NextResponse.json({
        ok: false,
        error: String(error)
          .replace(/^Error:\s*/, '')
          .slice(0, 200),
      });
    }

    const url = config.PODIUM_TEAMARR_URL.trim();
    if (!url) {
      return NextResponse.json({
        ok: false,
        error: 'No Teamarr URL is set. Enter one above, then test.',
      });
    }

    const live = await new TeamarrClient(url).rules();
    const summary = summarise(live);

    // What Podium believes it last put there. Absent on an install that has
    // never pushed, which is not a failure -- it is the normal state before the
    // first push, and saying so beats reporting a drift against nothing.
    const stored = store.teamarrRules();
    const lastSync = store.teamarrSync();
    const pushed = (stored?.rules ?? null) as TeamarrRuleRow[] | null;

    return NextResponse.json({
      ok: true,
      url,
      ...summary,
      lastPushedAt: stored?.uploadedAt ?? null,
      lastAttemptAt: lastSync?.ranAt ?? null,
      drift: pushed ? compareRules(live, pushed) : null,
      neverPushed: pushed === null,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: String(error)
        .replace(/^Error:\s*/, '')
        .slice(0, 300),
    });
  } finally {
    store?.close();
  }
}
