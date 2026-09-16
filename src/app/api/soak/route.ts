import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { errorText } from '@/lib/error-text';
import { snapshot } from '@/lib/server/state';
import { type SoakRequest, Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Ask for streams to be soaked -- held open for minutes to find out how long
 * they actually last.
 *
 * The same bargain `/api/refresh` strikes, and for the same two reasons. A soak
 * holds a provider connection for minutes, so running one here would be a
 * second scheduler that knows nothing about lane limits, the pause while
 * somebody is watching, or how many connections the account has. And it would
 * be a multi-minute HTTP request, which most ingresses cut off long before it
 * answers -- a group of two hundred channels could not be expressed this way at
 * all.
 *
 * So this writes rows and returns. The ordinary pass drains them under every
 * gate it already applies, oldest request first. DELETE is the other half of
 * the bargain: a queue somebody queued by mistake can be dropped before it has
 * spent anything.
 *
 * Note the asymmetry with `PODIUM_SOAK_WINDOW`: that confines the *automatic*
 * sweep to quiet hours, but a request made here is an instruction and is
 * drained whenever there is spare capacity. It still waits for nobody to be
 * watching, which is the protection that actually matters.
 */

interface Scope {
  streams: SoakRequest[];
  label: string;
}

function open(): Store {
  return new Store(loadConfig().dbPath);
}

/**
 * Every stream Podium would rank for a channel, in the order the channel
 * carries them.
 *
 * Read from the live catalogue rather than from the ledger, so a channel that
 * has never been soaked still resolves to its streams.
 */
async function streamsForChannels(channelIds: number[]): Promise<SoakRequest[]> {
  const snap = await snapshot();
  const wanted = new Set(channelIds);
  const out: SoakRequest[] = [];
  const seen = new Set<number>();
  for (const channel of snap.channels) {
    if (!wanted.has(channel.id)) continue;
    for (const streamId of channel.streams) {
      if (seen.has(streamId)) continue;
      seen.add(streamId);
      out.push({ streamId, channelId: channel.id });
    }
  }
  return out;
}

/** `{scope: 'stream'|'channel'|'group', id}` into the streams it names. */
async function resolveScope(
  scope: string | null,
  rawId: unknown,
): Promise<Scope | { error: string }> {
  const id = Number(rawId);
  if (scope === 'stream') {
    if (!Number.isInteger(id)) return { error: 'bad stream id' };
    // Deliberately not checked against the catalogue: a stream the snapshot has
    // not caught up with yet is still a legitimate thing to queue, and the pass
    // simply skips a row it cannot resolve to a URL.
    return { streams: [{ streamId: id }], label: `stream ${id}` };
  }
  if (scope === 'channel') {
    if (!Number.isInteger(id)) return { error: 'bad channel id' };
    return { streams: await streamsForChannels([id]), label: `channel ${id}` };
  }
  if (scope === 'group') {
    if (!Number.isInteger(id)) return { error: 'bad group id' };
    const snap = await snapshot();
    const channelIds = snap.channels.filter((c) => c.groupId === id).map((c) => c.id);
    return {
      streams: await streamsForChannels(channelIds),
      label: `group ${id} (${channelIds.length} channel(s))`,
    };
  }
  return { error: `unknown scope ${JSON.stringify(scope)}` };
}

/** What is waiting, so the UI can show progress and offer to cancel. */
export function GET() {
  let store: Store | null = null;
  try {
    store = open();
    const pending = store.pendingSoaks(500);
    return NextResponse.json({
      count: store.pendingSoakCount(),
      // Enough for a panel to mark its own rows, not the whole queue.
      streamIds: pending.map((row) => row.streamId),
    });
  } catch (error) {
    return NextResponse.json({ error: errorText(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}

export async function POST(request: Request) {
  let store: Store | null = null;
  try {
    const body = (await request.json().catch(() => ({}))) as { scope?: string; id?: unknown };
    const resolved = await resolveScope(body.scope ?? null, body.id);
    if ('error' in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }
    if (resolved.streams.length === 0) {
      return NextResponse.json({ error: `nothing to soak for ${resolved.label}` }, { status: 404 });
    }

    store = open();
    const queued = store.queueSoaks(resolved.streams, 'manual');
    return NextResponse.json({
      status: 'queued',
      label: resolved.label,
      // Asked for, and newly queued. They differ when some were already
      // waiting, which is worth saying rather than reporting a silent no-op.
      requested: resolved.streams.length,
      queued,
      pending: store.pendingSoakCount(),
    });
  } catch (error) {
    return NextResponse.json({ error: errorText(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}

/** Drop the queue, or one stream from it. Nothing already measured is undone. */
export async function DELETE(request: Request) {
  let store: Store | null = null;
  try {
    const url = new URL(request.url);
    const raw = url.searchParams.get('streamId');
    store = open();
    const cleared =
      raw === null ? store.clearSoaks() : store.clearSoaks([Number(raw)].filter(Number.isInteger));
    return NextResponse.json({ status: 'cleared', cleared, pending: store.pendingSoakCount() });
  } catch (error) {
    return NextResponse.json({ error: errorText(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}
