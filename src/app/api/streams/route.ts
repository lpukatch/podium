import { NextResponse } from 'next/server';
import { leadingWord, matchKey, normalize } from '@/lib/normalize';
import { index, matcher, snapshot } from '@/lib/server/state';

export const dynamic = 'force-dynamic';

/**
 * Search the whole provider stream catalogue.
 *
 * Writing an alias blind against 22,000 stream names is guesswork. This is the
 * "what is actually out there" view: type NBC, see every NBC stream across
 * every provider, and lift the normalised name straight into an alias.
 *
 * Results are grouped by normalised name, because that is the unit an alias
 * actually matches -- twelve providers carrying "NBC 4 WRC" are one decision,
 * not twelve rows to read.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') ?? '').trim();
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 60), 200);
    if (query.length < 2) {
      return NextResponse.json({ query, groups: [], total: 0, truncated: false });
    }

    const snap = await snapshot();
    const idx = await index();
    const m = matcher();
    const providerNames = new Map(snap.providers.map((p) => [p.id, p.name]));

    // Which channel already claims a stream, so the UI can say "taken".
    const claimedBy = new Map<number, string>();
    for (const [channelId, rule] of m.rules) {
      for (const [streamId] of m.match(rule, idx)) {
        if (!claimedBy.has(streamId)) {
          claimedBy.set(streamId, rule.name || String(channelId));
        }
      }
    }

    const needle = matchKey(query);
    const loose = query.toLowerCase();

    interface Bucket {
      normalized: string;
      key: string;
      providers: Set<string>;
      samples: string[];
      count: number;
      claimedBy: string | null;
      /** Distinct leading segments this name appears under, and how often. */
      prefixes: Map<string, number>;
      /**
       * The section each stream sits in -- the first word of its leading
       * segment, or of the name itself when the provider did not punctuate one.
       *
       * That is what an `@` qualifier matches, and it is the difference between
       * a usable suggestion and a useless one for names like "NFL WASHINGTON
       * COMMANDERS", which carry a section but no segment for it to live in.
       */
      sections: Map<string, number>;
    }
    const buckets = new Map<string, Bucket>();

    for (const stream of snap.streams) {
      const norm = idx.normalized.get(stream.id) ?? normalize(stream.name);
      const key = m.key(norm.name);
      // Match on the folded key first (so "nbc4wrc" finds "NBC 4 WRC"), and
      // fall back to a raw substring so a search including a prefix still works.
      if (!key.includes(needle) && !stream.name.toLowerCase().includes(loose)) continue;

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          normalized: norm.name,
          key,
          providers: new Set(),
          samples: [],
          count: 0,
          claimedBy: null,
          prefixes: new Map(),
          sections: new Map(),
        };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      bucket.providers.add(providerNames.get(stream.providerId) ?? String(stream.providerId));
      if (bucket.samples.length < 3) bucket.samples.push(stream.name);
      bucket.claimedBy ??= claimedBy.get(stream.id) ?? null;
      for (const prefix of norm.prefixes) {
        bucket.prefixes.set(prefix, (bucket.prefixes.get(prefix) ?? 0) + 1);
      }
      const section = leadingWord(norm.prefixes[0] ?? norm.name);
      if (section) bucket.sections.set(section, (bucket.sections.get(section) ?? 0) + 1);
    }

    const all = [...buckets.values()].sort(
      (a, b) => b.count - a.count || a.normalized.localeCompare(b.normalized),
    );

    return NextResponse.json({
      query,
      total: all.length,
      truncated: all.length > limit,
      groups: all.slice(0, limit).map((b) => ({
        normalized: b.normalized,
        count: b.count,
        providers: [...b.providers].sort(),
        samples: b.samples,
        claimedBy: b.claimedBy,
        // Commonest first: the choice being offered is "which of these feeds
        // do I mean", and the long tail of one-off prefixes is noise.
        prefixes: [...b.prefixes]
          .sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0]))
          .slice(0, 8)
          .map(([name, count]) => ({ name, count })),
        sections: [...b.sections]
          .sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0]))
          .slice(0, 8)
          .map(([name, count]) => ({ name, count })),
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  }
}
