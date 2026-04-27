/**
 * Material validation helpers — V2-007a-T4.
 *
 * Reusable, pure validation primitives for the Material lifecycle (T4),
 * mix flow (T5), recycle flow (T6), and retire flow (T7). Each helper
 * returns a discriminated union `{ ok: true, ... } | { ok: false, reason }`
 * so callers compose without try/catch.
 *
 * Color rules (locked in V2-007a):
 *   - colors is an array of 1–4 hex strings.
 *   - Each entry MUST match /^#[0-9A-Fa-f]{6}$/. 3-digit shorthand and
 *     8-digit alpha forms are explicitly NOT accepted (would introduce
 *     ambiguity in colorPattern length matching).
 *   - colorPattern length expectations:
 *       solid         → exactly 1 color
 *       dual-tone     → exactly 2 colors
 *       gradient      → 2 or 3 colors
 *       multi-section → 2, 3, or 4 colors
 *
 * Unit/kind compatibility (locked in V2-007a):
 *   filament_spool  → 'g' only
 *   resin_bottle    → 'ml' or 'g'
 *   mix_batch       → 'ml' only (typically resin mixes)
 *   recycled_spool  → 'g' only
 *   other           → 'ml' or 'g'
 */

import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import type { ColorPattern, MaterialKind, MaterialUnit } from '../db/schema.materials';
import {
  COLOR_PATTERNS,
  MATERIAL_KINDS,
  MATERIAL_UNITS,
} from '../db/schema.materials';

/** Strict 6-digit hex color: `#RRGGBB`. Case-insensitive on input; normalized to uppercase. */
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * Validate a colors array + colorPattern combination.
 *
 * Returns the colors array normalized to uppercase hex strings on success.
 *
 * Reason codes:
 *   colors-not-array        — input was not an array
 *   colors-empty            — array length 0
 *   colors-too-many         — array length > 4
 *   color-format            — at least one entry didn't match `/^#[0-9A-Fa-f]{6}$/`
 *   color-pattern-invalid   — colorPattern not in COLOR_PATTERNS
 *   color-pattern-mismatch  — colorPattern's length expectation doesn't match colors.length
 */
export function validateColors(
  colors: unknown,
  colorPattern: unknown,
): { ok: true; colors: string[]; colorPattern: ColorPattern } | { ok: false; reason: string } {
  if (!Array.isArray(colors)) {
    return { ok: false, reason: 'colors-not-array' };
  }
  if (colors.length === 0) {
    return { ok: false, reason: 'colors-empty' };
  }
  if (colors.length > 4) {
    return { ok: false, reason: 'colors-too-many' };
  }

  const normalized: string[] = [];
  for (const c of colors) {
    if (typeof c !== 'string' || !HEX_COLOR_RE.test(c)) {
      return { ok: false, reason: 'color-format' };
    }
    normalized.push(c.toUpperCase());
  }

  if (typeof colorPattern !== 'string' || !(COLOR_PATTERNS as readonly string[]).includes(colorPattern)) {
    return { ok: false, reason: 'color-pattern-invalid' };
  }
  const pattern = colorPattern as ColorPattern;

  const len = normalized.length;
  let matches: boolean;
  switch (pattern) {
    case 'solid':
      matches = len === 1;
      break;
    case 'dual-tone':
      matches = len === 2;
      break;
    case 'gradient':
      matches = len === 2 || len === 3;
      break;
    case 'multi-section':
      matches = len >= 2 && len <= 4;
      break;
  }
  if (!matches) {
    return { ok: false, reason: 'color-pattern-mismatch' };
  }

  return { ok: true, colors: normalized, colorPattern: pattern };
}

/**
 * Validate a (unit, kind) pair against the locked compatibility matrix.
 *
 * Reason codes:
 *   kind-invalid       — kind not in MATERIAL_KINDS
 *   unit-invalid       — unit not in MATERIAL_UNITS
 *   unit-kind-mismatch — pair fails the compatibility matrix
 */
export function validateUnitKind(
  unit: unknown,
  kind: unknown,
): { ok: true; unit: MaterialUnit; kind: MaterialKind } | { ok: false; reason: string } {
  if (typeof kind !== 'string' || !(MATERIAL_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: 'kind-invalid' };
  }
  if (typeof unit !== 'string' || !(MATERIAL_UNITS as readonly string[]).includes(unit)) {
    return { ok: false, reason: 'unit-invalid' };
  }

  const k = kind as MaterialKind;
  const u = unit as MaterialUnit;

  let compatible: boolean;
  switch (k) {
    case 'filament_spool':
      compatible = u === 'g';
      break;
    case 'resin_bottle':
      compatible = u === 'ml' || u === 'g';
      break;
    case 'mix_batch':
      compatible = u === 'ml';
      break;
    case 'recycled_spool':
      compatible = u === 'g';
      break;
    case 'other':
      compatible = u === 'ml' || u === 'g';
      break;
  }

  if (!compatible) {
    return { ok: false, reason: 'unit-kind-mismatch' };
  }
  return { ok: true, unit: u, kind: k };
}

// ---------------------------------------------------------------------------
// resolveCatalogProduct — V2-007b T_B3
// ---------------------------------------------------------------------------

/**
 * The fields denormalized from a catalog product onto a Material row when
 * `productId` is provided. These are filter-critical fields that benefit from
 * being on the Material row directly (no JOIN needed for browse/search). NOT
 * copied: spoolWeightG, defaultTemps, slicerId, etc. — those live on the
 * catalog product and are queryable via JOIN when surfaced.
 */
export interface ResolvedCatalogProduct {
  brand: string;
  subtype: string;
  colors: string[];
  colorPattern: ColorPattern;
  colorName: string | null;
  density: number | null;
}

