/**
 * Ingest worker — V2-003-T9 fix-pass
 *
 * Polls `ingest_jobs WHERE status='queued'`, atomically claims rows by
 * flipping them to `'running'`, invokes the V2-003 ingest pipeline for each
 * claim, and writes terminal state back. This fulfils the async ingest
 * contract documented at apps/server/src/app/api/v1/ingest/route.ts:
 *
 *     POST /api/v1/ingest → 201 { jobId, status: 'queued' }
 *     (out-of-band) ingest worker drives the job through the pipeline
 *     GET /api/v1/ingest/:jobId → returns terminal state
 *
 * Without this worker the route enqueues jobs that never run.
 *
 * Polling cadence:
 *   - 1.5s base interval with ±500 ms jitter when work is found
 *   - exponential backoff 5s → 30s when no rows are returned
 *
 * Claim atomicity:
 *   - better-sqlite3 sync transaction: SELECT next queued row, then UPDATE
 *     that row's status='queued' → 'running' guarded by both id and status.
 *     Only one worker wins; the others get null and loop.
 *
 * Crash recovery:
 *   - On startup, every row stuck in `'running'` for > STALE_TIMEOUT_MS
 *     gets reset to `'queued'`. Logged so operators see the recovery.
 */

import { and, eq, lt } from 'drizzle-orm';

import { logger } from '../logger';
import { getDb, schema } from '../db/client';
import { decrypt } from '../crypto';
import { env } from '../env';
import {
  createIngestPipeline,
  defaultRegistry,
  type FetchTarget,
} from '../scavengers';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const POLL_BASE_MS = 1500;
const POLL_JITTER_MS = 500;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 30_000;
/** A row stuck in 'running' for longer than this is assumed crashed mid-run. */
const STALE_TIMEOUT_MS = 10 * 60_000; // 10 minutes

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

let abort: AbortController | null = null;

/**
 * Start the ingest worker pool. Idempotent — second call is a no-op.
 *
 * Concurrency reads from env.WORKER_CONCURRENCY (defaults to 2). The ingest
 * worker reuses the same setting as the v1 queue worker since they target
 * different tables and the cap is a per-process resource budget.
 */
export function startIngestWorker(opts?: { concurrency?: number }): void {
  if (abort) return;
  abort = new AbortController();

  // Best-effort recovery before any worker loops start.
  resetStaleRunningRows().catch((err) =>
    logger.warn({ err }, 'ingest-worker: stale-row recovery failed (non-fatal)'),
  );

  // Default to env concurrency unless an explicit value is supplied (tests).
  // env is imported eagerly (not lazy-required) — tests that don't call
  // startIngestWorker bypass this branch entirely by exercising
  // runOneIngestJob directly.
  const concurrency = opts?.concurrency ?? env.WORKER_CONCURRENCY;

  for (let i = 0; i < concurrency; i++) {
    void runIngestWorkerLoop(abort.signal).catch((err) =>
      logger.error({ err }, 'ingest-worker: loop crashed'),
    );
  }
  logger.info({ concurrency }, 'ingest-worker: started');
}

