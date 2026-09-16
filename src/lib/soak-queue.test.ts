/**
 * The soak queue: what a button writes and what a pass drains.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store';

describe('the soak queue', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => store.close());

  it('starts empty', () => {
    expect(store.pendingSoakCount()).toEqual({ total: 0, manual: 0, now: 0, sweep: 0 });
    expect(store.pendingSoaks()).toEqual([]);
  });

  it('queues streams with the channel they came from', () => {
    expect(
      store.queueSoaks([
        { streamId: 1, channelId: 10 },
        { streamId: 2, channelId: 10 },
      ]),
    ).toBe(2);
    expect(store.pendingSoaks()).toMatchObject([
      { streamId: 1, channelId: 10, source: 'manual' },
      { streamId: 2, channelId: 10, source: 'manual' },
    ]);
  });

  it('is idempotent per stream, so a group and its channel do not double up', () => {
    store.queueSoaks([{ streamId: 1, channelId: 10 }]);
    expect(store.queueSoaks([{ streamId: 1, channelId: 10 }, { streamId: 2 }])).toBe(1);
    expect(store.pendingSoakCount().total).toBe(2);
  });

  it('keeps a re-queued stream in its original place rather than sending it to the back', () => {
    store.queueSoaks([{ streamId: 1 }]);
    store.queueSoaks([{ streamId: 2 }]);
    store.queueSoaks([{ streamId: 1 }]);
    // Pressing the button twice must not starve the earlier request.
    expect(store.pendingSoaks().map((r) => r.streamId)).toEqual([1, 2]);
  });

  it('records where a request came from', () => {
    store.queueSoaks([{ streamId: 1 }], 'sweep');
    expect(store.pendingSoaks()[0]?.source).toBe('sweep');
  });

  it('counts the two sources apart, because they drain at different times', () => {
    store.queueSoaks([{ streamId: 1 }, { streamId: 2 }], 'manual');
    store.queueSoaks([{ streamId: 3 }], 'sweep');
    expect(store.pendingSoakCount()).toEqual({ total: 3, manual: 2, now: 0, sweep: 1 });
  });

  it('hands back only the manual rows when the window is shut', () => {
    // How the window is enforced on the queue rather than only on the planner:
    // "soak everything" is queued as a sweep and waits for the hours, where a
    // request about one channel runs whenever there is capacity.
    store.queueSoaks([{ streamId: 1 }], 'sweep');
    store.queueSoaks([{ streamId: 2 }], 'manual');
    expect(store.pendingSoaks(10, { excludeSweep: true }).map((r) => r.streamId)).toEqual([2]);
    expect(store.pendingSoaks(10).map((r) => r.streamId)).toEqual([1, 2]);
  });

  it('drains oldest first and respects a limit', () => {
    store.queueSoaks([{ streamId: 3 }, { streamId: 1 }, { streamId: 2 }]);
    expect(store.pendingSoaks(2)).toHaveLength(2);
  });

  it('clears spent requests by stream', () => {
    store.queueSoaks([{ streamId: 1 }, { streamId: 2 }, { streamId: 3 }]);
    expect(store.clearSoaks([1, 3])).toBe(2);
    expect(store.pendingSoaks().map((r) => r.streamId)).toEqual([2]);
  });

  it('clears the whole queue when asked', () => {
    store.queueSoaks([{ streamId: 1 }, { streamId: 2 }]);
    expect(store.clearSoaks()).toBe(2);
    expect(store.pendingSoakCount().total).toBe(0);
  });

  it('writes nothing for an empty request', () => {
    expect(store.queueSoaks([])).toBe(0);
    expect(store.clearSoaks([])).toBe(0);
  });
});

describe('a baseline run', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => store.close());

  it('drains whatever the window says, unlike a sweep', () => {
    store.queueSoaks([{ streamId: 1 }], 'now');
    store.queueSoaks([{ streamId: 2 }], 'sweep');
    // `excludeSweep` is what a shut window asks for: the baseline run is still
    // handed over, the ordinary sweep is not.
    expect(store.pendingSoaks(10, { excludeSweep: true }).map((r) => r.streamId)).toEqual([1]);
  });

  it('is counted apart from the other two', () => {
    store.queueSoaks([{ streamId: 1 }], 'now');
    store.queueSoaks([{ streamId: 2 }], 'manual');
    store.queueSoaks([{ streamId: 3 }], 'sweep');
    expect(store.pendingSoakCount()).toEqual({ total: 3, manual: 1, now: 1, sweep: 1 });
  });

  it('carries its own length', () => {
    store.queueSoaks([{ streamId: 1, seconds: 60 }], 'now');
    expect(store.pendingSoaks()[0]?.seconds).toBe(60);
  });

  it('means the setting when it carries no length', () => {
    store.queueSoaks([{ streamId: 1 }], 'manual');
    expect(store.pendingSoaks()[0]?.seconds).toBeNull();
  });

  it('promotes a stream a sweep had already queued', () => {
    // The regression this guards: on a settled install the nightly sweep has
    // already queued most of the catalogue, so a baseline run that skipped
    // rows already present would silently do almost nothing.
    store.queueSoaks([{ streamId: 1 }], 'sweep');
    store.queueSoaks([{ streamId: 1, seconds: 60 }], 'now');
    const [row] = store.pendingSoaks();
    expect(row?.source).toBe('now');
    expect(row?.seconds).toBe(60);
    expect(store.pendingSoakCount().total).toBe(1);
  });

  it('does not demote a baseline row back to a sweep', () => {
    store.queueSoaks([{ streamId: 1 }], 'now');
    store.queueSoaks([{ streamId: 1 }], 'sweep');
    expect(store.pendingSoaks()[0]?.source).toBe('now');
  });
});

describe('the queue version the heartbeat wakes on', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => store.close());

  it('changes when a stream is queued', () => {
    const before = store.soakQueueVersion();
    store.queueSoaks([{ streamId: 1 }]);
    expect(store.soakQueueVersion()).not.toBe(before);
  });

  it('changes when a waiting stream is promoted to a baseline run', () => {
    // The case the newest queue time alone would miss: a promotion keeps the
    // row's place, so every queued_at stays put -- and that is exactly what
    // "Start now" does on a settled install.
    store.queueSoaks([{ streamId: 1 }], 'sweep');
    const before = store.soakQueueVersion();
    store.queueSoaks([{ streamId: 1 }], 'now');
    expect(store.soakQueueVersion()).not.toBe(before);
  });

  it('does not change when nothing new was asked for', () => {
    store.queueSoaks([{ streamId: 1 }]);
    const before = store.soakQueueVersion();
    store.queueSoaks([{ streamId: 1 }]);
    expect(store.soakQueueVersion()).toBe(before);
  });

  it('is stable on an empty queue', () => {
    expect(store.soakQueueVersion()).toBe(store.soakQueueVersion());
  });
});
