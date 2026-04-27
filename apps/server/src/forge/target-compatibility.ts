/**
 * TargetCompatibilityMatrix — V2-005a-T6
 *
 * Declarative table of `{format, target_kind} → compatibility_band`.
 * Drives the dispatch UI's "which targets accept this Loot?" verdict and
 * gates POST /api/v1/forge/dispatch from creating jobs that can't possibly
 * complete (`unsupported` → 422 instead of pending).
 *
 * Architectural decisions (locked in F-Q2):
 *  - TS constant, not a DB table. New format-target pairs ship in the same
 *    PR as the dispatcher that handles them. v2.0 has no per-instance
 *    overrides — Option-3 hybrid (DB overlay) is a V3+ stretch.
 *  - Three bands: 'native' | 'conversion-required' | 'unsupported'.
 *  - Format namespace: file extension lowercased without the leading dot.
 *  - 'unsupported' is the *default*. The matrix only enumerates NATIVE
 *    acceptance + known CONVERSION_PATHS + explicit UNSUPPORTED_REASONS.
 *    Anything else falls through to 'unsupported' with no specific reason.
 *
 * Conversion modeling note:
 *  Archive formats (zip/rar/7z) collapse to a single special verdict:
 *  `{band: 'conversion-required', conversionTo: 'archive-extract'}`. The
 *  actual recursion (extract → re-evaluate inner contents) happens in
 *  V2-005b at runtime — the matrix can't model it because the inner
 *  format is unknown until extraction.
 *
 *  STL / OBJ / 3MF / etc. landing on FDM printers need *slicing* (mesh →
 *  gcode), modeled here as `conversionTo: 'gcode'`. The dispatcher in
 *  V2-005c will perform the slice.
 *
 * Cross-references:
 *  - FORGE_PRINTER_KINDS / FORGE_SLICER_KINDS — db/schema.forge.ts.
 *  - Dispatch validation — app/api/v1/forge/dispatch/route.ts (POST).
 *  - Compatibility query API — app/api/v1/forge/dispatch/compatibility/route.ts.
 */

import {
  FORGE_PRINTER_KINDS,
  FORGE_SLICER_KINDS,
  type ForgePrinterKind,
  type ForgeSlicerKind,
} from '@/db/schema.forge';

export type TargetKind = ForgePrinterKind | ForgeSlicerKind;

export type CompatibilityBand =
  | 'native'
  | 'conversion-required'
  | 'unsupported';

export interface CompatibilityVerdict {
  band: CompatibilityBand;
  /**
   * When band='conversion-required': the format we'll convert *to*. Either
   * a normal extension (e.g. 'stl', 'gcode') or the special sentinel
   * 'archive-extract' for zip/rar/7z (V2-005b extracts + recurses).
   */
  conversionTo?: string;
  /** When band='unsupported': human-readable reason for the UI grey-out badge. */
  reason?: string;
}

/** Special sentinel for archive formats — see file header. */
export const ARCHIVE_EXTRACT_SENTINEL = 'archive-extract';

const ARCHIVE_FORMATS = ['zip', 'rar', '7z'] as const;
type ArchiveFormat = (typeof ARCHIVE_FORMATS)[number];
function isArchiveFormat(format: string): format is ArchiveFormat {
  return (ARCHIVE_FORMATS as readonly string[]).includes(format);
}

const IMAGE_FORMATS = ['jpeg', 'jpg', 'png', 'webp'] as const;
type ImageFormat = (typeof IMAGE_FORMATS)[number];
function isImageFormat(format: string): format is ImageFormat {
  return (IMAGE_FORMATS as readonly string[]).includes(format);
}

const ALL_TARGET_KINDS = [
  ...FORGE_PRINTER_KINDS,
  ...FORGE_SLICER_KINDS,
] as const;

// ---------------------------------------------------------------------------
// NATIVE_FORMATS — what each target accepts directly without conversion.
// ---------------------------------------------------------------------------

/**
 * What each target accepts natively. Anything not listed here either has a
 * conversion path (CONVERSION_PATHS) or is unsupported.
 *
 * Notes per kind:
 *  - FDM printers (Klipper / OctoPrint) accept gcode only. Bambu LAN also
 *    accepts the Bambu-flavoured 3mf with embedded print metadata.
 *  - SDCP resin printers accept their proprietary sliced formats (ctb, goo,
 *    cbddlp, photon-suffixed). Mesh files must go via a resin slicer first.
 *  - Slicers accept the broad mesh + project formats — entries reflect each
 *    slicer's documented import support.
 */
