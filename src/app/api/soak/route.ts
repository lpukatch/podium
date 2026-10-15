import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { errorText } from '@/lib/error-text';
import { snapshot } from '@/lib/server/state';
import { type SoakRequest, type SoakSource, Store } from '@/lib/store';

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
  /**
   * Which drain picks these up.
   *
   * `manual` runs whenever a pass has spare capacity, whatever the hour --
   * that is right for a request about one stream, one channel or one group,
   * where somebody is waiting for the answer.
   *
   * `sweep` waits for `PODIUM_SOAK_WINDOW`. A catalogue-wide request is hours
   * of provider connection time (166 of them on the install this was measured
   * against), and letting that drain through a weekday afternoon is precisely
   * the runaway the window exists to prevent. Queueing it as a sweep is what
   * makes "soak everything" a safe thing to press.
   */
  source: SoakSource;
  /**
   * Leave out streams whose last probe found them dead.
   *
   * For the bulk scopes only. A soak of a dead stream is two quick failed
   * dials that re-learn what the probe already said -- cheap once, but on a
   * whole catalogue it was one queued stream in eight. A single stream asked
   * for by name is soaked regardless: somebody pointed at it.
   */
  skipDead: boolean;
}

function open(): Store {
  return new Store(loadConfig().dbPath);
}

/**
 * Every stream Podium would rank for a channel, in the order the channel
 * carries them.
 *
 * Read from the live catalogue rather than from the ledger, so a channel that
 * has never been soaked still resolves to its streams. A crawl that fails is
 * the one case the managed catalogue stands in for, and then for the whole
 * request: a crawl that answered is the truth about which channels exist, and
 * a channel missing from it must not be queued from rows an earlier pass
 * wrote -- the channel may have been deleted upstream entirely.
 */
