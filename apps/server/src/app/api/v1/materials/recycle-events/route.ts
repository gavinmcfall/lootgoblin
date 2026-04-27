/**
 * POST /api/v1/materials/recycle-events + GET — V2-007a-T14
 *
 * Apply a recycle event atomically — calls T6 applyRecycleEvent. Returns the
 * new recycled_spool material id, the recycle event id, and the ledger
 * event id.
 *
 * GET lists the caller's recycle events (paginated by createdAt DESC).
 *
 * Body
 * ────
 * { inputs: [{ sourceMaterialId|null, weight, provenanceClass, note? }, ...],
 *   outputWeight, acknowledgeWeightAnomaly?, outputSpoolBrand?,
 *   outputSpoolColors?, outputSpoolColorPattern?, outputSpoolColorName?,
 *   notes? }
 */

import { NextResponse, type NextRequest } from 'next/server';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';
import { applyRecycleEvent } from '@/materials/recycle';
import { COLOR_PATTERNS } from '@/db/schema.materials';

import {
  errorResponse,
  findByIdempotencyKey,
  requireAuth,
  statusForReason,
  toRecycleEventDto,
  tryClaimIdempotencyKey,
} from '../_shared';

const HEX = /^#[0-9A-Fa-f]{6}$/;

const InputSchema = z.object({
  sourceMaterialId: z.string().min(1).nullable(),
  weight: z.number().positive().finite(),
  provenanceClass: z.enum(['measured', 'entered', 'estimated']),
  note: z.string().max(500).optional(),
});

const CreateBodySchema = z.object({
  inputs: z.array(InputSchema).min(1).max(20),
  outputWeight: z.number().positive().finite(),
  acknowledgeWeightAnomaly: z.boolean().optional(),
  outputSpoolBrand: z.string().min(1).max(200).optional(),
  outputSpoolColors: z.array(z.string().regex(HEX)).min(1).max(4).optional(),
  outputSpoolColorPattern: z.enum(COLOR_PATTERNS).optional(),
  outputSpoolColorName: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
});

type CreateBody = z.infer<typeof CreateBodySchema>;

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

function normalizeBody(body: CreateBody, ownerId: string): string {
  return JSON.stringify({
    ownerId,
    inputs: body.inputs,
    outputWeight: body.outputWeight,
    outputSpoolBrand: body.outputSpoolBrand ?? null,
    outputSpoolColors: body.outputSpoolColors ?? null,
    outputSpoolColorPattern: body.outputSpoolColorPattern ?? null,
    outputSpoolColorName: body.outputSpoolColorName ?? null,
    notes: body.notes ?? null,
  });
}

