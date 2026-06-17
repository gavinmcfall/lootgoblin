// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * conversion.ts — V2-005f-CF-5b T_b1
 *
 * mm→grams filament conversion via V2-007b catalog chain.
 *
 * Walk: printer_loadouts (WHERE printer_id = ? AND slot_index = ? AND unloaded_at IS NULL)
 *   → materials.product_id
 *   → filament_products.density + diameterMm
 *
 * Falls back to PLA defaults (1.24 g/cm³, 1.75 mm) when any link is broken
 * (no current loadout, material has no product_id, or product has no density/diameter).
 *
 * Formula: grams = (filamentUsedMm × π × (diameter/2)²) / 1000 × density
 */

import { eq, and, isNull } from 'drizzle-orm';
import { getServerDb, schema } from '../../../db/client';

export interface ConvertArgs {
  printerId: string;
  filamentUsedMm: number;
  /** Single-extruder printers default to slot 0. */
  slotIndex?: number;
  dbUrl?: string;
}

export interface ConvertResult {
  grams: number;
  densitySource: 'catalog' | 'fallback';
}

const PLA_DENSITY_G_PER_CM3 = 1.24;
const DEFAULT_DIAMETER_MM = 1.75;

export async function convertFilamentMmToGrams(args: ConvertArgs): Promise<ConvertResult> {
  const db = getServerDb(args.dbUrl);
  const slotIndex = args.slotIndex ?? 0;

  let densityGPerCm3 = PLA_DENSITY_G_PER_CM3;
  let diameterMm = DEFAULT_DIAMETER_MM;
  let densitySource: 'catalog' | 'fallback' = 'fallback';

  // Step 1: find the current loadout for this printer slot.
  const [loadout] = await db
    .select({ materialId: schema.printerLoadouts.materialId })
    .from(schema.printerLoadouts)
    .where(
      and(
        eq(schema.printerLoadouts.printerId, args.printerId),
        eq(schema.printerLoadouts.slotIndex, slotIndex),
        isNull(schema.printerLoadouts.unloadedAt),
      ),
    )
    .limit(1);

  if (loadout) {
    // Step 2: look up the material's product_id.
    const [material] = await db
      .select({ productId: schema.materials.productId })
      .from(schema.materials)
      .where(eq(schema.materials.id, loadout.materialId))
      .limit(1);

    if (material?.productId) {
      // Step 3: look up catalog density + diameter from filament_products.
      const [product] = await db
        .select({
          density: schema.filamentProducts.density,
          diameterMm: schema.filamentProducts.diameterMm,
        })
        .from(schema.filamentProducts)
        .where(eq(schema.filamentProducts.id, material.productId))
        .limit(1);

      if (product && typeof product.density === 'number' && typeof product.diameterMm === 'number') {
        densityGPerCm3 = product.density;
        diameterMm = product.diameterMm;
        densitySource = 'catalog';
      }
    }
  }

  const crossSectionMm2 = Math.PI * (diameterMm / 2) ** 2;
  const volumeMm3 = args.filamentUsedMm * crossSectionMm2;
  const volumeCm3 = volumeMm3 / 1000;
  const grams = volumeCm3 * densityGPerCm3;

  return { grams, densitySource };
}