async function streamsForChannels(channelIds: number[], store: Store): Promise<SoakRequest[]> {
  const snap = await snapshot().catch(() => null);
  const wanted = new Set(channelIds);
  const out: SoakRequest[] = [];
  const seen = new Set<number>();
  if (snap) {
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
  for (const row of store.catalogue().rows) {
    if (!wanted.has(row.channelId)) continue;
    // The same stream can sit on two channels; it is queued once.
    if (seen.has(row.streamId)) continue;
    seen.add(row.streamId);
    out.push({ streamId: row.streamId, channelId: row.channelId });
  }
  return out;
}

/** `{scope: 'stream'|'channel'|'channels'|'group', id}` into the streams it names. */
async function resolveScope(
  scope: string | null,
  rawId: unknown,
  now: boolean,
  store: Store,
): Promise<Scope | { error: string }> {
  const id = Number(rawId);
  if (scope === 'stream') {
    if (!Number.isInteger(id)) return { error: 'bad stream id' };
    // Deliberately not checked against the catalogue: a stream the snapshot has
    // not caught up with yet is still a legitimate thing to queue, and the pass
    // simply skips a row it cannot resolve to a URL.
    return {
      streams: [{ streamId: id }],
      label: `stream ${id}`,
      source: 'manual',
      skipDead: false,
    };
  }
  if (scope === 'channel') {
    if (!Number.isInteger(id)) return { error: 'bad channel id' };
    return {
      streams: await streamsForChannels([id], store),
      label: `channel ${id}`,
      source: 'manual',
      skipDead: true,
    };
  }
  if (scope === 'channels') {
    const rawList = Array.isArray(rawId) ? rawId : [];
    if (rawList.length === 0) return { error: 'no channel ids provided' };
    // As strict as the single-channel scope above: coerce nothing, or a null
    // in the list would land on channel 0 and a true on channel 1.
    if (!rawList.every((v) => Number.isInteger(v))) return { error: 'bad channel ids' };
    const channelIds = rawList as number[];
    return {
      streams: await streamsForChannels(channelIds, store),
      label: `${channelIds.length} channel(s)`,
      source: 'manual',
      skipDead: true,
    };
  }
  if (scope === 'group') {
    if (!Number.isInteger(id)) return { error: 'bad group id' };
    // Group membership lives only in the crawl, so its failure is an error,
    // not "this group has no channels": swallowing it here used to answer 404
    // about a fifty-channel group while Dispatcharr was merely unreachable.
    const snap = await snapshot();
    const channelIds = snap.channels.filter((c) => c.groupId === id).map((c) => c.id);
    return {
      streams: await streamsForChannels(channelIds, store),
      label: `group ${id} (${channelIds.length} channel(s))`,
      source: 'manual',
      skipDead: true,
    };
  }
  if (scope === 'all') {
    // The catalogue Podium manages, not every channel Dispatcharr has. The
    // latter is what this used to read, and on the install it was found on a
    // sixth of what it queued sat on channels Podium ranks nothing for --
    // hours of connection time measuring streams whose result could change
    // no order anywhere.
    //
    // Every stream on those channels, though, not the top few per channel:
    // the depth limit is a property of the automatic planner deciding what is
    // worth its night, and "soak everything" is an instruction, not a budget.
    const rows = store.catalogue().rows;
    if (rows.length === 0) {
      return { error: 'no managed catalogue yet -- let a pass finish first' };
    }
    const seen = new Set<number>();
    const streams: SoakRequest[] = [];
    for (const row of rows) {
      if (seen.has(row.streamId)) continue;
      seen.add(row.streamId);
      streams.push({ streamId: row.streamId, channelId: row.channelId });
    }
    const channels = new Set(rows.map((row) => row.channelId)).size;
    return {
      streams,
      label: `every managed channel (${channels})`,
      skipDead: true,
      // `now` is the operator saying they know the house is empty. It overrides
      // the clock and nothing else -- pause-while-watching, the yielded
      // providers and the reserve are all decided by `laneLimits`, long before
      // the queue is read, and a viewer arriving still aborts the phase.
      source: now ? 'now' : 'sweep',
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
      ...store.pendingSoakCount(),
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
    const body = (await request.json().catch(() => ({}))) as {
      scope?: string;
      id?: unknown;
      channelIds?: unknown;
      now?: boolean;
      seconds?: unknown;
    };
    store = open();
    const rawId = body.id ?? body.channelIds;
    const resolved = await resolveScope(body.scope ?? null, rawId, body.now === true, store);
    if ('error' in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }

    let candidates = resolved.streams;
    let skippedDead = 0;
    if (resolved.skipDead) {
      // Alive-but-black streams are kept: the connection holds, and whether it
      // keeps holding is still a fair question. Only a stream the probe could
      // not play at all is left out.
      const dead = new Set(
        store
          .deadStreams()
          .filter((row) => !row.result.alive)
          .map((row) => row.streamId),
      );
      candidates = resolved.streams.filter((row) => !dead.has(row.streamId));
      skippedDead = resolved.streams.length - candidates.length;
    }
    if (candidates.length === 0) {
      return NextResponse.json(
        {
          error:
            skippedDead > 0
              ? `every stream on ${resolved.label} was dead at its last probe`
              : `nothing to soak for ${resolved.label}`,
        },
        { status: 404 },
      );
    }

    // A length for this run only, so a first baseline of a whole catalogue can
    // be taken at a minute a stream -- hours rather than most of a day -- and
    // the streams it finds wanting re-soaked properly afterwards. Bounded to
    // the same range the setting allows.
    const asked = Number(body.seconds);
    const seconds =
      Number.isFinite(asked) && asked > 0 ? Math.min(Math.max(Math.round(asked), 10), 900) : null;

    const queued = store.queueSoaks(
      seconds === null ? candidates : candidates.map((row) => ({ ...row, seconds })),
      resolved.source,
    );
    return NextResponse.json({
      status: 'queued',
      label: resolved.label,
      // Asked for, and newly queued. They differ when some were already
      // waiting, which is worth saying rather than reporting a silent no-op.
      requested: candidates.length,
      queued,
      // Reported, so a group whose count looks short is explained rather than
      // mysterious.
      skippedDead,
      // Said back, because it changes when the work will happen: a sweep-sourced
      // request sits until the soak window opens.
      source: resolved.source,
      seconds,
      ...store.pendingSoakCount(),
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
    return NextResponse.json({ status: 'cleared', cleared, ...store.pendingSoakCount() });
  } catch (error) {
    return NextResponse.json({ error: errorText(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}
