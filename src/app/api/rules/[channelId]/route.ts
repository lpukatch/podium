import { NextResponse } from 'next/server';
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
  };
  const clean = (values: string[] | undefined) =>
    (values ?? []).map((v) => v.trim()).filter(Boolean);

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

  writeRulesDoc(doc);
  return NextResponse.json({ status: 'saved' });
}
