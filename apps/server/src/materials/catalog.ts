/**
 * Catalog CRUD — V2-007b T_B2.
 *
 * Pure-domain create/update/delete/list/get/search helpers for the
 * `filament_products` and `resin_products` tables expanded by T_B1.
 *
 * Two distinct surfaces:
 *
 *  - READ (browse) — any authenticated user can list/search the catalog.
 *    Visibility = system-seeded entries (`owner_id IS NULL`) + the caller's
 *    OWN custom entries (`owner_id = actor.id`). Cross-owner CUSTOM entries
 *    are intentionally not visible (privacy: a hand-typed homebrew is the
 *    user's alone).
 *
 *  - WRITE (mutate) — bifurcated by row provenance:
 *      * User-CUSTOM rows  → only the row's owner can update/delete.
 *        `source` MUST be `'user'`, `owner_id = actor.id`.
 *      * SYSTEM rows       → only admins can create/update/delete.
 *        `source` MUST be one of the `system:*` (or `community-pr`) values,
 *        `owner_id` is NULL.
 *      * Admins do NOT bypass user-custom ownership (privacy by design).
 *
 * Source–owner discipline (validated on every write):
 *
 *      | source                  | owner_id  | actor role |
 *      |-------------------------|-----------|------------|
 *      | user                    | actor.id  | any        |
 *      | system:spoolmandb       | NULL      | admin      |
 *      | system:open-filament-db | NULL      | admin      |
 *      | system:polymaker-preset | NULL      | admin      |
 *      | community-pr            | NULL      | admin      |
 *
 * All functions return a discriminated union — `{ ok: true, ... }` on
 * success, `{ ok: false, reason, details? }` on validation failure (matches
 * the V2-007a-T4 lifecycle pattern). DB errors set `reason: 'persist-failed'`.
 *
 * Idempotency: an explicit `id` MAY be supplied (e.g. seed scripts re-running
 * with stable ids). Same id + same body → returns existing row; same id +
 * different body → `id-conflict`. No (ownerId, idempotencyKey) plumbing here
 * — the tables don't carry an idempotency_key column, only the explicit-id
 * path needs to be reentrant.
 */

import * as crypto from 'node:crypto';
import { and, asc, desc, eq, isNull, or, like, lt } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import { logger } from '../logger';
import {
  FILAMENT_SUBTYPES,
  RESIN_SUBTYPES,
  RESIN_MATERIAL_CLASSES,
  PRODUCT_SOURCES,
  isFilamentSubtype,
  isResinSubtype,
  isResinMaterialClass,
  isProductSource,
  type FilamentSubtype,
  type ResinSubtype,
  type ResinMaterialClass,
  type ProductSource,
  type FilamentProduct,
  type ResinProduct,
} from './catalog-types';
import type { ColorPattern } from '../db/schema.materials';
import { validateColors } from './validate';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type CatalogFailure = { ok: false; reason: string; details?: string };

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

const SYSTEM_SOURCES: readonly ProductSource[] = [
  'system:spoolmandb',
  'system:open-filament-db',
  'system:polymaker-preset',
  'community-pr',
];

function isSystemSource(s: ProductSource): boolean {
  return (SYSTEM_SOURCES as readonly string[]).includes(s);
}

/**
 * Validate the source/ownerId/actor-role triple. Centralised so create,
 * update, and delete enforce identical rules.
 *
 *   - source='user'     → ownerId MUST be a non-empty string AND must equal
 *                          actorUserId (no impersonation).
 *   - source=system:*   → ownerId MUST be null AND actorRole MUST be 'admin'.
 */
function validateSourceOwnership(args: {
  source: ProductSource;
  ownerId: string | null;
  actorUserId: string;
  actorRole: 'user' | 'admin';
}): { ok: true } | CatalogFailure {
  const { source, ownerId, actorUserId, actorRole } = args;
  if (source === 'user') {
    if (ownerId === null || ownerId === undefined || ownerId.length === 0) {
      return {
        ok: false,
        reason: 'source-owner-mismatch',
        details: "source='user' requires ownerId",
      };
    }
    if (ownerId !== actorUserId) {
      return { ok: false, reason: 'cannot-impersonate-owner' };
    }
    return { ok: true };
  }
  // system / community-pr.
  if (ownerId !== null) {
    return {
      ok: false,
      reason: 'source-owner-mismatch',
      details: `source=${source} requires ownerId=null`,
    };
  }
  if (actorRole !== 'admin') {
    return { ok: false, reason: 'admin-required' };
  }
  return { ok: true };
}

/**
 * Validate that the actor may MUTATE the given existing catalog row.
 *  - user-custom row (ownerId set) → only that owner can mutate.
 *    Admins cannot bypass (privacy).
 *  - system row (ownerId null)     → only admins can mutate.
 */
