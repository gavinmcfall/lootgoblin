export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startOtel } = await import('./otel');
    const { runMigrations } = await import('./db/client');
    const { startWorkers } = await import('./workers/pool');
    const { startScheduler } = await import('./workers/tasks');
    const { logger } = await import('./logger');

    startOtel();

    // ── Config resolution (V2-001-T3) ──────────────────────────────────
    // Must run BEFORE migrations and workers so that DATABASE_URL and other
    // boot-time values are confirmed present. A ConfigurationError here is
    // fatal — the process exits non-zero so Docker / K8s restarts cleanly.
    try {
      const { configResolver } = await import('./config/index');
      await configResolver.resolve();
      logger.info('config resolved');
    } catch (err) {
      process.stderr.write(
        `[lootgoblin] Fatal: config resolution failed — ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }

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
