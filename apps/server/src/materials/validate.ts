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