const NATIVE_FORMATS: Record<TargetKind, ReadonlyArray<string>> = {
  // FDM printer transports
  fdm_klipper: ['gcode'],
  fdm_octoprint: ['gcode'],
  fdm_bambu_lan: ['gcode', '3mf'],
  // Resin printer transport (SDCP)
  resin_sdcp: ['ctb', 'cbddlp', 'goo', 'photon', 'pwmx', 'pwmo'],
  // Slicers
  bambu_studio: ['stl', '3mf', 'obj', 'step', 'stp', 'gcode', 'amf'],
  orcaslicer: ['stl', '3mf', 'obj', 'step', 'stp', 'amf', 'gcode'],
  prusaslicer: ['stl', '3mf', 'obj', 'amf', 'step', 'stp', 'gcode'],
  cura: ['stl', '3mf', 'obj', 'amf'],
  chitubox: ['stl', 'obj', '3mf'],
  lychee: ['stl', 'obj', '3mf'],
};

// ---------------------------------------------------------------------------
// CONVERSION_PATHS — source format → list of formats it can be converted to.
// ---------------------------------------------------------------------------

/**
 * Conversion paths the system knows about. Keys are SOURCE formats; each
 * entry lists the formats we can produce. The matrix consults this when the
 * source isn't natively accepted: if any of the listed conversion targets is
 * native to the desired target kind, we return 'conversion-required' with
 * the *first matching* destination format.
 *
 * V2-005b owns the actual converter implementations. This table mirrors the
 * conversions documented in the plan ("obj → stl via Blender CLI", etc.)
 * plus the implicit slicing path (any mesh → gcode for FDM) that V2-005c
 * will perform.
 */
const CONVERSION_PATHS: Record<string, ReadonlyArray<string>> = {
  // Mesh interchange — convert via Blender CLI to STL.
  fbx: ['stl'],
  glb: ['stl'],
  gltf: ['stl'],
  ply: ['stl'],
  // OBJ → STL (when the target only takes STL, e.g. some resin slicers).
  // OBJ is itself native to most slicers, so this only fires when needed.
  obj: ['stl'],
  // STL → 3MF (Blender CLI / 7z) and 3MF → STL (3MF unpack + STL extract).
  stl: ['3mf', 'gcode'],
  '3mf': ['stl', 'gcode'],
  // STEP / AMF → STL when a slicer doesn't accept them directly.
  step: ['stl', 'gcode'],
  stp: ['stl', 'gcode'],
  amf: ['stl', 'gcode'],
  // Image conversions — supported by libvips/sharp but UNSUPPORTED for
  // printer/slicer targets (no lithophane workflow yet). Listed here for
  // completeness; matrix returns 'unsupported' for image → printer/slicer
  // via the image-format guard below.
};

// ---------------------------------------------------------------------------
// UNSUPPORTED_REASONS — explicit human-readable rejections.
// ---------------------------------------------------------------------------

/**
 * Human-readable reasons for specific (format, targetKind) rejections. Used
 * to populate `verdict.reason` for the UI grey-out badge. The matrix falls
 * back to a generic reason when no entry matches.
 *
 * Wildcard `'*'` applies to any target. More-specific (format, kind) entries
 * win over wildcards.
 */
