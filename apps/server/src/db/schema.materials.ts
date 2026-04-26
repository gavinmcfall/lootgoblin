/**
 * Materials pillar — V2-007a-T1
 *
 * Models the user's physical inventory: filament spools, resin bottles, mix
 * batches (resin), recycled spools, and "other" catch-all. Each row tracks
 * lifecycle state (initial/remaining amounts, retirement) plus enough
 * metadata to identify the product (brand, subtype, colors).
 *
 * Catalog integration (V2-007b):
 *   - product_id is a nullable FK to filament_products / resin_products.
 *   - In v2-007a, those tables are STUBS (just `id text PK`). Materials
 *     created in v2-007a have product_id=NULL and inline brand/subtype/colors.
 *   - In v2-007b, the catalog tables expand with kind-specific columns + seed
 *     data; new Materials may set product_id to link to a catalog entry.
 *   - Display-field resolution (V2-007b T_B4): product fields when product_id
 *     is set; fall back to Material's inline columns when NULL.
 *
 * Multi-hex color (V2-007a): every material declares 1–4 hex colors + a
 * pattern discriminator. Solid PLA = ["#E63946"], "solid". Dual-tone silk
 * = ["#FFD700", "#FFFFFF"], "dual-tone". 4-color rainbow PLA = the four
 * hex values, "multi-section".
 */

import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { user } from './schema.auth';

// MaterialKind enum value list (TS-side; no DB CHECK constraint per project pattern)
export const MATERIAL_KINDS = [
  'filament_spool',
  'resin_bottle',
  'mix_batch',
  'recycled_spool',
  'other',
] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const COLOR_PATTERNS = [
  'solid',
  'dual-tone',
  'gradient',
  'multi-section',
] as const;
export type ColorPattern = (typeof COLOR_PATTERNS)[number];

export const MATERIAL_UNITS = ['g', 'ml'] as const;
export type MaterialUnit = (typeof MATERIAL_UNITS)[number];

// ---------------------------------------------------------------------------
// Catalog stub tables (v2-007a: empty; v2-007b expands)
// ---------------------------------------------------------------------------

/**
 * Filament product catalog (V2-007b expansion).
 *
 * v2-007a: just an id PK. v2-007b adds: brand, subtype, colors, color_pattern,
 * default_temps (JSON), density, diameter_mm, retail_url, owner_id (NULL =
 * system-seeded; non-NULL = user custom entry).
 */
export const filamentProducts = sqliteTable('filament_products', {
  id: text('id').primaryKey(),
});

/**
 * Resin product catalog (V2-007b expansion).
 *
 * v2-007a: just an id PK. v2-007b adds: brand, subtype, colors, color_pattern,
 * default_exposure (JSON), viscosity, owner_id.
 */
export const resinProducts = sqliteTable('resin_products', {
  id: text('id').primaryKey(),
});

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------

/**
 * Owner-scoped material inventory. Every spool, bottle, mix, recycled output,
 * or "other" item is one row.
 *
 * Mass conservation invariant (T5/T6 enforce): the sum of (initial_amount of
 * mix_batch + recycled_spool) MUST equal the sum of (decrements from source
 * materials) across the system at any point in time. T15 e2e tests assert
 * this with a property-based test.
 */
