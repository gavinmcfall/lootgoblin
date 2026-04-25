export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startOtel } = await import('./otel');
    const { runMigrations } = await import('./db/client');
    const { startWorkers, stopWorkers } = await import('./workers/pool');
    const { startIngestWorker, stopIngestWorker } = await import('./workers/ingest-worker');
    const { startWatchlistScheduler, stopWatchlistScheduler } = await import('./workers/watchlist-scheduler');
    const { startWatchlistWorker, stopWatchlistWorker } = await import('./workers/watchlist-worker');
    const { startScheduler } = await import('./workers/tasks');
    const { logger } = await import('./logger');

    startOtel();

    // ── Config resolution (V2-001-T3) ──────────────────────────────────
    // Must run BEFORE migrations and workers so that DATABASE_URL and other
    // boot-time values are confirmed present. A ConfigurationError here is
    // fatal — the process exits non-zero so Docker / K8s restarts cleanly.
    let resolvedInstanceName: string | null = null;
    try {
      const { configResolver } = await import('./config/index');
      await configResolver.resolve();
      resolvedInstanceName = configResolver.get('INSTANCE_NAME') ?? null;
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

    // ── Instance identity bootstrap (V2-001-T6) ────────────────────────
    // Runs after migrations (schema must exist) and after config resolution
    // (we want INSTANCE_NAME if configured). Idempotent — no-op if the row
    // already exists. Failures are non-fatal but logged.
    try {
      const { bootstrapInstanceIdentity } = await import('./identity/index');
      await bootstrapInstanceIdentity(resolvedInstanceName);
      logger.info('instance identity bootstrapped');
    } catch (err) {
      logger.error({ err }, 'instance identity bootstrap failed');
    }

    startWorkers();
    // V2-003-T9 ingest worker — drains ingest_jobs WHERE status='queued'.
    startIngestWorker();
    // V2-004-T3 watchlist scheduler — polls due watchlist_subscriptions and
    // enqueues watchlist_jobs.
    startWatchlistScheduler();
    // V2-004-T4 watchlist worker — drains watchlist_jobs WHERE status='queued',
    // calls SubscribableAdapter.discover(), enqueues child ingest_jobs (which
    // the V2-003 ingest worker then drains).
    startWatchlistWorker();

    const abort = new AbortController();
    startScheduler(abort.signal).catch((err) => logger.error({ err }, 'scheduler crashed'));

    // Graceful shutdown — k8s/Docker send SIGTERM with a grace period before
    // SIGKILL. Stop the worker loops so no job is mid-claim when the process
    // exits, and abort the scheduler so its sleeps don't hang the shutdown.
    const shutdown = (signal: string) => {
      logger.info({ signal }, 'shutdown signal received');
      abort.abort();
      stopWorkers();
      stopIngestWorker();
      stopWatchlistScheduler();
      stopWatchlistWorker();
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }
}
