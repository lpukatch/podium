import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Vitest's run-mode default is one worker per core the OS reports. Inside a
    // CI container that is the host's core count, not the job's share, so the
    // suite oversubscribes the runner and trivially fast SQLite tests starve
    // past their 5s timeout. Wall time is bounded by soak.test.ts (~36s of
    // real-time waits in one file), so two workers finish as fast as twelve.
    maxWorkers: process.env.CI ? 2 : undefined,
    // CI runners share a 6-core node with other concurrent jobs (kube CI,
    // kritika), so individual tests can stall seconds on CPU/IO contention
    // even with the worker cap — podium run 1735 lost 19 tests to default
    // 5s/10s timeouts during exactly such a collision. 20s/25s only makes
    // genuinely stuck tests fail slower; contention now absorbs the headroom.
    testTimeout: process.env.CI ? 20_000 : undefined,
    hookTimeout: process.env.CI ? 25_000 : undefined,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/**/*.test.ts', 'src/lib/**/*.d.ts'],
    },
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
});
