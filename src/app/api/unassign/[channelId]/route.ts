import { NextResponse } from 'next/server';
import { requireCredentials } from '@/lib/config';
import { DispatcharrClient } from '@/lib/dispatcharr';
import { catalogueRows, withoutStream } from '@/lib/runner';
import { noteStreamOrder, config as serverConfig, snapshot } from '@/lib/server/state';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Drop one stream from a channel, leaving the order of the rest alone.
 *
 * The ✕ in the channel editor is a one-stream edit, so it must not post back
 * the order the page happens to be showing: that comes from a snapshot up to
 * five minutes old, and writing it would quietly undo whatever the worker
 * ranked in between. Reading the channel first and filtering one id out of what
 * Dispatcharr holds *now* removes exactly what was asked and nothing else.
 *
 * Group policy is not consulted. It decides when podium may reorder a channel
 * on its own; this is somebody pointing at one stream and saying "not this
 * one", which is the same authority that sets the policy in the first place.
 */
export async function POST(request: Request, context: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await context.params;
  const id = Number(channelId);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: 'bad channel id' }, { status: 400 });
  }

  let store: Store | null = null;
  try {
    const body = (await request.json()) as { streamId?: number };
    const streamId = Number(body.streamId);
    if (!Number.isInteger(streamId)) {
      return NextResponse.json({ error: 'streamId must be an integer' }, { status: 400 });
    }

    const config = serverConfig();
    requireCredentials(config);
    if (config.PODIUM_DRY_RUN) {
      return NextResponse.json(
        { error: 'PODIUM_DRY_RUN is set; refusing to write' },
        { status: 409 },
      );
    }

    const client = new DispatcharrClient(config.DISPATCHARR_URL, {
      apiKey: config.DISPATCHARR_API_KEY,
      username: config.DISPATCHARR_USERNAME,
      password: config.DISPATCHARR_PASSWORD,
    });
    await client.login();
    const channel = await client.channel(id);
    if (!channel) {
      return NextResponse.json({ error: 'unknown channel' }, { status: 404 });
    }

    const previous = channel.streams ?? [];
    const order = withoutStream(previous, streamId);
    // Already gone -- somebody else removed it, or the click landed twice. The
    // caller wanted it off the channel and it is off the channel, so this is a
    // success with nothing to write.
    if (order.length === previous.length) {
      noteStreamOrder(id, previous);
      return NextResponse.json({ status: 'unchanged', channelId: id, streamId, order: previous });
    }

    await client.setStreamOrder(id, order);
    noteStreamOrder(id, order);
    // Same reasoning as the apply route: the persisted catalogue must show the
    // order that was just written, not the one the next full pass would fetch.
    // Opened per request rather than held for the process, matching how every
    // other Store consumer in the web process behaves.
    store = new Store(config.dbPath);
    // Taking a stream off a channel is an instruction, not a ranking outcome:
    // record it so a later pass with PODIUM_AUTO_ASSIGN on does not assign the
    // very stream that was just removed. Written before the catalogue patch so
    // a crash in between leaves the block, not the resurrection.
    store.blockAssignment(id, streamId);
    const snap = await snapshot();
    store.updateChannelOrder(
      id,
      catalogueRows(
        { id, name: channel.name },
        order,
        new Map(snap.streams.map((s) => [s.id, s])),
        new Map(snap.providers.map((p) => [p.id, p.name])),
      ),
    );

    return NextResponse.json({ status: 'removed', channelId: id, streamId, previous, order });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}
