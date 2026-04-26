/**
 * Watchlist scheduler — V2-004-T3
 *
 * Polls due subscriptions, enqueues `watchlist_jobs` rows. Runs as a
 * long-running loop alongside the ingest worker. Does NOT do the actual
 * fetching — that's the watchlist worker's job (T4).
 *
 * Sole responsibility of THIS loop: turn
 *   (subscription is active) AND
 *   (last_fired_at is NULL OR last_fired_at + cadence_seconds*1000 <= now()) AND
 *   (no in-flight watchlist_job for the subscription)
 * into a `queued` row + advance `last_fired_at` atomically.
 *
 * In-flight detection — query `watchlist_jobs WHERE subscription_id=?
 * AND status IN ('queued','claimed','running')`. If any rows, skip.
 *
 * Missed-window collapse — one tick fires each due subscription at most
 * once. As long as the tick is idempotent (in-flight check), multiple
 * missed windows collapse naturally — the next tick fires it exactly
 * once because the previous firing is still 'queued'/'running'.
 *
 * Cursor advancement — NOT this loop's concern. The worker (T4) advances
 * `cursor_state` atomically on watchlist_job success. This loop only
 * stamps `last_fired_at`.
 *
 * Stale recovery — on startup, watchlist_jobs stuck in 'running' or
 * 'claimed' beyond WATCHLIST_STALE_TIMEOUT_MS are reset to 'queued'.
 *
 * Auto-started by instrumentation.ts in Node runtime.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import { logger } from '../logger';
import { getDb, schema } from '../db/client';
import { env } from '../env';
import { sleep } from '../scavengers/rate-limit';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 30_000;
/** Jitter window (±) applied to each tick interval. */
const TICK_JITTER_MS = 2_500;

// In-flight statuses — a subscription with any watchlist_job in these
// statuses is skipped on the current tick.
const IN_FLIGHT_STATUSES = ['queued', 'claimed', 'running'] as const;
// Statuses we sweep on stale recovery — both 'claimed' and 'running' are
// owned by a worker that may have crashed.
const STALE_STATUSES = ['claimed', 'running'] as const;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

let schedulerAbort: AbortController | null = null;

export interface SchedulerTickResult {
  enqueued: number;
  skippedInFlight: number;
  skippedNotDue: number;
  errors: number;
}

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb() as DB;
}

// ---------------------------------------------------------------------------
// Tick — single pass over due subscriptions
// ---------------------------------------------------------------------------

/**
 * Run a single scheduler tick. Idempotent — safe to call concurrently
 * (the in-flight check serialises behaviour after the first INSERT).
 *
 * Filters subscriptions in SQL by (active=1 AND due) so we don't iterate
 * the full table. The "due" predicate uses
 *   (last_fired_at IS NULL) OR (last_fired_at + cadence_seconds*1000 <= now)
 * which the (active, last_fired_at) compound index covers.
 *
 * For each due subscription, the in-flight check + atomic enqueue runs in
 * a sync better-sqlite3 transaction. Within that transaction we re-read
 * `last_fired_at` so a parallel tick that already fired the same row
 * causes us to skip (no double-firing).
 */