export const materials = sqliteTable(
  'materials',
  {
    id: text('id').primaryKey(),

    /** Owner. Cascade: user delete removes their materials. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),

    /**
     * Discriminator. App-layer validates against MATERIAL_KINDS. No DB CHECK
     * (project pattern — see V2-004 T1 audit).
     */
    kind: text('kind').notNull(),

    /**
     * Optional FK to catalog product. In v2-007a always NULL (catalog tables
     * are stubs). v2-007b: when set, the product's columns shadow the inline
     * brand/subtype/colors below.
     *
     * Note: Drizzle better-sqlite3 doesn't enforce foreign-table type by kind
     * (we'd need a poly FK). At app layer: kind='filament_spool' → product_id
     * targets filament_products; kind='resin_bottle' → resin_products. mix /
     * recycled / other always NULL.
     */
    productId: text('product_id'),

    /** Manufacturer brand. e.g. "Bambu Lab", "Polymaker", "ELEGOO". */
    brand: text('brand'),

    /** Material subtype. e.g. "PLA", "PETG-CF", "Standard Resin", "TPU 95A". */
    subtype: text('subtype'),

    /**
     * 1–4 hex colors. JSON array of strings. Validated at app layer:
     *  - 1–4 entries
     *  - each matches /^#[0-9A-F]{6}$/i (uppercase preferred but case-insensitive)
     */
    colors: text('colors', { mode: 'json' }).$type<string[]>(),

    /**
     * Color pattern discriminator. App-layer validates against COLOR_PATTERNS.
     * Length of colors array should match: 'solid'=1, 'dual-tone'=2,
     * 'gradient'=2-3, 'multi-section'=2-4.
     */
    colorPattern: text('color_pattern'),

    /** Vendor-given color name. e.g. "Galaxy Blue", "Sunset Gradient". Optional. */
    colorName: text('color_name'),

    /** Density in g/ml (resin) or g/cm³ (filament — same unit, different connotation). */
    density: real('density'),

    /**
     * Initial amount. Always positive. Unit per `unit` column. For mix_batch:
     * = total_volume of the batch. For recycled_spool: = sum of input weights
     * (minus expected loss).
     */
    initialAmount: real('initial_amount').notNull(),

    /**
     * Currently remaining. Decrements on consumption events (T8). For
     * retired materials: preserved for historical reporting.
     */
    remainingAmount: real('remaining_amount').notNull(),

    /** 'g' (filament, recycled, weight-tracked resin) or 'ml' (volume-tracked resin). */
    unit: text('unit').notNull(),

    /**
     * Purchase metadata: { purchasedAt, vendor, price, currency, lot_number, ... }.
     * App-layer schema; not validated at DB level.
     */
    purchaseData: text('purchase_data', { mode: 'json' }).$type<Record<string, unknown>>(),

    /**
     * Optional FK to a printer entity (V2-005 Forge will add the printers
     * table). For now a free-form text reference; v2-007b or v2-005 promotes
     * it to a real FK.
     */
    loadedInPrinterRef: text('loaded_in_printer_ref'),

    /** false = retired (no longer active inventory). Default true on create. */
    active: integer('active', { mode: 'boolean' }).notNull().default(true),

    /** Free-form retirement reason. NULL while active. */
    retirementReason: text('retirement_reason'),

    /** When retired. NULL while active. */
    retiredAt: integer('retired_at', { mode: 'timestamp_ms' }),

    /**
     * Kind-specific overflow JSON. Rare. Example for resin_bottle:
     * `{"expiry_date":"2026-12-31","require_uv_post_cure":true}`. Most
     * kind-specific properties (default temps, viscosity) live on the
     * catalog product when product_id is set.
     */
    extra: text('extra', { mode: 'json' }).$type<Record<string, unknown>>(),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    /** List user's active materials. */
    index('materials_owner_active_idx').on(t.ownerId, t.active),
    /** Filter by kind (filament-only views, etc). */
    index('materials_owner_kind_idx').on(t.ownerId, t.kind),
    /** Loaded-in-printer lookup. Sparse (most rows NULL). */
    index('materials_loaded_idx').on(t.loadedInPrinterRef),
    /** Catalog-linked materials (for v2-007b joins). */
    index('materials_product_idx').on(t.productId),
    /** Brand-filter via expression index (cheap; SQLite supports). */
    index('materials_owner_brand_idx').on(t.ownerId, t.brand),
    /** Subtype-filter (e.g. "all my PLA"). */
    index('materials_owner_subtype_idx').on(t.ownerId, t.subtype),
  ],
);

// ---------------------------------------------------------------------------
// mix_recipes
// ---------------------------------------------------------------------------

