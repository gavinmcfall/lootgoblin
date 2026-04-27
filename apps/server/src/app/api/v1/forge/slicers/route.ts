/**
 * GET  /api/v1/forge/slicers — list caller's slicers (admin: all)
 * POST /api/v1/forge/slicers — create a forge_slicers row
 *
 * V2-005a-T5. Mirrors the printers route shape — same auth/idempotency/
 * pagination conventions. Slicers are runtime entities (where slicing
 * happens), distinct from Grimoire's slicer_profiles (slicer configuration).
 */

import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';
import { FORGE_SLICER_KINDS, SLICER_INVOCATION_METHODS } from '@/db/schema.forge';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  errorResponse,
  findByIdempotencyKey,
  requireAuth,
  toSlicerDto,
  tryClaimIdempotencyKey,
} from '../_shared';

const CreateBody = z.object({
  kind: z.enum(FORGE_SLICER_KINDS),
  name: z.string().min(1).max(200),
  invocationMethod: z.enum(SLICER_INVOCATION_METHODS),
  deviceId: z.string().min(1).max(200).nullable().optional(),
});

type CreateBodyT = z.infer<typeof CreateBody>;

const ListQuery = z.object({
  kind: z.enum(FORGE_SLICER_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().optional(),
});

function normalizeBody(body: CreateBodyT, ownerId: string): string {
  return JSON.stringify({
    ownerId,
    kind: body.kind,
    name: body.name,
    invocationMethod: body.invocationMethod,
    deviceId: body.deviceId ?? null,
  });
}

function normalizeStored(row: typeof schema.forgeSlicers.$inferSelect): string {
  return JSON.stringify({
    ownerId: row.ownerId,
    kind: row.kind,
    name: row.name,
    invocationMethod: row.invocationMethod,
    deviceId: row.deviceId ?? null,
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
    const prior = await findByIdempotencyKey<typeof schema.forgeSlicers.$inferSelect>(
      schema.forgeSlicers,
      schema.forgeSlicers.ownerId,
      schema.forgeSlicers.idempotencyKey,
      actor.id,
      idempotencyKey,
    );
    if (prior) {
      if (normalizeStored(prior) === normalized) {
        return NextResponse.json({ slicer: toSlicerDto(prior) }, { status: 200 });
      }
      return NextResponse.json(
        {
          error: 'idempotency-mismatch',
          message: 'Idempotency-Key reused with a different request body',
          slicerId: prior.id,
        },
        { status: 409 },
      );
    }
  }

  const id = randomUUID();
  const now = new Date();
  try {
    await db.insert(schema.forgeSlicers).values({
      id,
      ownerId: actor.id,
      kind: body.kind,
      name: body.name,
      invocationMethod: body.invocationMethod,
      deviceId: body.deviceId ?? null,
      createdAt: now,
    });
  } catch (err) {
    logger.error({ err, ownerId: actor.id }, 'POST /api/v1/forge/slicers: insert failed');
    return errorResponse(
      'internal',
      'failed to create slicer',
      500,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (idempotencyKey) {
    const claim = await tryClaimIdempotencyKey(
      schema.forgeSlicers,
      schema.forgeSlicers.id,
      id,
      idempotencyKey,
    );
    if (!claim.ok) {
      try {
        await db.delete(schema.forgeSlicers).where(eq(schema.forgeSlicers.id, id));
      } catch (cleanupErr) {
        logger.warn(
          { err: cleanupErr, slicerId: id },
          'POST /api/v1/forge/slicers: cleanup of idempotency loser failed',
        );
      }
      const winner = await findByIdempotencyKey<typeof schema.forgeSlicers.$inferSelect>(
        schema.forgeSlicers,
        schema.forgeSlicers.ownerId,
        schema.forgeSlicers.idempotencyKey,
        actor.id,
        idempotencyKey,
      );
      if (winner) {
        return NextResponse.json({ slicer: toSlicerDto(winner) }, { status: 200 });
      }
      logger.error(
        { err: claim.err, slicerId: id },
        'POST /api/v1/forge/slicers: idempotency claim failed and no winner found',
      );
      return errorResponse('internal', 'failed to persist idempotency key', 500);
    }
  }

  const refreshed = await db
    .select()
    .from(schema.forgeSlicers)
    .where(eq(schema.forgeSlicers.id, id))
    .limit(1);
  return NextResponse.json({ slicer: toSlicerDto(refreshed[0]!) }, { status: 201 });
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
    kind: url.searchParams.get('kind') ?? undefined,
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
    conditions.push(eq(schema.forgeSlicers.ownerId, actor.id));
  }
  if (q.kind) conditions.push(eq(schema.forgeSlicers.kind, q.kind));
  if (q.cursor) {
    const cursorMs = Number(q.cursor);
    if (!Number.isFinite(cursorMs)) {
      return errorResponse('invalid-query', 'cursor must be a numeric ms timestamp', 400);
    }
    conditions.push(lt(schema.forgeSlicers.createdAt, new Date(cursorMs)));
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
        .from(schema.forgeSlicers)
        .where(whereClause)
        .orderBy(desc(schema.forgeSlicers.createdAt), asc(schema.forgeSlicers.id))
        .limit(q.limit + 1)
    : db
        .select()
        .from(schema.forgeSlicers)
        .orderBy(desc(schema.forgeSlicers.createdAt), asc(schema.forgeSlicers.id))
        .limit(q.limit + 1));

  const hasMore = rows.length > q.limit;
  const sliced = hasMore ? rows.slice(0, q.limit) : rows;
  const nextCursor =
    hasMore && sliced.length > 0
      ? String(sliced[sliced.length - 1]!.createdAt.getTime())
      : undefined;

  return NextResponse.json({
    slicers: sliced.map(toSlicerDto),
    ...(nextCursor ? { nextCursor } : {}),
  });
}
