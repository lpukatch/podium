import { NextResponse } from 'next/server';
import { ALWAYS, VALID_MODES } from '@/lib/eligibility';
import { parseMinResolution } from '@/lib/resolution';
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
    audioOnly?: boolean;
    measureOnly?: boolean;
    /** `720p`, `1080p`, `2160p`, or `none` to clear it. Absent keeps what is stored. */
    minResolution?: string | null;
  };
  const mode = body.mode ?? ALWAYS;
  if (!VALID_MODES.includes(mode as never)) {
    return NextResponse.json({ error: `unknown mode ${mode}` }, { status: 400 });
  }
  const requestedFloor = parseMinResolution(body.minResolution);
  if (body.minResolution != null && requestedFloor === undefined) {
    return NextResponse.json(
      { error: `unknown resolution ${body.minResolution}` },
      { status: 400 },
    );
  }

  const doc = readRulesDoc();
  const groups = (doc.groups ?? {}) as Record<string, unknown>;
  const stored = groups[String(id)];
  const storedObj =
    stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : undefined;
  const keptLive = storedObj?.require_live;
  const audioOnly = body.audioOnly !== undefined ? body.audioOnly : Boolean(storedObj?.audio_only);
  const measureOnly =
    body.measureOnly !== undefined ? body.measureOnly : Boolean(storedObj?.measure_only);
  // Carried over like the flags above: every chip on the group posts only the
  // one thing it changes, and changing the mode must not quietly drop a floor.
  const minResolution =
    body.minResolution !== undefined
      ? (requestedFloor ?? undefined)
      : (parseMinResolution(storedObj?.min_resolution) ?? undefined);

  if (mode === ALWAYS && !audioOnly && !measureOnly && !minResolution && keptLive === undefined) {
    // Default mode with no custom settings: clean up entry
    delete groups[String(id)];
  } else {
    groups[String(id)] = {
      mode,
      grace_minutes: body.graceMinutes ?? 5,
      window_minutes: body.windowMinutes ?? 180,
      ...(audioOnly ? { audio_only: true } : {}),
      ...(measureOnly ? { measure_only: true } : {}),
      ...(minResolution ? { min_resolution: minResolution } : {}),
      ...(keptLive === undefined ? {} : { require_live: keptLive }),
    };
  }

  doc.groups = groups;
  writeRulesDoc(doc);
  return NextResponse.json({
    status: 'saved',
    mode,
    audioOnly,
    measureOnly,
    minResolution: minResolution ?? null,
  });
}
