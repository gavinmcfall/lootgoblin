/**
 * Read-side helpers for `gdrive_watch_channels` — V2-004b-T1.
 *
 * The webhook route (POST /api/v1/watchlist/gdrive/notification) and the
 * subscription-management code paths use these helpers to look up channel
 * rows without each site duplicating the Drizzle query shape.
 *
 * Write-side helpers (`createGdriveChannel`, `markChannelRefreshing`,
 * `markChannelExpired`, etc) come in T2 (registration) and T3 (refresh).
 */

import { and, eq, lte } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';

type GdriveWatchChannelRow = typeof schema.gdriveWatchChannels.$inferSelect;

function db(opts?: { dbUrl?: string }): ReturnType<typeof getServerDb> {
  return getServerDb(opts?.dbUrl);
}

/**
 * Fetch the channel row matching the `X-Goog-Channel-ID` header value.
 *
 * Returns `null` when no row exists — the webhook treats this as
 * "unknown-channel" and rejects with 401.
 */
export async function getGdriveWatchChannelByChannelId(
  channelId: string,
  opts?: { dbUrl?: string },
): Promise<GdriveWatchChannelRow | null> {
  const rows = await db(opts)
    .select()
    .from(schema.gdriveWatchChannels)
    .where(eq(schema.gdriveWatchChannels.channelId, channelId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * List active channels, optionally restricted to those whose
 * `expirationMs` is at or before a cutoff. Used by the T3 refresh worker
 * (`expiringBeforeMs = now + bufferMs`) to find rows that need rolling.
 */
export async function listActiveGdriveChannels(opts?: {
  dbUrl?: string;
  expiringBeforeMs?: number;
}): Promise<GdriveWatchChannelRow[]> {
  const conditions = [eq(schema.gdriveWatchChannels.status, 'active')];
  if (typeof opts?.expiringBeforeMs === 'number') {
    conditions.push(
      lte(schema.gdriveWatchChannels.expirationMs, new Date(opts.expiringBeforeMs)),
    );
  }
  return db(opts)
    .select()
    .from(schema.gdriveWatchChannels)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions));
}

/**
 * Fetch the (single) channel row attached to a subscription, if any.
 *
 * The subscription→channel relationship is 1:1; a UNIQUE constraint per
 * subscription is NOT enforced at the DB level (T2 owns the upsert flow
 * and may briefly hold two rows during refresh-then-rotate). Callers that
 * want "the channel" should treat the result as the most recently created
 * row when more than one exists.
 */
export async function getGdriveChannelForSubscription(
  subscriptionId: string,
  opts?: { dbUrl?: string },
): Promise<GdriveWatchChannelRow | null> {
  const rows = await db(opts)
    .select()
    .from(schema.gdriveWatchChannels)
    .where(eq(schema.gdriveWatchChannels.subscriptionId, subscriptionId))
    .limit(1);
  return rows[0] ?? null;
}
