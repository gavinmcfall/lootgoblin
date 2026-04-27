/**
 * GET / PATCH / DELETE /api/v1/materials/mix-recipes/:id — V2-007a-T14
 *
 * Owner-scoped CRUD on MixRecipe. Cross-owner returns 404 (id-leak prev.).
 *
 * DELETE blocks if the recipe has any mix_batches (FK ON DELETE RESTRICT).
 * Surfaces as 409 with reason='recipe-has-batches'.
 *
 * PATCH mutable: name, components, notes.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';

import { errorResponse, requireAuth, toMixRecipeDto } from '../../_shared';

const ComponentSchema = z.object({
  materialProductRef: z.string().min(1).max(200),
  ratioOrGrams: z.number().positive().finite(),
});

const PatchBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    components: z.array(ComponentSchema).min(2).max(10).optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'at least one mutable field is required',
  });

async function loadRecipe(actorId: string, recipeId: string) {
  const db = getServerDb();
  const rows = await db
    .select()
    .from(schema.mixRecipes)
    .where(and(eq(schema.mixRecipes.id, recipeId), eq(schema.mixRecipes.ownerId, actorId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const row = await loadRecipe(auth.actor.id, id);
  if (!row) {
    return errorResponse('not-found', 'recipe-not-found', 404);
  }
  return NextResponse.json({ recipe: toMixRecipeDto(row) });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const row = await loadRecipe(auth.actor.id, id);
  if (!row) {
    return errorResponse('not-found', 'recipe-not-found', 404);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('invalid-body', 'JSON parse failed', 400);
  }
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', message: 'request body failed validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const patch: Partial<typeof schema.mixRecipes.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.components !== undefined) patch.components = body.components;
  if (body.notes !== undefined) patch.notes = body.notes;

  const db = getServerDb();
  await db
    .update(schema.mixRecipes)
    .set(patch)
    .where(eq(schema.mixRecipes.id, id));

  const refreshed = await db
    .select()
    .from(schema.mixRecipes)
    .where(eq(schema.mixRecipes.id, id))
    .limit(1);
  return NextResponse.json({ recipe: toMixRecipeDto(refreshed[0]!) });
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const row = await loadRecipe(auth.actor.id, id);
  if (!row) {
    return errorResponse('not-found', 'recipe-not-found', 404);
  }

  const db = getServerDb();
  // Pre-check: are there mix_batches that reference this recipe?
  const batchRows = await db
    .select({ id: schema.mixBatches.id })
    .from(schema.mixBatches)
    .where(eq(schema.mixBatches.recipeId, id))
    .limit(1);
  if (batchRows.length > 0) {
    return errorResponse(
      'recipe-has-batches',
      'recipe has applied batches; delete batches first or retire associated mix_batch materials',
      409,
    );
  }

  try {
    await db.delete(schema.mixRecipes).where(eq(schema.mixRecipes.id, id));
  } catch (err) {
    // Defense-in-depth in case the FK RESTRICT fires due to a concurrent
    // mix-batch insert that landed after the pre-check.
    logger.warn(
      { err, recipeId: id },
      'DELETE /api/v1/materials/mix-recipes/:id: delete raised',
    );
    return errorResponse(
      'recipe-has-batches',
      'recipe has applied batches; delete batches first',
      409,
    );
  }

  return new Response(null, { status: 204 });
}
