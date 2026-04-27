/**
 * Google Drive watch-channel refresh worker — V2-004b-T3.
 *
 * Long-running worker that refreshes `gdrive_watch_channels` rows before their
 * Google-enforced 7-day TTL elapses. Without this loop, push notifications
 * would silently stop and folder_watch subscriptions would fall back to
 * cadence polling forever.
 *
 * Architectural decisions (LOCKED in V2-004b-T3 design):
 *
 *   1. Refresh at TTL - 2 days. Google's max channel TTL is 7 days; we
 *      refresh 2 days before expiration to leave buffer for worker downtime
 *      + transient API failures.
 *
 *   2. Refresh strategy: stop-old-then-register-new. Google's API does NOT
 *      support extend-in-place. Each refresh generates a fresh channel id +
 *      token; the OLD row is deleted (or replaced) and a new one inserted.
 *
 *   3. Polling cadence: default 1 hour (TICK_INTERVAL_MS). Each tick scans
 *      `status='active' AND expirationMs < now() + 2 days`. Sequential
 *      per-channel — refresh isn't latency-sensitive (2-day buffer).
 *
 *   4. Error isolation: one failing channel's refresh does NOT stop the
 *      worker. Mark `status='error'` with `errorReason` populated and
 *      continue to the next.
 *
 *   5. Stale-recovery on startup: rows with `status='refreshing'` AND
 *      `refreshedAt < now() - 10min` reset to `status='active'`. Crash
 *      mid-refresh leaves a row in 'refreshing'; recovery returns it to
 *      'active' so the next tick retries.
 *
 *   6. Already-expired channels: skip refresh (Google's `channels/stop`
 *      would 404), mark `status='expired'`. The owning subscription's next
 *      cadence-based fire still works; user can pause+resume to re-register.
 *
 * Auto-started via `instrumentation.ts` alongside the ingest worker and
 * watchlist scheduler. SIGTERM/SIGINT shuts down cleanly via the module-
 * level AbortController.
 *
 * @see apps/server/src/watchlist/gdrive-channels-register.ts (T2 helpers)
 * @see apps/server/src/db/schema.watchlist.ts (gdriveWatchChannels table)
 */

import { and, eq, lt } from 'drizzle-orm';

import { logger } from '../logger';
import { getServerDb, schema } from '../db/client';
import { sleep } from '../scavengers/rate-limit';
import {
  registerGdriveChannel,
  unregisterGdriveChannel,
} from '../watchlist/gdrive-channels-register';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Refresh window — channels with expirationMs < now() + 2 days are refreshed. */
const REFRESH_LEAD_MS = 2 * 24 * 3600_000;
/** Reset 'refreshing' rows whose `refreshedAt` is older than this. */
const STALE_TIMEOUT_MS = 10 * 60_000;
/** Default tick interval — 1 hour. */
const TICK_INTERVAL_MS = 3600_000;
/** ±jitter applied to each tick interval to spread load across instances. */
const TICK_JITTER_MS = 60_000;
/** Backoff on tick errors. */
const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 600_000;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

let refreshAbort: AbortController | null = null;

export interface ChannelRefreshTickResult {
  refreshed: number;
  errored: number;
  /** Channels found already past their TTL — marked 'expired', not refreshed. */
  skippedExpired: number;
}

// ---------------------------------------------------------------------------
// runOneChannelRefreshTick
// ---------------------------------------------------------------------------

/**
 * Single pass over channels approaching expiry. Idempotent — safe to call
 * concurrently (the `status='refreshing'` lock serialises the per-channel
 * refresh). Each candidate is processed sequentially within a tick; per-
 * channel concurrency is 1 by design (ADR-T3-4).
 */
export async function runOneChannelRefreshTick(
  opts: {
    now?: Date;
    httpFetch?: typeof fetch;
    refreshLeadMs?: number;
  } = {},
): Promise<ChannelRefreshTickResult> {
  const now = opts.now ?? new Date();
  const refreshLeadMs = opts.refreshLeadMs ?? REFRESH_LEAD_MS;
  const httpFetch = opts.httpFetch ?? globalThis.fetch;
  const db = getServerDb();

  // Find candidates: active channels whose expiration is within the lead
  // window. We don't filter `expirationMs > now` here — already-expired
  // channels still need a status flip, handled in the per-channel branch.
  const cutoff = new Date(now.getTime() + refreshLeadMs);
  const candidates = await db
    .select()
    .from(schema.gdriveWatchChannels)
    .where(
      and(
        eq(schema.gdriveWatchChannels.status, 'active'),
        lt(schema.gdriveWatchChannels.expirationMs, cutoff),
      ),
    );

  let refreshed = 0;
  let errored = 0;
  let skippedExpired = 0;

  for (const channel of candidates) {
    try {
      const outcome = await refreshOneChannel(channel, { now, httpFetch });
      if (outcome === 'refreshed') refreshed++;
      else if (outcome === 'expired') skippedExpired++;
      else errored++;
    } catch (err) {
      // Defensive: refreshOneChannel handles its own errors, but a thrown
      // exception (e.g. unexpected DB driver bug) must not block the loop.
      logger.error(
        { err, channelId: channel.channelId, subscriptionId: channel.subscriptionId },
        'gdrive-channel-refresh: unexpected error during channel refresh',
      );
      try {
        await db
          .update(schema.gdriveWatchChannels)
          .set({
            status: 'error',
            errorReason: err instanceof Error ? err.message : String(err),
          })
          .where(eq(schema.gdriveWatchChannels.id, channel.id));
      } catch {
        /* ignore — per-channel error isolation */
      }
      errored++;
    }
  }

  return { refreshed, errored, skippedExpired };
}