const UNSUPPORTED_REASONS: Record<string, Partial<Record<TargetKind | '*', string>>> = {
  // Image formats — no printer/slicer accepts pixels.
  jpeg: { '*': 'Image files cannot be sent to printers or slicers (lithophane workflow not yet supported)' },
  jpg: { '*': 'Image files cannot be sent to printers or slicers (lithophane workflow not yet supported)' },
  png: { '*': 'Image files cannot be sent to printers or slicers (lithophane workflow not yet supported)' },
  webp: { '*': 'Image files cannot be sent to printers or slicers (lithophane workflow not yet supported)' },
  // Documents — no path forward.
  pdf: { '*': 'PDF files cannot be sent to printers or slicers' },
  txt: { '*': 'Text files cannot be sent to printers or slicers' },
  md: { '*': 'Markdown files cannot be sent to printers or slicers' },
  // Resin-vs-FDM mismatches.
  gcode: {
    resin_sdcp: 'Resin printers do not accept gcode',
  },
  ctb: {
    fdm_klipper: 'FDM printers do not accept resin-sliced formats (ctb)',
    fdm_octoprint: 'FDM printers do not accept resin-sliced formats (ctb)',
    fdm_bambu_lan: 'FDM printers do not accept resin-sliced formats (ctb)',
    bambu_studio: 'FDM slicers do not import resin-sliced formats (ctb)',
    orcaslicer: 'FDM slicers do not import resin-sliced formats (ctb)',
    prusaslicer: 'FDM slicers do not import resin-sliced formats (ctb)',
    cura: 'FDM slicers do not import resin-sliced formats (ctb)',
  },
  cbddlp: {
    '*': 'Resin-sliced cbddlp files are only accepted by SDCP resin printers',
  },
  goo: {
    '*': 'Resin-sliced goo files are only accepted by SDCP resin printers',
  },
  photon: {
    '*': 'Resin-sliced photon files are only accepted by SDCP resin printers',
  },
  pwmx: {
    '*': 'Resin-sliced pwmx files are only accepted by SDCP resin printers',
  },
  pwmo: {
    '*': 'Resin-sliced pwmo files are only accepted by SDCP resin printers',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lower-case + strip leading dot so callers can pass either '.STL' or 'stl'. */
function normalizeFormat(format: string): string {
  return format.replace(/^\./, '').toLowerCase();
}

function isKnownTargetKind(kind: string): kind is TargetKind {
  return (ALL_TARGET_KINDS as readonly string[]).includes(kind);
}

/** Lookup the most-specific unsupported reason for (format, kind), if any. */
function lookupReason(format: string, targetKind: TargetKind): string | undefined {
  const entry = UNSUPPORTED_REASONS[format];
  if (!entry) return undefined;
  return entry[targetKind] ?? entry['*'];
}

/**
 * Pick the best conversion target: prefer one the desired targetKind accepts
 * natively. Returns the first matching destination format, or undefined if
 * no path leads somewhere the target accepts.
 */
function findConversionTarget(format: string, targetKind: TargetKind): string | undefined {
  const paths = CONVERSION_PATHS[format];
  if (!paths) return undefined;
  const native = NATIVE_FORMATS[targetKind];
  for (const dest of paths) {
    if (native.includes(dest)) return dest;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the compatibility verdict for a (format, targetKind) pair. Format
 * comparison is case-insensitive and tolerates a leading '.'.
 *
 * Order of evaluation:
 *   1. Native acceptance.
 *   2. Image formats — always unsupported for any printer/slicer.
 *   3. Archive formats — always conversion-required → 'archive-extract'.
 *   4. Explicit unsupported reason (format, kind) or wildcard.
 *   5. Conversion path → first matching native destination.
 *   6. Default: unsupported (no specific reason).
 */
export function getCompatibility(
  rawFormat: string,
  targetKind: TargetKind,
): CompatibilityVerdict {
  const format = normalizeFormat(rawFormat);

  // (1) Native acceptance.
  if (NATIVE_FORMATS[targetKind].includes(format)) {
    return { band: 'native' };
  }

  // (2) Image formats are universally unsupported on printer/slicer targets.
  if (isImageFormat(format)) {
    const reason = lookupReason(format, targetKind);
    return {
      band: 'unsupported',
      reason: reason ?? 'Image files cannot be sent to printers or slicers',
    };
  }

  // (3) Archive formats: conversion-required with the special sentinel.
  if (isArchiveFormat(format)) {
    return {
      band: 'conversion-required',
      conversionTo: ARCHIVE_EXTRACT_SENTINEL,
    };
  }

  // (4) Explicit unsupported reason — wins over conversion paths because the
  //     matrix author has decided "no, this combination doesn't make sense"
  //     even if a chain technically exists (e.g. resin formats on FDM).
  const explicitReason = lookupReason(format, targetKind);
  if (explicitReason) {
    return { band: 'unsupported', reason: explicitReason };
  }

  // (5) Conversion path.
  const dest = findConversionTarget(format, targetKind);
  if (dest) {
    return { band: 'conversion-required', conversionTo: dest };
  }

  // (6) Default — unknown format, no path.
  return {
    band: 'unsupported',
    reason: `No known conversion from '${format}' to a format accepted by ${targetKind}`,
  };
}

/**
 * Bulk lookup for a single source format across multiple target kinds.
 * Convenient for the dispatch UI: "given this Loot's format, which of the
 * user's configured targets light up green/yellow/grey?"
 */
export function bulkGetCompatibility(
  rawFormat: string,
  targetKinds: ReadonlyArray<TargetKind>,
): Record<TargetKind, CompatibilityVerdict> {
  const out = {} as Record<TargetKind, CompatibilityVerdict>;
  for (const kind of targetKinds) {
    out[kind] = getCompatibility(rawFormat, kind);
  }
  return out;
}

/**
 * Returns a frozen view of the matrix data for testing / introspection.
 * The shape mirrors the internal constants but the references are deeply
 * frozen so callers can't accidentally mutate the live tables.
 */
export function getMatrixSnapshot(): {
  nativeFormats: Readonly<Record<TargetKind, ReadonlyArray<string>>>;
  conversionPaths: Readonly<Record<string, ReadonlyArray<string>>>;
} {
  return Object.freeze({
    nativeFormats: NATIVE_FORMATS,
    conversionPaths: CONVERSION_PATHS,
  });
}

/** Re-export for callers that need to iterate every target kind. */
export const ALL_FORGE_TARGET_KINDS: ReadonlyArray<TargetKind> = ALL_TARGET_KINDS;

/** Type guard — exported so HTTP routes can validate query params. */
export function isTargetKind(value: unknown): value is TargetKind {
  return typeof value === 'string' && isKnownTargetKind(value);
}
