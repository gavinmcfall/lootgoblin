/**
 * status-event-handler.ts — V2-005f-T_dcf10
 *
 * Wires the per-printer status feed (T_dcf3–8 subscribers + T_dcf9 worker)
 * to the persistence layer:
 *
 *   1. INSERT every emitted StatusEvent into `dispatch_status_events` (audit
 *      trail; one row per event; protocol-native payload preserved as JSON).
 *   2. UPDATE `dispatch_jobs.last_status_at` + `progress_pct` cache columns
 *      so cheap UI reads don't need to scan the event log.
 *   3. On terminal events (`completed` / `failed`), atomically transition
 *      `dispatch_jobs.status='dispatched' → 'completed' | 'failed'` via the
 *      V2-005a-T3 `markCompleted` / `markFailed` state-machine functions —
 *      reusing their UPDATE-with-WHERE-status guard. Wrong-state outcomes
 *      (already terminal via reconnect storm or operator override) are
 *      tolerated: log warn but don't fail the event handling.
 *   4. After successful terminal transition + on `completed` only, invoke
 *      `deps.emitConsumption` (T_dcf11 plugs in here).
 *   5. On every event, invoke `deps.emitToBus` (T_dcf12 plugs in here for
 *      live SSE broadcast).
 *   6. After the terminal transition is recorded, invoke `deps.notifyTerminal`
 *      so the status worker can begin the teardown grace timer for the
 *      printer's subscription.
 *
 * Correlation. The status worker emits `(printerId, event)`; the sink must
 * resolve a `dispatch_job_id` before it can persist anything. The default
 * correlator queries `dispatch_jobs WHERE target_kind='printer' AND
 * target_id=printerId AND status IN ('dispatched','claimed')` ordered by
 * createdAt DESC. When `event.remoteJobRef` is non-empty, we narrow to jobs
 * whose related loot_files row's path basename matches the remote ref
 * (fall through to most-recent if no match). Empty remoteJobRef → most
 * recent active dispatch on the printer wins. When nothing matches we drop
 * the event with a debug log — no DB writes, no transition.
 *
 * Atomic discipline (V2-005a-T3 / FE-L4 / FF-L18 patterns):
 *   - The terminal transition runs through markCompleted / markFailed which
 *     enforce `WHERE id=? AND status='dispatched'` (or any non-terminal for
 *     failures). The cache-column UPDATE runs unguarded by status — losing
 *     a race against the terminal transition is harmless because both
 *     transitions write disjoint columns; status moves forward independently
 *     and the cache eventually-converges to the latest event's pct/timestamp.
 *
 * Idempotency:
 *   - dispatch_status_events INSERTs are not deduped — duplicate reconnect-
 *     storm events create duplicate rows. T_dcf11's consumption emitter
 *     handles its own idempotency; the audit trail tolerates duplicates.
 *   - Terminal transitions are idempotent at the state-machine level: a
 *     second markCompleted on an already-completed job returns
 *     `{ ok:false, reason:'wrong-state' }` which we log and swallow.
 *   - emitConsumption fires only when markCompleted's transition wins. A
 *     duplicate completed-event therefore won't double-consume.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';

import { logger } from '@/logger';
import { getServerDb, schema } from '@/db/client';
import { markCompleted, markFailed } from '@/forge/dispatch-state';
import type { StatusEvent, StatusSourceProtocol } from './types';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface StatusEventHandlerDeps {
  /** Bus for live SSE broadcast. T_dcf12 wires this; default no-op. */
  emitToBus?: (dispatchJobId: string, event: StatusEvent) => void;
  /**
   * Consumption emitter. T_dcf11 wires this. Called ONLY after a successful
   * `dispatched → completed` transition (failures don't trigger consumption).
   */
  emitConsumption?: (args: {
    dispatchJobId: string;
    event: StatusEvent;
  }) => Promise<void> | void;
  /**
   * Notify the status worker that the dispatch reached a terminal state, so
   * it can start the teardown grace timer for the printer's subscription.
   * Wired in instrumentation.ts to `statusWorker.notifyTerminal`.
   */
  notifyTerminal?: (args: {
    dispatchJobId: string;
    printerId: string;
  }) => Promise<void> | void;
}

export interface CreateStatusEventSinkOpts {
  /**
   * Correlate `(printerId, remoteJobRef)` to a `dispatch_job_id` (or null
   * when no active dispatch matches). Default queries `dispatch_jobs` for
   * the most-recent dispatched/claimed job on the printer, narrowing by
   * remoteJobRef when provided. Tests override.
   */
  correlate?: (args: {
    printerId: string;
    remoteJobRef: string;
    dbUrl?: string;
  }) => Promise<string | null>;
  deps?: StatusEventHandlerDeps;
  /** SQLite URL override for tests. Defaults to `getServerDb()`'s default. */
  dbUrl?: string;
}

