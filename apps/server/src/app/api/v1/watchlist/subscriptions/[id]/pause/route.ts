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
import { loadSubscriptionForActor } from '../../_shared';

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

  return new Response(null, { status: 204 });
}
