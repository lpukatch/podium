/**
 * CLI entrypoint for running only the worker.
 *
 * The single-container image starts the loop in-process via src/entry.ts; this
 * exists for anyone who wants the worker on its own, and for local development.
 */

import { loadConfig } from '../lib/config';
import { ensureRulesFile } from '../lib/rules';
import { buildRunner, startWorker } from './loop';

const log = (message: string): void => {
  console.log(`${new Date().toISOString()} ${message}`);
};

async function main(): Promise<number> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    log(`configuration error: ${String(error)}`);
    return 2;
  }

  if (ensureRulesFile(config.rulesPath)) {
    log(`created an empty rules file at ${config.rulesPath}`);
  }

  if (config.PODIUM_RUN_ONCE) {
    const { runner, store } = buildRunner(config, log);
    try {
      console.log(JSON.stringify(await runner.runOnce(), null, 2));
    } finally {
      store.close();
    }
    return 0;
  }

  // Never fails on a held lock any more: `startWorker` waits for it and starts
  // passing when it comes free, so this process stays up either way.
  const stop = await startWorker(config, log);

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string) => {
      log(`${signal} received, shutting down`);
      stop();
      resolve();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  });
  log('shut down cleanly');
  return 0;
}

main().then((code) => process.exit(code));
