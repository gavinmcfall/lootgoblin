export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startOtel } = await import('./otel');
    const { runMigrations } = await import('./db/client');
    const { startWorkers } = await import('./workers/pool');
    const { startScheduler } = await import('./workers/tasks');
    const { logger } = await import('./logger');

    startOtel();

    // Run migrations before anything touches the DB. Workers start immediately
    // and will crash on a fresh schema if we skip this — especially in Docker
    // first-boot. Failures are fatal: without schema, nothing downstream works.
    try {
      await runMigrations();
      logger.info('migrations ran');
    } catch (err) {
      logger.error({ err }, 'migrations failed');
      throw err;
    }

    startWorkers();

    const abort = new AbortController();
    startScheduler(abort.signal).catch((err) => logger.error({ err }, 'scheduler crashed'));
  }
}
