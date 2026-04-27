/**
 * Resin seed JSON → lootgoblin resin_products transform — V2-007b T_B5b.
 *
 * Pure (no I/O, no DB) transform from a hand-curated brand JSON file into a
 * list of `CreateResinProductInput` payloads. Resin lacks a single open
 * MIT-licensed catalog like SpoolmanDB, so the seed is hand-keyed: each
 * `seed/resins/<brand>.json` file holds an array of products keyed from the
 * vendor's public product pages (factual data only — non-copyrightable).
 *
 * Mapping is mostly identity: the JSON shape mirrors the resin_products
 * column set (see schema.materials.ts). Validation:
 *
 *   - `subtype` must resolve to a RESIN_SUBTYPES member (after light alias
 *     normalisation: "Tough" → "tough", "Water Washable" → "water-washable",
 *     "ABS Like" → "abs-like", etc).
 *   - `materialClass`, when provided, must be a RESIN_MATERIAL_CLASSES
 *     member; otherwise drop with a logged warning (the entry is still
 *     kept — class is optional).
 *   - `colors` (when provided): each entry hex-validated + normalized to
 *     uppercase `#RRGGBB`. Invalid hexes are dropped from the variant; if
 *     all are invalid, `colors` becomes null.
 *   - `id`, when omitted, is auto-generated from the brand + product line +
 *     color name (or subtype as fallback).
 *
 * Slug rule (deterministic, idempotent):
 *
 *     id = `system:community-pr:${slug(brand)}:${slug(productLine ?? '')}:${slug(colorName ?? subtype)}`
 *
 * `source` is hard-coded to `'community-pr'` per the locked architectural
 * decision: hand-curated entries get `community-pr` provenance, since the
 * `system:*` slugs are reserved for direct redistributions of MIT-licensed
 * datasets (see V2-007b T_B5b spec + research Q5).
 */

import { logger } from '../logger';
import type { CreateResinProductInput } from '../materials/catalog';
import {
  isResinSubtype,
  isResinMaterialClass,
  type ResinSubtype,
  type ResinMaterialClass,
} from '../materials/catalog-types';
import { slugify } from './_slug';

// ---------------------------------------------------------------------------
// Seed JSON shape
// ---------------------------------------------------------------------------

export interface ResinSeedFile {
  /** Brand display name. e.g. "Prusa Polymers", "Anycubic". */
  brand: string;
  /** Optional licensing / sourcing note shown to maintainers (not persisted). */
  license_note?: string;
  /** Products; each becomes one resin_products row. */
  products: ResinSeedProduct[];
}

export interface ResinSeedProduct {
  /** Explicit slug; auto-generated if omitted. */
  id?: string;
  productLine?: string;
  /** Validated against RESIN_SUBTYPES at transform time. */
  subtype: string;
  /** Typically a single hex; null/omitted is allowed (industrial resins). */
  colors?: string[] | null;
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
  /** Validated against RESIN_MATERIAL_CLASSES; logged + dropped if invalid. */
  materialClass?: string;
  retailUrl?: string;
  /** Public vendor page URL the entry was hand-keyed from (provenance). */
  sourceRef?: string;
}

// ---------------------------------------------------------------------------
// Subtype / material-class normalisation
// ---------------------------------------------------------------------------

/**
 * Common typo / wording aliases for resin subtypes. Keys are lowercased for
 * case-insensitive lookup. Anything not in this table or the enum itself is
 * rejected by the transform with reason='invalid-subtype'.
 */
const SUBTYPE_ALIASES: Record<string, ResinSubtype> = {
  // Direct title-case forms
  standard: 'standard',
  tough: 'tough',
  flexible: 'flexible',
  ceramic: 'ceramic',
  engineering: 'engineering',
  translucent: 'translucent',
  casting: 'casting',
  medical: 'medical',
  model: 'model',
  // Multi-word forms commonly typed by humans
  'water washable': 'water-washable',
  'water-washable': 'water-washable',
  'high temp': 'high-temp',
  'high-temp': 'high-temp',
  'plant based': 'plant-based',
  'plant-based': 'plant-based',
  'abs like': 'abs-like',
  'abs-like': 'abs-like',
  // Dental classes — vendor pages sometimes spell these differently
  'dental class i': 'dental-Class-I',
  'dental-class-i': 'dental-Class-I',
  'dental class ii': 'dental-Class-II',
  'dental-class-ii': 'dental-Class-II',
};

export function normalizeResinSubtype(
  raw: unknown,
):
  | { ok: true; subtype: ResinSubtype }
  | { ok: false; reason: 'invalid-subtype'; raw: unknown } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'invalid-subtype', raw };
  }
  // Direct enum hit (case-sensitive — covers "dental-Class-I" etc).
  if (isResinSubtype(raw)) {
    return { ok: true, subtype: raw };
  }
  const key = raw.trim().toLowerCase();
  if (key in SUBTYPE_ALIASES) {
    return { ok: true, subtype: SUBTYPE_ALIASES[key]! };
  }
  return { ok: false, reason: 'invalid-subtype', raw };
}

export function normalizeResinMaterialClass(
  raw: unknown,
): ResinMaterialClass | null {
  if (raw === undefined || raw === null) return null;
  if (isResinMaterialClass(raw)) return raw;
  return null; // sentinel; caller logs + drops
}

