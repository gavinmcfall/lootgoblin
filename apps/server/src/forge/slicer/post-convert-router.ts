/**
 * Post-convert router — V2-005c-T_c9
 *
 * Pure decision module called by the converter worker after a job has
 * either:
 *
 *   (a) just finished converting (converting → ?), OR
 *   (b) been picked up with no conversion needed (pending → ?)
 *
 * Returns whether the job needs slicing, can be claimed directly, or is
 * incompatible and should fail. The caller is responsible for the actual
 * atomic UPDATE — this module touches no DB and exposes no I/O surface
 * other than the injected `resolvePrinterKind` lookup.
 *
 * Decision logic (in order):
 *
 *   1. `targetKind === 'slicer'` → always claimable. V2-005e slicer
 *      dispatchers just open the file in the slicer GUI — no server-side
 *      slicing.
 *
 *   2. `targetKind === 'printer'`:
 *      a. Resolve the printer's kind via the injected lookup. Null means
 *         the printer row is gone (race with delete) → fail with
 *         `unknown-printer`.
 *      b. If the current format is already `gcode` / `bgcode` the printer
 *         accepts the file directly — claimable.
 *      c. Consult `TargetCompatibilityMatrix.getCompatibility(format, kind)`:
 *         - `native`              → claimable (e.g. 3MF on Bambu LAN).
 *         - `conversion-required` with `conversionTo === 'gcode'` → slicing.
 *         - any other branch     → fail with `incompatible-target`. This
 *           covers `unsupported` outright, plus the (currently impossible)
 *           case of a non-gcode conversion target landing on a printer.
 *
 * Why we use the matrix rather than a hardcoded mesh-extension list: the
 * matrix is the single source of truth for `{format, target_kind} → band`
 * (V2-005a-T6). Adding a new mesh format only requires updating the matrix;
 * the router picks it up automatically.
 */

import {
  getCompatibility,
  isTargetKind,
  type TargetKind,
} from '../target-compatibility';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PostConvertRouteInput {
  targetKind: 'printer' | 'slicer';
  targetId: string;
  /**
   * Format extension of the file the job currently has, lowercase, no dot
   * (e.g. 'stl', '3mf', 'gcode', 'bgcode'). Comes from convertedFileId's
   * stored filename if conversion happened, otherwise the source loot file.
   */
  currentFormat: string;
  /**
   * Caller-supplied lookup. Returns the printer's `kind` string (one of
   * FORGE_PRINTER_KINDS) for the given printer id, or null when the printer
   * row is missing. Kept as DI so the router stays pure / DB-free.
   */
  resolvePrinterKind: (
    printerId: string,
  ) => Promise<string | null> | string | null;
}

export type PostConvertDecision =
  | { next: 'claimable'; reason: string }
  | { next: 'slicing'; reason: string }
  | {
      next: 'failed';
      reason: 'incompatible-target' | 'unknown-printer';
      details?: string;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** gcode-family formats that any FDM printer accepts directly (no slicing). */
const GCODE_FORMATS = new Set(['gcode', 'bgcode']);

function normalizeFormat(format: string): string {
  return format.replace(/^\./, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// routePostConvert
// ---------------------------------------------------------------------------

export async function routePostConvert(
  input: PostConvertRouteInput,
): Promise<PostConvertDecision> {
  const format = normalizeFormat(input.currentFormat);

  // (1) Slicer targets — V2-005e dispatchers just open the file.
  if (input.targetKind === 'slicer') {
    return {
      next: 'claimable',
      reason: 'slicer-target-just-opens-file',
    };
  }

  // (2) Printer targets.
  const printerKind = await input.resolvePrinterKind(input.targetId);
  if (printerKind === null || printerKind === undefined) {
    return {
      next: 'failed',
      reason: 'unknown-printer',
      details: `No printer row found for targetId=${input.targetId}`,
    };
  }

  // (2b) gcode/bgcode is accepted directly by every FDM printer kind we
  // model. Short-circuit before consulting the matrix.
  if (GCODE_FORMATS.has(format)) {
    return { next: 'claimable', reason: 'already-gcode' };
  }

  // (2c) Defensive: if the printer kind isn't one the matrix knows about
  // we can't make a decision. Treat as incompatible.
  if (!isTargetKind(printerKind)) {
    return {
      next: 'failed',
      reason: 'incompatible-target',
      details: `printer kind '${printerKind}' is not modeled in TargetCompatibilityMatrix`,
    };
  }

  const verdict = getCompatibility(format, printerKind as TargetKind);

  if (verdict.band === 'native') {
    return { next: 'claimable', reason: 'native-format' };
  }

  if (
    verdict.band === 'conversion-required' &&
    verdict.conversionTo === 'gcode'
  ) {
    return { next: 'slicing', reason: 'needs-gcode-from-mesh' };
  }

  return {
    next: 'failed',
    reason: 'incompatible-target',
    details: `'${format}' not compatible with printer kind '${printerKind}'`,
  };
}
