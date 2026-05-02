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
// Catalog product enums (V2-007b T_B1)
// ---------------------------------------------------------------------------

/**
 * Filament subtype enum. App-layer validates against this list (no DB CHECK
 * per project pattern). Sourced from SpoolmanDB `material` field union plus
 * common engineering grades — see planning/odad/research/v2-007b-catalog-seed.md
 * Q1/Q6.
 */
export const FILAMENT_SUBTYPES = [
  'PLA', 'PLA+', 'PLA-CF', 'PLA-Silk', 'PLA-Matte', 'PLA-Marble', 'PLA-Wood',
  'PETG', 'PETG-CF', 'PETG-rCF',
  'ABS', 'ABS-CF', 'ABS-GF',
  'ASA', 'ASA-CF',
  'TPU-95A', 'TPU-90A', 'TPU-85A',
  'PC', 'PC-FR',
  'Nylon', 'PA-CF', 'PA-GF', 'PAHT-CF', 'PA6-CF', 'PA6-GF', 'PA12', 'PA12-CF',
  'PET-CF',
  'PP', 'PPS-CF', 'PPA-CF', 'PPA-GF',
  'HIPS', 'PVA',
  'other',
] as const;
export type FilamentSubtype = (typeof FILAMENT_SUBTYPES)[number];

/**
 * Resin subtype enum. App-layer validates. Extends PrusaSlicerSLA's
 * material_type list (Tough/Medical/Casting/Model/Engineering/Flexible) with
 * the broader prosumer space (water-washable, dental classes, ceramic, etc).
 * See research Q2/Q6.
 */
export const RESIN_SUBTYPES = [
  'standard',
  'tough',
  'flexible',
  'water-washable',
  'dental-Class-I',
  'dental-Class-II',
  'high-temp',
  'ceramic',
  'engineering',
  'translucent',
  'casting',
  'medical',
  'model',
  'abs-like',
  'plant-based',
  'other',
] as const;
export type ResinSubtype = (typeof RESIN_SUBTYPES)[number];

/**
 * Resin material classification. Tracks regulatory/use-case posture
 * separately from subtype. App-layer validates. See research Q6.
 */
export const RESIN_MATERIAL_CLASSES = [
  'consumer',
  'industrial',
  'medical-Class-I',
  'medical-Class-IIa',
] as const;
export type ResinMaterialClass = (typeof RESIN_MATERIAL_CLASSES)[number];

/**
 * Provenance of a catalog product row. App-layer validates against this list.
 *  - `system:*` rows are bundled with the lootgoblin release; admin-created
 *    only and `owner_id` MUST be NULL.
 *  - `community-pr` rows came in via the community contribution pipeline
 *    (v2-008+ work) and are bundled at release time; `owner_id` NULL.
 *  - `user` rows are user-customised entries; `owner_id` MUST be non-NULL.
 *
 * App-layer enforcement of NULL/non-NULL ownership lives in the catalog
 * route handlers (V2-007b T_B2/T_B3).
 */
export const PRODUCT_SOURCES = [
  'system:spoolmandb',
  'system:open-filament-db',
  'system:polymaker-preset',
  'community-pr',
  'user',
] as const;
export type ProductSource = (typeof PRODUCT_SOURCES)[number];

// ---------------------------------------------------------------------------
// filament_products (V2-007b T_B1: full catalog schema)
// ---------------------------------------------------------------------------

