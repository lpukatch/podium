import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from './eligibility';
import type { ProbeResult } from './probe';
import { checkInputs } from './rule-check-inputs';
import type { Snapshot } from './server/state';
import { Store } from './store';

vi.mock('./server/state', () => ({
  policies: () => new Map([[2, { ...DEFAULT_POLICY, audioOnly: true }]]),
  groupPatterns: () => [],
  ordering: () => undefined,
  channelFloors: () => new Map(),
  channelCeilings: () => new Map(),
}));

describe('checkInputs audio classification', () => {
  it.each([
    [true, 1, true],
    [false, 2, true],
    [false, 1, false],
    [undefined, 1, false],
  ])('resolves isRadio=%s group=%s to audioOnly=%s', (isRadio, groupId, expected) => {
    const store = new Store(':memory:');
    try {
      for (const id of [1, 2]) {
        store.put(id, 'h', { alive: true, bitrateKbps: 128, audioCodec: 'aac' } as ProbeResult);
      }
      const snap = {
        channels: [{ id: 1, name: 'Channel', groupId, isRadio, streams: [1, 2] }],
        streams: [1, 2].map((id) => ({ id, name: `Stream ${id}`, providerId: 1, groupId })),
        providers: [{ id: 1, name: 'Provider' }],
        groups: [
          { id: 1, name: 'General' },
          { id: 2, name: 'Audio' },
        ],
        fetchedAt: Date.now(),
      } as Snapshot;
      expect(checkInputs(snap, store).channels[0]?.audioOnly).toBe(expected);
    } finally {
      store.close();
    }
  });
});
