import { NextResponse } from 'next/server';
import { index, matcher, readRulesDoc, snapshot, writeRulesDoc } from '@/lib/server/state';

export const dynamic = 'force-dynamic';

/** Before/after for one stream an entry changes. */
interface Sample {
  raw: string;
  normalized: string;
}

interface EntryReport {
  text: string;
  streams: number;
  samples: Sample[];
}

const SAMPLES = 4;

/**
 * The noise words an operator has told Podium to delete, and what each one does.
 *
 * Badge *glyphs* need no configuration -- they are swept as a Unicode category,
 * so the next one a provider invents is already covered. Words cannot be: they
 * are only noise on the catalogue they appear in, and a list of them baked into
 * the code means a release every time a provider adds a badge.
 *
 * The counts are the reason this is a page rather than a line in a file. A
 * strip entry is the one kind of rule that acts on *every* channel at once, so
 * "how many names does this touch, and what do they look like afterwards" is
 * the only thing that says whether it is the entry you meant. `?q=` reports a
 * candidate the same way before it is saved.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const candidate = (url.searchParams.get('q') ?? '').trim();

    const snap = await snapshot();
    const m = matcher();
    const idx = await index();
    const strip = m.guards.strip;

    /**
     * What one entry changes, measured against the ruleset as it stands.
     *
     * Diffed rather than pattern-matched, because deleting the word is only
     * half of what an entry does: taking "CATCHUP" out of "CNN CATCHUP FHD"
     * also un-blocks the FHD behind it, and a name that gains a resolution is
     * exactly as changed as one that loses a word.
     */
    const describe = (entry: string, base: readonly string[]): EntryReport => {
      const withEntry = [...base, entry];
      let streams = 0;
      const samples: Sample[] = [];
      for (const stream of snap.streams) {
        const before = idx.normalized.get(stream.id) ?? m.normalize(stream.name);
        const after = m.normalizeWith(stream.name, withEntry);
        if (after.name === before.name) continue;
        streams++;
        if (samples.length < SAMPLES) samples.push({ raw: stream.name, normalized: after.name });
      }
      return { text: entry, streams, samples };
    };

    // Each saved entry is reported against the list *without* it, so its count
    // is what it contributes rather than what the whole list does.
    const entries = strip.map((entry) =>
      describe(
        entry,
        strip.filter((other) => other !== entry),
      ),
    );

    return NextResponse.json({
      strip,
      entries,
      candidate: candidate ? describe(candidate, strip) : null,
      totalStreams: snap.streams.length,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  }
}

/** Replace the list wholesale -- the UI always sends the full set. */
export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { strip?: string[] };
    const clean = [...new Set((body.strip ?? []).map((s) => s.trim()).filter(Boolean))];

    const doc = readRulesDoc();
    const defaults = (doc.defaults ?? {}) as Record<string, unknown>;
    defaults.strip = clean;
    doc.defaults = defaults;
    writeRulesDoc(doc);

    return NextResponse.json({ status: 'saved', strip: clean });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  }
}
