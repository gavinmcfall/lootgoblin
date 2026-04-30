/**
 * types.ts — V2-005d-b T_db1
 *
 * Per-model capability data for Bambu Lab LAN-mode printers. Drives UI hints
 * (max AMS slots, bed size, multi-function affordances) and dispatcher
 * behaviour (e.g. AMS slot remapping in T_db2/T_db3).
 *
 * NOTE (V2-005d-b-CF-7): Capability values are initial best-effort from
 * research against Bambu's official spec pages. Refine when authoritative
 * spec data becomes available — the source of truth is the table here, but
 * a follow-up sweep against vendor docs is expected once H2-series spec
 * surfaces stabilise (especially AMS unit / slot maxima for the multi-
 * function H2 line).
 *
 * The `BambuLanKind` type is a strict subset of `ForgePrinterKind`. The
 * legacy generic `'fdm_bambu_lan'` kind in FORGE_PRINTER_KINDS is *not*
 * part of this list — it stays for backwards compatibility with V2-005a-era
 * printer rows; new printers should be created with a per-model kind.
 */

export const BAMBU_LAN_KINDS = [
  // H2 series — multi-function (print + laser + cut + plot)
  'bambu_h2d',
  'bambu_h2d_pro',
  'bambu_h2c',
  'bambu_h2s',
  // X series
  'bambu_x2d',
  // P series
  'bambu_p2s',
  'bambu_p1s',
  'bambu_p1p',
  // A series
  'bambu_a1',
  'bambu_a1_mini',
  // X1 series — EOL 2026-03-31, still supported in homes
  'bambu_x1c',
  'bambu_x1e',
  'bambu_x1',
] as const;
export type BambuLanKind = (typeof BAMBU_LAN_KINDS)[number];

export interface BambuModelCapability {
  /** Max AMS 2 Pro / AMS units that can be daisy-chained. */
  maxAmsUnits: number;
  /** Max total filament slots across all AMS units (excluding external). */
  maxAmsSlots: number;
  /** Bed size in mm (X, Y, Z). */
  bedSizeMm: { x: number; y: number; z: number };
  /** Whether the printer has an actively heated chamber. */
  hasHeatedChamber: boolean;
  /** Whether the printer supports AMS HT (high-temp) modules. */
  supportsAmsHt: boolean;
  /** Whether the printer supports the H2-series multi-function (laser/cut/plot). */
  isMultiFunction: boolean;
  /** Display name for UI. */
  displayName: string;
}

export const BAMBU_MODEL_CAPABILITIES: Record<BambuLanKind, BambuModelCapability> = {
  // H2 series — multi-function, dual-nozzle (except H2S)
  bambu_h2d: {
    maxAmsUnits: 4,
    maxAmsSlots: 16,
    bedSizeMm: { x: 350, y: 320, z: 325 },
    hasHeatedChamber: true,
    supportsAmsHt: true,
    isMultiFunction: true,
    displayName: 'Bambu Lab H2D',
  },
  bambu_h2d_pro: {
    maxAmsUnits: 4,
    maxAmsSlots: 16,
    bedSizeMm: { x: 350, y: 320, z: 325 },
    hasHeatedChamber: true,
    supportsAmsHt: true,
    isMultiFunction: true,
    displayName: 'Bambu Lab H2D Pro',
  },
  bambu_h2c: {
    maxAmsUnits: 4,
    maxAmsSlots: 16,
    bedSizeMm: { x: 350, y: 320, z: 325 },
    hasHeatedChamber: true,
    supportsAmsHt: true,
    isMultiFunction: true,
    displayName: 'Bambu Lab H2C',
  },
  bambu_h2s: {
    maxAmsUnits: 4,
    maxAmsSlots: 16,
    bedSizeMm: { x: 350, y: 320, z: 350 },
    hasHeatedChamber: true,
    supportsAmsHt: true,
    isMultiFunction: false,
    displayName: 'Bambu Lab H2S',
  },
  // X series
  bambu_x2d: {
    maxAmsUnits: 4,
    maxAmsSlots: 16,
    bedSizeMm: { x: 256, y: 256, z: 256 },
    hasHeatedChamber: false,
    supportsAmsHt: false,
    isMultiFunction: false,
    displayName: 'Bambu Lab X2D',
  },
  // P series
  bambu_p2s: {
    maxAmsUnits: 8,
    maxAmsSlots: 20,
    bedSizeMm: { x: 256, y: 256, z: 256 },
    hasHeatedChamber: false,
    supportsAmsHt: true,
    isMultiFunction: false,
    displayName: 'Bambu Lab P2S',
  },
  bambu_p1s: {
    maxAmsUnits: 4,
    maxAmsSlots: 16,
    bedSizeMm: { x: 256, y: 256, z: 256 },
    hasHeatedChamber: false,
    supportsAmsHt: false,
    isMultiFunction: false,
    displayName: 'Bambu Lab P1S',
  },
  bambu_p1p: {
    maxAmsUnits: 4,
    maxAmsSlots: 16,
    bedSizeMm: { x: 256, y: 256, z: 256 },
    hasHeatedChamber: false,
    supportsAmsHt: false,
    isMultiFunction: false,
    displayName: 'Bambu Lab P1P',
  },
  // A series
  bambu_a1: {
    maxAmsUnits: 1,
    maxAmsSlots: 4,
    bedSizeMm: { x: 256, y: 256, z: 256 },
    hasHeatedChamber: false,
    supportsAmsHt: false,
    isMultiFunction: false,
    displayName: 'Bambu Lab A1',
  },
  bambu_a1_mini: {
    maxAmsUnits: 0,
    maxAmsSlots: 0,
    bedSizeMm: { x: 180, y: 180, z: 180 },
    hasHeatedChamber: false,
    supportsAmsHt: false,
    isMultiFunction: false,
    displayName: 'Bambu Lab A1 mini',
  },
  // X1 series — EOL 2026-03-31
  bambu_x1c: {
    maxAmsUnits: 4,
    maxAmsSlots: 16,
    bedSizeMm: { x: 256, y: 256, z: 256 },
    hasHeatedChamber: false,
    supportsAmsHt: false,
    isMultiFunction: false,
    displayName: 'Bambu Lab X1 Carbon (EOL)',
  },
  bambu_x1e: {
    maxAmsUnits: 4,
    maxAmsSlots: 16,
    bedSizeMm: { x: 256, y: 256, z: 256 },
    hasHeatedChamber: true,
    supportsAmsHt: false,
    isMultiFunction: false,
    displayName: 'Bambu Lab X1E (EOL)',
  },
  bambu_x1: {
    maxAmsUnits: 4,
    maxAmsSlots: 16,
    bedSizeMm: { x: 256, y: 256, z: 256 },
    hasHeatedChamber: false,
    supportsAmsHt: false,
    isMultiFunction: false,
    displayName: 'Bambu Lab X1 (EOL)',
  },
};

/** Type guard — narrows `string` to a Bambu LAN per-model kind. */
export function isBambuLanKind(kind: string): kind is BambuLanKind {
  return (BAMBU_LAN_KINDS as readonly string[]).includes(kind);
}
