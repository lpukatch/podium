import { NextResponse } from 'next/server';
import { ALWAYS, globToRegExp, VALID_MODES } from '@/lib/eligibility';
import { readRulesDoc, snapshot, userGroups, writeRulesDoc } from '@/lib/server/state';

export const dynamic = 'force-dynamic';

interface PatternRow {
  pattern: string;
  mode: string;
  grace_minutes?: number;
  window_minutes?: number;
  require_live?: boolean;
  audio_only?: boolean;
}

/** Add or replace a name-pattern rule, and report which groups it would hit. */
export async function PUT(request: Request) {
  const body = (await request.json()) as {
    pattern?: string;
    mode?: string;
    audioOnly?: boolean;
    audio_only?: boolean;
  };
  const pattern = (body.pattern ?? '').trim();
  const mode = body.mode ?? ALWAYS;

  if (!pattern) return NextResponse.json({ error: 'pattern is required' }, { status: 400 });
  if (!VALID_MODES.includes(mode as never)) {
    return NextResponse.json({ error: `unknown mode ${mode}` }, { status: 400 });
  }

  const doc = readRulesDoc();
  const patterns = (doc.group_patterns ?? []) as PatternRow[];
  const existing = patterns.findIndex((p) => p.pattern.toLowerCase() === pattern.toLowerCase());
  const audioOnly =
    body.audioOnly ??
    body.audio_only ??
    (existing >= 0 ? patterns[existing]?.audio_only : undefined);

  if (mode === ALWAYS && !audioOnly) {
    // `always` with no custom flags is the default; storing it would just be noise.
    if (existing >= 0) patterns.splice(existing, 1);
  } else {
    const entry: PatternRow = {
      pattern,
      mode,
      grace_minutes: 5,
      window_minutes: 180,
      ...(audioOnly ? { audio_only: true } : {}),
    };
    // Carried over rather than reset: `require_live` has no control in this UI,
    // so an operator who turned it off did it by hand in the rules file, and
    // silently switching the gate back on the next time they touch the mode
    // dropdown is the failure mode the setting exists to avoid.
    const kept = existing >= 0 ? patterns[existing]?.require_live : undefined;
    if (kept !== undefined) entry.require_live = kept;
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
