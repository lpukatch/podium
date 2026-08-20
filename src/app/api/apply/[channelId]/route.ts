import { NextResponse } from 'next/server';
import { requireCredentials } from '@/lib/config';
import { DispatcharrClient } from '@/lib/dispatcharr';
import { currentProgrammes, describeVerdict, Eligibility } from '@/lib/eligibility';
import { catalogueRows, composeOrder } from '@/lib/runner';
import {
  groupPatterns,
  noteStreamOrder,
  policies,
  config as serverConfig,
  snapshot,
} from '@/lib/server/state';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Write one channel's stream order to Dispatcharr.
 *
 * Separated from the check endpoint on purpose: checking is safe and
 * repeatable, applying overwrites the channel's stream array with no undo. The
 * previous order is returned so it can be put back by hand if the new one is
 * wrong.
 */
export async function POST(request: Request, context: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await context.params;
  const id = Number(channelId);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: 'bad channel id' }, { status: 400 });
  }

  let store: Store | null = null;
  try {
    const body = (await request.json()) as {
      order?: number[];
      removeUnmatched?: boolean;
      force?: boolean;
      allowAssign?: boolean;
    };
    const order = body.order ?? [];
    if (order.length === 0 || order.some((n) => !Number.isInteger(n))) {
      return NextResponse.json({ error: 'order must be a non-empty list of ids' }, { status: 400 });
    }

    const config = serverConfig();
    // Every settable knob here -- dry run, write stats, analyze seconds -- can
    // come from the settings table, so this must not read the environment alone.
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
    // `previous` is the undo safety-net for a destructive write, so it must be
    // what Dispatcharr holds right now -- not the five-minute snapshot the UI
    // pages share, which could already be stale.
    const channel = await client.channel(id);
    if (!channel) {
      return NextResponse.json({ error: 'unknown channel' }, { status: 404 });
    }

    store = new Store(config.dbPath);
    const snap = await snapshot();
    const groupName =
      channel.groupId !== null
        ? snap.groups.find((g) => g.id === channel.groupId)?.name
        : undefined;
    const elig = new Eligibility(policies(), undefined, groupPatterns());
    const epgRows = (await client.epgWindow().catch(() => [])) as never[];
    const programmes = currentProgrammes(epgRows);
    const verdict = elig.allows(channel.groupId, channel.tvgId, programmes, new Date(), groupName);

    if (!verdict.allowed && !body.force) {
      return NextResponse.json(
        {
          error: `Group policy prevents apply: ${describeVerdict(verdict)}`,
          heldBack: describeVerdict(verdict),
        },
        { status: 409 },
      );
    }

    const previous = channel.streams ?? [];
    const removeUnmatched = body.removeUnmatched ?? config.PODIUM_REMOVE_UNMATCHED;
    const targetOrder = body.allowAssign ? order : composeOrder(order, previous, removeUnmatched);

    if (targetOrder.length === 0) {
      return NextResponse.json({ error: 'composed order is empty' }, { status: 400 });
    }

    await client.setStreamOrder(id, targetOrder);
    // So the page that applied can redraw from the shared snapshot instead of
    // forcing a full refetch of every channel and stream just to see its own
    // write -- which is what made an applied removal look like it had not
    // happened until Refresh.
    noteStreamOrder(id, targetOrder);
    // Keep the persisted catalogue honest about what was just written: it is
    // the worker's snapshot until the next pass, and an apply the worker did
    // not make would otherwise not show up in the metrics until a full pass
    // later. The web snapshot's stream/provider maps are minutes stale at
    // worst, which provider attribution does not care about.
    store.updateChannelOrder(
      id,
      catalogueRows(
        { id, name: channel.name },
        targetOrder,
        new Map(snap.streams.map((s) => [s.id, s])),
        new Map(snap.providers.map((p) => [p.id, p.name])),
      ),
    );

    return NextResponse.json({
      status: 'applied',
      channelId: id,
      previous,
      order: targetOrder,
      heldBack: verdict.allowed ? null : describeVerdict(verdict),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}
