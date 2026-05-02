/**
 * V2-005f-CF-1 T_g2: Read-only queries over `printer_loadouts`.
 *
 * `getCurrentLoadout(printerId)` — list the currently-loaded slots on a
 * printer (rows with `unloaded_at IS NULL`), ordered by `slotIndex` ascending.
 *
 * `getLoadoutHistory(materialId)` — full load + unload history for a single
 * material, ordered by `loadedAt` descending.
 *
 * Used by T_g3 HTTP routes and T_g4 claim-worker `material_id` resolution.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';

import { getServerDb, schema } from '../../db/client';

// ---------------------------------------------------------------------------
// getCurrentLoadout
// ---------------------------------------------------------------------------

export interface CurrentLoadoutSlot {
  loadoutId: string;
  slotIndex: number;
  materialId: string;
  brand: string | null;
  subtype: string | null;
  colorName: string | null;
  colors: string[] | null;
  loadedAt: Date;
}

export async function getCurrentLoadout(
  printerId: string,
  opts?: { dbUrl?: string },
): Promise<CurrentLoadoutSlot[]> {
  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select({
      loadoutId: schema.printerLoadouts.id,
      slotIndex: schema.printerLoadouts.slotIndex,
      materialId: schema.printerLoadouts.materialId,
      brand: schema.materials.brand,
      subtype: schema.materials.subtype,
      colorName: schema.materials.colorName,
      colors: schema.materials.colors,
      loadedAt: schema.printerLoadouts.loadedAt,
    })
    .from(schema.printerLoadouts)
    .innerJoin(
      schema.materials,
      eq(schema.materials.id, schema.printerLoadouts.materialId),
    )
    .where(
      and(
        eq(schema.printerLoadouts.printerId, printerId),
        isNull(schema.printerLoadouts.unloadedAt),
      ),
    )
    .orderBy(schema.printerLoadouts.slotIndex);

  return rows.map((r) => ({
    loadoutId: r.loadoutId,
    slotIndex: r.slotIndex,
    materialId: r.materialId,
    brand: r.brand ?? null,
    subtype: r.subtype ?? null,
    colorName: r.colorName ?? null,
    colors: r.colors ?? null,
    loadedAt: r.loadedAt,
  }));
}

// ---------------------------------------------------------------------------
// getLoadoutHistory
// ---------------------------------------------------------------------------

export interface LoadoutHistoryEntry {
  loadoutId: string;
  printerId: string;
  printerName: string;
  slotIndex: number;
  loadedAt: Date;
  unloadedAt: Date | null;
  notes: string | null;
}

export async function getLoadoutHistory(
  materialId: string,
  opts?: { dbUrl?: string },
): Promise<LoadoutHistoryEntry[]> {
  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select({
      loadoutId: schema.printerLoadouts.id,
      printerId: schema.printerLoadouts.printerId,
      printerName: schema.printers.name,
      slotIndex: schema.printerLoadouts.slotIndex,
      loadedAt: schema.printerLoadouts.loadedAt,
      unloadedAt: schema.printerLoadouts.unloadedAt,
      notes: schema.printerLoadouts.notes,
    })
    .from(schema.printerLoadouts)
    .innerJoin(
      schema.printers,
      eq(schema.printers.id, schema.printerLoadouts.printerId),
    )
    .where(eq(schema.printerLoadouts.materialId, materialId))
    .orderBy(desc(schema.printerLoadouts.loadedAt));

  return rows.map((r) => ({
    loadoutId: r.loadoutId,
    printerId: r.printerId,
    printerName: r.printerName,
    slotIndex: r.slotIndex,
    loadedAt: r.loadedAt,
    unloadedAt: r.unloadedAt ?? null,
    notes: r.notes ?? null,
  }));
}
