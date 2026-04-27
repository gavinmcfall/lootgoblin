/**
 * GET /api/v1/forge/dispatch/:id — read a single DispatchJob
 *
 * V2-005a-T5. Owner sees own; admin sees all. Cross-owner → 404.
 *
 * No PATCH/DELETE on dispatch jobs in V2-005a — the state machine is driven
 * by the worker layer. Future tasks may add an explicit cancel endpoint.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';

import {
  errorResponse,
  requireAuth,
  toDispatchJobDto,
} from '../../_shared';

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

  // Cross-owner: 404 unless admin.
  if (actor.role !== 'admin' && row.ownerId !== actor.id) {
    return errorResponse('not-found', 'dispatch-not-found', 404);
  }

  return NextResponse.json({ job: toDispatchJobDto(row) });
}
