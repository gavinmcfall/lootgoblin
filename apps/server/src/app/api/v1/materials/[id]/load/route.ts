/**
 * POST /api/v1/materials/:id/load — V2-005f-CF-1 T_g3
 *
 * Loads a material into a (printer, slot) pair via the new
 * `printer_loadouts`-backed lifecycle (T_g2). Replaces the V2-007a-T14 free-
 * text `printerRef` shape (which T_g1 dropped from the schema).
 *
 * Request body
 * ────────────
 *   { printerId: string, slotIndex: number, notes?: string }
 *
 * Auth + ACL
 * ──────────
 * BetterAuth session OR programmatic x-api-key. Cross-owner access on
 * EITHER the material OR the printer returns 404 (matches the rest of the
 * API — no id leak across users). Admins MAY load on behalf of any owner;
 * this is the only printer-action where admin override is allowed (load
 * tracking is bookkeeping, not a remote-control action like dispatch).
 *
 * Result-reason → HTTP status
 *   material-not-found / printer-not-found       → 404
 *   material-already-loaded-elsewhere            → 409
 *   material-retired                             → 409
 *   invalid-slot                                 → 400
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { loadInPrinter } from '@/forge/loadouts/lifecycle';

import { errorResponse, requireAuth } from '../../_shared';

const Body = z
  .object({
    printerId: z.string().min(1),
    slotIndex: z.number().int().nonnegative(),
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

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('invalid-body', 'JSON parse failed', 400);
  }
  const parsed = Body.safeParse(raw);
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

  const db = getServerDb();

  // ACL: actor must own the material (or be admin).
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

  // ACL: actor must own the printer (or be admin). Cross-owner returns 404
  // (id leak prevention).
  const printerRows = await db
    .select()
    .from(schema.printers)
    .where(eq(schema.printers.id, parsed.data.printerId))
    .limit(1);
  if (printerRows.length === 0) {
    return errorResponse('not-found', 'printer-not-found', 404);
  }
  if (auth.actor.role !== 'admin' && printerRows[0]!.ownerId !== auth.actor.id) {
    return errorResponse('not-found', 'printer-not-found', 404);
  }

  const result = await loadInPrinter({
    materialId,
    printerId: parsed.data.printerId,
    slotIndex: parsed.data.slotIndex,
    userId: auth.actor.id,
    ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
  });

  if (!result.ok) {
    const status =
      result.reason === 'material-not-found'
        ? 404
        : result.reason === 'printer-not-found'
          ? 404
          : result.reason === 'material-already-loaded-elsewhere'
            ? 409
            : result.reason === 'material-retired'
              ? 409
              : result.reason === 'invalid-slot'
                ? 400
                : 500;
    return errorResponse(result.reason, result.details ?? '', status);
  }

  return NextResponse.json({
    loadoutId: result.loadoutId,
    ...(result.swappedOutMaterialId !== undefined
      ? { swappedOutMaterialId: result.swappedOutMaterialId }
      : {}),
  });
}
