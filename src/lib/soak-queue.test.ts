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
    expect(store.pendingSoakCount()).toBe(0);
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
    expect(store.pendingSoakCount()).toBe(2);
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
    expect(store.pendingSoakCount()).toBe(0);
  });

  it('writes nothing for an empty request', () => {
    expect(store.queueSoaks([])).toBe(0);
    expect(store.clearSoaks([])).toBe(0);
  });
});
