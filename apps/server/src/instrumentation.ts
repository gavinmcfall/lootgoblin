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
    // V2-005d-a-T_da6 — register protocol-specific DispatchHandlers in the
    // process-singleton registry BEFORE the claim worker's first tick. The
    // worker's default dispatcher resolves printer.kind → handler via this
    // registry; missing-kind fails the dispatch_job with reason
    // 'unsupported-format' (mapped from the adapter-level 'unsupported-protocol').
    try {
      const { getDefaultRegistry } = await import('./forge/dispatch/registry');
      const { createMoonrakerHandler } = await import(
        './forge/dispatch/moonraker/adapter'
      );
      const { createOctoprintHandler } = await import(
        './forge/dispatch/octoprint/adapter'
      );
      const { createBambuLanHandler } = await import(
        './forge/dispatch/bambu/adapter'
      );
      const { BAMBU_LAN_KINDS } = await import('./forge/dispatch/bambu/types');
      const { createSdcpHandler } = await import('./forge/dispatch/sdcp/adapter');
      const { SDCP_KINDS } = await import('./forge/dispatch/sdcp/types');
      const { createChituNetworkHandler } = await import(
        './forge/dispatch/chitu-network/adapter'
      );
      const { CHITU_NETWORK_KINDS } = await import(
        './forge/dispatch/chitu-network/types'
      );
      const dispatchRegistry = getDefaultRegistry();
      const moonrakerHandler = createMoonrakerHandler();
      dispatchRegistry.register(moonrakerHandler);
      dispatchRegistry.register(createOctoprintHandler());
      // V2-005d-b-T_db4: register the Bambu LAN handler against all 13 per-model
      // kinds. One adapter, one dispatch logic, 13 registry entries — operator
      // UI distinguishes printer models (BAMBU_MODEL_CAPABILITIES) but the
      // dispatch path converges on a single MQTT+FTPS implementation. The
      // adapter exposes a sentinel kind ('fdm_bambu_lan') internally; we wrap
      // it once per per-model kind so registry routing works without the
      // worker needing protocol knowledge.
      const bambuHandler = createBambuLanHandler();
      for (const kind of BAMBU_LAN_KINDS) {
        dispatchRegistry.register({
          kind,
          dispatch: bambuHandler.dispatch.bind(bambuHandler),
        });
      }
      // V2-005d-c-T_dc10: register the SDCP handler against all 8 SDCP kinds
      // (Elegoo Saturn 4 Ultra family + Mars 5 Ultra). One adapter, one
      // WebSocket+upload+job-control implementation, fanned out per per-model
      // kind so operator UI can distinguish models while the dispatch path
      // converges.
      const sdcpHandler = createSdcpHandler();
      for (const kind of SDCP_KINDS) {
        dispatchRegistry.register({
          kind,
          dispatch: sdcpHandler.dispatch.bind(sdcpHandler),
        });
      }
      // V2-005d-c-T_dc10: register the ChituNetwork handler against all 7
      // ChituNetwork kinds (Anycubic Photon Mono X / M3 / M5 / M5s / M7 Pro
      // family). Same fan-out pattern as SDCP/Bambu — single HTTP-API
      // implementation, per-model registry entries.
      const chituHandler = createChituNetworkHandler();
      for (const kind of CHITU_NETWORK_KINDS) {
        dispatchRegistry.register({
          kind,
          dispatch: chituHandler.dispatch.bind(chituHandler),
        });
      }
      // V2-005d-c-T_dc10: V2-005d-a Moonraker registry expansion — register
      // the existing Moonraker handler against 2 new FDM Klipper per-model
      // kinds (Phrozen ARCO + Elegoo Centauri Carbon). Both are FDM Klipper-
      // based printers caught during V2-005d-c research as needing per-model
      // classification. They reuse the V2-005d-a Moonraker dispatcher
      // unchanged — operator UI gets distinct kind tags while dispatch
      // converges on the existing implementation.
      const FDM_KLIPPER_NEW_KINDS = [
        'fdm_klipper_phrozen_arco',
        'fdm_klipper_elegoo_centauri_carbon',
      ] as const;
      for (const kind of FDM_KLIPPER_NEW_KINDS) {
        dispatchRegistry.register({
          kind,
          dispatch: moonrakerHandler.dispatch.bind(moonrakerHandler),
        });
      }
      logger.info(
        { kinds: dispatchRegistry.list().map((h) => h.kind) },
        'forge.dispatch: handlers registered',
      );
    } catch (err) {
      logger.error({ err }, 'forge.dispatch: handler registration failed');
    }
    // V2-005f-T_dcf9 / T_dcf10 forge status worker — lazy-starts per-printer
    // status subscribers when dispatches enter 'dispatched', persists every
    // emitted StatusEvent to dispatch_status_events, and atomically transitions
    // dispatch_jobs.status='dispatched' → 'completed' | 'failed' on terminal
    // events. Recovers in-flight prints across restarts.
    let forgeStatusWorker:
      | Awaited<ReturnType<typeof import('./workers/forge-status-worker').createForgeStatusWorker>>
      | null = null;
    try {
      const { getDefaultSubscriberRegistry } = await import(
        './forge/status/registry'
      );
      const { createMoonrakerSubscriber } = await import(
        './forge/status/subscribers/moonraker'
      );
      const { createOctoprintSubscriber } = await import(
        './forge/status/subscribers/octoprint'
      );
      const { createBambuSubscriber } = await import(
        './forge/status/subscribers/bambu'
      );
      const { createSdcpSubscriber } = await import(
        './forge/status/subscribers/sdcp'
      );
      const { createChituNetworkSubscriber } = await import(
        './forge/status/subscribers/chitu-network'
      );
      const { BAMBU_LAN_KINDS } = await import('./forge/dispatch/bambu/types');
      const { SDCP_KINDS } = await import('./forge/dispatch/sdcp/types');
      const { CHITU_NETWORK_KINDS } = await import(
        './forge/dispatch/chitu-network/types'
      );
      const { createStatusEventSink } = await import(
        './forge/status/status-event-handler'
      );
      const { emitConsumptionForCompletion } = await import(
        './forge/status/consumption-emitter'
      );
      const { createForgeStatusWorker } = await import(
        './workers/forge-status-worker'
      );
      // V2-005f-T_dcf12: in-memory pub/sub for live SSE consumers. The status
      // sink calls `bus.emit` on every event; SSE handlers at
      // /api/v1/forge/dispatch/:id/status/stream subscribe per dispatch.
      const { getDefaultStatusEventBus } = await import(
        './forge/status/event-bus'
      );
      const statusEventBus = getDefaultStatusEventBus();

      const subRegistry = getDefaultSubscriberRegistry();
      // Klipper-via-Moonraker: legacy + per-model FDM kinds.
      subRegistry.register('fdm_klipper', {
        create: () => createMoonrakerSubscriber({}),
      });
      subRegistry.register('fdm_klipper_phrozen_arco', {
        create: () => createMoonrakerSubscriber({}),
      });
      subRegistry.register('fdm_klipper_elegoo_centauri_carbon', {
        create: () => createMoonrakerSubscriber({}),
      });
      // OctoPrint.
      subRegistry.register('fdm_octoprint', {
        create: () => createOctoprintSubscriber({}),
      });
      // Bambu LAN — one entry per per-model kind, all delegating to the
      // same protocol implementation.
      for (const kind of BAMBU_LAN_KINDS) {
        subRegistry.register(kind, {
          create: () =>
            createBambuSubscriber({ printerKind: kind }),
        });
      }
      // SDCP — same fan-out.
      for (const kind of SDCP_KINDS) {
        subRegistry.register(kind, {
          create: () => createSdcpSubscriber({ printerKind: kind }),
        });
      }
      // ChituNetwork — same fan-out.
      for (const kind of CHITU_NETWORK_KINDS) {
        subRegistry.register(kind, {
          create: () => createChituNetworkSubscriber({ printerKind: kind }),
        });
      }

      // Build the worker first so we can pass `notifyTerminal` into the sink
      // without a circular dep (sink → worker → sink).
      // eslint-disable-next-line prefer-const
      let workerRef: ReturnType<typeof createForgeStatusWorker>;
      const statusEventSink = createStatusEventSink({
        deps: {
          notifyTerminal: (args) => workerRef.notifyTerminal(args),
          // V2-005f-T_dcf11: bridge terminal-completed events into V2-007a's
          // consumption ledger. Phase B emits one `material.consumed` ledger
          // event per AMS slot (provenance='measured') using the
          // event.measuredConsumption signal + cached materials_used. Phase A
          // (estimated) is emitted at dispatch time by the claim worker.
          emitConsumption: async ({ dispatchJobId, event }) => {
            await emitConsumptionForCompletion({ dispatchJobId, event });
          },
          // V2-005f-T_dcf12: live broadcast every persisted event to SSE
          // subscribers (one Set<listener> per dispatchJobId in the bus).
          emitToBus: (dispatchJobId, event) => {
            statusEventBus.emit(dispatchJobId, event);
          },
        },
      });
      workerRef = createForgeStatusWorker({
        registry: subRegistry,
        onEvent: (printerId, event) => {
          void statusEventSink(printerId, event);
        },
      });
      forgeStatusWorker = workerRef;
      // Boot recovery — replay every dispatched/printer-target row.
      try {
        await workerRef.recover();
      } catch (err) {
        logger.error({ err }, 'forge-status: recover() threw on boot');
      }
      logger.info(
        { kinds: subRegistry.list() },
        'forge.status: subscribers registered',
      );
    } catch (err) {
      logger.error({ err }, 'forge.status: worker setup failed');
    }

    // V2-005a-T4 forge claim worker — drains dispatch_jobs WHERE status='claimable'
    // for the in-process central_worker agent. Default dispatcher routes
    // printer-target jobs through the DispatchHandlerRegistry registered above;
    // slicer-target jobs stay on the stub until V2-005e.
    // V2-005f-T_dcf10: pass the status worker's notifyDispatched as the
    // onJobDispatched hook so per-printer status subscribers lazy-start as
    // soon as a dispatch reaches 'dispatched'.
    void startForgeClaimWorker({
      onJobDispatched: forgeStatusWorker
        ? (args) => forgeStatusWorker!.notifyDispatched(args)
        : undefined,
    }).catch((err) =>
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
      // V2-005f-T_dcf10: tear down per-printer status subscriptions so the
      // process can exit cleanly. Fire-and-forget — graceful-shutdown timing
      // is owned by the orchestrator.
      if (forgeStatusWorker) {
        void forgeStatusWorker.stop().catch((err: unknown) =>
          logger.warn({ err }, 'forge-status: stop threw on shutdown'),
        );
      }
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }
}