export async function runOneSchedulerTick(
  opts: { now?: Date } = {},
): Promise<SchedulerTickResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  // ── Find candidates: active=1 AND (never fired OR cadence elapsed) ──────
  // SQLite stores `last_fired_at` as ms epoch, `cadence_seconds` as integer.
  // We compute the due-cutoff in SQL so the planner can use the
  // (active, last_fired_at) index.
  const candidates = await db()
    .select({
      id: schema.watchlistSubscriptions.id,
      lastFiredAt: schema.watchlistSubscriptions.lastFiredAt,
      cadenceSeconds: schema.watchlistSubscriptions.cadenceSeconds,
    })
    .from(schema.watchlistSubscriptions)
    .where(
      and(
        eq(schema.watchlistSubscriptions.active, 1),
        or(
          isNull(schema.watchlistSubscriptions.lastFiredAt),
          // last_fired_at + cadence_seconds*1000 <= now
          sql`${schema.watchlistSubscriptions.lastFiredAt} + ${schema.watchlistSubscriptions.cadenceSeconds} * 1000 <= ${nowMs}`,
        ),
      ),
    );

  let enqueued = 0;
  let skippedInFlight = 0;
  let errors = 0;
  const skippedNotDue = 0; // candidates filter already excludes not-due rows

  for (const sub of candidates) {
    try {
      const result = tryEnqueueForSubscription(sub.id, now);
      if (result === 'enqueued') enqueued++;
      else if (result === 'in-flight') skippedInFlight++;
      // 'race-lost' means a concurrent tick already updated the row;
      // we count it as in-flight from this tick's perspective.
      else if (result === 'race-lost') skippedInFlight++;
    } catch (err) {
      logger.error(
        { err, subscriptionId: sub.id },
        'watchlist-scheduler: subscription firing failed',
      );
      errors++;
    }
  }

  return { enqueued, skippedInFlight, skippedNotDue, errors };
}

type EnqueueOutcome = 'enqueued' | 'in-flight' | 'race-lost';

/**
 * Atomic firing for a single subscription.
 *
 * Within a sync better-sqlite3 transaction:
 *   1. Re-read the subscription's `last_fired_at` + `active` (lost-update
 *      guard: a concurrent tick may have fired it already).
 *   2. Count in-flight watchlist_jobs (queued/claimed/running). If any
 *      exist, skip.
 *   3. INSERT the new watchlist_job and UPDATE the subscription's
 *      last_fired_at to `now`.
 *
 * Returns:
 *   'enqueued'  — INSERT + UPDATE both ran.
 *   'in-flight' — an existing watchlist_job blocks firing.
 *   'race-lost' — subscription was already fired by another tick (its
 *                 last_fired_at advanced past our `now`).
 */
function tryEnqueueForSubscription(
  subscriptionId: string,
  now: Date,
): EnqueueOutcome {
  const nowMs = now.getTime();
  // better-sqlite3 transactions are SYNCHRONOUS — callbacks must not be async.
  return (db() as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }).transaction((tx) => {
    const t = tx as DB;

    // 1. Re-read subscription. If active=0 or already-fired-after-our-now,
    //    bail (race-lost).
    const subRows = t
      .select({
        id: schema.watchlistSubscriptions.id,
        active: schema.watchlistSubscriptions.active,
        lastFiredAt: schema.watchlistSubscriptions.lastFiredAt,
      })
      .from(schema.watchlistSubscriptions)
      .where(eq(schema.watchlistSubscriptions.id, subscriptionId))
      .limit(1)
      .all();
    const sub = subRows[0];
    if (!sub || sub.active !== 1) return 'race-lost';
    if (sub.lastFiredAt && sub.lastFiredAt.getTime() >= nowMs) {
      // A parallel tick already fired this subscription with an
      // equal-or-newer timestamp. Yield.
      return 'race-lost';
    }

    // 2. In-flight check.
    const inFlight = t
      .select({ id: schema.watchlistJobs.id })
      .from(schema.watchlistJobs)
      .where(
        and(
          eq(schema.watchlistJobs.subscriptionId, subscriptionId),
          inArray(schema.watchlistJobs.status, IN_FLIGHT_STATUSES as unknown as string[]),
        ),
      )
      .limit(1)
      .all();
    if (inFlight.length > 0) return 'in-flight';

    // 3. Atomic enqueue + stamp last_fired_at.
    t.insert(schema.watchlistJobs)
      .values({
        id: randomUUID(),
        subscriptionId,
        status: 'queued',
        itemsDiscovered: 0,
        itemsEnqueued: 0,
        createdAt: now,
      })
      .run();
    t.update(schema.watchlistSubscriptions)
      .set({ lastFiredAt: now, updatedAt: now })
      .where(eq(schema.watchlistSubscriptions.id, subscriptionId))
      .run();

    return 'enqueued';
  });
}

