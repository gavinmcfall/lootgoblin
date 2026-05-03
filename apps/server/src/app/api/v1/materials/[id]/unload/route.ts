/**
 * POST /api/v1/materials/:id/unload — V2-005f-CF-1 T_g3
 *
 * Unloads a material from whichever (printer, slot) it is currently open in,
 * via the new `printer_loadouts`-backed lifecycle (T_g2). Body is optional:
 * empty body OR `{ notes?: string }`.
 *
 * Result-reason → HTTP status
 *   material-not-found    → 404
 *   material-not-loaded   → 409
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { unloadFromPrinter } from '@/forge/loadouts/lifecycle';

import { errorResponse, requireAuth } from '../../_shared';

const Body = z
  .object({
    notes: z.string().max(500).optional(),
  })
  .strict();

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: materialId } = await ctx.params;

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  // Body is OPTIONAL — accept empty body OR `{ notes? }`.
  let notes: string | undefined;
  const text = await req.text().catch(() => '');
  if (text.length > 0) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      return errorResponse('invalid-body', 'malformed json', 400);
    }
    const parsed = Body.safeParse(parsedJson);
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
    notes = parsed.data.notes;
  }

  const db = getServerDb();

  // ACL: actor must own the material (or be admin). Cross-owner returns 404.
  const matRows = await db
    .select()
    .from(schema.materials)
    .where(eq(schema.materials.id, materialId))
    .limit(1);
  if (matRows.length === 0) {
    return errorResponse('not-found', 'material-not-found', 404);
  }
  if (auth.actor.role !== 'admin' && matRows[0]!.ownerId !== auth.actor.id) {
    return errorResponse('not-found', 'material-not-found', 404);
  }

  const result = await unloadFromPrinter({
    materialId,
    userId: auth.actor.id,
    ...(notes !== undefined ? { notes } : {}),
  });

  if (!result.ok) {
    const status =
      result.reason === 'material-not-found'
        ? 404
        : result.reason === 'material-not-loaded'
          ? 409
          : 500;
    return errorResponse(result.reason, result.details ?? '', status);
  }

  return NextResponse.json({
    loadoutId: result.loadoutId,
    previousPrinterId: result.previousPrinterId,
    previousSlotIndex: result.previousSlotIndex,
  });
}
