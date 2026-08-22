import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { buildProfile, mergeTeamarrRules, teamarrRules } from '@/lib/quality';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/** Query knobs, all optional, all clamped -- this is a public GET. */
function options(url: URL): { minSamples: number; pointsPerMbps: number } {
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const raw = Number(url.searchParams.get(key));
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(min, Math.min(max, raw));
  };
  return {
    minSamples: Math.round(number('minSamples', 20, 1, 100_000)),
    pointsPerMbps: number('pointsPerMbps', 10, 0, 10_000),
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
    const { minSamples, pointsPerMbps } = options(url);
    store = new Store(loadConfig().dbPath);
    const profile = buildProfile(store.qualitySamples(), { minSamples });

    if (url.searchParams.get('format') !== 'teamarr') {
      return NextResponse.json(profile);
    }

    const body = teamarrRules(profile, { minSamples, pointsPerMbps });
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
    const { minSamples, pointsPerMbps } = options(url);

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
    const profile = buildProfile(store.qualitySamples(), { minSamples });
    const generated = teamarrRules(profile, { minSamples, pointsPerMbps });
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
