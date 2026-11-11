import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { responseErrorText } from '@/lib/error-text';
import { ALL_GROUPS, Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Ask for a channel, a group, or the whole catalogue to be re-checked, whatever
 * the cache says.
 *
 * The freshness target answers "nothing older than 24 hours", which is the
 * right default and the wrong one on the afternoon of a big event: everything
 * can be comfortably inside the target and still have been measured at four in
 * the morning. This is how you say "I do not care that it is fresh, look
 * again".
 *
 * It deliberately does not probe. It writes one timestamp and returns; the
 * planner treats every older verdict as expired and the next pass picks the
 * work up through the ordinary machinery, so provider lanes, the pause while
 * somebody is watching, and the after-kickoff gate all keep applying. Probing
 * here instead would be a second scheduler that knows none of that -- see
 * `/api/check/[channelId]`, which probes on the spot and is bounded to one
 * channel and fifty streams precisely because it does.
 *
 * The other half of that bargain is that the request is cancellable: DELETE
 * drops the mark and every verdict it retired goes straight back into service,
 * because nothing was ever deleted from the cache.
 *
 * A channel id is checked for shape, not existence, the same as a group id: a
 * mark for a channel the planner never meets holds no verdicts, so the next
 * pass finds it satisfied and retires it on its own. Checking against
 * Dispatcharr here would make queueing a timestamp depend on a crawl.
 */

type Scope =
  | { kind: 'group'; groupId: number; label: string }
  | { kind: 'channel'; channelId: number; label: string };

/**
 * `{scope: 'all'}`, `{scope: 'group', groupId}` or `{scope: 'channel',
 * channelId}`, from a body or a query.
 */
function parseScope(
  scope: string | null,
  rawGroupId: unknown,
  rawChannelId: unknown,
): Scope | { error: string } {
  if (scope === 'all') return { kind: 'group', groupId: ALL_GROUPS, label: 'the whole catalogue' };
  if (scope === 'channel') {
    // Stricter than the group id: nothing coerces to a channel, so a missing
    // or empty id is refused rather than read as 0.
    const channelId =
      typeof rawChannelId === 'string' && /^\d+$/.test(rawChannelId)
        ? Number(rawChannelId)
        : rawChannelId;
    if (typeof channelId !== 'number' || !Number.isSafeInteger(channelId) || channelId <= 0) {
      return { error: 'bad channel id' };
    }
    return { kind: 'channel', channelId, label: `channel ${channelId}` };
  }
  if (scope !== 'group') return { error: `unknown scope ${JSON.stringify(scope)}` };
  const groupId = Number(rawGroupId);
  if (!Number.isInteger(groupId) || groupId < 0) {
    return { error: 'bad group id' };
  }
  return { kind: 'group', groupId, label: `group ${groupId}` };
}

function open(): Store {
  return new Store(loadConfig().dbPath);
}

/** What is currently queued, so the UI can offer to cancel it. */
export function GET() {
  let store: Store | null = null;
  try {
    store = open();
    const marks = store.refreshMarks();
    return NextResponse.json({
      all: marks.all,
      groups: Object.fromEntries(marks.byGroup),
      channels: Object.fromEntries(marks.byChannel),
    });
  } catch (error) {
    return NextResponse.json({ error: responseErrorText(error) }, { status: 500 });
  } finally {
    store?.close();
  }
}

export async function POST(request: Request) {
  let store: Store | null = null;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      scope?: string;
      groupId?: unknown;
      channelId?: unknown;
    };
    const scope = parseScope(body.scope ?? null, body.groupId, body.channelId);
    if ('error' in scope) return NextResponse.json({ error: scope.error }, { status: 400 });

    store = open();
    const forcedAt = Date.now();
    if (scope.kind === 'channel') {
      store.setChannelRefreshMark(scope.channelId, forcedAt);
    } else {
      store.setRefreshMark(scope.groupId, forcedAt);
    }
    // A whole-catalogue request supersedes the per-group and per-channel ones:
    // they can only retire verdicts this one has already retired, and leaving
    // them behind means cancelling the big request quietly leaves several small
    // ones running.
    if (scope.kind === 'group' && scope.groupId === ALL_GROUPS) {
      store.clearGroupRefreshMarks();
      store.clearChannelRefreshMarks();
    }
    return NextResponse.json({ queued: true, scope: scope.label, forcedAt });
  } catch (error) {
    return NextResponse.json({ error: responseErrorText(error) }, { status: 500 });
  } finally {
    store?.close();
  }
}

export function DELETE(request: Request) {
  let store: Store | null = null;
  try {
    const params = new URL(request.url).searchParams;
    const scope = parseScope(params.get('scope'), params.get('groupId'), params.get('channelId'));
    if ('error' in scope) return NextResponse.json({ error: scope.error }, { status: 400 });

    store = open();
    const cleared =
      scope.kind === 'channel'
        ? store.clearChannelRefreshMark(scope.channelId)
        : store.clearRefreshMark(scope.groupId);
    return NextResponse.json({ cancelled: cleared > 0, scope: scope.label });
  } catch (error) {
    return NextResponse.json({ error: responseErrorText(error) }, { status: 500 });
  } finally {
    store?.close();
  }
}
