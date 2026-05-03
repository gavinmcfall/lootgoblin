/**
 * GET /api/v1/materials/:id/loadout-history — V2-005f-CF-1 T_g3
 *
 * Returns the material's full load + unload history (rows in
 * `printer_loadouts` for the material id), ordered by `loaded_at`
 * descending.
 *
 * Auth + ACL
 * ──────────
 * BetterAuth session OR programmatic x-api-key. Owner-or-admin only;
 * cross-owner access returns 404.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { getLoadoutHistory } from '@/forge/loadouts/queries';

import { errorResponse, requireAuth } from '../../_shared';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: materialId } = await ctx.params;

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const db = getServerDb();
  const rows = await db
    .select()
    .from(schema.materials)
    .where(eq(schema.materials.id, materialId))
    .limit(1);
  if (rows.length === 0) {
    return errorResponse('not-found', 'material-not-found', 404);
  }
  if (auth.actor.role !== 'admin' && rows[0]!.ownerId !== auth.actor.id) {
    return errorResponse('not-found', 'material-not-found', 404);
  }

  const history = await getLoadoutHistory(materialId);
  return NextResponse.json({
    history: history.map((h) => ({
      loadout_id: h.loadoutId,
      printer_id: h.printerId,
      printer_name: h.printerName,
      slot_index: h.slotIndex,
      loaded_at: h.loadedAt instanceof Date ? h.loadedAt.getTime() : h.loadedAt,
      unloaded_at:
        h.unloadedAt instanceof Date
          ? h.unloadedAt.getTime()
          : h.unloadedAt,
      notes: h.notes,
    })),
  });
}