export function stopIngestWorker(): void {
  abort?.abort();
  abort = null;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export async function runIngestWorkerLoop(signal: AbortSignal): Promise<void> {
  let backoffMs = BACKOFF_MIN_MS;
  while (!signal.aborted) {
    let outcome: 'ran' | 'idle' | 'errored';
    try {
      outcome = await runOneIngestJob();
    } catch (err) {
      logger.error({ err }, 'ingest-worker: runOneIngestJob threw — backing off');
      outcome = 'errored';
    }

    if (outcome === 'ran') {
      backoffMs = BACKOFF_MIN_MS;
      await sleep(POLL_BASE_MS + Math.floor(Math.random() * POLL_JITTER_MS));
    } else {
      // idle or errored: exponential backoff, capped at BACKOFF_MAX_MS.
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Single-job execution
// ---------------------------------------------------------------------------

/**
 * Atomically claim ONE queued ingest_jobs row and run it through the pipeline.
 *
 * Returns:
 *   'ran'     — a row was claimed and processed (regardless of terminal status)
 *   'idle'    — no queued rows available
 *   'errored' — a row was claimed but processing threw before terminal state
 *               (the row will have been marked failed by the pipeline / catch)
 */
export async function runOneIngestJob(): Promise<'ran' | 'idle' | 'errored'> {
  const claimed = claimNextJob();
  if (!claimed) return 'idle';

  const log = logger.child({ jobId: claimed.id, sourceId: claimed.sourceId });

  // ── Resolve adapter ───────────────────────────────────────────────────────
  const adapter = defaultRegistry.getById(claimed.sourceId as never);
  if (!adapter) {
    await markFailed(claimed.id, 'unknown', `no adapter registered for sourceId=${claimed.sourceId}`);
    log.warn({ sourceId: claimed.sourceId }, 'ingest-worker: no adapter — marked failed');
    return 'errored';
  }

  // ── Reconstruct FetchTarget from stored payload ───────────────────────────
  let target: FetchTarget;
  try {
    target = JSON.parse(claimed.targetPayload) as FetchTarget;
    if (!target || typeof target !== 'object' || typeof (target as { kind?: unknown }).kind !== 'string') {
      throw new Error('targetPayload missing kind discriminator');
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await markFailed(claimed.id, 'unknown', `invalid stored target payload: ${reason}`);
    log.warn({ err }, 'ingest-worker: invalid target payload — marked failed');
    return 'errored';
  }

  // ── Pull credentials (best-effort) ────────────────────────────────────────
  // Like the v1 worker, look up source_credentials by sourceId. If missing or
  // decrypt fails, hand undefined to the pipeline — adapters that need creds
  // emit `auth-required` and the pipeline pauses the job correctly.
  let credentials: Record<string, unknown> | undefined;
  try {
    credentials = await readDecryptedCredentialsBag(claimed.sourceId);
  } catch (err) {
    log.warn({ err }, 'ingest-worker: credentials read/decrypt failed — running without');
    credentials = undefined;
  }

  if (!claimed.collectionId) {
    await markFailed(claimed.id, 'unknown', 'job has no collectionId');
    return 'errored';
  }

  // ── Drive the pipeline using the existing job row ─────────────────────────
  const pipeline = createIngestPipeline({
    ownerId: claimed.ownerId,
    collectionId: claimed.collectionId,
  });

  try {
    const outcome = await pipeline.run({
      adapter,
      target,
      credentials,
      existingJobId: claimed.id,
    });
    log.info({ status: outcome.status }, 'ingest-worker: job complete');
    return 'ran';
  } catch (err) {
    // Pipeline.run already wraps its own errors and writes status='failed' to
    // the job. This catch is the last-resort guard: log + ensure the row is
    // not stuck in 'running'.
    const details = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'ingest-worker: pipeline threw outside its try/catch');
    await markFailed(claimed.id, 'unknown', `pipeline threw: ${details}`);
    return 'errored';
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb() as DB;
}

type ClaimedJob = {
  id: string;
  ownerId: string;
  sourceId: string;
  targetKind: string;
  targetPayload: string;
  collectionId: string | null;
};

/**
 * Atomic claim: SELECT one queued row + UPDATE its status to 'running' inside
 * a single better-sqlite3 sync transaction. Returns the claimed row, or null
 * if no queued rows exist.
 */
function claimNextJob(): ClaimedJob | null {
  // better-sqlite3 transactions are SYNCHRONOUS — callbacks must not be async.
  // We cast through `any` once so Drizzle's typed surface composes cleanly
  // with the sync transaction boundary the underlying driver requires.
  return (db() as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }).transaction((tx) => {
    const t = tx as DB;
    const next = t
      .select({
        id: schema.ingestJobs.id,
        ownerId: schema.ingestJobs.ownerId,
        sourceId: schema.ingestJobs.sourceId,
        targetKind: schema.ingestJobs.targetKind,
        targetPayload: schema.ingestJobs.targetPayload,
        collectionId: schema.ingestJobs.collectionId,
      })
      .from(schema.ingestJobs)
      .where(eq(schema.ingestJobs.status, 'queued'))
      .orderBy(schema.ingestJobs.createdAt)
      .limit(1)
      .all();

    const row = next[0];
    if (!row) return null;

    // Guarded UPDATE: the WHERE clause includes status='queued' so a racing
    // worker that already flipped this row sees zero rows updated.
    const result = t
      .update(schema.ingestJobs)
      .set({ status: 'running', updatedAt: new Date() })
      .where(and(eq(schema.ingestJobs.id, row.id), eq(schema.ingestJobs.status, 'queued')))
      .run();

    // better-sqlite3's RunResult exposes `changes`. If 0, another worker won.
    const changes = (result as unknown as { changes?: number }).changes ?? 0;
    if (changes === 0) return null;

    return row;
  });
}

/**
 * Reset rows that have been stuck in 'running' longer than STALE_TIMEOUT_MS.
 * Called once at worker startup. Idempotent.
 */
export async function resetStaleRunningRows(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_TIMEOUT_MS);
  const stale = await db()
    .select({ id: schema.ingestJobs.id })
    .from(schema.ingestJobs)
    .where(and(eq(schema.ingestJobs.status, 'running'), lt(schema.ingestJobs.updatedAt, cutoff)));

  if (stale.length === 0) return 0;

  await db()
    .update(schema.ingestJobs)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(and(eq(schema.ingestJobs.status, 'running'), lt(schema.ingestJobs.updatedAt, cutoff)));

  logger.warn(
    { count: stale.length, ids: stale.slice(0, 10).map((r) => r.id) },
    'ingest-worker: reset stale running rows to queued',
  );
  return stale.length;
}

/** Update a job row to terminal `failed` state. */
async function markFailed(jobId: string, reason: string, details: string): Promise<void> {
  try {
    await db()
      .update(schema.ingestJobs)
      .set({
        status: 'failed',
        failureReason: reason,
        failureDetails: details,
        updatedAt: new Date(),
      })
      .where(eq(schema.ingestJobs.id, jobId));
  } catch (err) {
    logger.warn({ err, jobId }, 'ingest-worker: failed to mark job failed (non-fatal)');
  }
}

/**
 * Look up + decrypt the latest credential bag for a sourceId. Returns
 * undefined when no row exists (so adapters can emit auth-required).
 *
 * Throws on decrypt failure — the caller catches and runs without creds.
 */
async function readDecryptedCredentialsBag(sourceId: string): Promise<Record<string, unknown> | undefined> {
  const secret = process.env.LOOTGOBLIN_SECRET;
  if (!secret) return undefined;

  const rows = await db()
    .select({ encryptedBlob: schema.sourceCredentials.encryptedBlob })
    .from(schema.sourceCredentials)
    .where(eq(schema.sourceCredentials.sourceId, sourceId))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;

  const buf = Buffer.from(row.encryptedBlob as Uint8Array);
  const json = decrypt(buf.toString('utf8'), secret);
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') return undefined;
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