// ---------------------------------------------------------------------------
// Stale recovery
// ---------------------------------------------------------------------------

/**
 * Reset watchlist_jobs stuck in 'claimed' or 'running' for longer than
 * the stale timeout back to 'queued'. Called once at scheduler startup —
 * matches the ingest-worker pattern. Returns the number of rows reset.
 */
export async function resetStaleRunningWatchlistJobs(
  opts: { now?: Date; staleTimeoutMs?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const staleTimeoutMs = opts.staleTimeoutMs ?? env.WATCHLIST_STALE_TIMEOUT_MS;
  const cutoff = new Date(now.getTime() - staleTimeoutMs);

  const stale = await db()
    .select({ id: schema.watchlistJobs.id })
    .from(schema.watchlistJobs)
    .where(
      and(
        inArray(schema.watchlistJobs.status, STALE_STATUSES as unknown as string[]),
        lt(schema.watchlistJobs.claimedAt, cutoff),
      ),
    );

  if (stale.length === 0) return 0;

  await db()
    .update(schema.watchlistJobs)
    .set({ status: 'queued', claimedAt: null, startedAt: null })
    .where(
      and(
        inArray(schema.watchlistJobs.status, STALE_STATUSES as unknown as string[]),
        lt(schema.watchlistJobs.claimedAt, cutoff),
      ),
    );

  logger.warn(
    { count: stale.length, ids: stale.slice(0, 10).map((r) => r.id) },
    'watchlist-scheduler: reset stale watchlist_jobs to queued',
  );
  return stale.length;
}

// ---------------------------------------------------------------------------
// Long-running loop
// ---------------------------------------------------------------------------

/**
 * Start the watchlist scheduler loop. Idempotent — second call is a no-op.
 *
 * Shape mirrors ingest-worker.startIngestWorker:
 *   - allocate a module-level AbortController (so stopWatchlistScheduler can abort)
 *   - run stale-job recovery once
 *   - enter the tick loop with exponential backoff on errors
 */
export function startWatchlistScheduler(opts?: { signal?: AbortSignal }): void {
  if (schedulerAbort) return;
  schedulerAbort = new AbortController();
  const signal = opts?.signal ?? schedulerAbort.signal;

  // Best-effort recovery before the loop starts.
  resetStaleRunningWatchlistJobs().catch((err) =>
    logger.warn(
      { err },
      'watchlist-scheduler: stale-job recovery failed (non-fatal)',
    ),
  );

  void runSchedulerLoop(signal).catch((err) =>
    logger.error({ err }, 'watchlist-scheduler: loop crashed'),
  );
  logger.info(
    { tickSeconds: env.WATCHLIST_TICK_SECONDS },
    'watchlist-scheduler: started',
  );
}

export function stopWatchlistScheduler(): void {
  schedulerAbort?.abort();
  schedulerAbort = null;
}

async function runSchedulerLoop(signal: AbortSignal): Promise<void> {
  const tickIntervalMs = env.WATCHLIST_TICK_SECONDS * 1000;
  let backoffMs = 0;

  while (!signal.aborted) {
    try {
      const result = await runOneSchedulerTick();
      if (result.enqueued > 0 || result.errors > 0) {
        logger.debug(result, 'watchlist-scheduler: tick complete');
      }
      backoffMs = 0; // reset on success
    } catch (err) {
      logger.error({ err }, 'watchlist-scheduler: tick failed — backing off');
      backoffMs =
        backoffMs === 0
          ? BACKOFF_MIN_MS
          : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    }

    // ±jitter to spread load across instances of the same image.
    const jitter = Math.floor(Math.random() * (TICK_JITTER_MS * 2)) - TICK_JITTER_MS;
    const waitMs = backoffMs > 0 ? backoffMs : Math.max(1_000, tickIntervalMs + jitter);

    try {
      await sleep(waitMs, signal);
    } catch {
      // Sleep aborted — loop condition will exit cleanly.
    }
  }
}