// ---------------------------------------------------------------------------
// Hex normalisation
// ---------------------------------------------------------------------------

const HEX6_RE = /^#?[0-9A-Fa-f]{6}$/;

export function normalizeHex(hex: unknown): string | null {
  if (typeof hex !== 'string') return null;
  const trimmed = hex.trim();
  if (!HEX6_RE.test(trimmed)) return null;
  const stripped = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  return `#${stripped.toUpperCase()}`;
}

function normalizeColorList(
  colors: ResinSeedProduct['colors'],
): string[] | null {
  if (colors === null || colors === undefined) return null;
  if (!Array.isArray(colors) || colors.length === 0) return null;
  const out: string[] = [];
  for (const c of colors) {
    const n = normalizeHex(c);
    if (n) out.push(n);
  }
  return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Id slug
// ---------------------------------------------------------------------------

/**
 * Build a stable id for a resin product. Same inputs always produce the same
 * id (idempotent re-imports). Falls back to subtype when colorName is
 * missing — matches T_B5a's "drop empty segments to 'unknown'" via slugify.
 */
export function buildResinProductId(
  brand: string,
  productLine: string,
  colorOrSubtype: string,
): string {
  return [
    'system:community-pr',
    slugify(brand),
    slugify(productLine),
    slugify(colorOrSubtype),
  ].join(':');
}

// ---------------------------------------------------------------------------
// Outcome shape per product
// ---------------------------------------------------------------------------

export type ResinTransformResult =
  | { ok: true; input: CreateResinProductInput }
  | {
      ok: false;
      reason: 'invalid-subtype' | 'invalid-shape' | 'brand-required';
      raw: ResinSeedProduct;
    };

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

/**
 * Transform one brand seed file into N CreateResinProductInput payloads.
 *
 * Returns the per-product results in order. Caller is responsible for
 * filtering ok/!ok and aggregating stats. Failed products are logged here
 * (warn level) so dry-runs surface the issue without dropping silently.
 *
 * `actorUserId` is the caller's responsibility (script passes the admin
 * importer id).
 */
export function transformResinSeed(
  brandFile: ResinSeedFile,
  actorUserId: string = 'system-importer',
): ResinTransformResult[] {
  if (
    typeof brandFile?.brand !== 'string' ||
    brandFile.brand.length === 0
  ) {
    logger.warn(
      { brandFile: { hasBrand: !!brandFile?.brand } },
      'resin-seed-transform: missing brand on seed file; skipping all products',
    );
    return (brandFile?.products ?? []).map((raw) => ({
      ok: false as const,
      reason: 'brand-required' as const,
      raw,
    }));
  }
  if (!Array.isArray(brandFile.products)) {
    logger.warn(
      { brand: brandFile.brand },
      'resin-seed-transform: products is not an array; skipping file',
    );
    return [];
  }

  const out: ResinTransformResult[] = [];
  for (const product of brandFile.products) {
    out.push(transformOne(brandFile.brand, product, actorUserId));
  }
  return out;
}

function transformOne(
  brand: string,
  raw: ResinSeedProduct,
  actorUserId: string,
): ResinTransformResult {
  if (typeof raw !== 'object' || raw === null) {
    logger.warn({ brand }, 'resin-seed-transform: product is not an object');
    return { ok: false, reason: 'invalid-shape', raw };
  }

  const subtypeResult = normalizeResinSubtype(raw.subtype);
  if (!subtypeResult.ok) {
    logger.warn(
      { brand, subtype: raw.subtype },
      "resin-seed-transform: subtype not in RESIN_SUBTYPES; skipping product",
    );
    return { ok: false, reason: 'invalid-subtype', raw };
  }

  const materialClass = normalizeResinMaterialClass(raw.materialClass);
  if (raw.materialClass !== undefined && materialClass === null) {
    logger.warn(
      { brand, materialClass: raw.materialClass, productLine: raw.productLine },
      'resin-seed-transform: materialClass not in RESIN_MATERIAL_CLASSES; dropping field',
    );
  }

  const colors = normalizeColorList(raw.colors);

  const productLine = raw.productLine ?? '';
  const idSeed =
    raw.colorName && raw.colorName.length > 0 ? raw.colorName : subtypeResult.subtype;
  const id = raw.id && raw.id.length > 0 ? raw.id : buildResinProductId(brand, productLine, idSeed);

  const input: CreateResinProductInput = {
    id,
    brand,
    subtype: subtypeResult.subtype,
    source: 'community-pr',
    ownerId: null,
    actorUserId,
    actorRole: 'admin',
    colors,
  };
  if (raw.productLine) input.productLine = raw.productLine;
  if (raw.colorName) input.colorName = raw.colorName;
  if (raw.defaultExposure) input.defaultExposure = raw.defaultExposure;
  if (typeof raw.densityGMl === 'number') input.densityGMl = raw.densityGMl;
  if (typeof raw.viscosityCps === 'number') input.viscosityCps = raw.viscosityCps;
  if (typeof raw.bottleVolumeMl === 'number') input.bottleVolumeMl = raw.bottleVolumeMl;
  if (raw.compatibility) input.compatibility = raw.compatibility;
  if (materialClass !== null) input.materialClass = materialClass;
  if (raw.retailUrl) input.retailUrl = raw.retailUrl;
  if (raw.sourceRef) input.sourceRef = raw.sourceRef;

  return { ok: true, input };
}
