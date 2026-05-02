/**
 * POST /api/v1/materials/:id/unload — V2-007a-T14
 *
 * V2-005f-CF-1 T_g2 status: lifecycle is wired against `printer_loadouts` and
 * exports the new `unloadFromPrinter` shape, but the route refactor lives in
 * T_g3. Returns 501 until then so we don't lock ourselves into the legacy
 * `previousPrinterRef` response shape.
 */

import { type NextRequest } from 'next/server';

import { errorResponse, loadMaterialForActor } from '../../_shared';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const loaded = await loadMaterialForActor(req, id, 'update');
  if (!loaded.ok) return loaded.response;

  return errorResponse(
    'not-implemented',
    'unload endpoint response shape will change in V2-005f-CF-1 T_g3; until then this route returns 501',
    501,
  );
}
