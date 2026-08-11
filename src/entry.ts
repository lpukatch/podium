/**
 * Single entrypoint: web and worker in one container.
 *
 * Podium ships as one image that does everything, the way a self-hosted app is
 * expected to — `docker run` and it works. Splitting the UI and the worker into
 * separate containers was an artefact of how it was built, not a requirement,
 * and it made the thing awkward to hand to anyone else.
 *
 * Both halves can still be disabled independently (PODIUM_ENABLE_WEB /
 * PODIUM_ENABLE_WORKER) for anyone who does want to scale them apart. The
 * singleton lock in SQLite means running a second worker is safe regardless:
 * it waits for the lock rather than double-probing, and takes over if the
 * holder dies.
 */

import { loadConfig } from './lib/config';
import { ensureRulesFile } from './lib/rules';
import { startWorker } from './worker/loop';

const log = (message: string): void => {
  console.log(`${new Date().toISOString()} ${message}`);
};

async function main(): Promise<void> {
  const config = loadConfig();

  // Do this before either half starts: both read the rules file, and a fresh
  // volume has none. Writing a valid empty one means a first run needs no
  // manual seeding at all.
  const created = ensureRulesFile(config.rulesPath);
  if (created) log(`created an empty rules file at ${config.rulesPath}`);

  // Not fatal. The settings page is how credentials get entered when they are
  // not in the environment, and exiting here takes that page down with it.
  if (!config.hasCredentials) {
    log('no Dispatcharr credentials yet -- open Settings to add them; passes will wait');
  }

  const web = process.env.PODIUM_ENABLE_WEB !== 'false';
  const worker = process.env.PODIUM_ENABLE_WORKER !== 'false';
  if (!web && !worker) {
    log('both PODIUM_ENABLE_WEB and PODIUM_ENABLE_WORKER are false; nothing to do');
    process.exit(2);
  }

  let stopWorker: (() => void) | null = null;
  if (worker) {
    log('starting worker');
    stopWorker = await startWorker(config, log);
  }

  if (web) {
    log(`starting web on :${process.env.PORT ?? 3456}`);
    // Next's standalone server. Required rather than bundled: it is generated
    // at build time and expects to sit at the app root with its own tracing.
    require('./server.js');
  }

  const shutdown = (signal: string) => {
    log(`${signal} received, shutting down`);
    stopWorker?.();
    // Next installs its own signal handling; give both a moment, then go.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  log(`fatal: ${String(error)}`);
  process.exit(1);
});
