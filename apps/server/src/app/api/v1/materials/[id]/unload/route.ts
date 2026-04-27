/**
 * POST /api/v1/materials/:id/unload — V2-007a-T14
 *
 * Calls T4 unloadFromPrinter. No body. 409 on not-loaded.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { unloadFromPrinter } from '@/materials/lifecycle';

import { errorResponse, loadMaterialForActor, statusForReason } from '../../_shared';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const loaded = await loadMaterialForActor(req, id, 'update');
  if (!loaded.ok) return loaded.response;
  const { actor } = loaded;

  const result = await unloadFromPrinter({
    materialId: id,
    actorUserId: actor.id,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `material unload rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }
  return NextResponse.json(
    {
      ledgerEventId: result.ledgerEventId,
      previousPrinterRef: result.previousPrinterRef,
    },
    { status: 200 },
  );
}
