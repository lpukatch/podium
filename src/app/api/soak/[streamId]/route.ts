import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { DispatcharrClient } from '@/lib/dispatcharr';
import { errorText } from '@/lib/error-text';
import { soakStream } from '@/lib/probe';
import { snapshot } from '@/lib/server/state';
import type { Leg } from '@/lib/stability';
import { Store } from '@/lib/store';
import { buildVariants, drawVariant, POOLED_VARIANT, providerLogins } from '@/lib/variants';

export const dynamic = 'force-dynamic';

/**
 * The longest soak this endpoint will run.
 *
 * A soak holds a provider connection for its whole window, so the cap is a
 * capacity decision rather than a patience one. Ten minutes is long enough for
 * any flapping worth finding -- the feed this was built against dropped every
 * 36 to 55 seconds, so three minutes already catches three or four -- and short
 * enough that a forgotten request frees the slot on its own.
 */
export const MAX_SOAK_SECONDS = 600;
/** What the button asks for when it does not say. Three legs' worth of the case it was built for. */
export const DEFAULT_SOAK_SECONDS = 180;

export interface SoakResponse {
  streamId: number;
  streamName: string;
  providerName: string;
  /** Seconds actually spent, which is the budget unless the stream went away. */
  elapsedSeconds: number;
  heldSeconds: number;
  drops: number;
  /** Each connection: how long it served, and whether it ended on its own. */
  legs: Array<{ heldSeconds: number; dropped: boolean; error: string }>;
  /** True when it could not reconnect at all -- dead, rather than unstable. */
  unreachable: boolean;
  /** Legs written to the ledger, so the ranking now knows about this. */
  recorded: number;
  /** Set when somebody was watching, since the soak then competed for a slot. */
  contended: boolean;
}

/**
 * Hold one stream open and report how long it lasts.
 *
 * The active half of the stability feature. The passive ledger can only learn
 * about streams somebody has watched, which on a six-stream channel is usually
 * the one already in slot 0 -- exactly the stream whose replacement you want to
 * know about. This measures any stream on request.
 *
 * POST rather than GET because it is not free: it occupies a provider
 * connection for minutes and it writes to the ledger, which changes ranking.
 *
 * The legs it produces are written to the same table the poller writes, and are
 * deliberately not distinguished there beyond `ended`. A connection that
 * dropped is the same evidence whichever side saw it happen, and keeping two
 * populations apart would mean two rates, two thresholds and two explanations
 * for one question.
 */
export async function POST(request: Request, context: { params: Promise<{ streamId: string }> }) {
  let store: Store | null = null;
  try {
    const streamId = Number((await context.params).streamId);
    if (!Number.isFinite(streamId)) {
      return NextResponse.json({ error: 'bad stream id' }, { status: 400 });
    }

    const url = new URL(request.url);
    const asked = Number(url.searchParams.get('seconds') ?? DEFAULT_SOAK_SECONDS);
    const seconds = Math.min(
      Math.max(Number.isFinite(asked) ? asked : DEFAULT_SOAK_SECONDS, 10),
      MAX_SOAK_SECONDS,
    );

    const config = loadConfig();
    const snap = await snapshot();
    const stream = snap.streams.find((s) => s.id === streamId);
    if (!stream) return NextResponse.json({ error: 'unknown stream' }, { status: 404 });
    const provider = snap.providers.find((p) => p.id === stream.providerId);

    const client = new DispatcharrClient(config.DISPATCHARR_URL, {
      apiKey: config.DISPATCHARR_API_KEY,
      username: config.DISPATCHARR_USERNAME,
      password: config.DISPATCHARR_PASSWORD,
    });

    // Reported, not enforced. The operator asked for this specific measurement
    // and refusing it because the television is on would make the feature
    // unusable exactly when a stream is misbehaving -- which is when anybody
    // thinks to press the button. Saying so lets them read a bad result as
    // possibly theirs rather than the provider's.
    let contended = false;
    try {
      await client.login();
      // `liveChannels`, not `activeSessions`: the latter resolves channel uuids
      // through a map this route has no reason to fetch, and throws when a
      // payload has entries it could not resolve -- which is every payload,
      // without the map. It would have made this flag permanently false.
      contended = (await client.liveChannels()).length > 0;
    } catch {
      // An unreachable Dispatcharr says nothing about the stream URL, which is
      // fetched from the provider directly. The soak can still run.
    }

    // Built through the same variant machinery the worker uses so that an
    // Xtream account's URL is rewritten the way playback rewrites it -- the
    // stored URL is not always reachable as stored. Drawn with no slot map,
    // which makes `drawVariant` hand back the first login rather than
    // balancing: one soak is one connection, and there is no pool to spread it
    // across.
    const logins = provider ? providerLogins(provider) : undefined;
    const menu =
      logins && logins.length > 0
        ? buildVariants(stream.url, logins)
        : [{ variantId: POOLED_VARIANT, profileId: 0, url: stream.url }];
    const variant = drawVariant(menu, stream.providerId, new Map(), 0);

    const startedAt = Date.now();
    const result = await soakStream(variant.url, { seconds });
    const elapsedMs = Date.now() - startedAt;

    // Written even when the soak found nothing wrong: clean watched time is
    // half of what a rate is made of, and a soak that held for three minutes
    // is exactly the evidence that a stream with an old bad record has
    // recovered. A leg the soak never got to serve is not evidence either way
    // and is dropped by `recordLegs`.
    const legs: Leg[] = [];
    let cursor = startedAt;
    for (const leg of result.legs) {
      legs.push({
        channelKey: `soak:${streamId}`,
        channelId: null,
        streamId,
        startedAt: cursor,
        endedAt: cursor + leg.heldMs,
        watchedMs: leg.heldMs,
        stalledMs: 0,
        stalls: 0,
        // A soak that ran its budget out is the operator stopping the watching,
        // which is `gone` -- the same ending a viewer switching off produces,
        // and charged to nobody for the same reason.
        ended: leg.dropped ? 'dropped' : 'gone',
      });
      cursor += leg.heldMs;
    }

    store = new Store(config.dbPath);
    store.recordLegs(legs);

    return NextResponse.json({
      streamId,
      streamName: stream.name,
      providerName: provider?.name ?? '',
      elapsedSeconds: Math.round(elapsedMs / 1000),
      heldSeconds: Math.round(result.heldMs / 1000),
      drops: result.drops,
      legs: result.legs.map((leg) => ({
        heldSeconds: Math.round(leg.heldMs / 1000),
        dropped: leg.dropped,
        error: leg.error.slice(0, 200),
      })),
      unreachable: result.unreachable,
      recorded: legs.filter((leg) => leg.watchedMs > 0).length,
      contended,
    } satisfies SoakResponse);
  } catch (error) {
    return NextResponse.json({ error: errorText(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}
