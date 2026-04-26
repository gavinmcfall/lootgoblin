/**
 * GET /api/v1/watchlist/subscriptions/:id/firings — V2-004-T9
 *
 * List `watchlist_jobs` rows for a subscription — the firing history. Used
 * by the UI's "subscription detail" page to show recent firings + their
 * outcomes (completed / failed / in-progress).
 *
 * Owner-only ACL via the shared loader (see `../../_shared.ts`); a 404 is
 * returned if the subscription is not owned by the caller.
 *
 * Cursor: numeric ms string of `created_at` (descending), same shape as the
 * other list endpoints. Optional `status` filter (queued/claimed/running/
 * completed/failed).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, desc, eq, lt } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { loadSubscriptionForActor } from '../../_shared';

const ListQuery = z.object({
  status: z
    .enum(['queued', 'claimed', 'running', 'completed', 'failed'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const loaded = await loadSubscriptionForActor(req, id);
  if (!loaded.ok) return loaded.response;

  const url = new URL(req.url);
  const queryRaw = {
    status: url.searchParams.get('status') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  };
  const queryParsed = ListQuery.safeParse(queryRaw);
  if (!queryParsed.success) {
    return NextResponse.json(
      { error: 'invalid-query', issues: queryParsed.error.issues },
      { status: 400 },
    );
  }
  const { status, limit, cursor } = queryParsed.data;

  const db = getServerDb();
  const conditions = [eq(schema.watchlistJobs.subscriptionId, id)];
  if (status) conditions.push(eq(schema.watchlistJobs.status, status));
  if (cursor) {
    const cursorMs = Number(cursor);
    if (!Number.isFinite(cursorMs)) {
      return NextResponse.json(
        { error: 'invalid-query', reason: 'cursor must be a numeric ms timestamp' },
        { status: 400 },
      );
    }
    conditions.push(lt(schema.watchlistJobs.createdAt, new Date(cursorMs)));
  }

  const rows = await db
    .select({
      id: schema.watchlistJobs.id,
      subscriptionId: schema.watchlistJobs.subscriptionId,
      status: schema.watchlistJobs.status,
      claimedAt: schema.watchlistJobs.claimedAt,
      startedAt: schema.watchlistJobs.startedAt,
      completedAt: schema.watchlistJobs.completedAt,
      itemsDiscovered: schema.watchlistJobs.itemsDiscovered,
      itemsEnqueued: schema.watchlistJobs.itemsEnqueued,
      failureReason: schema.watchlistJobs.failureReason,
      failureDetails: schema.watchlistJobs.failureDetails,
      createdAt: schema.watchlistJobs.createdAt,
    })
    .from(schema.watchlistJobs)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(schema.watchlistJobs.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && sliced.length > 0
      ? String(sliced[sliced.length - 1]!.createdAt.getTime())
      : undefined;

  return NextResponse.json({
    firings: sliced.map((r) => ({
      id: r.id,
      subscriptionId: r.subscriptionId,
      status: r.status,
      itemsDiscovered: r.itemsDiscovered,
      itemsEnqueued: r.itemsEnqueued,
      claimedAt: r.claimedAt ? r.claimedAt.toISOString() : null,
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      ...(r.failureReason ? { failureReason: r.failureReason } : {}),
      ...(r.failureDetails ? { failureDetails: r.failureDetails } : {}),
      createdAt: r.createdAt.toISOString(),
    })),
    ...(nextCursor ? { nextCursor } : {}),
  });
}
