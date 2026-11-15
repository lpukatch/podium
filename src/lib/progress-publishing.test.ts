import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import { RulesSource } from './rules-source';
import { Runner } from './runner';
import type { Progress } from './store';
import { Store } from './store';

afterEach(() => vi.useRealTimers());

describe('probe progress publishing', () => {
  it('bounds rapid writes, publishes the latest counters, and flushes phase transitions', () => {
    vi.useFakeTimers();
    const store = new Store(':memory:');
    try {
      const runner = new Runner({
        config: () => loadConfig({}),
        store,
        rules: new RulesSource('/tmp/no-podium-rules.json'),
      });
      const emit = (patch: Partial<Progress>) => Reflect.get(runner, 'emit').call(runner, patch);
      const writes = vi.spyOn(store, 'setProgress');
      emit({ phase: 'probing', probed: 0 });
      for (let probed = 1; probed <= 20; probed++) emit({ probed });
      expect(writes).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(250);
      expect(writes).toHaveBeenCalledTimes(2);
      expect(store.getProgress().probed).toBe(20);
      emit({ probed: 21 });
      emit({ phase: 'done', probed: 22 });
      expect(store.getProgress()).toMatchObject({ phase: 'done', probed: 22 });
      const count = writes.mock.calls.length;
      vi.advanceTimersByTime(500);
      expect(writes).toHaveBeenCalledTimes(count);
    } finally {
      store.close();
    }
  });
});
