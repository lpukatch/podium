import { NextResponse } from 'next/server';
import { ALWAYS, globToRegExp, VALID_MODES } from '@/lib/eligibility';
import { readRulesDoc, snapshot, userGroups, writeRulesDoc } from '@/lib/server/state';

export const dynamic = 'force-dynamic';

interface PatternRow {
  pattern: string;
  mode: string;
  grace_minutes?: number;
  window_minutes?: number;
}

/** Add or replace a name-pattern rule, and report which groups it would hit. */
export async function PUT(request: Request) {
  const body = (await request.json()) as { pattern?: string; mode?: string };
  const pattern = (body.pattern ?? '').trim();
  const mode = body.mode ?? ALWAYS;

  if (!pattern) return NextResponse.json({ error: 'pattern is required' }, { status: 400 });
  if (!VALID_MODES.includes(mode as never)) {
    return NextResponse.json({ error: `unknown mode ${mode}` }, { status: 400 });
  }

  const doc = readRulesDoc();
  const patterns = (doc.group_patterns ?? []) as PatternRow[];
  const existing = patterns.findIndex((p) => p.pattern.toLowerCase() === pattern.toLowerCase());

  if (mode === ALWAYS) {
    // `always` is the default; storing it would just be noise.
    if (existing >= 0) patterns.splice(existing, 1);
  } else {
    const entry: PatternRow = { pattern, mode, grace_minutes: 5, window_minutes: 180 };
    if (existing >= 0) patterns[existing] = entry;
    else patterns.push(entry);
  }

  doc.group_patterns = patterns;
  writeRulesDoc(doc);

  const snap = await snapshot();
  const test = globToRegExp(pattern);
  const affected = userGroups(snap)
    .filter((g) => test.test(g.name))
    .map((g) => ({ id: g.id, name: g.name, channels: g.channels }));

  return NextResponse.json({ status: 'saved', pattern, mode, affected });
}

export async function DELETE(request: Request) {
  const pattern = new URL(request.url).searchParams.get('pattern') ?? '';
  const doc = readRulesDoc();
  const patterns = (doc.group_patterns ?? []) as PatternRow[];
  doc.group_patterns = patterns.filter((p) => p.pattern.toLowerCase() !== pattern.toLowerCase());
  writeRulesDoc(doc);
  return NextResponse.json({ status: 'removed' });
}
