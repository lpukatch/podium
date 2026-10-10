/**
 * The connect_events hand-off: what the webhook route writes and what the
 * worker's ledger drains.
 *
 * The interesting property is not the storage but the consuming -- an event
 * folded twice is a failure charged twice, so `take` must empty the table in
 * the same transaction that reads it, and rows too old to fold safely must be
 * dropped rather than delivered.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectEventRow } from './store';
import { Store } from './store';

function row(over: Partial<ConnectEventRow> = {}): ConnectEventRow {
  return {
    event: 'stream_switch',
    channelKey: '09bbd059-1a49-47ee-a525-c1444e1c6bd7',
    streamId: 77177,
    previousStreamId: 77013,
    reason: 'buffering_timeout',
    receivedAt: Date.now(),
    ...over,
  };
}

describe('the connect event queue', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
    vi.restoreAllMocks();
  });

  it('hands back what was written, in arrival order', () => {
    store.recordConnectEvents([
      row({ streamId: 2, receivedAt: Date.now() - 5_000 }),
      row({ event: 'channel_error', streamId: 2, previousStreamId: null, reason: '' }),
    ]);
    const events = store.takeConnectEvents(60_000);
    expect(events.map((e) => e.event)).toEqual(['stream_switch', 'channel_error']);
    expect(events[0]).toMatchObject({
      channelKey: row().channelKey,
      streamId: 2,
      reason: 'buffering_timeout',
    });
  });

  it('consumes rather than peeks: a second take finds nothing', () => {
    store.recordConnectEvents([row()]);
    expect(store.takeConnectEvents(60_000)).toHaveLength(1);
    expect(store.takeConnectEvents(60_000)).toEqual([]);
  });

  it('drops deliveries too old to fold safely, without delivering them', () => {
    store.recordConnectEvents([row({ receivedAt: Date.now() - 120_000 }), row({ streamId: 3 })]);
    const events = store.takeConnectEvents(60_000);
    expect(events.map((e) => e.streamId)).toEqual([3]);
    // The stale one is gone, not left for the next drain to rediscover.
    expect(store.takeConnectEvents(60_000)).toEqual([]);
  });

  it('keeps delivery totals and history when the worker empties its queue', () => {
    store.recordConnectEvents([row(), row({ event: 'channel_error', streamId: 2 })]);
    expect(store.connectActivity().pending).toBe(2);
    store.takeConnectEvents(60_000);
    const activity = store.connectActivity();
    expect(activity.pending).toBe(0);
    expect(activity.summary.accepted).toBe(2);
    expect(activity.summary.lastReceivedAt).not.toBeNull();
    expect(activity.recent.map((x) => x.event)).toEqual(['channel_error', 'stream_switch']);
    expect(activity.recent[1]).toMatchObject({
      previousStreamId: 77013,
      status: 204,
      reason: 'buffering_timeout',
    });
  });

  it('records receiver errors without queuing them or inventing channel details', () => {
    store.recordConnectRejection('stream_switch', 401, 'Missing or wrong Connect token');
    const activity = store.connectActivity();
    expect(activity.pending).toBe(0);
    expect(activity.summary).toMatchObject({ accepted: 0, rejected: 1, lastReceivedAt: null });
    expect(activity.recent[0]).toMatchObject({ channelKey: null, streamId: null, status: 401 });
  });

  it('retains at most 500 history rows, with 25 shown and totals unaffected', () => {
    store.recordConnectEvents(Array.from({ length: 510 }, (_, i) => row({ streamId: i })));
    const activity = store.connectActivity();
    expect(activity.summary.accepted).toBe(510);
    expect(activity.recent).toHaveLength(25);
    expect(activity.recent[0]?.streamId).toBe(509);
    // Age all retained deliveries, then add one: retention never resets totals.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15 * 86_400_000);
    store.recordConnectEvents([row({ streamId: 999 })]);
    expect(store.connectActivity().recent).toHaveLength(1);
    expect(store.connectActivity().summary.accepted).toBe(511);
  });

  it('does not show history beyond the retention window on a quiet install', () => {
    store.recordConnectEvents([row()]);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15 * 86_400_000);
    const activity = store.connectActivity();
    expect(activity.recent).toEqual([]);
    expect(activity.summary.accepted).toBe(1);
    expect(activity.summary.lastReceivedAt).not.toBeNull();
  });

  it('does not confuse subscription checks with event reception and clears recovered errors', () => {
    const target = {
      wanted: true,
      podiumUrl: 'http://podium:3456/',
      dispatcharrUrl: 'http://dispatcharr:9191',
    };
    store.recordConnectSync(target, 'Subscription check failed');
    expect(store.connectActivity().summary).toMatchObject({
      syncErrors: 1,
      lastSyncSuccessAt: null,
      syncError: 'Subscription check failed',
    });
    store.recordConnectSync(target, null);
    expect(store.connectActivity().summary).toMatchObject({
      syncErrors: 1,
      syncError: null,
      lastReceivedAt: null,
      syncPodiumUrl: 'http://podium:3456',
    });
    expect(store.connectActivity().summary.lastSyncSuccessAt).not.toBeNull();
  });

  it('upgrades an existing queue without pretending old events were tracked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-connect-upgrade-'));
    try {
      const path = join(dir, 'podium.db');
      const old = new Database(path);
      old.exec(`CREATE TABLE connect_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL, channel_key TEXT NOT NULL, stream_id INTEGER,
        previous_stream_id INTEGER, reason TEXT NOT NULL DEFAULT '', received_at INTEGER NOT NULL)`);
      old
        .prepare('INSERT INTO connect_events (event, channel_key, received_at) VALUES (?, ?, ?)')
        .run('channel_error', 'abc', Date.now());
      old.close();
      const upgraded = new Store(path);
      expect(upgraded.connectActivity()).toMatchObject({
        pending: 1,
        recent: [],
        summary: { accepted: 0 },
      });
      upgraded.recordConnectEvents([row()]);
      upgraded.takeConnectEvents(60_000);
      const since = upgraded.connectActivity().summary.trackingSince;
      upgraded.close();
      const reopened = new Store(path);
      try {
        expect(reopened.connectActivity()).toMatchObject({
          pending: 0,
          summary: { accepted: 1, trackingSince: since },
        });
        expect(reopened.connectActivity().recent).toHaveLength(1);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds physical history and rolls back the queue if history cannot be written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-connect-atomic-'));
    const path = join(dir, 'podium.db');
    const disk = new Store(path);
    const inspect = new Database(path);
    try {
      disk.recordConnectEvents(Array.from({ length: 510 }, (_, i) => row({ streamId: i })));
      expect(inspect.prepare('SELECT COUNT(*) AS n FROM connect_delivery_history').get()).toEqual({
        n: 500,
      });
      inspect.exec(`CREATE TRIGGER fail_history BEFORE INSERT ON connect_delivery_history
        BEGIN SELECT RAISE(ABORT, 'history unavailable'); END`);
      expect(() => disk.recordConnectEvents([row()])).toThrow('history unavailable');
      expect(disk.connectActivity()).toMatchObject({ pending: 510, summary: { accepted: 510 } });
    } finally {
      inspect.close();
      disk.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
