import { NextResponse } from 'next/server';
import { summarizeDead } from '@/lib/dead';
import type { DeadStreamRow } from '@/lib/store';
import { loadConfig } from '@/lib/config';
import { snapshot } from '@/lib/server/state';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Everything the dead view and the All-channels Dead chip read, in one round
 * trip: the folded dead list joined against the catalogue, with channel
 * attribution and provider tallies. The aggregation is `summarizeDead`'s --
 * this route is only the plumbing of snapshot + cache together, so the join
 * stays testable without a Dispatcharr behind it.
 */
export async function GET() {
  try {
    const snap = await snapshot();

    // Cache unavailable is not fatal, exactly as /api/preview reads it: the
    // catalogue half still answers, with the flag saying why the list is
    // empty rather than letting an empty list claim nothing is dead.
    let store: Store | null = null;
    let rows: DeadStreamRow[] = [];
    let cacheUnavailable = false;
    try {
      store = new Store(loadConfig().dbPath);
      rows = store.deadStreams();
    } catch {
      cacheUnavailable = true;
    } finally {
      store?.close();
    }

    return NextResponse.json({ ...summarizeDead(rows, snap, snap.fetchedAt), cacheUnavailable });
  } catch (error) {
    return NextResponse.json(
      { error: 'Cannot read dead streams', detail: String(error).slice(0, 300) },
      { status: 500 },
    );
  }
}
