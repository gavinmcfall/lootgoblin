/**
 * POST /api/v1/materials/:id/retire — V2-007a-T14
 *
 * Calls T4 retireMaterial. Body: { reason, acknowledgeLoaded? }.
 * 409 on already-retired / loaded-in-printer-no-ack / active-dispatch.
 *
 * No idempotency key — state transitions are naturally idempotent at the
 * domain layer (already-retired returns 409, no double-apply).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { retireMaterial } from '@/materials/lifecycle';

import { errorResponse, loadMaterialForActor, statusForReason } from '../../_shared';

const BodySchema = z.object({
  reason: z.string().min(1).max(500),
  acknowledgeLoaded: z.boolean().optional(),
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

  const result = await retireMaterial({
    materialId: id,
    actorUserId: actor.id,
    retirementReason: parsed.data.reason,
    acknowledgeLoaded: parsed.data.acknowledgeLoaded,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `material retirement rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }
  return NextResponse.json({ ledgerEventId: result.ledgerEventId }, { status: 200 });
}
