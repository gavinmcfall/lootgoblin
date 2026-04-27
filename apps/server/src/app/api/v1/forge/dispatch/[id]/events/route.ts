/**
 * GET /api/v1/forge/dispatch/:id/events
 *
 * V2-005a-T5: returns the dispatch_jobs row's status + lifecycle timestamps.
 * Future V2-005f will surface status-feed events from the printer/slicer
 * adapters; for T5 this is just the row's own state log.
 *
 * Owner-scoped (admin sees all). Cross-owner → 404.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';

import { errorResponse, requireAuth } from '../../../_shared';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  if (typeof id !== 'string' || id.length === 0) {
    return errorResponse('invalid-path', 'missing dispatch id', 400);
  }

  const db = getServerDb();
  const rows = await db
    .select()
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return errorResponse('not-found', 'dispatch-not-found', 404);
  }
  if (actor.role !== 'admin' && row.ownerId !== actor.id) {
    return errorResponse('not-found', 'dispatch-not-found', 404);
  }

  // Build a chronological event log from the row's lifecycle timestamps.
  // The order matches the state machine: created → claimed → started →
  // completed/failed. Each event includes the resulting status when knowable.
  const events: Array<{ at: number; kind: string; status?: string; details?: string }> = [];
  events.push({ at: row.createdAt.getTime(), kind: 'created', status: row.status });
  if (row.claimedAt) {
    events.push({
      at: row.claimedAt.getTime(),
      kind: 'claimed',
      status: 'claimed',
    });
  }
  if (row.startedAt) {
    events.push({
      at: row.startedAt.getTime(),
      kind: 'dispatched',
      status: 'dispatched',
    });
  }
  if (row.completedAt) {
    if (row.failureReason) {
      events.push({
        at: row.completedAt.getTime(),
        kind: 'failed',
        status: 'failed',
        details: row.failureDetails ?? row.failureReason,
      });
    } else {
      events.push({
        at: row.completedAt.getTime(),
        kind: 'completed',
        status: 'completed',
      });
    }
  }
  events.sort((a, b) => a.at - b.at);

  return NextResponse.json({
    jobId: row.id,
    status: row.status,
    failureReason: row.failureReason ?? null,
    failureDetails: row.failureDetails ?? null,
    events,
  });
}
