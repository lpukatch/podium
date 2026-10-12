import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { responseErrorText } from '@/lib/error-text';
import { DEFAULT_WEIGHTS, isUsable } from '@/lib/scoring';
import { resolveEnv } from '@/lib/settings';
import { STALE_LOCK_MS, Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

type HealthState = 'alive' | 'dead' | 'black' | 'low_bitrate' | 'unmeasured';

/**
 * Dashboard-sized library health: the Prometheus endpoint stays exhaustive,
 * while this returns the few ratios that are useful at a glance.
 */
export function GET() {
  let store: Store | null = null;
  try {
    const boot = loadConfig();
    store = new Store(boot.dbPath);
    const config = loadConfig(resolveEnv(process.env, store.settings()));
    const { rows, writtenAt } = store.catalogue();
    const streamIds = [...new Set(rows.map((row) => row.streamId))];
    const verdicts = store.verdicts(streamIds);
    const primaryByProvider = new Map<string, { primary: number; healthy: number }>();
    const states: Record<HealthState, number> = {
      alive: 0,
      dead: 0,
      black: 0,
      low_bitrate: 0,
      unmeasured: 0,
    };
    let primary = 0;
    let healthyPrimary = 0;

    for (const streamId of streamIds) {
      const result = verdicts.get(streamId)?.result;
      const state: HealthState = !result
        ? 'unmeasured'
        : !result.alive
          ? 'dead'
          : result.black
            ? 'black'
            : result.bitrateKbps > 0 && result.bitrateKbps < DEFAULT_WEIGHTS.minBitrateKbps
              ? 'low_bitrate'
              : 'alive';
      states[state]++;
    }

    for (const row of rows) {
      if (row.slot !== 0) continue;
      primary++;
      const provider = primaryByProvider.get(row.providerName) ?? { primary: 0, healthy: 0 };
      provider.primary++;
      const verdict = verdicts.get(row.streamId)?.result;
      if (verdict && isUsable(verdict)) {
        provider.healthy++;
        healthyPrimary++;
      }
      primaryByProvider.set(row.providerName, provider);
    }

    const lock = store.lockState();
    const heartbeatAge = lock ? Date.now() - lock.heartbeat : null;
    const workerEnabled = process.env.PODIUM_ENABLE_WORKER !== 'false';
    const worker = !workerEnabled
      ? 'disabled'
      : heartbeatAge !== null && heartbeatAge < STALE_LOCK_MS
        ? 'active'
        : heartbeatAge === null
          ? 'absent'
          : 'stale';
    const progress = store.getProgress();
    const cache = store.cacheStats();
    const oldestProbedAt = progress.oldestManagedProbedAt ?? cache.oldestProbedAt;
    const oldestProbeAgeSeconds =
      oldestProbedAt === null
        ? null
        : Math.max(0, Math.round((Date.now() - oldestProbedAt) / 1000));
    const freshnessTargetSeconds = Math.round(config.PODIUM_MAX_AGE_MS / 1000);
    const lastRun = store.recentRuns(1)[0] ?? null;

    return NextResponse.json({
      worker,
      heartbeatAgeSeconds: heartbeatAge === null ? null : Math.round(heartbeatAge / 1000),
      catalogueWrittenAt: writtenAt,
      streams: {
        total: streamIds.length,
        measured: streamIds.length - states.unmeasured,
        healthy: states.alive,
        states,
      },
      primary: { total: primary, healthy: healthyPrimary },
      providers: [...primaryByProvider]
        .map(([name, counts]) => ({ name, ...counts }))
        .sort((a, b) => b.primary - a.primary || a.name.localeCompare(b.name)),
      freshness: {
        oldestProbeAgeSeconds,
        targetSeconds: freshnessTargetSeconds,
        breaching: oldestProbeAgeSeconds !== null && oldestProbeAgeSeconds > freshnessTargetSeconds,
      },
      lastRun,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Cannot read stats', detail: responseErrorText(error) },
      { status: 500 },
    );
  } finally {
    store?.close();
  }
}