function validateMutateExisting(args: {
  rowOwnerId: string | null;
  actorUserId: string;
  actorRole: 'user' | 'admin';
}): { ok: true } | CatalogFailure {
  const { rowOwnerId, actorUserId, actorRole } = args;
  if (rowOwnerId === null) {
    if (actorRole !== 'admin') {
      return { ok: false, reason: 'admin-required' };
    }
    return { ok: true };
  }
  // user-custom row.
  if (rowOwnerId !== actorUserId) {
    // 404 surface at the route layer (id-leak prevention).
    return { ok: false, reason: 'not-found' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// FILAMENT — types
// ---------------------------------------------------------------------------

export interface CreateFilamentProductInput {
  brand: string;
  subtype: FilamentSubtype;
  colors: string[];
  colorPattern: ColorPattern;
  source: ProductSource;
  ownerId: string | null;
  actorUserId: string;
  actorRole: 'user' | 'admin';
  productLine?: string;
  colorName?: string;
  defaultTemps?: {
    nozzle_min?: number;
    nozzle_max?: number;
    bed?: number;
    chamber?: number;
  };
  diameterMm?: number;
  density?: number;
  spoolWeightG?: number;
  emptySpoolWeightG?: number;
  finish?: string;
  pattern?: string;
  isGlow?: boolean;
  isTranslucent?: boolean;
  retailUrl?: string;
  slicerId?: string;
  sourceRef?: string;
  /** Optional client-supplied id (stable seed-import re-runs). */
  id?: string;
}

export type CreateFilamentProductResult =
  | { ok: true; productId: string; product: FilamentProduct; replayed: boolean }
  | CatalogFailure;

export interface UpdateFilamentProductInput {
  id: string;
  actorUserId: string;
  actorRole: 'user' | 'admin';
  patch: Partial<{
    brand: string;
    productLine: string | null;
    subtype: FilamentSubtype;
    colors: string[];
    colorPattern: ColorPattern;
    colorName: string | null;
    defaultTemps:
      | {
          nozzle_min?: number;
          nozzle_max?: number;
          bed?: number;
          chamber?: number;
        }
      | null;
    diameterMm: number | null;
    density: number | null;
    spoolWeightG: number | null;
    emptySpoolWeightG: number | null;
    finish: string | null;
    pattern: string | null;
    isGlow: boolean | null;
    isTranslucent: boolean | null;
    retailUrl: string | null;
    slicerId: string | null;
    sourceRef: string | null;
  }>;
}

export type UpdateFilamentProductResult =
  | { ok: true; product: FilamentProduct }
  | CatalogFailure;

export interface DeleteFilamentProductInput {
  id: string;
  actorUserId: string;
  actorRole: 'user' | 'admin';
}

export type DeleteFilamentProductResult =
  | { ok: true }
  | CatalogFailure;

export interface ListFilamentProductsInput {
  actorUserId: string;
  actorRole: 'user' | 'admin';
  brand?: string;
  subtype?: FilamentSubtype;
  source?: ProductSource;
  /** Primary (first) color hex filter — matches json_extract(colors, '$[0]'). */
  primaryColor?: string;
  limit?: number;
  /** Cursor — last id from previous page (keyset by id ascending). */
  cursor?: string;
}

export type ListFilamentProductsResult =
  | {
      ok: true;
      products: FilamentProduct[];
      nextCursor: string | null;
    }
  | CatalogFailure;

export interface SearchFilamentProductsInput {
  actorUserId: string;
  actorRole: 'user' | 'admin';
  prefix: string;
  limit?: number;
}

export type SearchFilamentProductsResult =
  | { ok: true; products: FilamentProduct[] }
  | CatalogFailure;

export type GetFilamentProductResult =
  | { ok: true; product: FilamentProduct }
  | CatalogFailure;

// ---------------------------------------------------------------------------
// FILAMENT — implementations
// ---------------------------------------------------------------------------

function normalizeFilamentForCompare(row: FilamentProduct): string {
  return JSON.stringify({
    brand: row.brand,
    productLine: row.productLine ?? null,
    subtype: row.subtype,
    colors: (row.colors ?? []).map((c) => c.toUpperCase()),
    colorPattern: row.colorPattern,
    colorName: row.colorName ?? null,
    defaultTemps: row.defaultTemps ?? null,
    diameterMm: row.diameterMm ?? null,
    density: row.density ?? null,
    spoolWeightG: row.spoolWeightG ?? null,
    emptySpoolWeightG: row.emptySpoolWeightG ?? null,
    finish: row.finish ?? null,
    pattern: row.pattern ?? null,
    isGlow: row.isGlow ?? null,
    isTranslucent: row.isTranslucent ?? null,
    retailUrl: row.retailUrl ?? null,
    slicerId: row.slicerId ?? null,
    ownerId: row.ownerId ?? null,
    source: row.source,
    sourceRef: row.sourceRef ?? null,
  });
}

function normalizeFilamentForCreate(
  input: CreateFilamentProductInput,
  colors: string[],
): string {
  return JSON.stringify({
    brand: input.brand,
    productLine: input.productLine ?? null,
    subtype: input.subtype,
    colors: colors.map((c) => c.toUpperCase()),
    colorPattern: input.colorPattern,
    colorName: input.colorName ?? null,
    defaultTemps: input.defaultTemps ?? null,
    diameterMm: input.diameterMm ?? null,
    density: input.density ?? null,
    spoolWeightG: input.spoolWeightG ?? null,
    emptySpoolWeightG: input.emptySpoolWeightG ?? null,
    finish: input.finish ?? null,
    pattern: input.pattern ?? null,
    isGlow: input.isGlow ?? null,
    isTranslucent: input.isTranslucent ?? null,
    retailUrl: input.retailUrl ?? null,
    slicerId: input.slicerId ?? null,
    ownerId: input.ownerId ?? null,
    source: input.source,
    sourceRef: input.sourceRef ?? null,
  });
}

export async function createFilamentProduct(
  input: CreateFilamentProductInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<CreateFilamentProductResult> {
  // brand
  if (typeof input.brand !== 'string' || input.brand.length === 0) {
    return { ok: false, reason: 'brand-required' };
  }
  // source enum
  if (!isProductSource(input.source)) {
    return { ok: false, reason: 'invalid-source' };
  }
  // subtype enum
  if (!isFilamentSubtype(input.subtype)) {
    return { ok: false, reason: 'invalid-subtype' };
  }
  // owner discipline
  const ownership = validateSourceOwnership({
    source: input.source,
    ownerId: input.ownerId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
  });
  if (!ownership.ok) return ownership;

  // colors+pattern
  const c = validateColors(input.colors, input.colorPattern);
  if (!c.ok) return c;

  const now = opts?.now ?? new Date();
  const id = input.id ?? crypto.randomUUID();

  // If client supplied an id, check for replay/conflict before insert.
  if (input.id) {
    const existing = await getServerDb(opts?.dbUrl)
      .select()
      .from(schema.filamentProducts)
      .where(eq(schema.filamentProducts.id, id))
      .limit(1);
    const prior = existing[0];
    if (prior) {
      const priorKey = normalizeFilamentForCompare(prior);
      const candidateKey = normalizeFilamentForCreate(input, c.colors);
      if (priorKey === candidateKey) {
        return { ok: true, productId: prior.id, product: prior, replayed: true };
      }
      return { ok: false, reason: 'id-conflict' };
    }
  }

  const row: typeof schema.filamentProducts.$inferInsert = {
    id,
    brand: input.brand,
    productLine: input.productLine ?? null,
    subtype: input.subtype,
    colors: c.colors,
    colorPattern: c.colorPattern,
    colorName: input.colorName ?? null,
    defaultTemps: input.defaultTemps ?? null,
    diameterMm: input.diameterMm ?? null,
    density: input.density ?? null,
    spoolWeightG: input.spoolWeightG ?? null,
    emptySpoolWeightG: input.emptySpoolWeightG ?? null,
    finish: input.finish ?? null,
    pattern: input.pattern ?? null,
    isGlow: input.isGlow ?? null,
    isTranslucent: input.isTranslucent ?? null,
    retailUrl: input.retailUrl ?? null,
    slicerId: input.slicerId ?? null,
    ownerId: input.ownerId,
    source: input.source,
    sourceRef: input.sourceRef ?? null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const db = getServerDb(opts?.dbUrl);
    await db.insert(schema.filamentProducts).values(row);
    const fetched = await db
      .select()
      .from(schema.filamentProducts)
      .where(eq(schema.filamentProducts.id, id))
      .limit(1);
    const persisted = fetched[0]!;
    return { ok: true, productId: id, product: persisted, replayed: false };
  } catch (err) {
    logger.warn(
      { err, id, ownerId: input.ownerId, source: input.source },
      'createFilamentProduct: persist failed',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getFilamentProduct(
  args: { id: string; actorUserId: string; actorRole: 'user' | 'admin' },
  opts?: { dbUrl?: string },
): Promise<GetFilamentProductResult> {
  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select()
    .from(schema.filamentProducts)
    .where(eq(schema.filamentProducts.id, args.id))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not-found' };

  // Read visibility: system rows visible to all; user-custom only to its owner.
  if (row.ownerId !== null && row.ownerId !== args.actorUserId) {
    return { ok: false, reason: 'not-found' };
  }
  return { ok: true, product: row };
}

export async function updateFilamentProduct(
  input: UpdateFilamentProductInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<UpdateFilamentProductResult> {
  if (typeof input.id !== 'string' || input.id.length === 0) {
    return { ok: false, reason: 'id-required' };
  }

  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select()
    .from(schema.filamentProducts)
    .where(eq(schema.filamentProducts.id, input.id))
    .limit(1);
  const existing = rows[0];
  if (!existing) return { ok: false, reason: 'not-found' };

  const guard = validateMutateExisting({
    rowOwnerId: existing.ownerId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
  });
  if (!guard.ok) return guard;

  const p = input.patch;
  if (Object.keys(p).length === 0) {
    return { ok: false, reason: 'empty-patch' };
  }

  // Subtype validation if patched.
  if (p.subtype !== undefined && !isFilamentSubtype(p.subtype)) {
    return { ok: false, reason: 'invalid-subtype' };
  }
  // Colors+pattern must be supplied together if either is present.
  if ((p.colors !== undefined) !== (p.colorPattern !== undefined)) {
    return { ok: false, reason: 'colors-pattern-paired' };
  }
  let normalizedColors: string[] | undefined;
  let normalizedPattern: ColorPattern | undefined;
  if (p.colors !== undefined && p.colorPattern !== undefined) {
    const c = validateColors(p.colors, p.colorPattern);
    if (!c.ok) return c;
    normalizedColors = c.colors;
    normalizedPattern = c.colorPattern;
  }

  const now = opts?.now ?? new Date();
  const patchRow: Partial<typeof schema.filamentProducts.$inferInsert> = {
    updatedAt: now,
  };
  if (p.brand !== undefined) {
    if (typeof p.brand !== 'string' || p.brand.length === 0) {
      return { ok: false, reason: 'brand-required' };
    }
    patchRow.brand = p.brand;
  }
  if (p.productLine !== undefined) patchRow.productLine = p.productLine;
  if (p.subtype !== undefined) patchRow.subtype = p.subtype;
  if (normalizedColors !== undefined) patchRow.colors = normalizedColors;
  if (normalizedPattern !== undefined) patchRow.colorPattern = normalizedPattern;
  if (p.colorName !== undefined) patchRow.colorName = p.colorName;
  if (p.defaultTemps !== undefined) patchRow.defaultTemps = p.defaultTemps;
  if (p.diameterMm !== undefined) patchRow.diameterMm = p.diameterMm;
  if (p.density !== undefined) patchRow.density = p.density;
  if (p.spoolWeightG !== undefined) patchRow.spoolWeightG = p.spoolWeightG;
  if (p.emptySpoolWeightG !== undefined) {
    patchRow.emptySpoolWeightG = p.emptySpoolWeightG;
  }
  if (p.finish !== undefined) patchRow.finish = p.finish;
  if (p.pattern !== undefined) patchRow.pattern = p.pattern;
  if (p.isGlow !== undefined) patchRow.isGlow = p.isGlow;
  if (p.isTranslucent !== undefined) patchRow.isTranslucent = p.isTranslucent;
  if (p.retailUrl !== undefined) patchRow.retailUrl = p.retailUrl;
  if (p.slicerId !== undefined) patchRow.slicerId = p.slicerId;
  if (p.sourceRef !== undefined) patchRow.sourceRef = p.sourceRef;

  try {
    await db
      .update(schema.filamentProducts)
      .set(patchRow)
      .where(eq(schema.filamentProducts.id, input.id));
    const refreshed = await db
      .select()
      .from(schema.filamentProducts)
      .where(eq(schema.filamentProducts.id, input.id))
      .limit(1);
    const updated = refreshed[0]!;
    return { ok: true, product: updated };
  } catch (err) {
    logger.warn({ err, id: input.id }, 'updateFilamentProduct: persist failed');
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deleteFilamentProduct(
  input: DeleteFilamentProductInput,
  opts?: { dbUrl?: string },
): Promise<DeleteFilamentProductResult> {
  if (typeof input.id !== 'string' || input.id.length === 0) {
    return { ok: false, reason: 'id-required' };
  }
  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select()
    .from(schema.filamentProducts)
    .where(eq(schema.filamentProducts.id, input.id))
    .limit(1);
  const existing = rows[0];
  if (!existing) return { ok: false, reason: 'not-found' };

  const guard = validateMutateExisting({
    rowOwnerId: existing.ownerId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
  });
  if (!guard.ok) return guard;

  try {
    await db
      .delete(schema.filamentProducts)
      .where(eq(schema.filamentProducts.id, input.id));
    return { ok: true };
  } catch (err) {
    logger.warn({ err, id: input.id }, 'deleteFilamentProduct: persist failed');
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

export async function listFilamentProducts(
  input: ListFilamentProductsInput,
  opts?: { dbUrl?: string },
): Promise<ListFilamentProductsResult> {
  const limit = Math.min(
    Math.max(1, input.limit ?? DEFAULT_LIST_LIMIT),
    MAX_LIST_LIMIT,
  );

  if (input.subtype !== undefined && !isFilamentSubtype(input.subtype)) {
    return { ok: false, reason: 'invalid-subtype' };
  }
  if (input.source !== undefined && !isProductSource(input.source)) {
    return { ok: false, reason: 'invalid-source' };
  }
  if (
    input.primaryColor !== undefined &&
    (typeof input.primaryColor !== 'string' || !HEX_COLOR_RE.test(input.primaryColor))
  ) {
    return { ok: false, reason: 'invalid-primary-color' };
  }

  const db = getServerDb(opts?.dbUrl);

  // Owner-scoped read predicate: system entries (NULL) OR caller's own.
  const ownerPredicate = or(
    isNull(schema.filamentProducts.ownerId),
    eq(schema.filamentProducts.ownerId, input.actorUserId),
  )!;

  const conditions = [ownerPredicate] as const;
  const extra: Array<ReturnType<typeof eq>> = [];
  if (input.brand) extra.push(eq(schema.filamentProducts.brand, input.brand));
  if (input.subtype) extra.push(eq(schema.filamentProducts.subtype, input.subtype));
  if (input.source) extra.push(eq(schema.filamentProducts.source, input.source));
  if (input.cursor) {
    // Keyset pagination by id ascending — id is unique + indexed (PK).
    // We pass last-seen id; subsequent rows have id > cursor. SQLite TEXT
    // collation supports `>` lexicographically (UUIDs are stable lex order).
    // Using `lt` on id for descending cursor would invert; we use ascending.
  }

  const whereExpr =
    extra.length === 0
      ? ownerPredicate
      : and(...conditions, ...extra)!;

  // For cursor pagination, we use id-ascending keyset. Build the cursor
  // predicate separately with `>` via raw drizzle expr.
  let finalWhere = whereExpr;
  if (input.cursor) {
    // Use lt on createdAt-by-cursor would be fragile — use id directly.
    // Drizzle drizzle-orm exposes `gt` via the same import; import inline
    // below to avoid bloating the top-level imports with rarely-used ops.
    const { gt } = await import('drizzle-orm');
    finalWhere = and(whereExpr, gt(schema.filamentProducts.id, input.cursor))!;
  }

  // Primary color expression filter — relies on the json_extract index from
  // migration 0022. SQL fragment via drizzle's `sql` template.
  if (input.primaryColor) {
    const { sql } = await import('drizzle-orm');
    finalWhere = and(
      finalWhere,
      sql`json_extract(${schema.filamentProducts.colors}, '$[0]') = ${input.primaryColor.toUpperCase()}`,
    )!;
  }

  const rows = await db
    .select()
    .from(schema.filamentProducts)
    .where(finalWhere)
    .orderBy(asc(schema.filamentProducts.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? sliced[sliced.length - 1]!.id : null;
  return { ok: true, products: sliced, nextCursor };
}

export async function searchFilamentProducts(
  input: SearchFilamentProductsInput,
  opts?: { dbUrl?: string },
): Promise<SearchFilamentProductsResult> {
  if (typeof input.prefix !== 'string' || input.prefix.length === 0) {
    return { ok: false, reason: 'prefix-required' };
  }
  const limit = Math.min(
    Math.max(1, input.limit ?? DEFAULT_SEARCH_LIMIT),
    MAX_SEARCH_LIMIT,
  );

  const db = getServerDb(opts?.dbUrl);
  const ownerPredicate = or(
    isNull(schema.filamentProducts.ownerId),
    eq(schema.filamentProducts.ownerId, input.actorUserId),
  )!;

  // Case-insensitive prefix on brand OR product_line OR color_name.
  // SQLite's LIKE is case-insensitive for ASCII by default, plus we lowercase
  // both sides for safety against the unicode edge.
  const { sql } = await import('drizzle-orm');
  const lowerPrefix = input.prefix.toLowerCase();
  const matchExpr = or(
    like(sql`lower(${schema.filamentProducts.brand})`, `${lowerPrefix}%`),
    like(sql`lower(${schema.filamentProducts.productLine})`, `${lowerPrefix}%`),
    like(sql`lower(${schema.filamentProducts.colorName})`, `${lowerPrefix}%`),
  )!;

  const rows = await db
    .select()
    .from(schema.filamentProducts)
    .where(and(ownerPredicate, matchExpr))
    .orderBy(asc(schema.filamentProducts.brand), asc(schema.filamentProducts.subtype))
    .limit(limit);

  return { ok: true, products: rows };
}

// ---------------------------------------------------------------------------
// RESIN — types + impl (parallel structure)
// ---------------------------------------------------------------------------

export interface CreateResinProductInput {
  brand: string;
  subtype: ResinSubtype;
  source: ProductSource;
  ownerId: string | null;
  actorUserId: string;
  actorRole: 'user' | 'admin';
  /** Resin colors are nullable, optionally a single hex (or short array). */
  colors?: string[] | null;
  productLine?: string;
  colorName?: string;
  defaultExposure?: {
    layer_height_mm?: number;
    exposure_seconds?: number;
    bottom_layers?: number;
    bottom_exposure_seconds?: number;
    lift_speed_mm_min?: number;
  };
  densityGMl?: number;
  viscosityCps?: number;
  bottleVolumeMl?: number;
  compatibility?: { wavelength_nm?: number; printer_compat?: string[] };
  materialClass?: ResinMaterialClass;
  retailUrl?: string;
  sourceRef?: string;
  id?: string;
}

export type CreateResinProductResult =
  | { ok: true; productId: string; product: ResinProduct; replayed: boolean }
  | CatalogFailure;

export interface UpdateResinProductInput {
  id: string;
  actorUserId: string;
  actorRole: 'user' | 'admin';
  patch: Partial<{
    brand: string;
    productLine: string | null;
    subtype: ResinSubtype;
    colors: string[] | null;
    colorName: string | null;
    defaultExposure:
      | {
          layer_height_mm?: number;
          exposure_seconds?: number;
          bottom_layers?: number;
          bottom_exposure_seconds?: number;
          lift_speed_mm_min?: number;
        }
      | null;
    densityGMl: number | null;
    viscosityCps: number | null;
    bottleVolumeMl: number | null;
    compatibility:
      | { wavelength_nm?: number; printer_compat?: string[] }
      | null;
    materialClass: ResinMaterialClass | null;
    retailUrl: string | null;
    sourceRef: string | null;
  }>;
}

export type UpdateResinProductResult =
  | { ok: true; product: ResinProduct }
  | CatalogFailure;

export interface DeleteResinProductInput {
  id: string;
  actorUserId: string;
  actorRole: 'user' | 'admin';
}

export type DeleteResinProductResult = { ok: true } | CatalogFailure;

export interface ListResinProductsInput {
  actorUserId: string;
  actorRole: 'user' | 'admin';
  brand?: string;
  subtype?: ResinSubtype;
  materialClass?: ResinMaterialClass;
  source?: ProductSource;
  limit?: number;
  cursor?: string;
}

export type ListResinProductsResult =
  | { ok: true; products: ResinProduct[]; nextCursor: string | null }
  | CatalogFailure;

export interface SearchResinProductsInput {
  actorUserId: string;
  actorRole: 'user' | 'admin';
  prefix: string;
  limit?: number;
}

export type SearchResinProductsResult =
  | { ok: true; products: ResinProduct[] }
  | CatalogFailure;

export type GetResinProductResult =
  | { ok: true; product: ResinProduct }
  | CatalogFailure;

/** Validate resin colors: nullable; if provided, 1-N entries each hex. */
function validateResinColors(
  colors: unknown,
): { ok: true; colors: string[] | null } | CatalogFailure {
  if (colors === null || colors === undefined) {
    return { ok: true, colors: null };
  }
  if (!Array.isArray(colors)) {
    return { ok: false, reason: 'colors-not-array' };
  }
  if (colors.length === 0) {
    // Empty array → treat as null (consistent with "no colors").
    return { ok: true, colors: null };
  }
  if (colors.length > 4) {
    return { ok: false, reason: 'colors-too-many' };
  }
  const out: string[] = [];
  for (const c of colors) {
    if (typeof c !== 'string' || !HEX_COLOR_RE.test(c)) {
      return { ok: false, reason: 'color-format' };
    }
    out.push(c.toUpperCase());
  }
  return { ok: true, colors: out };
}

function normalizeResinForCompare(row: ResinProduct): string {
  return JSON.stringify({
    brand: row.brand,
    productLine: row.productLine ?? null,
    subtype: row.subtype,
    colors: row.colors ? row.colors.map((c) => c.toUpperCase()) : null,
    colorName: row.colorName ?? null,
    defaultExposure: row.defaultExposure ?? null,
    densityGMl: row.densityGMl ?? null,
    viscosityCps: row.viscosityCps ?? null,
    bottleVolumeMl: row.bottleVolumeMl ?? null,
    compatibility: row.compatibility ?? null,
    materialClass: row.materialClass ?? null,
    retailUrl: row.retailUrl ?? null,
    ownerId: row.ownerId ?? null,
    source: row.source,
    sourceRef: row.sourceRef ?? null,
  });
}

function normalizeResinForCreate(
  input: CreateResinProductInput,
  colors: string[] | null,
): string {
  return JSON.stringify({
    brand: input.brand,
    productLine: input.productLine ?? null,
    subtype: input.subtype,
    colors: colors ? colors.map((c) => c.toUpperCase()) : null,
    colorName: input.colorName ?? null,
    defaultExposure: input.defaultExposure ?? null,
    densityGMl: input.densityGMl ?? null,
    viscosityCps: input.viscosityCps ?? null,
    bottleVolumeMl: input.bottleVolumeMl ?? null,
    compatibility: input.compatibility ?? null,
    materialClass: input.materialClass ?? null,
    retailUrl: input.retailUrl ?? null,
    ownerId: input.ownerId ?? null,
    source: input.source,
    sourceRef: input.sourceRef ?? null,
  });
}

export async function createResinProduct(
  input: CreateResinProductInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<CreateResinProductResult> {
  if (typeof input.brand !== 'string' || input.brand.length === 0) {
    return { ok: false, reason: 'brand-required' };
  }
  if (!isProductSource(input.source)) {
    return { ok: false, reason: 'invalid-source' };
  }
  if (!isResinSubtype(input.subtype)) {
    return { ok: false, reason: 'invalid-subtype' };
  }
  if (
    input.materialClass !== undefined &&
    !isResinMaterialClass(input.materialClass)
  ) {
    return { ok: false, reason: 'invalid-material-class' };
  }
  const ownership = validateSourceOwnership({
    source: input.source,
    ownerId: input.ownerId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
  });
  if (!ownership.ok) return ownership;

  const c = validateResinColors(input.colors);
  if (!c.ok) return c;

  const now = opts?.now ?? new Date();
  const id = input.id ?? crypto.randomUUID();

  if (input.id) {
    const existing = await getServerDb(opts?.dbUrl)
      .select()
      .from(schema.resinProducts)
      .where(eq(schema.resinProducts.id, id))
      .limit(1);
    const prior = existing[0];
    if (prior) {
      const priorKey = normalizeResinForCompare(prior);
      const candidateKey = normalizeResinForCreate(input, c.colors);
      if (priorKey === candidateKey) {
        return { ok: true, productId: prior.id, product: prior, replayed: true };
      }
      return { ok: false, reason: 'id-conflict' };
    }
  }

  const row: typeof schema.resinProducts.$inferInsert = {
    id,
    brand: input.brand,
    productLine: input.productLine ?? null,
    subtype: input.subtype,
    colors: c.colors,
    colorName: input.colorName ?? null,
    defaultExposure: input.defaultExposure ?? null,
    densityGMl: input.densityGMl ?? null,
    viscosityCps: input.viscosityCps ?? null,
    bottleVolumeMl: input.bottleVolumeMl ?? null,
    compatibility: input.compatibility ?? null,
    materialClass: input.materialClass ?? null,
    retailUrl: input.retailUrl ?? null,
    ownerId: input.ownerId,
    source: input.source,
    sourceRef: input.sourceRef ?? null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const db = getServerDb(opts?.dbUrl);
    await db.insert(schema.resinProducts).values(row);
    const fetched = await db
      .select()
      .from(schema.resinProducts)
      .where(eq(schema.resinProducts.id, id))
      .limit(1);
    const persisted = fetched[0]!;
    return { ok: true, productId: id, product: persisted, replayed: false };
  } catch (err) {
    logger.warn({ err, id, source: input.source }, 'createResinProduct: persist failed');
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getResinProduct(
  args: { id: string; actorUserId: string; actorRole: 'user' | 'admin' },
  opts?: { dbUrl?: string },
): Promise<GetResinProductResult> {
  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select()
    .from(schema.resinProducts)
    .where(eq(schema.resinProducts.id, args.id))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.ownerId !== null && row.ownerId !== args.actorUserId) {
    return { ok: false, reason: 'not-found' };
  }
  return { ok: true, product: row };
}

export async function updateResinProduct(
  input: UpdateResinProductInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<UpdateResinProductResult> {
  if (typeof input.id !== 'string' || input.id.length === 0) {
    return { ok: false, reason: 'id-required' };
  }
  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select()
    .from(schema.resinProducts)
    .where(eq(schema.resinProducts.id, input.id))
    .limit(1);
  const existing = rows[0];
  if (!existing) return { ok: false, reason: 'not-found' };

  const guard = validateMutateExisting({
    rowOwnerId: existing.ownerId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
  });
  if (!guard.ok) return guard;

  const p = input.patch;
  if (Object.keys(p).length === 0) {
    return { ok: false, reason: 'empty-patch' };
  }
  if (p.subtype !== undefined && !isResinSubtype(p.subtype)) {
    return { ok: false, reason: 'invalid-subtype' };
  }
  if (
    p.materialClass !== undefined &&
    p.materialClass !== null &&
    !isResinMaterialClass(p.materialClass)
  ) {
    return { ok: false, reason: 'invalid-material-class' };
  }
  let normalizedColors: string[] | null | undefined;
  if (p.colors !== undefined) {
    const c = validateResinColors(p.colors);
    if (!c.ok) return c;
    normalizedColors = c.colors;
  }

  const now = opts?.now ?? new Date();
  const patchRow: Partial<typeof schema.resinProducts.$inferInsert> = {
    updatedAt: now,
  };
  if (p.brand !== undefined) {
    if (typeof p.brand !== 'string' || p.brand.length === 0) {
      return { ok: false, reason: 'brand-required' };
    }
    patchRow.brand = p.brand;
  }
  if (p.productLine !== undefined) patchRow.productLine = p.productLine;
  if (p.subtype !== undefined) patchRow.subtype = p.subtype;
  if (normalizedColors !== undefined) patchRow.colors = normalizedColors;
  if (p.colorName !== undefined) patchRow.colorName = p.colorName;
  if (p.defaultExposure !== undefined) patchRow.defaultExposure = p.defaultExposure;
  if (p.densityGMl !== undefined) patchRow.densityGMl = p.densityGMl;
  if (p.viscosityCps !== undefined) patchRow.viscosityCps = p.viscosityCps;
  if (p.bottleVolumeMl !== undefined) patchRow.bottleVolumeMl = p.bottleVolumeMl;
  if (p.compatibility !== undefined) patchRow.compatibility = p.compatibility;
  if (p.materialClass !== undefined) patchRow.materialClass = p.materialClass;
  if (p.retailUrl !== undefined) patchRow.retailUrl = p.retailUrl;
  if (p.sourceRef !== undefined) patchRow.sourceRef = p.sourceRef;

  try {
    await db
      .update(schema.resinProducts)
      .set(patchRow)
      .where(eq(schema.resinProducts.id, input.id));
    const refreshed = await db
      .select()
      .from(schema.resinProducts)
      .where(eq(schema.resinProducts.id, input.id))
      .limit(1);
    return { ok: true, product: refreshed[0]! };
  } catch (err) {
    logger.warn({ err, id: input.id }, 'updateResinProduct: persist failed');
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deleteResinProduct(
  input: DeleteResinProductInput,
  opts?: { dbUrl?: string },
): Promise<DeleteResinProductResult> {
  if (typeof input.id !== 'string' || input.id.length === 0) {
    return { ok: false, reason: 'id-required' };
  }
  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select()
    .from(schema.resinProducts)
    .where(eq(schema.resinProducts.id, input.id))
    .limit(1);
  const existing = rows[0];
  if (!existing) return { ok: false, reason: 'not-found' };
  const guard = validateMutateExisting({
    rowOwnerId: existing.ownerId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
  });
  if (!guard.ok) return guard;

  try {
    await db
      .delete(schema.resinProducts)
      .where(eq(schema.resinProducts.id, input.id));
    return { ok: true };
  } catch (err) {
    logger.warn({ err, id: input.id }, 'deleteResinProduct: persist failed');
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function listResinProducts(
  input: ListResinProductsInput,
  opts?: { dbUrl?: string },
): Promise<ListResinProductsResult> {
  const limit = Math.min(
    Math.max(1, input.limit ?? DEFAULT_LIST_LIMIT),
    MAX_LIST_LIMIT,
  );
  if (input.subtype !== undefined && !isResinSubtype(input.subtype)) {
    return { ok: false, reason: 'invalid-subtype' };
  }
  if (input.source !== undefined && !isProductSource(input.source)) {
    return { ok: false, reason: 'invalid-source' };
  }
  if (
    input.materialClass !== undefined &&
    !isResinMaterialClass(input.materialClass)
  ) {
    return { ok: false, reason: 'invalid-material-class' };
  }

  const db = getServerDb(opts?.dbUrl);
  const ownerPredicate = or(
    isNull(schema.resinProducts.ownerId),
    eq(schema.resinProducts.ownerId, input.actorUserId),
  )!;

  const extra: Array<ReturnType<typeof eq>> = [];
  if (input.brand) extra.push(eq(schema.resinProducts.brand, input.brand));
  if (input.subtype) extra.push(eq(schema.resinProducts.subtype, input.subtype));
  if (input.source) extra.push(eq(schema.resinProducts.source, input.source));
  if (input.materialClass) {
    extra.push(eq(schema.resinProducts.materialClass, input.materialClass));
  }

  let finalWhere =
    extra.length === 0 ? ownerPredicate : and(ownerPredicate, ...extra)!;
  if (input.cursor) {
    const { gt } = await import('drizzle-orm');
    finalWhere = and(finalWhere, gt(schema.resinProducts.id, input.cursor))!;
  }

  const rows = await db
    .select()
    .from(schema.resinProducts)
    .where(finalWhere)
    .orderBy(asc(schema.resinProducts.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? sliced[sliced.length - 1]!.id : null;
  return { ok: true, products: sliced, nextCursor };
}

export async function searchResinProducts(
  input: SearchResinProductsInput,
  opts?: { dbUrl?: string },
): Promise<SearchResinProductsResult> {
  if (typeof input.prefix !== 'string' || input.prefix.length === 0) {
    return { ok: false, reason: 'prefix-required' };
  }
  const limit = Math.min(
    Math.max(1, input.limit ?? DEFAULT_SEARCH_LIMIT),
    MAX_SEARCH_LIMIT,
  );
  const db = getServerDb(opts?.dbUrl);
  const ownerPredicate = or(
    isNull(schema.resinProducts.ownerId),
    eq(schema.resinProducts.ownerId, input.actorUserId),
  )!;

  const { sql } = await import('drizzle-orm');
  const lowerPrefix = input.prefix.toLowerCase();
  const matchExpr = or(
    like(sql`lower(${schema.resinProducts.brand})`, `${lowerPrefix}%`),
    like(sql`lower(${schema.resinProducts.productLine})`, `${lowerPrefix}%`),
    like(sql`lower(${schema.resinProducts.colorName})`, `${lowerPrefix}%`),
  )!;

  const rows = await db
    .select()
    .from(schema.resinProducts)
    .where(and(ownerPredicate, matchExpr))
    .orderBy(asc(schema.resinProducts.brand), asc(schema.resinProducts.subtype))
    .limit(limit);

  return { ok: true, products: rows };
}

// Re-exports for convenience consumers.
export { FILAMENT_SUBTYPES, RESIN_SUBTYPES, RESIN_MATERIAL_CLASSES, PRODUCT_SOURCES };

// Suppress unused-warning on `lt` (kept in import for future cursor variant).
void lt;
