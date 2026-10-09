/**
 * The connect_events hand-off: what the webhook route writes and what the
 * worker's ledger drains.
 *
 * The interesting property is not the storage but the consuming -- an event
 * folded twice is a failure charged twice, so `take` must empty the table in
 * the same transaction that reads it, and rows too old to fold safely must be
 * dropped rather than delivered.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  afterEach(() => store.close());

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
});
