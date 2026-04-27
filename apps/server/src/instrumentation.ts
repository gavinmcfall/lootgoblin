export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startOtel } = await import('./otel');
    const { runMigrations } = await import('./db/client');
    const { startWorkers, stopWorkers } = await import('./workers/pool');
    const { startIngestWorker, stopIngestWorker } = await import('./workers/ingest-worker');
    const { startWatchlistScheduler, stopWatchlistScheduler } = await import('./workers/watchlist-scheduler');
    const { startWatchlistWorker, stopWatchlistWorker } = await import('./workers/watchlist-worker');
    const { startChannelRefreshWorker, stopChannelRefreshWorker } = await import(
      './workers/gdrive-channel-refresh-worker'
    );
    const { startForgeClaimWorker, stopForgeClaimWorker } = await import(
      './workers/forge-claim-worker'
    );
    const { startForgeConverterWorker, stopForgeConverterWorker } = await import(
      './workers/forge-converter-worker'
    );
    const { startForgeSlicerWorker, stopForgeSlicerWorker } = await import(
      './workers/forge-slicer-worker'
    );
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

    // ── Forge central_worker bootstrap (V2-005a-T2) ────────────────────
    // Ensures the in-process central_worker Agent row exists. Runs after
    // migrations (schema must exist) and after instance-identity bootstrap
    // (so logs show identity context first). Idempotent — no-op if the row
    // already exists. Failures are non-fatal — the future Forge claim loop
    // (V2-005a-T4) will re-run the bootstrap on its own startup.
    try {
      const { bootstrapCentralWorker } = await import('./forge/agent-bootstrap');
      const result = await bootstrapCentralWorker();
      if (result.created) {
        logger.info({ agentId: result.agentId }, 'forge central_worker bootstrapped');
      }
    } catch (err) {
      logger.error({ err }, 'forge central_worker bootstrap failed');
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
    // V2-004b-T3 gdrive channel refresh worker — refreshes
    // gdrive_watch_channels rows ~2 days before their 7-day TTL elapses.
    // Runs as a fire-and-forget loop; failures inside the loop are logged
    // and do not propagate.
    void startChannelRefreshWorker().catch((err) =>
      logger.error({ err }, 'gdrive-channel-refresh: loop crashed'),
    );
    // V2-005a-T4 forge claim worker — drains dispatch_jobs WHERE status='claimable'
    // for the in-process central_worker agent. Stub dispatcher today; V2-005d/e
    // inject real printer/slicer dispatch handlers.
    void startForgeClaimWorker().catch((err) =>
      logger.error({ err }, 'forge-claim-worker crashed'),
    );
    // V2-005b-T_b4 forge converter worker — drains dispatch_jobs WHERE
    // status='pending' and runs format conversion (sharp/7z/Blender), then
    // transitions pending → converting → claimable. Failures land on
    // 'failed' with reason='conversion-failed' or 'unsupported-format'.
    void startForgeConverterWorker().catch((err) =>
      logger.error({ err }, 'forge-converter-worker crashed'),
    );
    // V2-005c-T_c10 forge slicer worker — drains dispatch_jobs WHERE
    // status='slicing' and runs the Prusa-fork SlicerAdapter against a
    // materialized Grimoire profile. On success: writes a forge_artifacts
    // gcode row + transitions slicing → claimable. On failure: maps the
    // adapter reason to a DispatchFailureReason and markFailed.
    startForgeSlicerWorker();

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
      stopChannelRefreshWorker();
      stopForgeClaimWorker();
      stopForgeConverterWorker();
      stopForgeSlicerWorker();
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }
}
