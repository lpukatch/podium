import { NextResponse } from 'next/server';
import { parseMinResolution } from '@/lib/resolution';
import { readRulesDoc, writeRulesDoc } from '@/lib/server/state';

export const dynamic = 'force-dynamic';

interface ChannelEntry {
  channel_id: number | string;
  aliases?: string[];
  contains?: string[];
  exclude?: string[];
  [key: string]: unknown;
}

export async function PUT(request: Request, context: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await context.params;
  const id = Number(channelId);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: 'bad channel id' }, { status: 400 });
  }

  const body = (await request.json()) as {
    aliases?: string[];
    contains?: string[];
    exclude?: string[];
    providers?: unknown;
    /**
     * `720p`, `1080p` or `2160p`; `none` to ignore the group's floor; `inherit`
     * to take the group's. Absent leaves whatever is stored alone, and `null`
     * and `""` both read as `inherit` -- a client resetting a field sends one of
     * those, and rejecting them would make "clear this" an error.
     */
    minResolution?: string | null;
  };
  const clean = (values: string[] | undefined) =>
    (values ?? []).map((v) => v.trim()).filter(Boolean);

  const inherits =
    body.minResolution === null || body.minResolution === '' || body.minResolution === 'inherit';
  const floor = inherits ? undefined : parseMinResolution(body.minResolution);
  if (body.minResolution !== undefined && !inherits && floor === undefined) {
    return NextResponse.json(
      { error: `unknown resolution ${body.minResolution}` },
      { status: 400 },
    );
  }

  const doc = readRulesDoc();
  const channels = (doc.channels ?? []) as ChannelEntry[];
  let entry = channels.find((c) => Number(c.channel_id) === id);

  if (!entry) {
    // A channel with no rule yet is the normal case for a group that was never
    // managed; create the entry rather than refusing the edit.
    entry = { channel_id: id, enabled: true, patterns: [], exclude_regions: [] };
    channels.push(entry);
    doc.channels = channels;
  }

  entry.aliases = clean(body.aliases);
  entry.contains = clean(body.contains);
  entry.exclude = clean(body.exclude);
  if (body.providers !== undefined) {
    if (Array.isArray(body.providers) && body.providers.length > 0) {
      entry.providers = body.providers.map(Number).filter(Number.isFinite);
    } else {
      delete entry.providers;
    }
  }
  if (body.minResolution !== undefined) {
    // Stored as `none` rather than omitted: omitting it is how a channel says
    // "use my group's floor", which is the opposite.
    if (floor === undefined) delete entry.min_resolution;
    else entry.min_resolution = floor ?? 'none';
  }

  writeRulesDoc(doc);
  return NextResponse.json({ status: 'saved' });
}
