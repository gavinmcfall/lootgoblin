/**
 * Catalog product types — V2-007b T_B1
 *
 * Re-exports the catalog enum unions and Drizzle row-types for the
 * filament_products + resin_products tables, plus type-guards for app-layer
 * validation (downstream T_B2/T_B3 routes consume these instead of importing
 * the schema module directly).
 *
 * Schema lives at apps/server/src/db/schema.materials.ts. App-layer
 * validation pattern (no DB CHECK constraints) means every write site must
 * gate on these guards before insert/update.
 */

import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import {
  FILAMENT_SUBTYPES,
  RESIN_SUBTYPES,
  RESIN_MATERIAL_CLASSES,
  PRODUCT_SOURCES,
  filamentProducts,
  resinProducts,
} from '../db/schema.materials';

export {
  FILAMENT_SUBTYPES,
  RESIN_SUBTYPES,
  RESIN_MATERIAL_CLASSES,
  PRODUCT_SOURCES,
};

export type {
  FilamentSubtype,
  ResinSubtype,
  ResinMaterialClass,
  ProductSource,
} from '../db/schema.materials';

import type {
  FilamentSubtype,
  ResinSubtype,
  ResinMaterialClass,
  ProductSource,
} from '../db/schema.materials';

/** Drizzle-inferred row types (read-side). */
export type FilamentProduct = InferSelectModel<typeof filamentProducts>;
export type ResinProduct = InferSelectModel<typeof resinProducts>;

/** Drizzle-inferred row types (write-side — for create/update payloads). */
export type FilamentProductInsert = InferInsertModel<typeof filamentProducts>;
export type ResinProductInsert = InferInsertModel<typeof resinProducts>;

// ---------------------------------------------------------------------------
// Type guards (app-layer validation entry points)
// ---------------------------------------------------------------------------

export function isFilamentSubtype(x: unknown): x is FilamentSubtype {
  return typeof x === 'string' && (FILAMENT_SUBTYPES as readonly string[]).includes(x);
}

export function isResinSubtype(x: unknown): x is ResinSubtype {
  return typeof x === 'string' && (RESIN_SUBTYPES as readonly string[]).includes(x);
}

export function isResinMaterialClass(x: unknown): x is ResinMaterialClass {
  return typeof x === 'string' && (RESIN_MATERIAL_CLASSES as readonly string[]).includes(x);
}

export function isProductSource(x: unknown): x is ProductSource {
  return typeof x === 'string' && (PRODUCT_SOURCES as readonly string[]).includes(x);
}
