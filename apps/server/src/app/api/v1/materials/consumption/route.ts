/**
 * POST /api/v1/materials/consumption — V2-007a-T14
 *
 * ADMIN-ONLY manual-entry path for recording ad-hoc material consumption.
 * The PRIMARY path is V2-005 Forge calling `emitMaterialConsumed` directly
 * after print-complete / scale-reading. This HTTP route is the escape valve
 * for admins to record consumption that the Forge pipeline didn't see.
 *
 * Auth model
 * ──────────
 * Same `authenticateRequest` shim. Additionally checks actor.role==='admin'
 * and rejects 403 otherwise.
 *
 * Body
 * ────
 * Same shape as MaterialConsumedEvent (T8) — minus the `type` discriminator.
 * `occurredAt` accepts an ISO string (the route converts to Date for the
 * domain helper, which expects a real Date).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { handleMaterialConsumed } from '@/materials/consumption';

import { errorResponse, requireAuth, statusForReason } from '../_shared';

const AttributedToSchema = z
  .object({
    kind: z.enum(['print', 'purge', 'priming', 'failed-print', 'waste']),
    jobId: z.string().min(1).optional(),
    lootId: z.string().min(1).optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();

const BodySchema = z
  .object({
    materialId: z.string().min(1),
    weightConsumed: z.number().positive().finite(),
    provenanceClass: z.enum(['measured', 'entered', 'estimated']),
    attributedTo: AttributedToSchema,
    occurredAt: z.string().datetime(),
    source: z
      .enum(['forge:dispatch', 'forge:scale-reading', 'manual-entry'])
      .default('manual-entry'),
  })
  .strict();

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  if (auth.actor.role !== 'admin') {
    return errorResponse(
      'forbidden',
      'manual consumption entry requires admin role',
      403,
    );
  }

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
  const body = parsed.data;

  const result = await handleMaterialConsumed({
    type: 'material.consumed',
    materialId: body.materialId,
    weightConsumed: body.weightConsumed,
    provenanceClass: body.provenanceClass,
    attributedTo: body.attributedTo,
    occurredAt: new Date(body.occurredAt),
    source: body.source,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `consumption event rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }
  return NextResponse.json(
    {
      ledgerEventId: result.ledgerEventId,
      newRemainingAmount: result.newRemainingAmount,
      reconciliationNeeded: result.reconciliationNeeded,
    },
    { status: 201 },
  );
}
