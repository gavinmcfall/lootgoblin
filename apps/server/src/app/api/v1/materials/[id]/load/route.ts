/**
 * POST /api/v1/materials/:id/load — V2-007a-T14
 *
 * V2-005f-CF-1 T_g2 status: the lifecycle has been rewritten against
 * `printer_loadouts` with the new `(printerId, slotIndex)` argument shape, but
 * this legacy route still accepts the v1 free-text `{ printerRef }` body.
 * T_g3 owns the route refactor — until it lands, this endpoint validates the
 * legacy shape (so existing clients see a 400 on malformed input) and returns
 * 501 `not-implemented` to direct callers to the new T_g3 routes.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { errorResponse, loadMaterialForActor } from '../../_shared';

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

  return errorResponse(
    'not-implemented',
    'load endpoint shape will change in V2-005f-CF-1 T_g3 (printerId+slotIndex); until then this route returns 501',
    501,
  );
}
