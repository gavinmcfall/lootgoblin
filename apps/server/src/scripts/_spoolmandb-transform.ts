/**
 * SpoolmanDB → lootgoblin filament_products transform — V2-007b T_B5a.
 *
 * Pure (no I/O, no DB) transform from SpoolmanDB's per-brand JSON shape into
 * a list of `CreateFilamentProductInput` payloads (one per color variant of
 * each filament). Mapping table is locked in the task spec; in particular:
 *
 *   - SpoolmanDB top-level `manufacturer`         → `brand`
 *   - per-product `material`                      → `subtype` (best-effort
 *                                                    enum mapping; unknown
 *                                                    falls back to `'other'`
 *                                                    with a logged warning)
 *   - per-product `density`                       → `density`
 *   - per-product `extruder_temp` + `bed_temp`    → `defaultTemps`
 *                                                    (single-value range)
 *   - per-product `finish` / `pattern` / `glow`
 *                  / `translucent`                 → same fields
 *   - per-product `multi_color_direction` (or per-color override) +
 *     `colors[].hex` / `colors[].hexes[]`         → `colorPattern` + `colors`
 *   - per-product `colors[].name`                 → `colorName`
 *   - `weights[0].weight` / `.spool_weight`       → spoolWeightG /
 *                                                    emptySpoolWeightG
 *   - `diameters[0]`                              → diameterMm
 *
 * Hex normalization: SpoolmanDB sometimes stores hex without `#`; we always
 * prepend `#` and uppercase. Hex strings that don't match `^#?[0-9A-Fa-f]{6}$`
 * are dropped from that color variant; if a variant ends up with no valid
 * colors the variant itself is dropped (logged).
 *
 * Slug rule (deterministic, idempotent):
 *
 *     id = `system:spoolmandb:${slug(brand)}:${slug(productLine)}:${slug(colorName)}`
 *
 * If a filament has no `name` field we fall back to slug-of-material.
 * If a color has no `name` we fall back to slug-of-hex-list.
 */

import { logger } from '../logger';
import type { CreateFilamentProductInput } from '../materials/catalog';
import { isFilamentSubtype, type FilamentSubtype } from '../materials/catalog-types';
import type { ColorPattern } from '../db/schema.materials';
import { slugify } from './_slug';

// ---------------------------------------------------------------------------
// SpoolmanDB JSON shape (subset we consume)
// ---------------------------------------------------------------------------

export interface SpoolmanDbBrandFile {
  manufacturer: string;
  filaments: SpoolmanDbFilament[];
}

