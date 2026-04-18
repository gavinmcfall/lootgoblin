export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startOtel } = await import('./otel');
    const { startWorkers } = await import('./workers/pool');
    const { startScheduler } = await import('./workers/tasks');
    const { logger } = await import('./logger');

    startOtel();
    startWorkers();

    const abort = new AbortController();
    startScheduler(abort.signal).catch((err) => logger.error({ err }, 'scheduler crashed'));
  }
}