/**
 * Saved resin mix recipes. Reusable across batches.
 *
 * Components shape (JSON):
 *   [
 *     { "materialProductRef": "polymaker-resin-purple", "ratioOrGrams": 50 },
 *     { "materialProductRef": "polymaker-resin-blue", "ratioOrGrams": 50 }
 *   ]
 *
 * `materialProductRef` is opaque in v2-007a (free-form string identifying a
 * product OR a brand+subtype+color combo). v2-007b can promote it to a real
 * FK to resin_products.id. Components are validated at app layer to sum to 100
 * (when treated as ratios) or to the batch total_volume (when treated as
 * grams) at apply time, not at recipe-save time (recipes are reusable; batch
 * is what enforces).
 */
export const mixRecipes = sqliteTable(
  'mix_recipes',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    components: text('components', { mode: 'json' })
      .$type<Array<{ materialProductRef: string; ratioOrGrams: number }>>()
      .notNull(),
    notes: text('notes'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('mix_recipes_owner_idx').on(t.ownerId)],
);

// ---------------------------------------------------------------------------
// mix_batches
// ---------------------------------------------------------------------------

/**
 * A single applied MixRecipe. Records the actual per-component draws (which
 * specific source bottles + how many grams from each).
 *
 * `perComponentDraws` shape (JSON):
 *   [
 *     { "sourceMaterialId": "<uuid>", "drawAmount": 50, "provenanceClass": "entered" },
 *     { "sourceMaterialId": "<uuid>", "drawAmount": 50, "provenanceClass": "entered" }
 *   ]
 *
 * The corresponding mix_batch material row (kind='mix_batch') has
 * initial_amount = remaining_amount = total_volume on create.
 *
 * When this batch is consumed (T8), the consumption decrements the mix_batch
 * material — NOT the original source bottles (those were already decremented
 * at mix-apply time).
 */
export const mixBatches = sqliteTable(
  'mix_batches',
  {
    id: text('id').primaryKey(),

    /** Recipe used. ON DELETE RESTRICT: don't allow deleting a recipe that has batches. */
    recipeId: text('recipe_id')
      .notNull()
      .references(() => mixRecipes.id, { onDelete: 'restrict' }),

    /** Linked Material row (kind='mix_batch'). ON DELETE CASCADE. */
    materialId: text('material_id')
      .notNull()
      .references(() => materials.id, { onDelete: 'cascade' }),

    totalVolume: real('total_volume').notNull(),

    perComponentDraws: text('per_component_draws', { mode: 'json' })
      .$type<Array<{ sourceMaterialId: string; drawAmount: number; provenanceClass: string }>>()
      .notNull(),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('mix_batches_recipe_idx').on(t.recipeId),
    index('mix_batches_material_idx').on(t.materialId),
  ],
);

// ---------------------------------------------------------------------------
// recycle_events
// ---------------------------------------------------------------------------

/**
 * A single applied recycling. Records the input materials (each contributing
 * weight) and the output spool produced.
 *
 * `inputs` shape (JSON):
 *   [
 *     { "sourceMaterialId": "<uuid>", "weight": 240, "provenanceClass": "measured" },
 *     { "sourceMaterialId": null, "weight": 50, "provenanceClass": "entered", "note": "scrap from purges" }
 *   ]
 *
 * sourceMaterialId may be null when the input is untracked (loose scrap, off-
 * cuts from old prints). The corresponding output Material row (kind=
 * 'recycled_spool') has initial_amount = sum of inputs minus expected loss.
 */
export const recycleEvents = sqliteTable(
  'recycle_events',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),

    inputs: text('inputs', { mode: 'json' })
      .$type<
        Array<{
          sourceMaterialId: string | null;
          weight: number;
          provenanceClass: string;
          note?: string;
        }>
      >()
      .notNull(),

    /** Linked Material row (kind='recycled_spool'). ON DELETE CASCADE. */
    outputSpoolId: text('output_spool_id')
      .notNull()
      .references(() => materials.id, { onDelete: 'cascade' }),

    notes: text('notes'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('recycle_events_owner_idx').on(t.ownerId),
    index('recycle_events_output_idx').on(t.outputSpoolId),
  ],
);
