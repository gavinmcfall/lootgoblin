/**
 * GET /api/v1/ingest/:jobId — V2-003-T9
 *
 * Returns the current state of an ingest job. Returns 404 (not 403) when the
 * job exists but is owned by a different user, to avoid leaking job ids.
 *
 * See ../route.ts for the POST + list documentation, including the
 * documented two-API-key boundary and the legacy-route coexistence.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { authenticateRequest, INVALID_API_KEY, unauthenticatedResponse } from '@/auth/request-auth';
import { getServerDb, schema } from '@/db/client';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  // TODO(scope-enforcement): once the BetterAuth `apikey` plugin is wired,
  // require the `ingest:read` scope here instead of accepting any programmatic key.
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return unauthenticatedResponse(actor as null | typeof INVALID_API_KEY);
  }

  const { jobId } = await context.params;
  if (!jobId) {
    return NextResponse.json({ error: 'invalid-path', reason: 'missing jobId' }, { status: 400 });
  }

  const db = getServerDb();

  const rows = await db
    .select({
      id: schema.ingestJobs.id,
      ownerId: schema.ingestJobs.ownerId,
      sourceId: schema.ingestJobs.sourceId,
      collectionId: schema.ingestJobs.collectionId,
      status: schema.ingestJobs.status,
      lootId: schema.ingestJobs.lootId,
      failureReason: schema.ingestJobs.failureReason,
      failureDetails: schema.ingestJobs.failureDetails,
      attempt: schema.ingestJobs.attempt,
      createdAt: schema.ingestJobs.createdAt,
      updatedAt: schema.ingestJobs.updatedAt,
    })
    .from(schema.ingestJobs)
    .where(and(eq(schema.ingestJobs.id, jobId), eq(schema.ingestJobs.ownerId, actor.id)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    // Don't distinguish between "job missing" and "job belongs to another user".
    return NextResponse.json({ error: 'not-found', reason: 'job-not-found' }, { status: 404 });
  }

  return NextResponse.json({
    jobId: row.id,
    status: row.status,
    sourceId: row.sourceId,
    collectionId: row.collectionId,
    attempt: row.attempt,
    createdAt: row.createdAt?.toISOString(),
    updatedAt: row.updatedAt?.toISOString(),
    ...(row.lootId ? { lootId: row.lootId } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    ...(row.failureDetails ? { failureDetails: row.failureDetails } : {}),
  });
}
