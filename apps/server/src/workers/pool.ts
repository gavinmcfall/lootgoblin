import { env } from '../env';
import { runWorkerLoop } from './worker';
import { logger } from '../logger';

let abort: AbortController | null = null;

export function startWorkers(): void {
  if (abort) return;
  abort = new AbortController();
  for (let i = 0; i < env.WORKER_CONCURRENCY; i++) {
    runWorkerLoop(abort.signal).catch((err) => logger.error({ err }, 'worker crashed'));
  }
  logger.info({ workers: env.WORKER_CONCURRENCY }, 'workers started');
}

export function stopWorkers(): void {
  abort?.abort();
  abort = null;
}
