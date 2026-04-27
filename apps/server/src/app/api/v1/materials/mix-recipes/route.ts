/**
 * POST /api/v1/materials/mix-recipes + GET — V2-007a-T14
 *
 * MixRecipe create + list. Same idempotency + auth pattern as the materials
 * top-level route. ACL: 'material' kind (recipes are owned material-adjacent
 * config). Owner-mismatch on individual lookups → 404.
 *
 * Body
 * ────
 * { name, components: [{ materialProductRef, ratioOrGrams }, ...], notes? }
 *
 * components: 2..10 entries; each entry validated by createMixRecipe (T5).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';
import { createMixRecipe } from '@/materials/mix';

import {
  errorResponse,
  findByIdempotencyKey,
  requireAuth,
  statusForReason,
  toMixRecipeDto,
  tryClaimIdempotencyKey,
} from '../_shared';

const ComponentSchema = z.object({
  materialProductRef: z.string().min(1).max(200),
  ratioOrGrams: z.number().positive().finite(),
});

const CreateBodySchema = z.object({
  name: z.string().min(1).max(200),
  components: z.array(ComponentSchema).min(2).max(10),
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
    name: body.name,
    components: body.components,
    notes: body.notes ?? null,
  });
}

function normalizeStored(row: typeof schema.mixRecipes.$inferSelect): string {
  return JSON.stringify({
    ownerId: row.ownerId,
    name: row.name,
    components: row.components,
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
  const normalized = normalizeBody(body, actor.id);

  if (idempotencyKey) {
    const prior = await findByIdempotencyKey<typeof schema.mixRecipes.$inferSelect>(
      schema.mixRecipes,
      schema.mixRecipes.ownerId,
      schema.mixRecipes.idempotencyKey,
      actor.id,
      idempotencyKey,
    );
    if (prior) {
      if (normalizeStored(prior) === normalized) {
        return NextResponse.json({ recipe: toMixRecipeDto(prior) }, { status: 200 });
      }
      return NextResponse.json(
        {
          error: 'idempotency-mismatch',
          message: 'Idempotency-Key reused with a different request body',
          recipeId: prior.id,
        },
        { status: 409 },
      );
    }
  }

  const result = await createMixRecipe({
    ownerId: actor.id,
    name: body.name,
    components: body.components,
    notes: body.notes,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `recipe creation rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }

  if (idempotencyKey) {
    const claim = await tryClaimIdempotencyKey(
      schema.mixRecipes,
      schema.mixRecipes.id,
      result.recipeId,
      idempotencyKey,
    );
    if (!claim.ok) {
      const db = getServerDb();
      try {
        await db.delete(schema.mixRecipes).where(eq(schema.mixRecipes.id, result.recipeId));
      } catch {
        /* best-effort cleanup */
      }
      const winner = await findByIdempotencyKey<typeof schema.mixRecipes.$inferSelect>(
        schema.mixRecipes,
        schema.mixRecipes.ownerId,
        schema.mixRecipes.idempotencyKey,
        actor.id,
        idempotencyKey,
      );
      if (winner) {
        return NextResponse.json({ recipe: toMixRecipeDto(winner) }, { status: 200 });
      }
      logger.error(
        { err: claim.err, recipeId: result.recipeId },
        'POST /api/v1/materials/mix-recipes: idempotency claim failed and no winner',
      );
      return errorResponse('internal', 'failed to persist idempotency key', 500);
    }
  }

  const db = getServerDb();
  const refreshed = await db
    .select()
    .from(schema.mixRecipes)
    .where(eq(schema.mixRecipes.id, result.recipeId))
    .limit(1);
  const row = refreshed[0]!;
  return NextResponse.json({ recipe: toMixRecipeDto(row) }, { status: 201 });
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
  const conditions = [eq(schema.mixRecipes.ownerId, actor.id)];
  if (q.cursor) {
    const cursorMs = Number(q.cursor);
    if (!Number.isFinite(cursorMs)) {
      return errorResponse('invalid-query', 'cursor must be a numeric ms timestamp', 400);
    }
    conditions.push(lt(schema.mixRecipes.createdAt, new Date(cursorMs)));
  }

  const rows = await db
    .select()
    .from(schema.mixRecipes)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(schema.mixRecipes.createdAt))
    .limit(q.limit + 1);

  const hasMore = rows.length > q.limit;
  const sliced = hasMore ? rows.slice(0, q.limit) : rows;
  const nextCursor =
    hasMore && sliced.length > 0
      ? String(sliced[sliced.length - 1]!.createdAt.getTime())
      : undefined;

  return NextResponse.json({
    recipes: sliced.map(toMixRecipeDto),
    ...(nextCursor ? { nextCursor } : {}),
  });
}
