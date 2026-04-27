/**
 * POST /api/v1/forge/dispatch — create a DispatchJob
 * GET  /api/v1/forge/dispatch — list caller's dispatch jobs (admin: all)
 *
 * V2-005a-T5.
 *
 * Body for POST:
 *   { lootId: string, targetKind: 'printer' | 'slicer', targetId: string }
 *
 * Returns:
 *   `{ job: <DispatchJobDto>, jobId: string, status: <initialStatus> }`
 *
 * Initial-status heuristic (T6 will refine via the TargetCompatibilityMatrix):
 *   - slicer-target → 'claimable' (slicers natively accept their input formats;
 *     no conversion or pre-slicing needed for the job to become claimable).
 *   - printer-target → 'pending' (V2-005b-c will determine whether conversion
 *     and/or slicing are needed and progress the row).
 *
 *   TODO(V2-005a-T6): replace this heuristic with the real format/target
 *   compatibility matrix.
 *
 * Validation:
 *   - lootId belongs to the actor (cross-owner → not-found)
 *   - target exists in the right table (printer / forge_slicer)
 *   - target belongs to the actor (cross-owner → not-found, unless admin)
 *   - actor has `push` ACL on the target
 *
 * Idempotency-Key supported on POST.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';
import {
  DISPATCH_TARGET_KINDS,
  type DispatchJobStatus,
} from '@/db/schema.forge';
import { createDispatchJob } from '@/forge/dispatch-jobs';
import { resolveAcl } from '@/acl/resolver';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  errorResponse,
  findByIdempotencyKey,
  requireAuth,
  toDispatchJobDto,
  tryClaimIdempotencyKey,
} from '../_shared';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CreateBody = z.object({
  lootId: z.string().min(1),
  targetKind: z.enum(DISPATCH_TARGET_KINDS),
  targetId: z.string().min(1),
});

const ListQuery = z.object({
  status: z.string().optional(),
  targetKind: z.enum(DISPATCH_TARGET_KINDS).optional(),
  lootId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().optional(),
});

function normalizeBody(body: z.infer<typeof CreateBody>, ownerId: string): string {
  return JSON.stringify({
    ownerId,
    lootId: body.lootId,
    targetKind: body.targetKind,
    targetId: body.targetId,
  });
}

function normalizeStored(row: typeof schema.dispatchJobs.$inferSelect): string {
  return JSON.stringify({
    ownerId: row.ownerId,
    lootId: row.lootId,
    targetKind: row.targetKind,
    targetId: row.targetId,
  });
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('invalid-body', 'JSON parse failed', 400);
  }
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid-body',
        message: 'request body failed validation',
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const db = getServerDb();
  const idempotencyKey = req.headers.get('Idempotency-Key');
  const normalized = normalizeBody(body, actor.id);

  if (idempotencyKey) {
    const prior = await findByIdempotencyKey<typeof schema.dispatchJobs.$inferSelect>(
      schema.dispatchJobs,
      schema.dispatchJobs.ownerId,
      schema.dispatchJobs.idempotencyKey,
      actor.id,
      idempotencyKey,
    );
    if (prior) {
      if (normalizeStored(prior) === normalized) {
        return NextResponse.json(
          { job: toDispatchJobDto(prior), jobId: prior.id, status: prior.status },
          { status: 200 },
        );
      }
      return NextResponse.json(
        {
          error: 'idempotency-mismatch',
          message: 'Idempotency-Key reused with a different request body',
          jobId: prior.id,
        },
        { status: 409 },
      );
    }
  }

  // Push-ACL gate: load the target's owner + grantees, ask the resolver.
  // Cross-owner → 404 not-found (don't leak existence). The push-ACL gate
  // honours the consent model — admins NOT exempt unless they're an explicit
  // grantee or owner.
  if (body.targetKind === 'printer') {
    const printerRows = await db
      .select({ ownerId: schema.printers.ownerId })
      .from(schema.printers)
      .where(eq(schema.printers.id, body.targetId))
      .limit(1);
    if (printerRows.length === 0) {
      return errorResponse('not-found', 'target-not-found', 404);
    }
    const grants = await db
      .select({ userId: schema.printerAcls.userId })
      .from(schema.printerAcls)
      .where(eq(schema.printerAcls.printerId, body.targetId));
    const decision = resolveAcl({
      user: actor,
      resource: {
        kind: 'printer',
        ownerId: printerRows[0]!.ownerId,
        id: body.targetId,
        aclGrantees: grants.map((g) => g.userId),
      },
      action: 'push',
    });
    if (!decision.allowed) {
      // Cross-owner / no-grant → mask as not-found (consistent with materials/
      // watchlist patterns).
      return errorResponse('not-found', 'target-not-found', 404);
    }
  } else {
    // 'slicer'
    const slicerRows = await db
      .select({ ownerId: schema.forgeSlicers.ownerId })
      .from(schema.forgeSlicers)
      .where(eq(schema.forgeSlicers.id, body.targetId))
      .limit(1);
    if (slicerRows.length === 0) {
      return errorResponse('not-found', 'target-not-found', 404);
    }
    const grants = await db
      .select({ userId: schema.slicerAcls.userId })
      .from(schema.slicerAcls)
      .where(eq(schema.slicerAcls.slicerId, body.targetId));
    const decision = resolveAcl({
      user: actor,
      resource: {
        kind: 'slicer',
        ownerId: slicerRows[0]!.ownerId,
        id: body.targetId,
        aclGrantees: grants.map((g) => g.userId),
      },
      action: 'push',
    });
    if (!decision.allowed) {
      return errorResponse('not-found', 'target-not-found', 404);
    }
  }

  // Initial-status heuristic (V2-005a-T5): slicer → claimable, printer →
  // pending. T6's TargetCompatibilityMatrix will refine.
  const initialStatus: DispatchJobStatus =
    body.targetKind === 'slicer' ? 'claimable' : 'pending';

  // createDispatchJob also validates loot ownership + target existence; if
  // the push gate above missed anything, the domain layer's
  // 'loot-not-found'/'target-not-found' fallbacks catch it.
  const result = await createDispatchJob({
    ownerId: actor.id,
    lootId: body.lootId,
    targetKind: body.targetKind,
    targetId: body.targetId,
    initialStatus,
  });
  if (!result.ok) {
    if (
      result.reason === 'loot-not-found' ||
      result.reason === 'target-not-found'
    ) {
      return errorResponse('not-found', result.reason, 404, result.details);
    }
    if (
      result.reason === 'invalid-target-kind' ||
      result.reason === 'invalid-status'
    ) {
      return errorResponse('invalid-body', result.reason, 400, result.details);
    }
    logger.error(
      { ownerId: actor.id, reason: result.reason },
      'POST /api/v1/forge/dispatch: createDispatchJob rejected',
    );
    return errorResponse('internal', result.reason, 500, result.details);
  }

  if (idempotencyKey) {
    const claim = await tryClaimIdempotencyKey(
      schema.dispatchJobs,
      schema.dispatchJobs.id,
      result.jobId,
      idempotencyKey,
    );
    if (!claim.ok) {
      try {
        await db.delete(schema.dispatchJobs).where(eq(schema.dispatchJobs.id, result.jobId));
      } catch (cleanupErr) {
        logger.warn(
          { err: cleanupErr, jobId: result.jobId },
          'POST /api/v1/forge/dispatch: cleanup of idempotency loser failed',
        );
      }
      const winner = await findByIdempotencyKey<typeof schema.dispatchJobs.$inferSelect>(
        schema.dispatchJobs,
        schema.dispatchJobs.ownerId,
        schema.dispatchJobs.idempotencyKey,
        actor.id,
        idempotencyKey,
      );
      if (winner) {
        return NextResponse.json(
          { job: toDispatchJobDto(winner), jobId: winner.id, status: winner.status },
          { status: 200 },
        );
      }
      return errorResponse('internal', 'failed to persist idempotency key', 500);
    }
  }

  const refreshed = await db
    .select()
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.id, result.jobId))
    .limit(1);
  return NextResponse.json(
    {
      job: toDispatchJobDto(refreshed[0]!),
      jobId: result.jobId,
      status: initialStatus,
      initialStatus,
    },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// GET — list
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const url = new URL(req.url);
  const queryParsed = ListQuery.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    targetKind: url.searchParams.get('targetKind') ?? undefined,
    lootId: url.searchParams.get('lootId') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  });
  if (!queryParsed.success) {
    return NextResponse.json(
      {
        error: 'invalid-query',
        message: 'invalid query parameters',
        issues: queryParsed.error.issues,
      },
      { status: 400 },
    );
  }
  const q = queryParsed.data;

  const db = getServerDb();
  const conditions = [];
  if (actor.role !== 'admin') {
    conditions.push(eq(schema.dispatchJobs.ownerId, actor.id));
  }
  if (q.status) conditions.push(eq(schema.dispatchJobs.status, q.status));
  if (q.targetKind) conditions.push(eq(schema.dispatchJobs.targetKind, q.targetKind));
  if (q.lootId) conditions.push(eq(schema.dispatchJobs.lootId, q.lootId));
  if (q.cursor) {
    const cursorMs = Number(q.cursor);
    if (!Number.isFinite(cursorMs)) {
      return errorResponse('invalid-query', 'cursor must be a numeric ms timestamp', 400);
    }
    conditions.push(lt(schema.dispatchJobs.createdAt, new Date(cursorMs)));
  }

  const whereClause =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
      ? conditions[0]
      : and(...conditions);

  const rows = await (whereClause
    ? db
        .select()
        .from(schema.dispatchJobs)
        .where(whereClause)
        .orderBy(desc(schema.dispatchJobs.createdAt), asc(schema.dispatchJobs.id))
        .limit(q.limit + 1)
    : db
        .select()
        .from(schema.dispatchJobs)
        .orderBy(desc(schema.dispatchJobs.createdAt), asc(schema.dispatchJobs.id))
        .limit(q.limit + 1));

  const hasMore = rows.length > q.limit;
  const sliced = hasMore ? rows.slice(0, q.limit) : rows;
  const nextCursor =
    hasMore && sliced.length > 0
      ? String(sliced[sliced.length - 1]!.createdAt.getTime())
      : undefined;

  return NextResponse.json({
    jobs: sliced.map(toDispatchJobDto),
    ...(nextCursor ? { nextCursor } : {}),
  });
}
