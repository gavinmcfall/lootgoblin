/**
 * POST /api/v1/materials/:id/load — V2-007a-T14
 *
 * Calls T4 loadInPrinter. Body: { printerRef }.
 * 409 on printer-slot-occupied (filament-spool exclusivity), material-retired.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { loadInPrinter } from '@/materials/lifecycle';

import { errorResponse, loadMaterialForActor, statusForReason } from '../../_shared';

const BodySchema = z.object({
  printerRef: z.string().min(1).max(500),
});

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const loaded = await loadMaterialForActor(req, id, 'update');
  if (!loaded.ok) return loaded.response;
  const { actor } = loaded;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('invalid-body', 'JSON parse failed', 400);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', message: 'request body failed validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await loadInPrinter({
    materialId: id,
    actorUserId: actor.id,
    printerRef: parsed.data.printerRef,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `material load rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }
  return NextResponse.json({ ledgerEventId: result.ledgerEventId }, { status: 200 });
}
