/**
 * Watchlist worker — V2-004-T4
 *
 * Drains `watchlist_jobs` rows enqueued by the T3 scheduler. For each claimed
 * row, the worker:
 *
 *   1. Loads the originating subscription + adapter credentials.
 *   2. Resolves a SubscribableAdapter from the registry that supports the
 *      subscription's kind.
 *   3. Calls `dispatchDiscovery(adapter, kind, context, params)` and iterates
 *      the resulting AsyncIterable<DiscoveryEvent>.
 *   4. Collects `item-discovered` events, watches for the terminal
 *      `discovery-completed` / `discovery-failed` event.
 *   5. On success: enqueues child `ingest_jobs` rows (one per discovered
 *      item) AND advances `cursor_state` AND resets `error_streak` AND marks
 *      the watchlist_job completed — all in a SINGLE sync transaction
 *      (WL-Q5 atomic-on-completion). If the transaction fails, both the
 *      cursor and the watchlist_job stay at their prior values; the next
 *      firing repeats safely (pipeline dedups on `(sourceId, sourceItemId)`).
 *   6. On failure: marks the watchlist_job failed. If the failure reason is
 *      `auth-revoked`, ALL active subscriptions for the same source_adapter_id
 *      are paused (active=0) — see WL-Q4. Otherwise, the per-subscription
 *      `error_streak` is incremented; if it crosses
 *      `WATCHLIST_ERROR_STREAK_THRESHOLD`, the subscription alone is paused.
 *
 * Idempotency / dedup
 * -------------------
 * Discovery may surface items already in the library (e.g. when a previous
 * firing's transaction rolled back and the cursor wasn't advanced). The
 * watchlist worker does NOT pre-check `ingest_jobs` to avoid the cost of N
 * lookups per discovery. Instead it relies on the V2-003-T2 ingest pipeline,
 * which dedups on `(sourceId, sourceItemId)` before staging anything.
 *
 * Polling cadence + concurrency
 * ----------------------------
 * Mirrors the ingest worker:
 *   - 1.5s base interval with ±500 ms jitter when work is found
 *   - exponential backoff 5s → 30s when no rows are returned
 *   - per-job concurrency from env.WATCHLIST_WORKER_CONCURRENCY (default 2)
 *
 * Crash recovery
 * --------------
 * On startup, every row stuck in `'running'` or `'claimed'` longer than
 * `WATCHLIST_STALE_TIMEOUT_MS` is reset to `'queued'`. The T3 scheduler also
 * runs this sweep at startup; both calls are idempotent.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

import { logger } from '../logger';
import { getDb, schema } from '../db/client';
import { decrypt, encrypt } from '../crypto';
import { env } from '../env';
import {
  defaultRegistry,
  dispatchDiscovery,
  hasCapability,
  type DiscoveryContext,
  type DiscoveryEvent,
  type SubscribableAdapter,
} from '../scavengers';
import type {
  WatchlistSubscriptionKind,
  WatchlistSubscriptionParameters,
} from '../watchlist/types';
import { resetStaleRunningWatchlistJobs } from './watchlist-scheduler';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const POLL_BASE_MS = 1500;
const POLL_JITTER_MS = 500;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 30_000;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

let abort: AbortController | null = null;

/**
 * Start the watchlist worker pool. Idempotent — second call is a no-op.
 *
 * Concurrency reads from `env.WATCHLIST_WORKER_CONCURRENCY` (default 2)
 * unless an explicit value is supplied (tests use `runOneWatchlistJob`
 * directly and bypass this path entirely).
 */
export function startWatchlistWorker(opts?: { concurrency?: number }): void {
  if (abort) return;
  abort = new AbortController();

  // Best-effort recovery before any worker loops start. The scheduler also
  // runs this at startup; both calls are idempotent.
  resetStaleRunningWatchlistJobs().catch((err) =>
    logger.warn(
      { err },
      'watchlist-worker: stale-row recovery failed (non-fatal)',
    ),
  );

  const concurrency = opts?.concurrency ?? env.WATCHLIST_WORKER_CONCURRENCY;

  for (let i = 0; i < concurrency; i++) {
    void runWatchlistWorkerLoop(abort.signal).catch((err) =>
      logger.error({ err }, 'watchlist-worker: loop crashed'),
    );
  }
  logger.info({ concurrency }, 'watchlist-worker: started');
}

