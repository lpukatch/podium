import { NextResponse } from 'next/server';
import { ALWAYS, VALID_MODES } from '@/lib/eligibility';
import { readRulesDoc, writeRulesDoc } from '@/lib/server/state';

export const dynamic = 'force-dynamic';

export async function PUT(request: Request, context: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await context.params;
  const id = Number(groupId);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: 'bad group id' }, { status: 400 });
  }

  const body = (await request.json()) as {
    mode?: string;
    graceMinutes?: number;
    windowMinutes?: number;
  };
  const mode = body.mode ?? ALWAYS;
  if (!VALID_MODES.includes(mode as never)) {
    return NextResponse.json({ error: `unknown mode ${mode}` }, { status: 400 });
  }

  const doc = readRulesDoc();
  const groups = (doc.groups ?? {}) as Record<string, unknown>;

  if (mode === ALWAYS) {
    // `always` is the default, so store nothing rather than accumulating
    // entries that say "behave normally".
    delete groups[String(id)];
  } else {
    // `require_live` has no control in this UI, so it is carried over from
    // whatever is stored rather than dropped -- an operator who turned the gate
    // off by hand should not have it switched back on by saving a mode.
    const stored = groups[String(id)];
    const kept =
      stored && typeof stored === 'object'
        ? (stored as Record<string, unknown>).require_live
        : undefined;
    groups[String(id)] = {
      mode,
      grace_minutes: body.graceMinutes ?? 5,
      window_minutes: body.windowMinutes ?? 180,
      ...(kept === undefined ? {} : { require_live: kept }),
    };
  }

  doc.groups = groups;
  writeRulesDoc(doc);
  return NextResponse.json({ status: 'saved', mode });
}
