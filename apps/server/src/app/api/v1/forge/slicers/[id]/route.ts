/**
 * GET    /api/v1/forge/slicers/:id
 * PATCH  /api/v1/forge/slicers/:id
 * DELETE /api/v1/forge/slicers/:id
 *
 * V2-005a-T5. Mutable: name, deviceId, invocationMethod. Immutable: id,
 * ownerId, kind. See ../route.ts and printers/[id]/route.ts for the auth
 * model.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';
import { SLICER_INVOCATION_METHODS } from '@/db/schema.forge';

import {
  errorResponse,
  loadSlicerForActor,
  toSlicerDto,
} from '../../_shared';

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  invocationMethod: z.enum(SLICER_INVOCATION_METHODS).optional(),
  deviceId: z.string().min(1).max(200).nullable().optional(),
});

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const loaded = await loadSlicerForActor(req, id, 'read');
  if (!loaded.ok) return loaded.response;
  return NextResponse.json({ slicer: toSlicerDto(loaded.row) });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('invalid-body', 'JSON parse failed', 400);
  }

  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    for (const immutable of ['id', 'ownerId', 'owner_id', 'kind']) {
      if (immutable in r) {
        return errorResponse(
          'invalid-body',
          `field '${immutable}' is immutable`,
          400,
        );
      }
    }
  }

  const parsed = PatchBody.safeParse(raw);
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

  const loaded = await loadSlicerForActor(req, id, 'update');
  if (!loaded.ok) return loaded.response;

  const patch: Partial<typeof schema.forgeSlicers.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.invocationMethod !== undefined) patch.invocationMethod = body.invocationMethod;
  if (body.deviceId !== undefined) patch.deviceId = body.deviceId;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ slicer: toSlicerDto(loaded.row) });
  }

  const db = getServerDb();
  try {
    await db.update(schema.forgeSlicers).set(patch).where(eq(schema.forgeSlicers.id, id));
  } catch (err) {
    logger.error({ err, id }, 'PATCH /api/v1/forge/slicers/:id: update failed');
    return errorResponse(
      'internal',
      'failed to update slicer',
      500,
      err instanceof Error ? err.message : String(err),
    );
  }

  const refreshed = await db
    .select()
    .from(schema.forgeSlicers)
    .where(eq(schema.forgeSlicers.id, id))
    .limit(1);
  return NextResponse.json({ slicer: toSlicerDto(refreshed[0]!) });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const loaded = await loadSlicerForActor(req, id, 'delete');
  if (!loaded.ok) return loaded.response;

  const db = getServerDb();
  try {
    await db.delete(schema.forgeSlicers).where(eq(schema.forgeSlicers.id, id));
  } catch (err) {
    logger.error({ err, id }, 'DELETE /api/v1/forge/slicers/:id: delete failed');
    return errorResponse(
      'internal',
      'failed to delete slicer',
      500,
      err instanceof Error ? err.message : String(err),
    );
  }
  return new Response(null, { status: 204 });
}