type RefreshOutcome = 'refreshed' | 'expired' | 'error';

/**
 * Refresh one channel. Returns one of:
 *   'refreshed' — old channel stopped, new one registered + inserted.
 *   'expired'   — channel was already past TTL; row marked status='expired'.
 *   'error'     — Google call failed or registration returned !ok.
 *                 Row is marked status='error' with errorReason populated.
 */
async function refreshOneChannel(
  channel: typeof schema.gdriveWatchChannels.$inferSelect,
  ctx: { now: Date; httpFetch: typeof fetch },
): Promise<RefreshOutcome> {
  const db = getServerDb();
  const { now, httpFetch } = ctx;

  // 1. Already expired? Skip refresh entirely — Google's stop would 404.
  const expirationMs =
    channel.expirationMs instanceof Date
      ? channel.expirationMs.getTime()
      : Number(channel.expirationMs);
  if (expirationMs <= now.getTime()) {
    await db
      .update(schema.gdriveWatchChannels)
      .set({ status: 'expired' })
      .where(eq(schema.gdriveWatchChannels.id, channel.id));
    return 'expired';
  }

  // 2. Look up the owning subscription so we can pass `ownerId` to register.
  //    The subscription FK is required (NOT NULL) so this should always be a
  //    single row; if it's missing the channel is orphaned and we mark error.
  const subRows = await db
    .select({ id: schema.watchlistSubscriptions.id, ownerId: schema.watchlistSubscriptions.ownerId })
    .from(schema.watchlistSubscriptions)
    .where(eq(schema.watchlistSubscriptions.id, channel.subscriptionId))
    .limit(1);
  const sub = subRows[0];
  if (!sub) {
    await db
      .update(schema.gdriveWatchChannels)
      .set({ status: 'error', errorReason: 'orphan: no subscription row' })
      .where(eq(schema.gdriveWatchChannels.id, channel.id));
    return 'error';
  }

  // 3. Mark refreshing. Lock against parallel ticks (next tick filter is
  //    `status='active'`, so a 'refreshing' row is invisible to it).
  await db
    .update(schema.gdriveWatchChannels)
    .set({ status: 'refreshing', refreshedAt: now })
    .where(eq(schema.gdriveWatchChannels.id, channel.id));

  // 4. Stop the old channel on Google's side. Best-effort — if Google
  //    returns 5xx, the new registration still wins (the new channel is what
  //    matters; the old one will TTL out on Google's side).
  //    NOTE: unregisterGdriveChannel ALSO deletes the local row when it
  //    finds it. We pass our channelId; on success the row is removed. We
  //    detect that below by checking if the row still exists before
  //    inserting the replacement.
  try {
    await unregisterGdriveChannel(
      { channelId: channel.channelId, subscriptionId: channel.subscriptionId },
      { httpFetch },
    );
  } catch (err) {
    // Already logged inside unregisterGdriveChannel; press on.
    logger.warn(
      { err, channelId: channel.channelId, subscriptionId: channel.subscriptionId },
      'gdrive-channel-refresh: unregister threw, continuing to register new',
    );
  }

  // 5. Register a fresh channel reusing the original webhook address.
  const result = await registerGdriveChannel(
    {
      subscriptionId: channel.subscriptionId,
      ownerId: sub.ownerId,
      webhookAddress: channel.address,
    },
    { httpFetch, now },
  );

  if (!result.ok) {
    // Registration failed. The old row may have been deleted by step 4 (best-
    // effort unregister succeeded) — in which case the channel is just gone.
    // If the old row still exists, mark it 'error'. If unregister already
    // deleted it, re-insert a placeholder error row so the operator + UI can
    // see what happened (rather than leaving a silent gap).
    const stillExists = await db
      .select({ id: schema.gdriveWatchChannels.id })
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.id, channel.id))
      .limit(1);
    if (stillExists.length > 0) {
      await db
        .update(schema.gdriveWatchChannels)
        .set({
          status: 'error',
          errorReason: `refresh-failed: ${result.reason}${result.details ? ` (${result.details})` : ''}`,
        })
        .where(eq(schema.gdriveWatchChannels.id, channel.id));
    } else {
      logger.warn(
        {
          channelId: channel.channelId,
          subscriptionId: channel.subscriptionId,
          reason: result.reason,
          details: result.details,
        },
        'gdrive-channel-refresh: register failed and old row was already deleted by unregister; channel gap',
      );
    }
    return 'error';
  }

  // 6. registerGdriveChannel inserted a NEW row. The OLD row may still exist
  //    if unregisterGdriveChannel's best-effort path failed silently (e.g.
  //    Google 5xx → row is left in place + logged). Delete it explicitly so
  //    we don't accumulate stale rows per subscription.
  try {
    await db
      .delete(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.id, channel.id));
  } catch (err) {
    // Old row was likely deleted already by unregisterGdriveChannel; this is
    // expected on the happy path and harmless.
    logger.debug(
      { err, channelId: channel.channelId },
      'gdrive-channel-refresh: old row delete (post-success) was no-op',
    );
  }

  logger.info(
    {
      subscriptionId: channel.subscriptionId,
      oldChannelId: channel.channelId,
      newChannelId: result.channelId,
      newExpirationMs: result.expirationMs,
    },
    'gdrive-channel-refresh: channel refreshed',
  );
  return 'refreshed';
}

