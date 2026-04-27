/**
 * Google Drive push-notification handler — V2-004b-T4.
 *
 * The route at `apps/server/src/app/api/v1/watchlist/gdrive/notification`
 * is a thin HTTP shim: it parses the `X-Goog-*` headers, calls
 * `handleGdrivePushNotification`, then maps the structured result to a
 * Response. All business logic — channel lookup, constant-time token
 * compare, message-number dedup, in-flight detection, paused-subscription
 * drop, watchlist_job enqueue — lives here so it can be unit-tested
 * without spinning up Next.js.
 *
 * Architectural decisions (locked in T4 design):
 *
 *   1. Resource states map to actions:
 *        'sync' → no-op (registration confirmation Google sends once).
 *        'change' | 'add' | 'update' | 'remove' | 'trash' | 'untrash' →
 *           enqueue a watchlist_job. The subscription's discovery pass
 *           will figure out what changed; even removes/trashes matter
 *           because the user's discovery includes "files I had access to
 *           that are now gone".
 *        anything else → log warn + return 200 (forward-compat).
 *
 *   2. In-flight detection: identical to the V2-004 scheduler. If any
 *      watchlist_job exists for this subscription with status in
 *      ('queued', 'claimed', 'running'), skip the enqueue. The firing
 *      already in flight will pick up the changes that triggered the
 *      push. We STILL advance `last_message_number` because the push
 *      WAS received — only the enqueue is suppressed.
 *
 *   3. Paused-subscription drop: if the subscription is `active=0`, the
 *      channel SHOULD have been unregistered on pause but Google may
 *      still deliver a few pushes until the unsubscribe propagates. We
 *      drop and return 200.
 *
 *   4. `last_fired_at` is NOT touched by pushes. Pushes are not
 *      "we've fired"; they are "Google says something changed". The
 *      worker handles `last_fired_at` on completion of the resulting
 *      watchlist_job, indistinguishable from a cadence-fired firing.
 *
 *   5. Idempotency under retries: Google may retry on transient 5xx.
 *      The handler tracks `last_message_number` per channel and silently
 *      drops pushes whose `X-Goog-Message-Number` is ≤ the stored value.
 *      The compare + INSERT + UPDATE happen in a single sync better-sqlite3
 *      transaction so a crash mid-flight cannot lose a push or
 *      double-enqueue.
 *
 *   6. Constant-time token compare via `crypto.timingSafeEqual`,
 *      identical to the V2-003-T9 OAuth-state pattern. Length-mismatch is
 *      rejected before the compare so we never throw.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

import { logger } from '@/logger';
import { getServerDb, schema } from '@/db/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PushNotificationInput {
  channelId: string;
  channelToken: string;
  resourceState: string;
  resourceId: string | null;
  /** Parsed `X-Goog-Message-Number` (numeric string from Google). NULL if absent or unparseable. */
  messageNumber: number | null;
}

export type PushHandlerResult =
  | { ok: true; action: 'enqueued'; watchlistJobId: string }
  | { ok: true; action: 'sync-confirmed' }
  | {
      ok: true;
      action: 'no-op';
      reason:
        | 'already-in-flight'
        | 'subscription-paused'
        | 'subscription-deleted'
        | 'duplicate-message'
        | 'unknown-resource-state';
    }
  | {
      ok: false;
      reason: 'unknown-channel' | 'invalid-token' | 'missing-headers';
      httpStatus: number;
    };

// ---------------------------------------------------------------------------
// Resource-state classification
// ---------------------------------------------------------------------------

/**
 * Resource states that warrant enqueuing a watchlist_job. Even `remove` /
 * `trash` are included — the user's view includes "files that were once
 * available and now aren't", so the worker needs to re-run discovery to
 * reconcile the local cursor.
 */
const CHANGE_RESOURCE_STATES = new Set([
  'change',
  'add',
  'update',
  'remove',
  'trash',
  'untrash',
]);

// ---------------------------------------------------------------------------
// DB type alias
// ---------------------------------------------------------------------------

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

// In-flight statuses — a watchlist_job in any of these blocks a fresh enqueue.
const IN_FLIGHT_STATUSES = ['queued', 'claimed', 'running'] as const;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Handle a single Google Drive push notification.
 *
 * Pure function over the DB — does NOT touch HTTP. The route maps the
 * `PushHandlerResult` to a Response.
 */
