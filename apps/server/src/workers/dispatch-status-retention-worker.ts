/**
 * Dispatch status events retention worker — V2-cleanup-batch-3 T2 (CF-2).
 *
 * Long-running worker that deletes `dispatch_status_events` rows older than
 * the configured retention window. Without this, the audit log grows
 * unbounded — back-of-envelope: 100 printers × ~1 progress event/10s × 24h
 * ≈ 864k rows/day.
 *
 * Architectural decisions:
 *
 *   1. DELETE, not archive — the audit log doesn't need to survive past
 *      retention. Primary durability is `dispatch_jobs.completedAt` for the
 *      lifecycle timestamps + `ledger_events` for consumption events. The
 *      status-events stream is tertiary signal (debug / live progress
 *      replay) and an aggressive retention policy is safe.
 *
 *   2. Default retention: 30 days. Env var
 *      `DISPATCH_STATUS_EVENTS_RETENTION_DAYS` overrides at process start.
 *
 *   3. Setting retention <= 0 DISABLES retention (audit log preserved
 *      forever). Useful for early-deployment debugging where operators
 *      want every status frame for diagnostic value.
 *
 *   4. Tick cadence: every 12 hours with ±5 min jitter. Daily would be
 *      too coarse for retention precision; hourly would be wasteful given
 *      a 30-day window.
 *
 *   5. Auto-started via `instrumentation.ts` alongside the other workers.
 *      SIGTERM/SIGINT shuts down cleanly via the module-level
 *      AbortController, mirroring `gdrive-channel-refresh-worker.ts`.
 *
 * @see apps/server/src/db/schema.forge.ts (dispatchStatusEvents table)
 */

import { lt } from 'drizzle-orm';

import { logger } from '../logger';
import { getServerDb, schema } from '../db/client';
import { sleep } from '../scouts/rate-limit';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Tick interval — every 12 hours. */
const TICK_INTERVAL_MS = 12 * 3600_000;
/** ±jitter applied to each tick interval to spread load across instances. */
const TICK_JITTER_MS = 5 * 60_000;
/** Default retention window when env var is unset / malformed. */
const DEFAULT_RETENTION_DAYS = 30;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

let retentionAbort: AbortController | null = null;

export interface RetentionTickResult {
  /** Number of dispatch_status_events rows deleted by this tick. */
  deleted: number;
  /** Cutoff in epoch-ms; rows with `occurredAt < cutoffMs` are deleted. */
  cutoffMs: number;
  /** Effective retention window (days) — DEFAULT_RETENTION_DAYS or env. */
  retentionDays: number;
  /** True when retention is disabled (retentionDays <= 0). No rows touched. */
  skipped: boolean;
}

/**
 * Resolve the active retention window from
 * `DISPATCH_STATUS_EVENTS_RETENTION_DAYS`. Malformed values (NaN / non-
 * numeric) fall back to the default. Negative + zero values are passed
 * through verbatim so the caller can detect "disabled" without re-parsing.
 */
export function getRetentionDays(): number {
  const raw = process.env.DISPATCH_STATUS_EVENTS_RETENTION_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// runRetentionTickOnce
// ---------------------------------------------------------------------------

/**
 * Single retention pass — delete every `dispatch_status_events` row whose
 * `occurredAt < now - retentionDays`. Idempotent. Tests drive this directly
 * (the long-running loop is just sleep-and-retick around it).
 */
export async function runRetentionTickOnce(opts?: {
  dbUrl?: string;
  now?: Date;
}): Promise<RetentionTickResult> {
  const retentionDays = getRetentionDays();
  if (retentionDays <= 0) {
    logger.info(
      { retentionDays },
      'dispatch-status-retention: disabled (retentionDays <= 0)',
    );
    return { deleted: 0, cutoffMs: 0, retentionDays, skipped: true };
  }

  const now = opts?.now ?? new Date();
  const cutoffMs = now.getTime() - retentionDays * 24 * 3600_000;
  const db = getServerDb(opts?.dbUrl);

  // better-sqlite3 surfaces `changes` only via the sync `.run()` exit, so
  // we mirror the dispatch-state.ts pattern rather than awaiting the
  // builder directly.
  const result = db
    .delete(schema.dispatchStatusEvents)
    .where(lt(schema.dispatchStatusEvents.occurredAt, new Date(cutoffMs)))
    .run();
  const deleted = (result as unknown as { changes?: number }).changes ?? 0;

  logger.info(
    { deleted, cutoffMs, retentionDays },
    'dispatch-status-retention: tick complete',
  );
  return { deleted, cutoffMs, retentionDays, skipped: false };
}

// ---------------------------------------------------------------------------
// Long-running loop
// ---------------------------------------------------------------------------

/**
 * Start the retention loop. Idempotent — a second call while the first is
 * still running is a no-op.
 *
 * Behaviour: each iteration runs `runRetentionTickOnce`, then sleeps
 * TICK_INTERVAL_MS ± TICK_JITTER_MS before the next tick. Exits cleanly
 * when the AbortSignal fires (SIGTERM / SIGINT path through
 * `stopDispatchStatusRetentionWorker`).
 */
export function startDispatchStatusRetentionWorker(): void {
  if (retentionAbort !== null) return;
  retentionAbort = new AbortController();
  const signal = retentionAbort.signal;

  logger.info(
    { tickIntervalMs: TICK_INTERVAL_MS, retentionDays: getRetentionDays() },
    'dispatch-status-retention: started',
  );

  const loop = async () => {
    while (!signal.aborted) {
      try {
        await runRetentionTickOnce();
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'dispatch-status-retention: tick failed',
        );
      }
      const jitter = (Math.random() - 0.5) * 2 * TICK_JITTER_MS;
      const waitMs = TICK_INTERVAL_MS + jitter;
      try {
        await sleep(waitMs, signal);
      } catch {
        return; // aborted
      }
    }
  };

  void loop();
}

export function stopDispatchStatusRetentionWorker(): void {
  if (retentionAbort === null) return;
  retentionAbort.abort();
  retentionAbort = null;
}
