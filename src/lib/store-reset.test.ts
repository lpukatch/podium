/**
 * What a hard reset actually resets.
 *
 * `resetData()` is the "start measuring again" button. Everything measured,
 * cached, or recorded has to go -- and, the sharp edge this file exists for,
 * the *pending* work: a queued soak that survived a reset would keep drawing
 * provider slots window after window against a catalogue that no longer
 * exists. Config (the settings table) is the other side of the line and has
 * to survive.
 */

import type { Database } from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store';

describe('resetData', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-reset-'));
    store = new Store(join(dir, 'podium.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const db = (): Database => (store as unknown as { db: Database }).db;
  const count = (table: string): number =>
    (db().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

  function seed(): void {
    // Pending work -- the part a pre-reset version of resetData left behind.
    store.queueSoaks([{ streamId: 1, channelId: 11 }], 'manual');

    // Records and derived state.
    store.recordLegs([
      {
        channelKey: 'sess-1',
        channelId: 11,
        streamId: 1,
        startedAt: 1,
        endedAt: 2,
        watchedMs: 1_000,
        stalledMs: 0,
        stalls: 0,
        ended: 'dropped',
      },
    ]);
    store.markUnmatched(11, [1], 1234);
    store.recordConnectEvents([
      {
        event: 'stream_switch',
        channelKey: 'chan-1',
        streamId: 1,
        previousStreamId: 2,
        reason: 'tune',
        receivedAt: 1234,
      },
    ]);
    store.saveTeamarrSync({ pushed: true, at: 1234 });
    store.setProgress({
      runId: 'run-1',
      phase: 'done',
      startedAt: 1,
      probed: 1,
      total: 1,
      dead: 0,
      reordered: 0,
      unchanged: 0,
      cached: 0,
      deferred: 0,
      backlog: 0,
      dueAt: null,
      heldBack: {},
      lanes: [],
      message: '',
      nextRunAt: null,
      tickMs: 0,
      maxAgeMs: 0,
    });
    // The line the reset must not cross.
    store.setSettings({ PODIUM_DRY_RUN: 'false' });
  }

  it('drains every data table, including pending soak work', () => {
    seed();

    store.resetData();

    for (const table of [
      'soak_requests',
      'soak_results',
      'stream_legs',
      'rule_checks',
      'rule_check_misses',
      'unmatched_since',
      'teamarr_rules',
      'teamarr_sync',
      'teamarr_sync_log',
      'connect_events',
      'connect_activity',
      'connect_delivery_history',
      'progress',
    ]) {
      expect(count(table), table).toBe(0);
    }
  });

  it('leaves the settings alone', () => {
    seed();

    store.resetData();

    expect(store.settings()).toEqual({ PODIUM_DRY_RUN: 'false' });
  });

  it('is safe to run on an already-empty database', () => {
    expect(() => store.resetData()).not.toThrow();
  });
});

describe('replaceCatalogue prunes clocks the catalogue no longer carries', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-catalogue-'));
    store = new Store(join(dir, 'podium.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('drops unmatched clocks for channels it no longer manages, and only those', () => {
    store.markUnmatched(11, [1], 1_000);
    store.markUnmatched(12, [2], 2_000);
    // Channel 12 vanishes from the catalogue; channel 11 stays.
    store.replaceCatalogue(
      [
        {
          channelId: 11,
          channelName: 'Kept',
          slot: 0,
          streamId: 1,
          providerId: 5,
          providerName: 'A',
        },
      ],
      'run-1',
    );

    expect([...store.unmatchedSince(11).keys()]).toEqual([1]);
    expect(store.unmatchedSince(12).size).toBe(0);
  });

  it('does not prune on an empty write', () => {
    // replaceCatalogue refuses an empty snapshot outright -- a truncated fetch
    // must not look like "nothing is managed" -- so the clocks survive it too.
    store.markUnmatched(11, [1], 1_000);
    store.replaceCatalogue([], 'run-1');
    expect(store.unmatchedSince(11).size).toBe(1);
  });
});
