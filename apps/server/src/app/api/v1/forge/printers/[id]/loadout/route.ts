/**
 * GET /api/v1/forge/printers/:id/loadout — V2-005f-CF-1 T_g3
 *
 * Returns the printer's currently-loaded slots (rows in `printer_loadouts`
 * with `unloaded_at IS NULL`), ordered by `slot_index` ascending.
 *
 * Auth + ACL
 * ──────────
 * BetterAuth session OR programmatic x-api-key. Owner-or-admin only;
 * cross-owner access returns 404 (id leak prevention, matches the rest of
 * the Forge surface).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { getCurrentLoadout } from '@/forge/loadouts/queries';

import { errorResponse, requireAuth } from '../../../../materials/_shared';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: printerId } = await ctx.params;

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const db = getServerDb();
  const rows = await db
    .select()
    .from(schema.printers)
    .where(eq(schema.printers.id, printerId))
    .limit(1);
  if (rows.length === 0) {
    return errorResponse('not-found', 'printer-not-found', 404);
  }
  if (auth.actor.role !== 'admin' && rows[0]!.ownerId !== auth.actor.id) {
    return errorResponse('not-found', 'printer-not-found', 404);
  }

  const slots = await getCurrentLoadout(printerId);
  return NextResponse.json({
    slots: slots.map((s) => ({
      loadout_id: s.loadoutId,
      slot_index: s.slotIndex,
      material_id: s.materialId,
      brand: s.brand,
      subtype: s.subtype,
      color_name: s.colorName,
      colors: s.colors,
      loaded_at: s.loadedAt instanceof Date ? s.loadedAt.getTime() : s.loadedAt,
    })),
  });
}