export interface ResolveCatalogProductInput {
  productId: string;
  kind: MaterialKind;
  /** The actor whose ownership is being checked (the new Material's owner). */
  ownerId: string;
  dbUrl?: string;
}

export type ResolveCatalogProductResult =
  | { ok: true; product: ResolvedCatalogProduct }
  | { ok: false; reason: string; details?: string };

/**
 * Validate + load a catalog product to denormalize onto a new Material row.
 *
 * Visibility model (mirrors catalog.getFilamentProduct / getResinProduct):
 *  - System rows (`owner_id IS NULL`) are visible to all.
 *  - User-custom rows (`owner_id` set) are visible only to that owner.
 *  - Cross-owner custom entries → reject as `product-not-found` (no leak).
 *
 * Kind/table consistency:
 *  - kind='filament_spool' → must reference filament_products.
 *  - kind='resin_bottle'   → must reference resin_products.
 *  - kind='mix_batch' / 'recycled_spool' / 'other' → MUST be NULL (these are
 *    derived/synthetic and have no upstream catalog product).
 *
 * Reason codes:
 *   product-not-allowed-for-kind  — kind disallows productId
 *   product-not-found             — id missing, or cross-owner custom (no leak)
 *   product-kind-mismatch         — productId points to wrong table for kind
 *   product-corrupt               — required field (brand/subtype/colors) missing
 */
export async function resolveCatalogProduct(
  input: ResolveCatalogProductInput,
): Promise<ResolveCatalogProductResult> {
  // Kinds that don't permit a productId.
  if (
    input.kind === 'mix_batch' ||
    input.kind === 'recycled_spool' ||
    input.kind === 'other'
  ) {
    return {
      ok: false,
      reason: 'product-not-allowed-for-kind',
      details: `kind='${input.kind}' must have productId=null`,
    };
  }

  const db = getServerDb(input.dbUrl);

  if (input.kind === 'filament_spool') {
    // Look up in filament_products first; fall back to resin to detect mismatches.
    const filamentRows = await db
      .select()
      .from(schema.filamentProducts)
      .where(eq(schema.filamentProducts.id, input.productId))
      .limit(1);

    if (filamentRows.length === 0) {
      // Maybe the user pointed at a resin product by mistake?
      const resinRows = await db
        .select({ id: schema.resinProducts.id })
        .from(schema.resinProducts)
        .where(eq(schema.resinProducts.id, input.productId))
        .limit(1);
      if (resinRows.length > 0) {
        return {
          ok: false,
          reason: 'product-kind-mismatch',
          details: 'productId points to resin_products but kind=filament_spool',
        };
      }
      return { ok: false, reason: 'product-not-found' };
    }

    const row = filamentRows[0]!;
    // Visibility: system row (owner null) OR caller's own custom row.
    if (row.ownerId !== null && row.ownerId !== input.ownerId) {
      return { ok: false, reason: 'product-not-found' };
    }

    // Required-field corruption (catalog enforces brand/subtype/colors NOT NULL —
    // belt-and-braces in case a hand-crafted seed slipped in).
    if (!row.brand || !row.subtype || !Array.isArray(row.colors) || row.colors.length === 0) {
      return {
        ok: false,
        reason: 'product-corrupt',
        details: 'catalog product missing required brand/subtype/colors',
      };
    }

    return {
      ok: true,
      product: {
        brand: row.brand,
        subtype: row.subtype,
        colors: row.colors,
        colorPattern: row.colorPattern as ColorPattern,
        colorName: row.colorName ?? null,
        density: row.density ?? null,
      },
    };
  }

  // input.kind === 'resin_bottle'
  const resinRows = await db
    .select()
    .from(schema.resinProducts)
    .where(eq(schema.resinProducts.id, input.productId))
    .limit(1);

  if (resinRows.length === 0) {
    const filamentRows = await db
      .select({ id: schema.filamentProducts.id })
      .from(schema.filamentProducts)
      .where(eq(schema.filamentProducts.id, input.productId))
      .limit(1);
    if (filamentRows.length > 0) {
      return {
        ok: false,
        reason: 'product-kind-mismatch',
        details: 'productId points to filament_products but kind=resin_bottle',
      };
    }
    return { ok: false, reason: 'product-not-found' };
  }

  const row = resinRows[0]!;
  if (row.ownerId !== null && row.ownerId !== input.ownerId) {
    return { ok: false, reason: 'product-not-found' };
  }

  if (!row.brand || !row.subtype) {
    return {
      ok: false,
      reason: 'product-corrupt',
      details: 'catalog product missing required brand/subtype',
    };
  }

  // Resin colors are nullable on the catalog. When NULL, default the Material
  // to a single solid black; the caller almost always supplies their own
  // colors override anyway. To avoid synthesising data, we treat this as
  // "no denormalized colors" and return a length-0 array — but the Material
  // schema demands 1-4 colors, so we surface this as corruption. (Real catalog
  // entries — even resin — always carry at least one hex; this is just safety.)
  const colorsArr = Array.isArray(row.colors) ? row.colors : null;
  if (!colorsArr || colorsArr.length === 0) {
    return {
      ok: false,
      reason: 'product-corrupt',
      details: 'resin catalog product has no colors; cannot denormalize',
    };
  }

  // Resin catalog has no colorPattern column — derive from length.
  const derivedPattern: ColorPattern =
    colorsArr.length === 1
      ? 'solid'
      : colorsArr.length === 2
        ? 'dual-tone'
        : 'multi-section';

  return {
    ok: true,
    product: {
      brand: row.brand,
      subtype: row.subtype,
      colors: colorsArr,
      colorPattern: derivedPattern,
      colorName: row.colorName ?? null,
      density: row.densityGMl ?? null,
    },
  };
}