/**
 * Filament product catalog. V2-007a shipped as a stub (just an id PK);
 * V2-007b T_B1 (migration 0022) ALTERs in the full column set.
 *
 * A row models a distinct {brand, product_line, color} catalog entry — e.g.
 * "Bambu Lab PLA Basic Sunset Orange". Materials in the user's inventory link
 * to this via `materials.product_id` when the user picks a known product;
 * inline brand/subtype/colors on the Material remain the fallback display when
 * `product_id` is NULL.
 *
 * Ownership model: `owner_id` is NULL for system-seeded entries (the bundled
 * catalog from SpoolmanDB / Open Filament DB / Polymaker preset). Non-NULL =
 * a user's custom entry. Only admins can create system-seeded rows; regular
 * users can only create rows where owner_id = their own id. Validated at app
 * layer.
 *
 * Multi-hex color encoding matches `materials.colors` exactly: a JSON array
 * of 1-4 hex strings + a `color_pattern` discriminator. SpoolmanDB's
 * `multi_color_direction` maps to `color_pattern` per research Q4:
 *  - solid          → length 1
 *  - dual-tone      → length 2 + coaxial direction
 *  - gradient       → length 2-3 + longitudinal direction
 *  - multi-section  → length 4 + longitudinal direction
 *
 * Migration 0022 ADDs all non-id columns as nullable (SQLite cannot ADD COLUMN
 * NOT NULL without a DEFAULT, and the default-on-empty-string anti-pattern
 * would corrupt invariants). NOT NULL is enforced at the Drizzle level on
 * inserts — every code path goes through Drizzle, so the runtime contract
 * holds. Raw-SQL writes that bypass Drizzle MUST honour the same invariants.
 *
 * Indexes match the catalog filter dimensions documented in research Q6:
 * brand, subtype, (brand, subtype) compound, owner_id, source, plus a JSON
 * expression index on colors[0] for primary-color filter (declared in raw SQL
 * since Drizzle's index() builder does not support json_extract expressions).
 */