export async function handleGdrivePushNotification(
  input: PushNotificationInput,
  opts: { dbUrl?: string; now?: Date } = {},
): Promise<PushHandlerResult> {
  const { channelId, channelToken, resourceState, messageNumber } = input;
  const now = opts.now ?? new Date();
  const db = getServerDb(opts.dbUrl);

  // ── Channel lookup ──────────────────────────────────────────────────────
  const channelRows = await db
    .select()
    .from(schema.gdriveWatchChannels)
    .where(eq(schema.gdriveWatchChannels.channelId, channelId))
    .limit(1);
  const channel = channelRows[0];
  if (!channel) {
    logger.warn({ channelId }, 'gdrive-push: unknown channel id');
    return { ok: false, reason: 'unknown-channel', httpStatus: 401 };
  }

  // ── Constant-time token compare ─────────────────────────────────────────
  const a = Buffer.from(channel.token, 'utf8');
  const b = Buffer.from(channelToken, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logger.warn({ channelId }, 'gdrive-push: token mismatch');
    return { ok: false, reason: 'invalid-token', httpStatus: 401 };
  }

  // ── 'sync' confirmation ─────────────────────────────────────────────────
  // Google sends `X-Goog-Resource-State: sync` exactly once per channel,
  // immediately after registration. No payload, no action — just ack.
  if (resourceState === 'sync') {
    logger.info(
      { channelId, subscriptionId: channel.subscriptionId },
      'gdrive-push: sync (registration confirmed)',
    );
    return { ok: true, action: 'sync-confirmed' };
  }

  // ── Unknown resource state ──────────────────────────────────────────────
  // Forward-compat: future Google states get a warn + 200 so we never
  // hammer ourselves into a retry loop on a state we don't yet handle.
  if (!CHANGE_RESOURCE_STATES.has(resourceState)) {
    logger.warn(
      {
        channelId,
        subscriptionId: channel.subscriptionId,
        resourceState,
      },
      'gdrive-push: unknown resource state — ignoring',
    );
    return { ok: true, action: 'no-op', reason: 'unknown-resource-state' };
  }

  // ── Subscription lookup (paused / deleted check) ────────────────────────
  // Cascade deletes should make 'subscription-deleted' unreachable, but a
  // race between channel-row read and subscription-delete commit could
  // theoretically expose it. Defensive guard.
  const subRows = await db
    .select({
      id: schema.watchlistSubscriptions.id,
      active: schema.watchlistSubscriptions.active,
    })
    .from(schema.watchlistSubscriptions)
    .where(eq(schema.watchlistSubscriptions.id, channel.subscriptionId))
    .limit(1);
  const sub = subRows[0];
  if (!sub) {
    logger.warn(
      { channelId, subscriptionId: channel.subscriptionId },
      'gdrive-push: channel references missing subscription — dropping',
    );
    return { ok: true, action: 'no-op', reason: 'subscription-deleted' };
  }
  if (sub.active !== 1) {
    logger.info(
      { channelId, subscriptionId: channel.subscriptionId },
      'gdrive-push: subscription paused — dropping push',
    );
    return { ok: true, action: 'no-op', reason: 'subscription-paused' };
  }

  // ── Message-number dedup + atomic enqueue ───────────────────────────────
  // Wrap the read-current-message-number / in-flight-check / INSERT /
  // UPDATE in a single sync better-sqlite3 transaction so a crash mid-flight
  // can't (a) leave us with last_message_number bumped without an enqueue,
  // or (b) double-enqueue when the retry arrives.
  const txResult = (
    db as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }
  ).transaction((tx): TxOutcome => {
    const t = tx as DB;

    // Re-read the channel row inside the transaction to pick up any
    // last_message_number advance from a parallel push.
    const refreshed = t
      .select({ lastMessageNumber: schema.gdriveWatchChannels.lastMessageNumber })
      .from(schema.gdriveWatchChannels)
      .where(eq(schema.gdriveWatchChannels.id, channel.id))
      .limit(1)
      .all();
    const stored = refreshed[0]?.lastMessageNumber ?? null;

    // Dedup: silently drop if we have already accepted an equal-or-newer
    // message on this channel. NULL message numbers (rare/synthetic) are
    // accepted unconditionally — there is nothing to compare against.
    if (
      messageNumber !== null &&
      stored !== null &&
      messageNumber <= stored
    ) {
      return { kind: 'duplicate' };
    }

    // In-flight check: another firing is already racing toward the same
    // discovery work. Suppress the new enqueue but advance
    // last_message_number — the push WAS received, we just don't need a
    // second job for it.
    const inFlight = t
      .select({ id: schema.watchlistJobs.id })
      .from(schema.watchlistJobs)
      .where(
        and(
          eq(schema.watchlistJobs.subscriptionId, channel.subscriptionId),
          inArray(
            schema.watchlistJobs.status,
            IN_FLIGHT_STATUSES as unknown as string[],
          ),
        ),
      )
      .limit(1)
      .all();

    if (inFlight.length > 0) {
      if (messageNumber !== null) {
        t.update(schema.gdriveWatchChannels)
          .set({ lastMessageNumber: messageNumber })
          .where(eq(schema.gdriveWatchChannels.id, channel.id))
          .run();
      }
      return { kind: 'in-flight' };
    }

    // Atomic enqueue + bump last_message_number.
    const watchlistJobId = randomUUID();
    t.insert(schema.watchlistJobs)
      .values({
        id: watchlistJobId,
        subscriptionId: channel.subscriptionId,
        status: 'queued',
        itemsDiscovered: 0,
        itemsEnqueued: 0,
        createdAt: now,
      })
      .run();
    if (messageNumber !== null) {
      t.update(schema.gdriveWatchChannels)
        .set({ lastMessageNumber: messageNumber })
        .where(eq(schema.gdriveWatchChannels.id, channel.id))
        .run();
    }
    return { kind: 'enqueued', watchlistJobId };
  });

  if (txResult.kind === 'duplicate') {
    logger.info(
      {
        channelId,
        subscriptionId: channel.subscriptionId,
        messageNumber,
      },
      'gdrive-push: duplicate / out-of-order message — dropped',
    );
    return { ok: true, action: 'no-op', reason: 'duplicate-message' };
  }

  if (txResult.kind === 'in-flight') {
    logger.info(
      {
        channelId,
        subscriptionId: channel.subscriptionId,
        messageNumber,
      },
      'gdrive-push: existing watchlist_job in flight — skipping enqueue',
    );
    return { ok: true, action: 'no-op', reason: 'already-in-flight' };
  }

  logger.info(
    {
      channelId,
      subscriptionId: channel.subscriptionId,
      resourceState,
      messageNumber,
      watchlistJobId: txResult.watchlistJobId,
    },
    'gdrive-push: change notification — watchlist_job enqueued',
  );
  return { ok: true, action: 'enqueued', watchlistJobId: txResult.watchlistJobId };
}

type TxOutcome =
  | { kind: 'enqueued'; watchlistJobId: string }
  | { kind: 'in-flight' }
  | { kind: 'duplicate' };
