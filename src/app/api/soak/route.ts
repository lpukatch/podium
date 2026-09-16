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
  now: boolean,
): Promise<Scope | { error: string }> {
  const id = Number(rawId);
  if (scope === 'stream') {
    if (!Number.isInteger(id)) return { error: 'bad stream id' };
    // Deliberately not checked against the catalogue: a stream the snapshot has
    // not caught up with yet is still a legitimate thing to queue, and the pass
    // simply skips a row it cannot resolve to a URL.
    return { streams: [{ streamId: id }], label: `stream ${id}`, source: 'manual' };
  }
  if (scope === 'channel') {
    if (!Number.isInteger(id)) return { error: 'bad channel id' };
    return {
      streams: await streamsForChannels([id]),
      label: `channel ${id}`,
      source: 'manual',
    };
  }
  if (scope === 'group') {
    if (!Number.isInteger(id)) return { error: 'bad group id' };
    const snap = await snapshot();
    const channelIds = snap.channels.filter((c) => c.groupId === id).map((c) => c.id);
    return {
      streams: await streamsForChannels(channelIds),
      label: `group ${id} (${channelIds.length} channel(s))`,
      source: 'manual',
    };
  }
  if (scope === 'all') {
    const snap = await snapshot();
    // Every stream on every channel, not the top few per channel: the depth
    // limit is a property of the automatic planner deciding what is worth its
    // night, and "soak everything" is an instruction rather than a budget.
    return {
      streams: await streamsForChannels(snap.channels.map((c) => c.id)),
      label: `the whole catalogue (${snap.channels.length} channel(s))`,
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
      now?: boolean;
      seconds?: unknown;
    };
    const resolved = await resolveScope(body.scope ?? null, body.id, body.now === true);
    if ('error' in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }
    if (resolved.streams.length === 0) {
      return NextResponse.json({ error: `nothing to soak for ${resolved.label}` }, { status: 404 });
    }

    // A length for this run only, so a first baseline of a whole catalogue can
    // be taken at a minute a stream -- hours rather than most of a day -- and
    // the streams it finds wanting re-soaked properly afterwards. Bounded to
    // the same range the setting allows.
    const asked = Number(body.seconds);
    const seconds =
      Number.isFinite(asked) && asked > 0 ? Math.min(Math.max(Math.round(asked), 10), 900) : null;

    store = open();
    const queued = store.queueSoaks(
      seconds === null ? resolved.streams : resolved.streams.map((row) => ({ ...row, seconds })),
      resolved.source,
    );
    return NextResponse.json({
      status: 'queued',
      label: resolved.label,
      // Asked for, and newly queued. They differ when some were already
      // waiting, which is worth saying rather than reporting a silent no-op.
      requested: resolved.streams.length,
      queued,
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