export const filamentProducts = sqliteTable(
  'filament_products',
  {
    id: text('id').primaryKey(),

    /** Manufacturer brand. e.g. "Bambu Lab", "Polymaker", "eSUN". */
    brand: text('brand').notNull(),

    /**
     * Product line within the brand. e.g. "PLA Basic", "PolyTerra", "Silk+".
     * Optional — many SpoolmanDB entries roll line into the product name.
     */
    productLine: text('product_line'),

    /**
     * Material subtype. App-layer validates against FILAMENT_SUBTYPES.
     * SpoolmanDB `material` maps near-1:1 (PLA, PETG, ABS, ASA, TPU, etc).
     */
    subtype: text('subtype').notNull(),

    /**
     * 1-4 hex colors, JSON array of #RRGGBB strings. Validated at app layer.
     * SpoolmanDB encodes via `hexes[]`; single-color entries use `hex` which
     * we wrap in a length-1 array for consistency with multi-hex products.
     */
    colors: text('colors', { mode: 'json' }).$type<string[]>().notNull(),

    /**
     * Color pattern discriminator. App-layer validates against COLOR_PATTERNS
     * (re-exported from this module). Length of `colors` must match the
     * pattern: solid=1, dual-tone=2, gradient=2-3, multi-section=2-4.
     */
    colorPattern: text('color_pattern').notNull(),

    /** Vendor-given color name. e.g. "Velvet Eclipse", "Sunset Gradient". */
    colorName: text('color_name'),

    /**
     * Default print temps. JSON object. Source: SpoolmanDB
     * `extruder_temp`/`bed_temp`/`chamber_temp` fields, mapped to nozzle min/
     * max (some entries publish a range, others a single point).
     */
    defaultTemps: text('default_temps', { mode: 'json' }).$type<{
      nozzle_min?: number;
      nozzle_max?: number;
      bed?: number;
      chamber?: number;
    }>(),

    /** Filament diameter in mm. SpoolmanDB `diameters[0]`. Almost always 1.75. */
    diameterMm: real('diameter_mm'),

    /** Density in g/cm³. SpoolmanDB `density`. */
    density: real('density'),

    /** Spool gross weight in g. SpoolmanDB `weights[0].weight`. */
    spoolWeightG: real('spool_weight_g'),

    /** Empty spool weight in g (tare). SpoolmanDB `weights[0].spool_weight`. */
    emptySpoolWeightG: real('empty_spool_weight_g'),

    /** Surface finish. e.g. "matte", "glossy". Freeform per source. */
    finish: text('finish'),

    /** Pattern attribute. e.g. "sparkle", "marble", "wood". Freeform per source. */
    pattern: text('pattern'),

    /** SpoolmanDB `glow` flag — phosphorescent material. */
    isGlow: integer('is_glow', { mode: 'boolean' }),

    /** SpoolmanDB `translucent` flag. */
    isTranslucent: integer('is_translucent', { mode: 'boolean' }),

    /** Vendor product page URL. Manually curated; not in SpoolmanDB. */
    retailUrl: text('retail_url'),

    /**
     * Slicer product identifier — Bambu Studio AMS GFA-codes etc. Opaque
     * string for slicer handoff later.
     */
    slicerId: text('slicer_id'),

    /**
     * Owner. NULL = system-seeded (bundled catalog). Non-NULL = user custom
     * entry. App-layer enforces the NULL/non-NULL invariant via the source
     * column (see PRODUCT_SOURCES). Cascade: user delete removes their custom
     * entries; system-seeded rows are untouched (their owner_id is already NULL).
     */
    ownerId: text('owner_id').references(() => user.id, { onDelete: 'cascade' }),

    /** Provenance. App-layer validates against PRODUCT_SOURCES. */
    source: text('source').notNull(),

    /**
     * Provenance back-reference. e.g. SpoolmanDB commit SHA + file path
     * ("d4f3a21:filaments/bambulab.json"), or vendor URL for manually curated
     * entries. Free-form; for traceability and audit only.
     */
    sourceRef: text('source_ref'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    /** Brand-only filter (e.g. "all Bambu Lab products"). */
    index('filament_products_brand_idx').on(t.brand),
    /** Subtype-only filter (e.g. "all PETG-CF"). */
    index('filament_products_subtype_idx').on(t.subtype),
    /** Brand+subtype compound (e.g. "all Bambu PLA"). */
    index('filament_products_brand_subtype_idx').on(t.brand, t.subtype),
    /** Owner lookup; partial-WHERE-NULL would be ideal but Drizzle SQLite
     *  index builder lacks .where(); plain index covers both browse paths
     *  (system catalog: owner_id IS NULL) and user-custom (owner_id = ?). */
    index('filament_products_owner_idx').on(t.ownerId),
    /** Provenance filter (e.g. "show me everything from SpoolmanDB"). */
    index('filament_products_source_idx').on(t.source),
    // NOTE: Expression index on json_extract(colors, '$[0]') for primary-color
    // filtering is declared directly in migration 0022 — Drizzle's index()
    // builder does not support SQLite expression indexes. See test 9.
  ],
);

// ---------------------------------------------------------------------------
// resin_products (V2-007b T_B1: full catalog schema)
// ---------------------------------------------------------------------------

/**
 * Resin product catalog. V2-007a stub → V2-007b T_B1 full schema (migration
 * 0022). Same ownership + source model as filament_products.
 *
 * Resin coverage is materially thinner than filament — PrusaSlicerSLA is the
 * only major open-license seed source and lacks ELEGOO/Phrozen/Anycubic/SUNLU
 * (the four largest resin brands by sales). Most non-Prusa entries will be
 * hand-curated or community-PR'd. Many fields are nullable to accommodate
 * sparse vendor data — PrusaSlicer .ini does not publish density, viscosity,
 * or bottle volumes.
 *
 * `colors` is nullable here (unlike filament): some seed entries may ship
 * without a hex (especially industrial/dental resins where color is
 * incidental). When provided, format matches filament: JSON array of
 * #RRGGBB strings (resin is almost always solid color so length-1).
 */
export const resinProducts = sqliteTable(
  'resin_products',
  {
    id: text('id').primaryKey(),

    /** Manufacturer brand. e.g. "Prusa Polymers", "Siraya Tech". */
    brand: text('brand').notNull(),

    /** Product line. e.g. "Tough", "Aqua 8K", "Standard". */
    productLine: text('product_line'),

    /**
     * Resin subtype. App-layer validates against RESIN_SUBTYPES. Extends
     * PrusaSlicerSLA's material_type list with the broader prosumer space.
     */
    subtype: text('subtype').notNull(),

    /**
     * 1-N hex colors. JSON array; nullable. Most resin entries are solid =
     * length-1. Multi-color resin is exotic.
     */
    colors: text('colors', { mode: 'json' }).$type<string[]>(),

    /** Vendor color name. e.g. "Prusa Orange", "Skull Grey". */
    colorName: text('color_name'),

    /**
     * Default exposure parameters. JSON. PrusaSlicerSLA `[sla_material:...]`
     * sections expose layer height + exposure + bottom layer params.
     */
    defaultExposure: text('default_exposure', { mode: 'json' }).$type<{
      layer_height_mm?: number;
      exposure_seconds?: number;
      bottom_layers?: number;
      bottom_exposure_seconds?: number;
      lift_speed_mm_min?: number;
    }>(),

    /** Density in g/ml. Hand-curated; not in PrusaSlicerSLA. */
    densityGMl: real('density_g_ml'),

    /** Viscosity in cps. Hand-curated. */
    viscosityCps: real('viscosity_cps'),

    /** Bottle volume in ml. Common values: 500, 1000. */
    bottleVolumeMl: real('bottle_volume_ml'),

    /**
     * Printer compatibility metadata. Stretch goal — UV wavelength + a list of
     * compatible printer references for surfacing "this resin works with your
     * Saturn 3" UX.
     */
    compatibility: text('compatibility', { mode: 'json' }).$type<{
      wavelength_nm?: number;
      printer_compat?: string[];
    }>(),

    /**
     * Material classification. App-layer validates against
     * RESIN_MATERIAL_CLASSES. Tracks regulatory/use-case posture (consumer
     * vs industrial vs medical Class I/IIa).
     */
    materialClass: text('material_class'),

    /** Vendor product page URL. */
    retailUrl: text('retail_url'),

    /**
     * Owner. NULL = system-seeded; non-NULL = user custom. Same invariant
     * as filament_products.
     */
    ownerId: text('owner_id').references(() => user.id, { onDelete: 'cascade' }),

    /** Provenance. App-layer validates against PRODUCT_SOURCES. */
    source: text('source').notNull(),

    /** Provenance back-reference. */
    sourceRef: text('source_ref'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('resin_products_brand_idx').on(t.brand),
    index('resin_products_subtype_idx').on(t.subtype),
    index('resin_products_class_idx').on(t.materialClass),
    index('resin_products_owner_idx').on(t.ownerId),
    index('resin_products_source_idx').on(t.source),
  ],
);

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

    /**
     * Idempotency-Key on POST /api/v1/materials. Nullable; when set, the route
     * dedupes replayed creates against (owner_id, idempotency_key). Migration
     * 0021 adds a partial unique index. See V2-007a-T14.
     */
    idempotencyKey: text('idempotency_key'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    /** List user's active materials. */
    index('materials_owner_active_idx').on(t.ownerId, t.active),
    /** Filter by kind (filament-only views, etc). */
    index('materials_owner_kind_idx').on(t.ownerId, t.kind),
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
    /** Idempotency-Key on POST /api/v1/materials/mix-recipes (V2-007a-T14). */
    idempotencyKey: text('idempotency_key'),
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

    /**
     * Denormalised owner_id for the partial unique idempotency index. Mirrors
     * the recipe's owner_id (recipes are owner-scoped). Added in migration
     * 0021. Nullable for legacy rows; the route always populates on insert.
     */
    ownerId: text('owner_id'),
    /** Idempotency-Key on POST /api/v1/materials/mix-batches (V2-007a-T14). */
    idempotencyKey: text('idempotency_key'),

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

    /** Idempotency-Key on POST /api/v1/materials/recycle-events (V2-007a-T14). */
    idempotencyKey: text('idempotency_key'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('recycle_events_owner_idx').on(t.ownerId),
    index('recycle_events_output_idx').on(t.outputSpoolId),
  ],
);
