import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { connectTokenMatches } from '@/lib/connect';
import { isConnectEventName, parseConnectEvent } from '@/lib/connect-events';
import { errorText } from '@/lib/error-text';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Where Dispatcharr's live-stream events land.
 *
 * One path per event type -- `/api/connect/events/stream_switch` and
 * `/api/connect/events/channel_error`, provisioned by `lib/connect.ts` --
 * because a real delivery does not name its event: the body is the event's
 * own fields alone, form-encoded, with an event name appearing only in the
 * payload Dispatcharr's "test" button sends. The type has to travel in the
 * URL.
 *
 * Writes a row and returns. The stability tracker lives in the worker, and
 * the two halves of Podium share this database and nothing else, so the
 * route's whole job is to get the delivery into `connect_events` intact and
 * let the worker's drain fold it -- the same bargain the soak queue strikes,
 * for the same reason: doing the work here would mean a second scheduler
 * with none of the gates.
 *
 * Authentication is the token provisioning set in the integration's headers
 * (`X-Podium-Connect-Token`), checked before the body is read. The endpoint
 * answers a machine rather than a browser, but it is still a write on a
 * server with no login -- and it is what makes it fine that Dispatcharr's
 * `requests.post` sends no `Origin` for the front door's cross-site check to
 * read. The check passes on that absence for exactly this shape of client,
 * as it does for backups and curl.
 */

/** The header provisioning sets on every managed integration. */
const TOKEN_HEADER = 'x-podium-connect-token';

function open(): Store {
  return new Store(loadConfig().dbPath);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ event: string }> },
): Promise<Response> {
  const { event } = await context.params;
  if (!isConnectEventName(event)) {
    return NextResponse.json({ error: `unknown event ${JSON.stringify(event)}` }, { status: 404 });
  }

  let store: Store | null = null;
  try {
    store = open();
    const settings = store.settings();
    if (
      !connectTokenMatches(request.headers.get(TOKEN_HEADER) ?? '', settings.PODIUM_CONNECT_TOKEN)
    ) {
      store.recordConnectRejection(event, 401, 'Missing or wrong Connect token');
      return NextResponse.json({ error: 'missing or wrong token' }, { status: 401 });
    }

    const parsed = parseConnectEvent(
      event,
      request.headers.get('content-type') ?? '',
      await request.text(),
      Date.now(),
    );
    if (parsed === null) {
      // A delivery without a channel cannot name a leg. Storing it would only
      // move the refusal to the drain; 400 says so in Dispatcharr's
      // DeliveryLog instead of failing there.
      store.recordConnectRejection(
        event,
        400,
        'Invalid delivery: missing channel_id or malformed body',
      );
      return NextResponse.json({ error: 'delivery had no channel_id' }, { status: 400 });
    }
    store.recordConnectEvents([parsed]);
    return new Response(null, { status: 204 });
  } catch (error) {
    try {
      store?.recordConnectRejection(
        event,
        500,
        'Receiver could not store the delivery; check server logs',
      );
    } catch {
      // Observability must not mask the original failure if SQLite is unavailable.
    }
    return NextResponse.json({ error: errorText(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}