export interface SpoolmanDbFilament {
  name?: string;
  material: string;
  density: number;
  weights?: Array<{ weight: number; spool_weight?: number }>;
  diameters?: number[];
  extruder_temp?: number;
  bed_temp?: number;
  finish?: string;
  pattern?: string;
  glow?: boolean;
  translucent?: boolean;
  multi_color_direction?: 'coaxial' | 'longitudinal';
  colors?: Array<{
    name: string;
    hex?: string;
    hexes?: string[];
    multi_color_direction?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Material-name → FilamentSubtype mapping
// ---------------------------------------------------------------------------

/**
 * SpoolmanDB stores `material` as an open-ended string ("PLA", "PLA Plus",
 * "PETG-CF", "PA12-CF", etc). Our enum has fixed members. This map handles
 * common alias normalization. Anything else falls through to enum-membership
 * test, then `'other'` with a warning.
 */
const MATERIAL_ALIASES: Record<string, FilamentSubtype> = {
  // Plain PLA family
  'pla plus': 'PLA+',
  'pla+': 'PLA+',
  'pla pro': 'PLA+',
  'pla cf': 'PLA-CF',
  'pla-cf': 'PLA-CF',
  'pla silk': 'PLA-Silk',
  'pla-silk': 'PLA-Silk',
  silk: 'PLA-Silk',
  'silk pla': 'PLA-Silk',
  'pla matte': 'PLA-Matte',
  'pla-matte': 'PLA-Matte',
  matte: 'PLA-Matte',
  'matte pla': 'PLA-Matte',
  'pla marble': 'PLA-Marble',
  'pla-marble': 'PLA-Marble',
  'pla wood': 'PLA-Wood',
  'pla-wood': 'PLA-Wood',
  wood: 'PLA-Wood',
  // PETG
  'petg cf': 'PETG-CF',
  'petg-cf': 'PETG-CF',
  'petg rcf': 'PETG-rCF',
  'petg-rcf': 'PETG-rCF',
  // ABS / ASA
  'abs cf': 'ABS-CF',
  'abs-cf': 'ABS-CF',
  'abs gf': 'ABS-GF',
  'abs-gf': 'ABS-GF',
  'asa cf': 'ASA-CF',
  'asa-cf': 'ASA-CF',
  // TPU
  'tpu 95a': 'TPU-95A',
  'tpu-95a': 'TPU-95A',
  'tpu 90a': 'TPU-90A',
  'tpu-90a': 'TPU-90A',
  'tpu 85a': 'TPU-85A',
  'tpu-85a': 'TPU-85A',
  // PC
  'pc fr': 'PC-FR',
  'pc-fr': 'PC-FR',
  // Nylon family
  'pa cf': 'PA-CF',
  'pa-cf': 'PA-CF',
  'pa gf': 'PA-GF',
  'pa-gf': 'PA-GF',
  'paht cf': 'PAHT-CF',
  'paht-cf': 'PAHT-CF',
  'pa6 cf': 'PA6-CF',
  'pa6-cf': 'PA6-CF',
  'pa6 gf': 'PA6-GF',
  'pa6-gf': 'PA6-GF',
  'pa12 cf': 'PA12-CF',
  'pa12-cf': 'PA12-CF',
  // PET / PP
  'pet cf': 'PET-CF',
  'pet-cf': 'PET-CF',
  'pps cf': 'PPS-CF',
  'pps-cf': 'PPS-CF',
  'ppa cf': 'PPA-CF',
  'ppa-cf': 'PPA-CF',
  'ppa gf': 'PPA-GF',
  'ppa-gf': 'PPA-GF',
};

export function mapMaterialToSubtype(material: string): {
  subtype: FilamentSubtype;
  matched: boolean;
} {
  if (typeof material !== 'string' || material.length === 0) {
    return { subtype: 'other', matched: false };
  }
  // Direct enum hit (case-sensitive, e.g. "PLA", "PETG-CF").
  if (isFilamentSubtype(material)) {
    return { subtype: material, matched: true };
  }
  // Alias table (case-insensitive).
  const key = material.trim().toLowerCase();
  if (key in MATERIAL_ALIASES) {
    return { subtype: MATERIAL_ALIASES[key]!, matched: true };
  }
  // Try the upper-cased form against the enum (handles "pla" lowercase).
  const upper = material.trim().toUpperCase();
  if (isFilamentSubtype(upper)) {
    return { subtype: upper as FilamentSubtype, matched: true };
  }
  return { subtype: 'other', matched: false };
}

// ---------------------------------------------------------------------------
// Hex normalization
// ---------------------------------------------------------------------------

const HEX6_RE = /^#?[0-9A-Fa-f]{6}$/;

export function normalizeHex(hex: unknown): string | null {
  if (typeof hex !== 'string') return null;
  const trimmed = hex.trim();
  if (!HEX6_RE.test(trimmed)) return null;
  const stripped = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  return `#${stripped.toUpperCase()}`;
}

function normalizeHexList(hexes: unknown): string[] {
  if (!Array.isArray(hexes)) return [];
  const out: string[] = [];
  for (const h of hexes) {
    const n = normalizeHex(h);
    if (n) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Color → (colorPattern, colors[]) derivation
// ---------------------------------------------------------------------------

interface ColorVariant {
  colorName: string;
  colorPattern: ColorPattern;
  colors: string[];
}

function deriveColorVariant(
  rawColor: NonNullable<SpoolmanDbFilament['colors']>[number],
  brandLevelDirection: SpoolmanDbFilament['multi_color_direction'],
): ColorVariant | null {
  const direction =
    (rawColor.multi_color_direction as 'coaxial' | 'longitudinal' | undefined) ??
    brandLevelDirection;

  // Single-hex variant.
  if (typeof rawColor.hex === 'string' && rawColor.hex.length > 0) {
    const norm = normalizeHex(rawColor.hex);
    if (!norm) return null;
    return {
      colorName: rawColor.name ?? '',
      colorPattern: 'solid',
      colors: [norm],
    };
  }

  // Multi-hex variant.
  if (Array.isArray(rawColor.hexes) && rawColor.hexes.length > 0) {
    const normList = normalizeHexList(rawColor.hexes);
    if (normList.length === 0) return null;

    let pattern: ColorPattern;
    if (normList.length === 1) {
      pattern = 'solid';
    } else if (normList.length === 2 && direction === 'coaxial') {
      pattern = 'dual-tone';
    } else if (
      direction === 'longitudinal' &&
      normList.length >= 2 &&
      normList.length <= 3
    ) {
      pattern = 'gradient';
    } else if (direction === 'longitudinal' && normList.length === 4) {
      pattern = 'multi-section';
    } else if (normList.length === 2) {
      // No direction provided + 2 hexes: best-guess dual-tone.
      pattern = 'dual-tone';
    } else if (normList.length >= 3 && normList.length <= 4) {
      // Default for 3-4 hexes without direction: multi-section if 4, else
      // gradient.
      pattern = normList.length === 4 ? 'multi-section' : 'gradient';
    } else {
      // > 4 hexes: not supported by validateColors; truncate to 4 + warn.
      logger.warn(
        { name: rawColor.name, hexCount: normList.length },
        'spoolmandb-transform: too many hexes (>4); truncating to 4',
      );
      pattern = 'multi-section';
      normList.length = 4;
    }

    return {
      colorName: rawColor.name ?? '',
      colorPattern: pattern,
      colors: normList,
    };
  }

  // No hex / no hexes — drop.
  return null;
}

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export interface TransformContext {
  commitSha: string;
  /** Path within the SpoolmanDB repo, e.g. "filaments/Bambu.json". */
  sourcePath: string;
}

/**
 * Build a stable id for a filament + color variant. Same inputs always
 * produce the same id (idempotent re-imports).
 */
export function buildFilamentProductId(
  brand: string,
  productName: string,
  colorName: string,
): string {
  return `system:spoolmandb:${slugify(brand)}:${slugify(productName)}:${slugify(colorName)}`;
}

/**
 * Transform one SpoolmanDB filament into 0..N CreateFilamentProductInput
 * payloads — one per color variant. `actorUserId` is the caller's
 * responsibility (the script passes the admin user id).
 */
export function transformSpoolmanDbFilament(
  brandFile: SpoolmanDbBrandFile,
  filament: SpoolmanDbFilament,
  ctx: TransformContext,
  actorUserId: string,
): CreateFilamentProductInput[] {
  if (!brandFile?.manufacturer || typeof brandFile.manufacturer !== 'string') {
    logger.warn({ ctx }, 'spoolmandb-transform: missing manufacturer; skipping file');
    return [];
  }
  if (!filament?.material || typeof filament.material !== 'string') {
    logger.warn(
      { ctx, manufacturer: brandFile.manufacturer },
      'spoolmandb-transform: missing material on filament; skipping',
    );
    return [];
  }

  const { subtype, matched } = mapMaterialToSubtype(filament.material);
  if (!matched) {
    logger.warn(
      { ctx, material: filament.material, manufacturer: brandFile.manufacturer },
      "spoolmandb-transform: material not in enum, mapping to 'other'",
    );
  }

  const productLine = filament.name && filament.name.length > 0
    ? filament.name
    : filament.material; // fall-back; see slug rule

  // Common per-filament fields shared across color variants.
  const defaultTemps =
    filament.extruder_temp !== undefined || filament.bed_temp !== undefined
      ? {
          ...(filament.extruder_temp !== undefined
            ? { nozzle_min: filament.extruder_temp, nozzle_max: filament.extruder_temp }
            : {}),
          ...(filament.bed_temp !== undefined ? { bed: filament.bed_temp } : {}),
        }
      : undefined;

  const firstWeight = Array.isArray(filament.weights) ? filament.weights[0] : undefined;
  const spoolWeightG = firstWeight?.weight;
  const emptySpoolWeightG = firstWeight?.spool_weight;

  const firstDiameter = Array.isArray(filament.diameters) ? filament.diameters[0] : undefined;

  const sourceRef = `${ctx.commitSha}:${ctx.sourcePath}`;

  // 0 colors → emit nothing (we don't seed colorless products).
  if (!Array.isArray(filament.colors) || filament.colors.length === 0) {
    logger.warn(
      { ctx, manufacturer: brandFile.manufacturer, productLine },
      'spoolmandb-transform: filament has no colors; skipping',
    );
    return [];
  }

  const out: CreateFilamentProductInput[] = [];
  for (const rawColor of filament.colors) {
    const variant = deriveColorVariant(rawColor, filament.multi_color_direction);
    if (!variant) {
      logger.warn(
        { ctx, manufacturer: brandFile.manufacturer, productLine, colorName: rawColor?.name },
        'spoolmandb-transform: color has no usable hex; skipping variant',
      );
      continue;
    }

    const id = buildFilamentProductId(brandFile.manufacturer, productLine, variant.colorName);

    const input: CreateFilamentProductInput = {
      id,
      brand: brandFile.manufacturer,
      productLine,
      subtype,
      colors: variant.colors,
      colorPattern: variant.colorPattern,
      colorName: variant.colorName.length > 0 ? variant.colorName : undefined,
      source: 'system:spoolmandb',
      ownerId: null,
      actorUserId,
      actorRole: 'admin',
      sourceRef,
    };
    if (defaultTemps) input.defaultTemps = defaultTemps;
    if (typeof filament.density === 'number') input.density = filament.density;
    if (typeof spoolWeightG === 'number') input.spoolWeightG = spoolWeightG;
    if (typeof emptySpoolWeightG === 'number') {
      input.emptySpoolWeightG = emptySpoolWeightG;
    }
    if (typeof firstDiameter === 'number') input.diameterMm = firstDiameter;
    if (typeof filament.finish === 'string') input.finish = filament.finish;
    if (typeof filament.pattern === 'string') input.pattern = filament.pattern;
    if (typeof filament.glow === 'boolean') input.isGlow = filament.glow;
    if (typeof filament.translucent === 'boolean') {
      input.isTranslucent = filament.translucent;
    }

    out.push(input);
  }

  return out;
}