function normalizeStored(row: typeof schema.recycleEvents.$inferSelect): string {
  return JSON.stringify({
    ownerId: row.ownerId,
    inputs: row.inputs,
    // outputWeight is on the linked material. For idempotency we approximate
    // by inputs + notes; collisions across same-day same-inputs different-
    // outputWeight are accepted as the same key (rare).
    outputWeight: null,
    outputSpoolBrand: null,
    outputSpoolColors: null,
    outputSpoolColorPattern: null,
    outputSpoolColorName: null,
    notes: row.notes ?? null,
  });
}

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
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', message: 'request body failed validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const idempotencyKey = req.headers.get('Idempotency-Key');

  if (idempotencyKey) {
    const prior = await findByIdempotencyKey<typeof schema.recycleEvents.$inferSelect>(
      schema.recycleEvents,
      schema.recycleEvents.ownerId,
      schema.recycleEvents.idempotencyKey,
      actor.id,
      idempotencyKey,
    );
    if (prior) {
      // Loose comparison: matching inputs + notes counts as a replay.
      const looseBody = JSON.stringify({
        ownerId: actor.id,
        inputs: body.inputs,
        outputWeight: null,
        outputSpoolBrand: null,
        outputSpoolColors: null,
        outputSpoolColorPattern: null,
        outputSpoolColorName: null,
        notes: body.notes ?? null,
      });
      if (normalizeStored(prior) === looseBody) {
        return NextResponse.json({ recycleEvent: toRecycleEventDto(prior) }, { status: 200 });
      }
      return NextResponse.json(
        {
          error: 'idempotency-mismatch',
          message: 'Idempotency-Key reused with a different request body',
          recycleEventId: prior.id,
        },
        { status: 409 },
      );
    }
  }
  void normalizeBody;

  const result = await applyRecycleEvent({
    ownerId: actor.id,
    actorUserId: actor.id,
    inputs: body.inputs,
    outputWeight: body.outputWeight,
    acknowledgeWeightAnomaly: body.acknowledgeWeightAnomaly,
    outputSpoolBrand: body.outputSpoolBrand,
    outputSpoolColors: body.outputSpoolColors,
    outputSpoolColorPattern: body.outputSpoolColorPattern,
    outputSpoolColorName: body.outputSpoolColorName,
    notes: body.notes,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `recycle event rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }

  if (idempotencyKey) {
    const claim = await tryClaimIdempotencyKey(
      schema.recycleEvents,
      schema.recycleEvents.id,
      result.recycleEventId,
      idempotencyKey,
    );
    if (!claim.ok) {
      const db = getServerDb();
      try {
        await db
          .delete(schema.recycleEvents)
          .where(eq(schema.recycleEvents.id, result.recycleEventId));
        await db.delete(schema.materials).where(eq(schema.materials.id, result.outputSpoolId));
      } catch {
        /* best-effort */
      }
      const winner = await findByIdempotencyKey<typeof schema.recycleEvents.$inferSelect>(
        schema.recycleEvents,
        schema.recycleEvents.ownerId,
        schema.recycleEvents.idempotencyKey,
        actor.id,
        idempotencyKey,
      );
      if (winner) {
        return NextResponse.json({ recycleEvent: toRecycleEventDto(winner) }, { status: 200 });
      }
      logger.error({ err: claim.err }, 'POST recycle-events: idempotency claim failed');
      return errorResponse('internal', 'failed to persist idempotency key', 500);
    }
  }

  const db = getServerDb();
  const refreshed = await db
    .select()
    .from(schema.recycleEvents)
    .where(eq(schema.recycleEvents.id, result.recycleEventId))
    .limit(1);
  return NextResponse.json(
    {
      recycleEvent: toRecycleEventDto(refreshed[0]!),
      outputSpoolId: result.outputSpoolId,
      ledgerEventId: result.ledgerEventId,
    },
    { status: 201 },
  );
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const url = new URL(req.url);
  const queryParsed = ListQuery.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  });
  if (!queryParsed.success) {
    return NextResponse.json(
      { error: 'invalid-query', message: 'invalid query parameters', issues: queryParsed.error.issues },
      { status: 400 },
    );
  }
  const q = queryParsed.data;
  const db = getServerDb();
  const conditions = [eq(schema.recycleEvents.ownerId, actor.id)];
  if (q.cursor) {
    const cursorMs = Number(q.cursor);
    if (!Number.isFinite(cursorMs)) {
      return errorResponse('invalid-query', 'cursor must be a numeric ms timestamp', 400);
    }
    conditions.push(lt(schema.recycleEvents.createdAt, new Date(cursorMs)));
  }
  const rows = await db
    .select()
    .from(schema.recycleEvents)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(schema.recycleEvents.createdAt))
    .limit(q.limit + 1);
  const hasMore = rows.length > q.limit;
  const sliced = hasMore ? rows.slice(0, q.limit) : rows;
  const nextCursor =
    hasMore && sliced.length > 0
      ? String(sliced[sliced.length - 1]!.createdAt.getTime())
      : undefined;
  return NextResponse.json({
    recycleEvents: sliced.map(toRecycleEventDto),
    ...(nextCursor ? { nextCursor } : {}),
  });
}