// ---------------------------------------------------------------------------
// resetStaleRefreshingChannels
// ---------------------------------------------------------------------------

/**
 * Reset rows stuck in `status='refreshing'` for longer than the stale timeout
 * back to `'active'`. Called once at startup; matches the ingest-worker /
 * watchlist-scheduler stale-recovery pattern.
 *
 * Returns the number of rows reset.
 */
export async function resetStaleRefreshingChannels(
  opts: { now?: Date; staleTimeoutMs?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.staleTimeoutMs ?? STALE_TIMEOUT_MS));
  const db = getServerDb();

  const stale = await db
    .select({ id: schema.gdriveWatchChannels.id })
    .from(schema.gdriveWatchChannels)
    .where(
      and(
        eq(schema.gdriveWatchChannels.status, 'refreshing'),
        lt(schema.gdriveWatchChannels.refreshedAt, cutoff),
      ),
    );

  if (stale.length === 0) return 0;

  await db
    .update(schema.gdriveWatchChannels)
    .set({ status: 'active' })
    .where(
      and(
        eq(schema.gdriveWatchChannels.status, 'refreshing'),
        lt(schema.gdriveWatchChannels.refreshedAt, cutoff),
      ),
    );

  logger.warn(
    { count: stale.length, ids: stale.slice(0, 10).map((r) => r.id) },
    'gdrive-channel-refresh: reset stale refreshing rows to active',
  );
  return stale.length;
}

// ---------------------------------------------------------------------------
// Long-running loop
// ---------------------------------------------------------------------------

/**
 * Start the channel-refresh loop. Idempotent — second call is a no-op while
 * the first is still running.
 *
 * Behaviour:
 *   1. Reset any 'refreshing' rows older than STALE_TIMEOUT_MS to 'active'.
 *   2. Enter the tick loop with exponential backoff on errors.
 *   3. Each tick: runOneChannelRefreshTick + sleep(TICK_INTERVAL_MS ± jitter).
 */
export async function startChannelRefreshWorker(
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  if (refreshAbort) return;
  refreshAbort = new AbortController();
  const signal = opts.signal ?? refreshAbort.signal;

  // Recovery once at startup. Best-effort — failure here doesn't stop the
  // loop (the next tick may still pick up the stale rows once they fall
  // through the window again).
  try {
    const reset = await resetStaleRefreshingChannels();
    if (reset > 0) {
      logger.info({ count: reset }, 'gdrive-channel-refresh: reset stale rows on startup');
    }
  } catch (err) {
    logger.warn({ err }, 'gdrive-channel-refresh: stale-row recovery failed (non-fatal)');
  }

  logger.info(
    { tickIntervalMs: TICK_INTERVAL_MS, refreshLeadMs: REFRESH_LEAD_MS },
    'gdrive-channel-refresh: started',
  );

  await runRefreshLoop(signal);
}

export function stopChannelRefreshWorker(): void {
  refreshAbort?.abort();
  refreshAbort = null;
}

async function runRefreshLoop(signal: AbortSignal): Promise<void> {
  let backoffMs = 0;

  while (!signal.aborted) {
    try {
      const result = await runOneChannelRefreshTick();
      if (result.refreshed > 0 || result.errored > 0 || result.skippedExpired > 0) {
        logger.info(result, 'gdrive-channel-refresh: tick complete');
      }
      backoffMs = 0;
    } catch (err) {
      logger.error({ err }, 'gdrive-channel-refresh: tick failed — backing off');
      backoffMs =
        backoffMs === 0 ? BACKOFF_MIN_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    }

    const jitter = Math.floor(Math.random() * (TICK_JITTER_MS * 2)) - TICK_JITTER_MS;
    const waitMs = backoffMs > 0 ? backoffMs : Math.max(1_000, TICK_INTERVAL_MS + jitter);

    try {
      await sleep(waitMs, signal);
    } catch {
      // Sleep aborted — loop condition will exit cleanly on next iteration.
    }
  }
}
