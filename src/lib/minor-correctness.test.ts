import { describe, expect, it } from 'vitest';
import { Store } from './store';

describe('MR 5 - Minor Correctness & Observability Tests', () => {
  it('prevents accidental cache wipe in Store.pruneOutside when keep set is tiny relative to cache size', () => {
    const store = new Store(':memory:');
    for (let i = 1; i <= 100; i++) {
      store.put(i, `hash-${i}`, {
        alive: true,
        width: 1920,
        height: 1080,
        fps: 60,
        videoCodec: 'h264',
        audioCodec: 'aac',
        pixelFormat: 'yuv420p',
        audioChannels: 2,
        channelLayout: 'stereo',
        bitrateKbps: 5000,
        bitrateMeasured: true,
        elapsedMs: 100,
        error: '',
      });
    }

    // Attempting to prune with only 5 streams (< 20% of 100) should be blocked by the sanity check
    const pruned = store.pruneOutside(new Set([1, 2, 3, 4, 5]));
    expect(pruned).toBe(0);

    // Verifies all rows are preserved
    expect(store.entry(50, 'hash-50')).not.toBeNull();
  });

  it('records expanded run metrics in Store.finishRun', () => {
    const store = new Store(':memory:');
    const runId = 'test-run-1';
    store.startRun(runId);

    store.finishRun(runId, {
      channels: 100,
      probed: 10,
      cached: 80,
      dead: 2,
      reordered: 5,
      unchanged: 75,
      deferred: 3,
      backlog: 15,
      nextDueAt: 1234567890,
      oldestProbedAt: 1234500000,
    });

    const recent = store.recentRuns(1);
    expect(recent.length).toBe(1);
    expect(recent[0]?.unchanged).toBe(75);
    expect(recent[0]?.deferred).toBe(3);
    expect(recent[0]?.backlog).toBe(15);
    expect(recent[0]?.next_due_at).toBe(1234567890);
    expect(recent[0]?.oldest_probed_at).toBe(1234500000);
  });
});
