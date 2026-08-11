import { NextResponse } from 'next/server';
import { readRulesDoc, writeRulesDoc } from '@/lib/server/state';

export const dynamic = 'force-dynamic';

interface ChannelEntry {
  channel_id: number | string;
  patterns?: unknown[];
  [key: string]: unknown;
}

/**
 * Drop the legacy regexes from a channel.
 *
 * The migration path is "replace a regex with aliases, confirm the match set is
 * still right, then remove the regex". Deleting is therefore a separate,
 * explicit action rather than something the alias editor does implicitly.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ channelId: string }> },
) {
  const { channelId } = await context.params;
  const id = Number(channelId);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: 'bad channel id' }, { status: 400 });
  }

  const doc = readRulesDoc();
  const channels = (doc.channels ?? []) as ChannelEntry[];
  const entry = channels.find((c) => Number(c.channel_id) === id);
  if (!entry) return NextResponse.json({ error: 'unknown channel' }, { status: 404 });

  const removed = (entry.patterns ?? []).length;
  entry.patterns = [];
  writeRulesDoc(doc);
  return NextResponse.json({ status: 'removed', removed });
}
