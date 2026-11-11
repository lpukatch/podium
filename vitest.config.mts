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
