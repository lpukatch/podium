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
    /**
     * `720p`, `1080p`, `2160p`, or `none` to pin this group to no floor at all.
     * Absent keeps what is stored; `null` and `""` read as `none`.
     */
    minResolution?: string | null;
  };
  const mode = body.mode ?? ALWAYS;
  if (!VALID_MODES.includes(mode as never)) {
    return NextResponse.json({ error: `unknown mode ${mode}` }, { status: 400 });
  }
  // `null` and `""` are how a client clears a floor, so only a value that was
  // written and could not be read is an error.
  const cleared = body.minResolution === null || body.minResolution === '';
  const requestedFloor = cleared ? null : parseMinResolution(body.minResolution);
  if (body.minResolution !== undefined && !cleared && requestedFloor === undefined) {
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
  const storedFloor = parseMinResolution(storedObj?.min_resolution);
  const minResolution =
    body.minResolution !== undefined ? requestedFloor : (storedFloor ?? undefined);

  // A group's "no floor" has to be written down, not inferred from an absent
  // entry. `Eligibility.policyFor` consults the name patterns only when a group
  // has no entry of its own, so deleting the entry is the one thing that hands
  // the group straight back to the pattern floor it was just told to ignore --
  // the menu would snap back to the pattern's answer and stay there.
  const pinnedToNoFloor = minResolution === null;
  // `none` is written out, not dropped: that is the value that keeps the entry
  // here at all, and the entry is the override.
  const storedValue = pinnedToNoFloor ? 'none' : minResolution;
  const isDefault =
    mode === ALWAYS && !audioOnly && !measureOnly && !minResolution && keptLive === undefined;

  if (isDefault && !pinnedToNoFloor) {
    // Default mode with no custom settings: clean up entry
    delete groups[String(id)];
  } else {
    groups[String(id)] = {
      mode,
      // Read back before defaulted: these have no control in this UI, so a
      // value in the file was put there by hand, and a chip that changes the
      // floor must not reset the window an operator tuned.
      grace_minutes: body.graceMinutes ?? storedObj?.grace_minutes ?? 5,
      window_minutes: body.windowMinutes ?? storedObj?.window_minutes ?? 180,
      ...(audioOnly ? { audio_only: true } : {}),
      ...(measureOnly ? { measure_only: true } : {}),
      ...(storedValue ? { min_resolution: storedValue } : {}),
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