export function stopWatchlistWorker(): void {
  abort?.abort();
  abort = null;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export async function runWatchlistWorkerLoop(
  signal: AbortSignal,
): Promise<void> {
  let backoffMs = BACKOFF_MIN_MS;
  while (!signal.aborted) {
    let outcome: 'ran' | 'idle' | 'errored';
    try {
      outcome = await runOneWatchlistJob({ signal });
    } catch (err) {
      logger.error(
        { err },
        'watchlist-worker: runOneWatchlistJob threw — backing off',
      );
      outcome = 'errored';
    }

    if (outcome === 'ran') {
      backoffMs = BACKOFF_MIN_MS;
      await sleep(POLL_BASE_MS + Math.floor(Math.random() * POLL_JITTER_MS));
    } else {
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Single-job execution
// ---------------------------------------------------------------------------

export interface RunOneOptions {
  /** Optional abort signal — propagated into the DiscoveryContext. */
  signal?: AbortSignal;
  /** Override the wall clock — tests use this for deterministic timestamps. */
  now?: Date;
}

/**
 * Atomically claim ONE queued watchlist_jobs row and run it through discovery.
 *
 * Returns:
 *   'ran'     — a row was claimed and processed (regardless of terminal status)
 *   'idle'    — no queued rows available
 *   'errored' — a row was claimed but processing threw before terminal state
 *               (the row will have been marked failed)
 */
export async function runOneWatchlistJob(
  opts: RunOneOptions = {},
): Promise<'ran' | 'idle' | 'errored'> {
  const now = opts.now ?? new Date();

  const claimed = claimNextWatchlistJob(now);
  if (!claimed) return 'idle';

  const log = logger.child({
    watchlistJobId: claimed.id,
    subscriptionId: claimed.subscriptionId,
  });

  // ── Load subscription ─────────────────────────────────────────────────────
  let sub: LoadedSubscription | null;
  try {
    sub = await loadSubscription(claimed.subscriptionId);
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    await markJobFailed(claimed.id, 'unknown', `failed to load subscription: ${details}`, now);
    log.error({ err }, 'watchlist-worker: subscription load failed');
    return 'errored';
  }

  if (!sub) {
    // Subscription was deleted between scheduler enqueue and worker claim.
    // ON DELETE CASCADE on watchlist_subscriptions.id should already have
    // dropped the job, but defend against the race.
    await markJobFailed(claimed.id, 'unknown', 'subscription not found', now);
    log.warn('watchlist-worker: subscription not found — marked failed');
    return 'errored';
  }

  if (!sub.defaultCollectionId) {
    await markJobFailed(
      claimed.id,
      'unknown',
      'subscription missing default_collection_id — re-target via UI',
      now,
    );
    log.warn(
      'watchlist-worker: subscription has no default_collection_id — marked failed',
    );
    return 'errored';
  }

  // ── Parse parameters ──────────────────────────────────────────────────────
  let params: WatchlistSubscriptionParameters;
  try {
    params = JSON.parse(sub.parameters) as WatchlistSubscriptionParameters;
    if (!params || typeof params !== 'object' || typeof (params as { kind?: unknown }).kind !== 'string') {
      throw new Error('parameters missing kind discriminator');
    }
    if (params.kind !== sub.kind) {
      throw new Error(
        `parameters.kind='${params.kind}' does not match subscription.kind='${sub.kind}'`,
      );
    }
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    await markJobFailed(claimed.id, 'unknown', `invalid parameters: ${details}`, now);
    log.warn({ err }, 'watchlist-worker: invalid parameters — marked failed');
    return 'errored';
  }

  // ── Resolve subscribable adapter ──────────────────────────────────────────
  const adapter = defaultRegistry.getSubscribable(sub.sourceAdapterId as never);
  if (!adapter) {
    await markJobFailed(
      claimed.id,
      'unknown',
      `adapter '${sub.sourceAdapterId}' is not subscribable`,
      now,
    );
    log.warn('watchlist-worker: adapter not subscribable — marked failed');
    return 'errored';
  }

  if (!hasCapability(adapter, sub.kind as WatchlistSubscriptionKind)) {
    await markJobFailed(
      claimed.id,
      'unknown',
      `adapter '${sub.sourceAdapterId}' does not implement capability '${sub.kind}'`,
      now,
    );
    log.warn('watchlist-worker: adapter missing capability — marked failed');
    return 'errored';
  }

  // ── Load credentials (best-effort) ────────────────────────────────────────
  let credentials: Record<string, unknown> | undefined;
  try {
    credentials = await readDecryptedCredentialsBag(sub.sourceAdapterId);
  } catch (err) {
    log.warn(
      { err },
      'watchlist-worker: credentials read/decrypt failed — running without',
    );
    credentials = undefined;
  }

  // ── Mark running ──────────────────────────────────────────────────────────
  try {
    await db()
      .update(schema.watchlistJobs)
      .set({ status: 'running', startedAt: now })
      .where(eq(schema.watchlistJobs.id, claimed.id));
  } catch (err) {
    log.warn({ err }, 'watchlist-worker: failed to flip status running (non-fatal)');
  }

  // ── Build discovery context ───────────────────────────────────────────────
  const context: DiscoveryContext = {
    userId: sub.ownerId,
    credentials,
    cursor: sub.cursorState ?? undefined,
    signal: opts.signal,
    onTokenRefreshed: async (newCredentials) => {
      try {
        await persistRefreshedCredentials(sub!.sourceAdapterId, newCredentials);
      } catch (err) {
        log.warn(
          { err, sourceId: sub!.sourceAdapterId },
          'watchlist-worker: failed to persist refreshed credentials (non-fatal)',
        );
      }
    },
  };

  // ── Run discovery ─────────────────────────────────────────────────────────
  const items: DiscoveredItem[] = [];
  let terminal: TerminalEvent | null = null;

  try {
    for await (const evt of dispatchDiscovery(adapter, sub.kind as WatchlistSubscriptionKind, context, params) as AsyncIterable<DiscoveryEvent>) {
      if (opts.signal?.aborted) {
        terminal = {
          kind: 'discovery-failed',
          reason: 'unknown',
          details: 'worker aborted before discovery completed',
        };
        break;
      }
      if (evt.kind === 'item-discovered') {
        items.push({
          sourceItemId: evt.sourceItemId,
          sourceUrl: evt.sourceUrl,
        });
      } else if (evt.kind === 'progress') {
        // Best-effort log; not persisted.
        log.debug({ message: evt.message, itemsSeen: evt.itemsSeen }, 'discovery progress');
      } else if (evt.kind === 'rate-limited') {
        log.info(
          { retryAfterMs: evt.retryAfterMs, attempt: evt.attempt },
          'discovery rate-limited — adapter backing off',
        );
      } else if (evt.kind === 'auth-required') {
        // Adapter is signalling that the credentials need user attention but
        // hasn't given up. Translate to a discovery-failed terminal so the
        // worker pauses the subscription via the error-streak path. (Adapters
        // that want to cascade can emit `discovery-failed reason='auth-revoked'`
        // instead — that path triggers the WL-Q4 cascade.)
        terminal = {
          kind: 'discovery-failed',
          reason: 'unknown',
          details: `auth-required: ${evt.reason}${evt.surfaceToUser ? ` — ${evt.surfaceToUser}` : ''}`,
        };
        break;
      } else if (evt.kind === 'discovery-completed') {
        terminal = { kind: 'discovery-completed', cursor: evt.cursor, itemsTotal: evt.itemsTotal };
        break;
      } else if (evt.kind === 'discovery-failed') {
        terminal = {
          kind: 'discovery-failed',
          reason: evt.reason,
          details: evt.details,
        };
        break;
      }
    }
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    terminal = { kind: 'discovery-failed', reason: 'unknown', details };
    log.error({ err }, 'watchlist-worker: discovery threw');
  }

  if (!terminal) {
    // Iterator ended without a terminal event — adapter contract violation.
    terminal = {
      kind: 'discovery-failed',
      reason: 'unknown',
      details: 'adapter ended discovery without a terminal event',
    };
    log.warn('watchlist-worker: adapter omitted terminal event');
  }

  // ── Apply outcome ─────────────────────────────────────────────────────────
  try {
    if (terminal.kind === 'discovery-completed') {
      applyDiscoveryCompleted(claimed.id, sub, items, terminal.cursor, now);
      log.info(
        { items: items.length },
        'watchlist-worker: discovery complete — children enqueued',
      );
      return 'ran';
    }

    // discovery-failed
    await applyDiscoveryFailed(claimed.id, sub, terminal.reason, terminal.details, now);
    log.info(
      { reason: terminal.reason, details: terminal.details },
      'watchlist-worker: discovery failed',
    );
    return 'errored';
  } catch (err) {
    // Atomic-write path threw — likely a DB error. Best-effort recovery: try
    // to mark the watchlist_job failed so it doesn't sit in 'running'. If
    // even that fails, the stale-recovery sweep will reset it on next
    // startup.
    const details = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'watchlist-worker: failed to apply discovery outcome');
    try {
      await markJobFailed(
        claimed.id,
        'unknown',
        `apply outcome failed: ${details}`,
        now,
      );
    } catch {
      // swallow — already logged
    }
    return 'errored';
  }
}

// ---------------------------------------------------------------------------
// Discovery outcome appliers
// ---------------------------------------------------------------------------

interface DiscoveredItem {
  sourceItemId: string;
  sourceUrl?: string;
}

type TerminalEvent =
  | { kind: 'discovery-completed'; cursor?: string; itemsTotal: number }
  | { kind: 'discovery-failed'; reason: string; details: string };

/**
 * On `discovery-completed` — atomically:
 *   1. INSERT one ingest_jobs row per discovered item.
 *   2. UPDATE watchlist_subscriptions: cursor_state, error_streak=0, updated_at.
 *   3. UPDATE watchlist_jobs: status=completed, items_discovered, items_enqueued, completed_at.
 *
 * Single sync better-sqlite3 transaction. If anything throws, all three
 * writes roll back and the next firing repeats safely (pipeline dedups on
 * (sourceId, sourceItemId)).
 */
function applyDiscoveryCompleted(
  jobId: string,
  sub: LoadedSubscription,
  items: DiscoveredItem[],
  cursor: string | undefined,
  now: Date,
): void {
  // Defence in depth — caller already validated this, but we run inside the
  // transaction to be sure.
  if (!sub.defaultCollectionId) {
    throw new Error('default_collection_id required to enqueue child jobs');
  }
  const collectionId = sub.defaultCollectionId;

  (db() as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }).transaction((tx) => {
    const t = tx as DB;

    for (const item of items) {
      t.insert(schema.ingestJobs)
        .values({
          id: randomUUID(),
          ownerId: sub.ownerId,
          sourceId: sub.sourceAdapterId,
          targetKind: 'source-item-id',
          targetPayload: JSON.stringify({
            kind: 'source-item-id',
            sourceItemId: item.sourceItemId,
          }),
          collectionId,
          status: 'queued',
          attempt: 1,
          parentSubscriptionId: sub.id,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    t.update(schema.watchlistSubscriptions)
      .set({
        cursorState: cursor ?? null,
        errorStreak: 0,
        updatedAt: now,
      })
      .where(eq(schema.watchlistSubscriptions.id, sub.id))
      .run();

    t.update(schema.watchlistJobs)
      .set({
        status: 'completed',
        itemsDiscovered: items.length,
        itemsEnqueued: items.length,
        completedAt: now,
      })
      .where(eq(schema.watchlistJobs.id, jobId))
      .run();

    return null;
  });
}

/**
 * On `discovery-failed`:
 *   - Mark the watchlist_job failed (failure_reason, failure_details, completed_at).
 *   - If reason='auth-revoked': cascade — set active=0 on ALL watchlist_subscriptions
 *     for the same source_adapter_id (WL-Q4). The cascade does NOT touch
 *     error_streak — the user must update credentials + manually re-activate.
 *   - Otherwise: increment THIS subscription's error_streak. If it crosses
 *     `WATCHLIST_ERROR_STREAK_THRESHOLD`, set active=0 for THIS subscription
 *     only.
 */
async function applyDiscoveryFailed(
  jobId: string,
  sub: LoadedSubscription,
  reason: string,
  details: string,
  now: Date,
): Promise<void> {
  const isAuthRevoked = reason === 'auth-revoked';

  if (isAuthRevoked) {
    // Cascade pause + mark job failed in a single sync transaction. Cumulative
    // count is logged so operators see the blast radius.
    const result = (db() as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }).transaction((tx) => {
      const t = tx as DB;

      const cascadeIds = t
        .select({ id: schema.watchlistSubscriptions.id })
        .from(schema.watchlistSubscriptions)
        .where(
          and(
            eq(schema.watchlistSubscriptions.sourceAdapterId, sub.sourceAdapterId),
            eq(schema.watchlistSubscriptions.active, 1),
          ),
        )
        .all();

      if (cascadeIds.length > 0) {
        t.update(schema.watchlistSubscriptions)
          .set({ active: 0, updatedAt: now })
          .where(
            and(
              eq(schema.watchlistSubscriptions.sourceAdapterId, sub.sourceAdapterId),
              eq(schema.watchlistSubscriptions.active, 1),
            ),
          )
          .run();
      }

      t.update(schema.watchlistJobs)
        .set({
          status: 'failed',
          failureReason: reason,
          failureDetails: details,
          completedAt: now,
        })
        .where(eq(schema.watchlistJobs.id, jobId))
        .run();

      return cascadeIds.length;
    });

    logger.warn(
      {
        watchlistJobId: jobId,
        sourceAdapterId: sub.sourceAdapterId,
        cascadedCount: result,
      },
      'watchlist-worker: auth-revoked — cascade-paused subscriptions',
    );
    return;
  }

  // Per-subscription error streak path.
  const newStreak = sub.errorStreak + 1;
  const shouldPause = newStreak >= env.WATCHLIST_ERROR_STREAK_THRESHOLD;

  (db() as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }).transaction((tx) => {
    const t = tx as DB;

    t.update(schema.watchlistSubscriptions)
      .set({
        errorStreak: newStreak,
        active: shouldPause ? 0 : sub.active,
        updatedAt: now,
      })
      .where(eq(schema.watchlistSubscriptions.id, sub.id))
      .run();

    t.update(schema.watchlistJobs)
      .set({
        status: 'failed',
        failureReason: reason,
        failureDetails: details,
        completedAt: now,
      })
      .where(eq(schema.watchlistJobs.id, jobId))
      .run();

    return null;
  });

  if (shouldPause) {
    logger.warn(
      {
        subscriptionId: sub.id,
        threshold: env.WATCHLIST_ERROR_STREAK_THRESHOLD,
        errorStreak: newStreak,
      },
      'watchlist-worker: error-streak threshold reached — subscription paused',
    );
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb() as DB;
}

interface ClaimedJob {
  id: string;
  subscriptionId: string;
}

/**
 * Atomic claim: SELECT one queued row + UPDATE its status to 'claimed' inside
 * a single better-sqlite3 sync transaction. Mirrors the ingest-worker pattern.
 *
 * The `claimed_at` timestamp is also stamped here so the stale-recovery sweep
 * has a known anchor.
 */
function claimNextWatchlistJob(now: Date = new Date()): ClaimedJob | null {
  return (db() as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }).transaction((tx) => {
    const t = tx as DB;
    const next = t
      .select({
        id: schema.watchlistJobs.id,
        subscriptionId: schema.watchlistJobs.subscriptionId,
      })
      .from(schema.watchlistJobs)
      .where(eq(schema.watchlistJobs.status, 'queued'))
      .orderBy(schema.watchlistJobs.createdAt)
      .limit(1)
      .all();

    const row = next[0];
    if (!row) return null;

    const result = t
      .update(schema.watchlistJobs)
      .set({ status: 'claimed', claimedAt: now })
      .where(
        and(
          eq(schema.watchlistJobs.id, row.id),
          eq(schema.watchlistJobs.status, 'queued'),
        ),
      )
      .run();

    const changes = (result as unknown as { changes?: number }).changes ?? 0;
    if (changes === 0) return null;

    return row;
  });
}

interface LoadedSubscription {
  id: string;
  ownerId: string;
  kind: string;
  sourceAdapterId: string;
  parameters: string;
  cursorState: string | null;
  active: number;
  errorStreak: number;
  defaultCollectionId: string | null;
}

async function loadSubscription(id: string): Promise<LoadedSubscription | null> {
  const rows = await db()
    .select({
      id: schema.watchlistSubscriptions.id,
      ownerId: schema.watchlistSubscriptions.ownerId,
      kind: schema.watchlistSubscriptions.kind,
      sourceAdapterId: schema.watchlistSubscriptions.sourceAdapterId,
      parameters: schema.watchlistSubscriptions.parameters,
      cursorState: schema.watchlistSubscriptions.cursorState,
      active: schema.watchlistSubscriptions.active,
      errorStreak: schema.watchlistSubscriptions.errorStreak,
      defaultCollectionId: schema.watchlistSubscriptions.defaultCollectionId,
    })
    .from(schema.watchlistSubscriptions)
    .where(eq(schema.watchlistSubscriptions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Mark a watchlist_job failed with the given reason + details. */
async function markJobFailed(
  jobId: string,
  reason: string,
  details: string,
  now: Date,
): Promise<void> {
  try {
    await db()
      .update(schema.watchlistJobs)
      .set({
        status: 'failed',
        failureReason: reason,
        failureDetails: details,
        completedAt: now,
      })
      .where(eq(schema.watchlistJobs.id, jobId));
  } catch (err) {
    logger.warn(
      { err, jobId },
      'watchlist-worker: failed to mark job failed (non-fatal)',
    );
  }
}

/**
 * Look up + decrypt the latest credential bag for a sourceId. Returns
 * undefined when no row exists (so adapters can emit auth-required).
 */
async function readDecryptedCredentialsBag(
  sourceId: string,
): Promise<Record<string, unknown> | undefined> {
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

/**
 * Persist refreshed credentials emitted by an adapter mid-discovery. Mirrors
 * the merge pattern in the V2-003 ingest pipeline so partial-refresh callbacks
 * (token-only) don't drop longer-lived fields like `clientId`/`clientSecret`.
 */
async function persistRefreshedCredentials(
  sourceId: string,
  newCredentials: Record<string, unknown>,
): Promise<void> {
  const secret = process.env.LOOTGOBLIN_SECRET;
  if (!secret) {
    logger.warn(
      { sourceId },
      'watchlist-worker: LOOTGOBLIN_SECRET unavailable — refreshed credentials NOT persisted',
    );
    return;
  }

  const rows = await db()
    .select({
      id: schema.sourceCredentials.id,
      encryptedBlob: schema.sourceCredentials.encryptedBlob,
    })
    .from(schema.sourceCredentials)
    .where(eq(schema.sourceCredentials.sourceId, sourceId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    logger.warn(
      { sourceId },
      'watchlist-worker: no source_credentials row to persist refreshed credentials — skipping',
    );
    return;
  }

  // Merge with existing bag so callbacks that only echo a subset of fields
  // don't drop the rest (matches V2-003-T9-L1 pattern).
  let merged: Record<string, unknown> = newCredentials;
  try {
    const buf = Buffer.from(row.encryptedBlob as Uint8Array);
    const existingJson = decrypt(buf.toString('utf8'), secret);
    const existing = JSON.parse(existingJson);
    if (existing && typeof existing === 'object') {
      merged = { ...(existing as Record<string, unknown>), ...newCredentials };
    }
  } catch (mergeErr) {
    logger.warn(
      { sourceId, err: mergeErr },
      'watchlist-worker: failed to merge with existing credential bag — writing new bag only',
    );
  }

  const blob = JSON.stringify(merged);
  const encrypted = encrypt(blob, secret);
  await db()
    .update(schema.sourceCredentials)
    .set({
      encryptedBlob: Buffer.from(encrypted),
      lastUsedAt: new Date(),
    })
    .where(eq(schema.sourceCredentials.id, row.id));
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export for tests + instrumentation that want a single import surface.
export { resetStaleRunningWatchlistJobs };

// Suppress unused import warnings — these are part of the documented API
// surface used by future tests + UI integrations.
void inArray;
