/**
 * POST /api/v1/watchlist/subscriptions/:id/pause — V2-004-T9
 *
 * Convenience wrapper over PATCH `{ active: false }`. Owner-only (same ACL
 * as the parent route). Returns 204 on success — clients re-read GET if
 * they need the latest row state.
 */

import { type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';
import { loadSubscriptionForActor } from '../../_shared';
import { expireGdriveChannel } from '@/watchlist/gdrive-channels-register';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const loaded = await loadSubscriptionForActor(req, id);
  if (!loaded.ok) return loaded.response;

  const db = getServerDb();
  await db
    .update(schema.watchlistSubscriptions)
    .set({ active: 0, updatedAt: new Date() })
    .where(eq(schema.watchlistSubscriptions.id, id));

  // V2-004b-T2: mark any GDrive push channel(s) as 'expired' locally. We do
  // NOT call channels/stop — the refresh worker (T3) skips expired rows and
  // Google times the channel out at TTL anyway. Saves an API roundtrip.
  try {
    const result = await expireGdriveChannel({ subscriptionId: id });
    if (!result.ok) {
      logger.warn(
        { subscriptionId: id, reason: result.reason },
        'gdrive-channel-expire: failed during pause (non-fatal)',
      );
    }
  } catch (expErr) {
    logger.warn(
      { subscriptionId: id, err: expErr },
      'gdrive-channel-expire: threw during pause (non-fatal)',
    );
  }

  return new Response(null, { status: 204 });
}
