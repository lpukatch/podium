import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { mineNames } from '@/lib/miner';
import {
  buildProfile,
  inScope,
  mergeTeamarrRules,
  parseGlobs,
  profileQuery,
  type QualityScope,
  scopeFromConfig,
  teamarrRules,
} from '@/lib/quality';
import { resolveEnv } from '@/lib/settings';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * The configured scope, with per-request overrides.
 *
 * Overrides exist because the scope is a judgement rather than a fact, and the
 * cost of a wrong one is invisible from inside it: an operator who narrows it
 * too far sees a smaller table, not a warning. `?eventOnly=0` answers "what
 * would I be reading if I had not gated this", against the same samples, with
 * nothing saved -- which is the question worth being able to ask before the
 * setting is trusted.
 */
function scopeOf(url: URL, config: Parameters<typeof scopeFromConfig>[0]): QualityScope {
  const scope = scopeFromConfig(config);
  const eventOnly = url.searchParams.get('eventOnly');
  const include = url.searchParams.get('include');
  const exclude = url.searchParams.get('exclude');
  return {
    eventOnly:
      eventOnly === null ? scope.eventOnly : ['1', 'true', 'yes', 'on'].includes(eventOnly.trim()),
    // An empty parameter clears the list rather than falling back to the
    // configured one: `?include=` has to mean something, and "no patterns" is
    // the only thing it can honestly mean.
    include: include === null ? scope.include : parseGlobs(include),
    exclude: exclude === null ? scope.exclude : parseGlobs(exclude),
  };
}

/**
 * The learned quality profile, and its export as Teamarr scoring rules.
 *
 * `?format=teamarr` returns a `stream-ordering-rules.json` Teamarr's Import
 * button accepts as-is. Anything else returns the profile it was derived from,
 * because the numbers in the rules file are the end of a chain -- sample
 * counts, alive rates, medians -- and an operator deciding whether to trust a
 * +40 wants to see that a bucket earned it over three hundred samples rather
 * than four.
 *
 * Opened and closed per request, as `/api/metrics`: this is read infrequently
 * and holding a handle would keep a WAL reader alive for the life of the web
 * process.
 */
export function GET(request: Request) {
  let store: Store | null = null;
  try {
    const url = new URL(request.url);
    const { minSamples, pointsPerMbps } = profileQuery(url.searchParams);
    store = new Store(loadConfig().dbPath);
    // Settings-resolved, not the raw environment: the scope is edited in the UI
    // and stored, and reading it from `process.env` would report the gate the
    // container booted with rather than the one in force.
    const config = loadConfig(resolveEnv(process.env, store.settings()));
    const scope = scopeOf(url, config);
    const samples = store.qualitySamples();
    const profile = buildProfile(samples, { minSamples, scope });
    // Mined from the same population the profile was fitted on -- see
    // `mineNames`. Pass A's findings are reported; only Pass B's are exported.
    const miner = mineNames(
      samples.filter((sample) => inScope(sample, scope)),
      profile.groups,
      { minCarrierSamples: minSamples },
    );

    if (url.searchParams.get('format') !== 'teamarr') {
      return NextResponse.json({ ...profile, miner });
    }

    const body = teamarrRules(profile, {
      minSamples,
      pointsPerMbps,
      consolidated: miner.passB.consolidated,
    });
    return new NextResponse(JSON.stringify(body, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="stream-ordering-rules.json"',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}

/**
 * The same export, folded into rules the Teamarr instance already has.
 *
 * POST the file Teamarr's own Export button produced -- a bare array or a
 * `{rules: [...]}` envelope -- and get back one carrying both. Teamarr's
 * import *replaces* the whole rule set rather than merging, so without this
 * step taking Podium's numbers would mean losing every hand-written rule on
 * the instance, which is not a trade anybody would knowingly make.
 */
export async function POST(request: Request) {
  let store: Store | null = null;
  try {
    const url = new URL(request.url);
    const { minSamples, pointsPerMbps } = profileQuery(url.searchParams);

    const parsed = (await request.json()) as unknown;
    const container = parsed as { rules?: unknown };
    const existing = Array.isArray(parsed) ? parsed : container?.rules;
    if (!Array.isArray(existing)) {
      return NextResponse.json(
        { error: 'expected a rules array, or a {"rules": [...]} envelope' },
        { status: 400 },
      );
    }
    // Enough of a shape check to merge on; everything else is passed through
    // untouched, because Teamarr owns those fields and Podium validating them
    // would only add a second opinion that can go stale.
    const rules = existing.filter(
      (rule): rule is { type: string; value: string; mode?: string } =>
        Boolean(rule) &&
        typeof (rule as { type?: unknown }).type === 'string' &&
        typeof (rule as { value?: unknown }).value === 'string',
    );

    store = new Store(loadConfig().dbPath);
    const config = loadConfig(resolveEnv(process.env, store.settings()));
    const scope = scopeOf(url, config);
    const samples = store.qualitySamples();
    const profile = buildProfile(samples, { minSamples, scope });
    const miner = mineNames(
      samples.filter((sample) => inScope(sample, scope)),
      profile.groups,
      { minCarrierSamples: minSamples },
    );
    const generated = teamarrRules(profile, {
      minSamples,
      pointsPerMbps,
      consolidated: miner.passB.consolidated,
    });
    const merged = mergeTeamarrRules(rules, generated.rules);

    const body = {
      rules: merged,
      podium: {
        ...generated.podium,
        merged: {
          existing: rules.length,
          skipped: existing.length - rules.length,
          generated: generated.rules.length,
          // How many of the generated rules landed on an existing row rather
          // than being appended -- the number that says a re-import updated
          // in place instead of stacking a second set of points.
          replaced: rules.length + generated.rules.length - merged.length,
        },
      },
    };

    return new NextResponse(JSON.stringify(body, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="stream-ordering-rules.json"',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}
