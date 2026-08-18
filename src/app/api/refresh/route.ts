import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { ALL_GROUPS, Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Ask for a group -- or the whole catalogue -- to be re-checked, whatever the
 * cache says.
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
 */

interface Scope {
  groupId: number;
  label: string;
}

/** `{scope: 'all'}` or `{scope: 'group', groupId}`, from a body or a query. */
function parseScope(scope: string | null, rawGroupId: unknown): Scope | { error: string } {
  if (scope === 'all') return { groupId: ALL_GROUPS, label: 'the whole catalogue' };
  if (scope !== 'group') return { error: `unknown scope ${JSON.stringify(scope)}` };
  const groupId = Number(rawGroupId);
  if (!Number.isInteger(groupId) || groupId < 0) {
    return { error: 'bad group id' };
  }
  return { groupId, label: `group ${groupId}` };
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
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
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
    };
    const scope = parseScope(body.scope ?? null, body.groupId);
    if ('error' in scope) return NextResponse.json({ error: scope.error }, { status: 400 });

    store = open();
    const forcedAt = Date.now();
    store.setRefreshMark(scope.groupId, forcedAt);
    // A whole-catalogue request supersedes the per-group ones: they can only
    // retire verdicts this one has already retired, and leaving them behind
    // means cancelling the big request quietly leaves several small ones
    // running.
    if (scope.groupId === ALL_GROUPS) store.clearGroupRefreshMarks();
    return NextResponse.json({ queued: true, scope: scope.label, forcedAt });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}

export function DELETE(request: Request) {
  let store: Store | null = null;
  try {
    const params = new URL(request.url).searchParams;
    const scope = parseScope(params.get('scope'), params.get('groupId'));
    if ('error' in scope) return NextResponse.json({ error: scope.error }, { status: 400 });

    store = open();
    const cleared = store.clearRefreshMark(scope.groupId);
    return NextResponse.json({ cancelled: cleared > 0, scope: scope.label });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}
