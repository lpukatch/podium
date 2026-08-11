import { NextResponse } from 'next/server';
import { globToRegExp } from '@/lib/eligibility';
import {
  index,
  matcher,
  readRulesDoc,
  snapshot,
  streamGroups,
  writeRulesDoc,
} from '@/lib/server/state';

export const dynamic = 'force-dynamic';

/**
 * The provider groups streams arrive in, and which of them are switched off.
 *
 * Providers ship far more than anyone wants matched: a subscription turned on
 * for its sports channels also drags in per-fixture PPV feeds and auto-built
 * event groups, and those streams are live candidates for every rule in the
 * file. `contains` needles in particular pick them up -- a Cubs channel will
 * happily claim "MLB 19 | Los Angeles Dodgers at Chicago Cubs AWAY", which is
 * dead by morning.
 *
 * Listing them by claimed count first is the point: a group nothing matches is
 * not worth reading, and a group matching hundreds is the one doing damage.
 */
export async function GET() {
  try {
    const snap = await snapshot();
    const m = matcher();
    const idx = await index();

    // Claimed *ignoring* the exclusions, so a group already switched off still
    // shows what it would take back if you switched it on again.
    const claimed = new Set<number>();
    for (const rule of m.rules.values()) {
      for (const [streamId] of m.match(rule, { ...idx, excludedGroups: new Set<number>() })) {
        claimed.add(streamId);
      }
    }

    const excludeGroups = m.guards.excludeGroups;
    const tests = excludeGroups.map((glob) => globToRegExp(glob));
    const groups = streamGroups(snap, claimed).map((g) => ({
      ...g,
      excluded: idx.excludedGroups.has(g.id),
      // Which rule switched it off: a glob covering 40 groups should read as a
      // glob, not as 40 unexplained toggles.
      excludedBy: excludeGroups.find((_, i) => tests[i]!.test(g.name)) ?? null,
    }));

    return NextResponse.json({
      excludeGroups,
      groups,
      totalStreams: snap.streams.length,
      excludedStreams: groups.filter((g) => g.excluded).reduce((n, g) => n + g.streams, 0),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  }
}

/** Replace the exclusion list wholesale -- the UI always sends the full set. */
export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { excludeGroups?: string[] };
    const clean = [...new Set((body.excludeGroups ?? []).map((g) => g.trim()).filter(Boolean))];

    const doc = readRulesDoc();
    const defaults = (doc.defaults ?? {}) as Record<string, unknown>;
    defaults.exclude_groups = clean;
    doc.defaults = defaults;
    writeRulesDoc(doc);

    return NextResponse.json({ status: 'saved', excludeGroups: clean });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  }
}
