import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { resolveEnv } from '@/lib/settings';
import { Store } from '@/lib/store';
import { syncToTeamarr } from '@/lib/teamarr-sync';

export const dynamic = 'force-dynamic';

/**
 * What the last push did, and whether one is scheduled.
 *
 * Includes the refusals, which are the reason this is stored rather than
 * logged: a push that declines to write leaves Teamarr byte-identical, so
 * without a record the operator cannot tell a scheduled sync that ran and
 * chose not to act from one that never ran at all.
 */
export function GET() {
  let store: Store | null = null;
  try {
    store = new Store(loadConfig().dbPath);
    const config = loadConfig(resolveEnv(process.env, store.settings()));
    const last = store.teamarrSync();
    // The row's own write time, not `outcome.at`. They differ by milliseconds,
    // but this is the one the scheduler measures its interval from, so it is
    // the only one that predicts the next run correctly -- and it is written
    // for refusals and failures too, which is what stops a declining install
    // from retrying every heartbeat.
    const lastAttemptAt = last?.ranAt ?? null;
    return NextResponse.json({
      configured: Boolean(config.PODIUM_TEAMARR_URL.trim()),
      scheduled: config.PODIUM_TEAMARR_SYNC,
      everyMs: config.PODIUM_TEAMARR_SYNC_MS,
      minSamples: config.PODIUM_TEAMARR_MIN_SAMPLES,
      lastAttemptAt,
      // Computed here rather than in the browser so it follows the scheduler's
      // rule rather than a second copy of it. Null when nothing is scheduled:
      // there is no next run to name, and a date implying otherwise is worse
      // than no date. A schedule that has never run is due immediately.
      nextAt: config.PODIUM_TEAMARR_SYNC
        ? (lastAttemptAt ?? Date.now() - config.PODIUM_TEAMARR_SYNC_MS) +
          config.PODIUM_TEAMARR_SYNC_MS
        : null,
      last: last?.outcome ?? null,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}

/**
 * Push now.
 *
 * `?dryRun=1` runs every check and reports what would happen without writing —
 * the honest answer to "what would tonight's scheduled push do", which is not
 * a question you can ask by doing it.
 *
 * `?force=1` pushes past a simulated regression. It exists for the one case the
 * simulation cannot see: a rule set carrying `epg_match` or `stream_type` is
 * scored with those rules skipped, which can read as a regression that is not
 * real. Never used by the scheduler.
 */
export async function POST(request: Request) {
  let store: Store | null = null;
  try {
    const url = new URL(request.url);
    const truthy = (key: string): boolean =>
      ['1', 'true', 'yes', 'on'].includes((url.searchParams.get(key) ?? '').trim().toLowerCase());

    store = new Store(loadConfig().dbPath);
    const config = loadConfig(resolveEnv(process.env, store.settings()));
    const outcome = await syncToTeamarr(store, config, {
      dryRun: truthy('dryRun'),
      force: truthy('force'),
    });
    // A preview is not an attempt, and recording it would overwrite the record
    // of the last real one with something that never touched Teamarr.
    if (!truthy('dryRun')) store.saveTeamarrSync(outcome);
    return NextResponse.json(outcome);
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}