export type StatusEventSink = (
  printerId: string,
  event: StatusEvent,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Map a `printers.kind` to the wire `StatusSourceProtocol` used to log the
 * event's `source_protocol` column. Must cover every kind the registry
 * registers a subscriber for. Returns null for unknown kinds (caller logs
 * + drops the event rather than persisting an invalid source_protocol).
 */
export function derivePrinterProtocol(
  kind: string,
): StatusSourceProtocol | null {
  // OctoPrint first — most distinctive prefix.
  if (kind === 'fdm_octoprint') return 'octoprint';

  // Klipper-via-Moonraker (legacy + per-model).
  if (kind === 'fdm_klipper') return 'moonraker';
  if (kind.startsWith('fdm_klipper_')) return 'moonraker';

  // Bambu LAN MQTT — legacy `fdm_bambu_lan` + per-model `bambu_*`.
  if (kind === 'fdm_bambu_lan') return 'bambu_lan';
  if (kind.startsWith('bambu_')) return 'bambu_lan';

  // SDCP 3.0 — legacy `resin_sdcp` + per-model `sdcp_*`.
  if (kind === 'resin_sdcp') return 'sdcp';
  if (kind.startsWith('sdcp_')) return 'sdcp';

  // ChituBox legacy network protocol.
  if (kind.startsWith('chitu_network_')) return 'chitu_network';

  return null;
}

/**
 * Extract the path-basename ("foo.gcode") from a loot_files relative path
 * ("Brand/Color/foo.gcode"). Used by the default correlator to match
 * `event.remoteJobRef` against the printer's known dispatch artifacts.
 */
function basename(p: string): string {
  // loot_files paths use posix separators (V2-002 path-template engine), but
  // tolerate both — adapters that uploaded with Windows-shaped paths
  // shouldn't poison the match.
  const ix = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return ix < 0 ? p : p.slice(ix + 1);
}

// ---------------------------------------------------------------------------
// Default correlator
// ---------------------------------------------------------------------------

/**
 * Resolve `(printerId, remoteJobRef)` to a `dispatch_job_id`.
 *
 *   1. SELECT dispatch_jobs (id, sliced_file_id, converted_file_id) WHERE
 *      target_kind='printer' AND target_id=printerId AND status IN
 *      ('dispatched','claimed') ORDER BY created_at DESC.
 *   2. If `remoteJobRef` is non-empty, fetch the loot_files rows for the
 *      candidates' sliced/converted file ids and narrow to the candidate
 *      whose basename matches `remoteJobRef`. Falls through to the most
 *      recent candidate if no basename match is found (e.g. Bambu MQTT
 *      uses `sequence_id`, not the filename).
 *   3. If `remoteJobRef` is empty, pick the most recent candidate.
 *
 * Returns null when no candidate exists.
 */
export async function correlateDispatchByPrinter(args: {
  printerId: string;
  remoteJobRef: string;
  dbUrl?: string;
}): Promise<string | null> {
  const db = getServerDb(args.dbUrl);

  const candidates = await db
    .select({
      id: schema.dispatchJobs.id,
      slicedFileId: schema.dispatchJobs.slicedFileId,
      convertedFileId: schema.dispatchJobs.convertedFileId,
      createdAt: schema.dispatchJobs.createdAt,
    })
    .from(schema.dispatchJobs)
    .where(
      and(
        eq(schema.dispatchJobs.targetKind, 'printer'),
        eq(schema.dispatchJobs.targetId, args.printerId),
        inArray(schema.dispatchJobs.status, ['dispatched', 'claimed']),
      ),
    )
    .orderBy(desc(schema.dispatchJobs.createdAt));

  if (candidates.length === 0) return null;

  if (!args.remoteJobRef) {
    return candidates[0]!.id;
  }

  // Narrow by filename match. Collect every loot_file id referenced by the
  // candidates, fetch their paths in one query, then map back.
  const fileIds = new Set<string>();
  for (const c of candidates) {
    if (c.slicedFileId) fileIds.add(c.slicedFileId);
    if (c.convertedFileId) fileIds.add(c.convertedFileId);
  }
  if (fileIds.size === 0) {
    // No artifacts attached yet — fall back to most-recent.
    return candidates[0]!.id;
  }

  const files = await db
    .select({
      id: schema.lootFiles.id,
      path: schema.lootFiles.path,
    })
    .from(schema.lootFiles)
    .where(inArray(schema.lootFiles.id, Array.from(fileIds)));

  const basenameById = new Map<string, string>();
  for (const f of files) {
    basenameById.set(f.id, basename(f.path));
  }

  for (const c of candidates) {
    const slicedBn = c.slicedFileId
      ? basenameById.get(c.slicedFileId)
      : undefined;
    const convertedBn = c.convertedFileId
      ? basenameById.get(c.convertedFileId)
      : undefined;
    if (
      (slicedBn && slicedBn === args.remoteJobRef) ||
      (convertedBn && convertedBn === args.remoteJobRef)
    ) {
      return c.id;
    }
  }

  // No basename match — fall through to most-recent dispatched candidate.
  return candidates[0]!.id;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist a single `(printerId, dispatchJobId, event)` triple:
 *   1. INSERT a `dispatch_status_events` row.
 *   2. UPDATE the `dispatch_jobs` cache columns (`last_status_at`,
 *      `progress_pct`).
 *
 * Returns the inserted event id (caller-side for tracing — currently unused
 * but useful for audit).
 */
export async function persistStatusEvent(args: {
  printerId: string;
  dispatchJobId: string;
  printerKind: string;
  event: StatusEvent;
  dbUrl?: string;
}): Promise<string> {
  const db = getServerDb(args.dbUrl);
  const sourceProtocol = derivePrinterProtocol(args.printerKind);
  if (!sourceProtocol) {
    // Caller should have filtered, but be defensive — the schema column has
    // an app-layer enum; we won't poison the DB with an invalid protocol.
    throw new Error(
      `derivePrinterProtocol returned null for kind='${args.printerKind}'`,
    );
  }

  const id = randomUUID();
  const now = new Date();
  const eventData = {
    progressPct: args.event.progressPct ?? null,
    layerNum: args.event.layerNum ?? null,
    totalLayers: args.event.totalLayers ?? null,
    remainingMin: args.event.remainingMin ?? null,
    measuredConsumption: args.event.measuredConsumption ?? null,
    remoteJobRef: args.event.remoteJobRef,
    rawPayload: args.event.rawPayload ?? null,
  };

  await db.insert(schema.dispatchStatusEvents).values({
    id,
    dispatchJobId: args.dispatchJobId,
    eventKind: args.event.kind,
    eventData: JSON.stringify(eventData),
    sourceProtocol,
    occurredAt: args.event.occurredAt,
    ingestedAt: now,
  });

  // Cache column update — unguarded by status. progressPct is only set when
  // the event reports it; otherwise we still bump last_status_at so the UI
  // sees liveness.
  const cachePatch: { lastStatusAt: Date; progressPct?: number } = {
    lastStatusAt: now,
  };
  if (typeof args.event.progressPct === 'number') {
    // Clamp to 0..100 — hostile / buggy upstreams shouldn't push 250%.
    cachePatch.progressPct = Math.max(
      0,
      Math.min(100, Math.round(args.event.progressPct)),
    );
  }
  // Use `.run()` (sync) for parity with dispatch-state.ts — cheap, no
  // transaction needed.
  (db
    .update(schema.dispatchJobs)
    .set(cachePatch)
    .where(eq(schema.dispatchJobs.id, args.dispatchJobId)) as unknown as {
    run: () => unknown;
  }).run();

  return id;
}

// ---------------------------------------------------------------------------
// Sink factory
// ---------------------------------------------------------------------------

/**
 * Build the worker-facing event sink. Returns a `StatusEventSink` callable
 * the worker passes as its `onEvent` option (forge-status-worker.ts).
 */
export function createStatusEventSink(
  opts: CreateStatusEventSinkOpts = {},
): StatusEventSink {
  const correlate = opts.correlate ?? correlateDispatchByPrinter;
  const deps = opts.deps ?? {};

  return async function sink(
    printerId: string,
    event: StatusEvent,
  ): Promise<void> {
    // 1) Correlate to a dispatch_job_id.
    let dispatchJobId: string | null;
    try {
      dispatchJobId = await correlate({
        printerId,
        remoteJobRef: event.remoteJobRef,
        dbUrl: opts.dbUrl,
      });
    } catch (err) {
      logger.error(
        { err, printerId, remoteJobRef: event.remoteJobRef, kind: event.kind },
        'forge-status-sink: correlate threw — dropping event',
      );
      return;
    }
    if (!dispatchJobId) {
      logger.info(
        { printerId, remoteJobRef: event.remoteJobRef, kind: event.kind },
        'forge-status-sink: no active dispatch matched — dropping event',
      );
      return;
    }

    // 2) Look up printer.kind so we can derive source_protocol.
    const db = getServerDb(opts.dbUrl);
    const printerRows = await db
      .select({ kind: schema.printers.kind })
      .from(schema.printers)
      .where(eq(schema.printers.id, printerId))
      .limit(1);
    const printerKind = printerRows[0]?.kind;
    if (!printerKind) {
      logger.warn(
        { printerId, dispatchJobId, kind: event.kind },
        'forge-status-sink: printer row vanished — dropping event',
      );
      return;
    }
    if (!derivePrinterProtocol(printerKind)) {
      logger.warn(
        { printerId, printerKind, dispatchJobId },
        'forge-status-sink: cannot derive source_protocol from printer.kind — dropping event',
      );
      return;
    }

    // 3) Persist (INSERT status event + UPDATE cache columns).
    try {
      await persistStatusEvent({
        printerId,
        dispatchJobId,
        printerKind,
        event,
        dbUrl: opts.dbUrl,
      });
    } catch (err) {
      logger.error(
        { err, printerId, dispatchJobId, kind: event.kind },
        'forge-status-sink: persistStatusEvent threw — continuing',
      );
      // Continue to bus broadcast / terminal handling — the event is still
      // useful for live UI even if persistence raced.
    }

    // 4) Live SSE bus broadcast (T_dcf12).
    if (deps.emitToBus) {
      try {
        deps.emitToBus(dispatchJobId, event);
      } catch (err) {
        logger.error(
          { err, dispatchJobId, kind: event.kind },
          'forge-status-sink: emitToBus threw',
        );
      }
    }

    // 5) Terminal handling.
    if (event.kind === 'completed' || event.kind === 'failed') {
      let transitioned = false;
      if (event.kind === 'completed') {
        const result = await markCompleted(
          { jobId: dispatchJobId },
          { dbUrl: opts.dbUrl },
        );
        if (result.ok) {
          transitioned = true;
          // Stamp progress_pct=100 atomically with the completion. The
          // transition itself doesn't carry progress; do it as a follow-up
          // unguarded UPDATE.
          (db
            .update(schema.dispatchJobs)
            .set({ progressPct: 100 })
            .where(
              eq(schema.dispatchJobs.id, dispatchJobId),
            ) as unknown as { run: () => unknown }).run();
        } else {
          logger.warn(
            {
              dispatchJobId,
              reason: result.reason,
              currentState:
                'currentState' in result ? result.currentState : undefined,
            },
            'forge-status-sink: markCompleted not ok — already terminal? continuing',
          );
        }
      } else {
        // failed
        const failureDetails = describeFailureDetails(event);
        const result = await markFailed(
          {
            jobId: dispatchJobId,
            reason: 'target-rejected',
            details: failureDetails,
          },
          { dbUrl: opts.dbUrl },
        );
        if (result.ok) {
          transitioned = true;
        } else {
          logger.warn(
            {
              dispatchJobId,
              reason: result.reason,
              currentState:
                'currentState' in result ? result.currentState : undefined,
            },
            'forge-status-sink: markFailed not ok — already terminal? continuing',
          );
        }
      }

      // 6) emitConsumption — only on a SUCCESSFUL completed transition.
      if (transitioned && event.kind === 'completed' && deps.emitConsumption) {
        try {
          await deps.emitConsumption({ dispatchJobId, event });
        } catch (err) {
          logger.error(
            { err, dispatchJobId },
            'forge-status-sink: emitConsumption threw',
          );
        }
      }

      // 7) notifyTerminal — fire whether or not we won the transition; the
      // worker's bookkeeping needs to drop the job from its activeJobs set
      // either way (a duplicate is a harmless delete).
      if (deps.notifyTerminal) {
        try {
          await deps.notifyTerminal({ dispatchJobId, printerId });
        } catch (err) {
          logger.error(
            { err, dispatchJobId, printerId },
            'forge-status-sink: notifyTerminal threw',
          );
        }
      }
    }
  };
}

/**
 * Build a human-readable failure-details string from a `failed` StatusEvent.
 * The schema's `failure_details` is free-form text for UI display — pull
 * whichever signal the event carries. Bambu surfaces a `failedReason` /
 * `errorCode`; Moonraker carries a print state. We stringify the rawPayload
 * as a best-effort last resort.
 */
function describeFailureDetails(event: StatusEvent): string {
  if (event.rawPayload && typeof event.rawPayload === 'object') {
    const obj = event.rawPayload as Record<string, unknown>;
    // Common per-protocol shapes:
    const candidate =
      (typeof obj.errorCode === 'string' && obj.errorCode) ||
      (typeof obj.error_code === 'string' && obj.error_code) ||
      (typeof obj.failureReason === 'string' && obj.failureReason) ||
      (typeof obj.failure_reason === 'string' && obj.failure_reason) ||
      (typeof obj.gcodeState === 'string' && obj.gcodeState) ||
      (typeof obj.gcode_state === 'string' && obj.gcode_state);
    if (candidate) return `printer reported failure: ${candidate}`;
  }
  return `printer reported failure (kind=${event.kind})`;
}
