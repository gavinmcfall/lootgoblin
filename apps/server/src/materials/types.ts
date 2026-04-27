/**
 * Materials pillar types — V2-007a-T1
 *
 * Re-exports the schema-side enum unions and provides a few small predicates
 * that downstream tasks (T4-T7 lifecycle, T8 consumption, T13 reports) can
 * use without re-importing the schema module directly.
 */

import type { InferSelectModel } from 'drizzle-orm';
import {
  MATERIAL_KINDS,
  COLOR_PATTERNS,
  MATERIAL_UNITS,
  materials,
  mixRecipes,
  mixBatches,
  recycleEvents,
} from '../db/schema.materials';

export { MATERIAL_KINDS, COLOR_PATTERNS, MATERIAL_UNITS };
export type { MaterialKind, ColorPattern, MaterialUnit } from '../db/schema.materials';

/** Drizzle-inferred row types for downstream consumers. */
export type Material = InferSelectModel<typeof materials>;
export type MixRecipe = InferSelectModel<typeof mixRecipes>;
export type MixBatch = InferSelectModel<typeof mixBatches>;
export type RecycleEvent = InferSelectModel<typeof recycleEvents>;

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

export function isFilamentSpool(m: Pick<Material, 'kind'>): boolean {
  return m.kind === 'filament_spool';
}

export function isResinBottle(m: Pick<Material, 'kind'>): boolean {
  return m.kind === 'resin_bottle';
}

export function isMixBatch(m: Pick<Material, 'kind'>): boolean {
  return m.kind === 'mix_batch';
}

export function isRecycledSpool(m: Pick<Material, 'kind'>): boolean {
  return m.kind === 'recycled_spool';
}

export function isOther(m: Pick<Material, 'kind'>): boolean {
  return m.kind === 'other';
}

export function isActive(m: Pick<Material, 'active'>): boolean {
  return m.active === true;
}

export function isRetired(m: Pick<Material, 'active'>): boolean {
  return m.active === false;
}
