/**
 * ams-extractor.ts — V2-005d-b T_db2
 *
 * Extract AMS (Automatic Material System) metadata from a Bambu Studio /
 * OrcaSlicer `.gcode.3mf` archive so the Bambu LAN dispatcher can issue an
 * MQTT print command with the correct multi-material slot mapping.
 *
 * A Bambu Studio export is a ZIP archive. The relevant entry is
 * `Metadata/slice_info.config`, an XML document containing per-plate
 * `<filament>` slot data. When AMS is enabled, each filament used by the
 * sliced plate appears as a `<filament>` element with an `id` attribute
 * pointing at the AMS slot index (0-based).
 *
 * NEVER throws — every failure path falls back to safe defaults so the
 * dispatcher can still attempt a single-color print.
 *
 * Carry-forward V2-005d-b-CF-2: multi-plate selection. For now we always
 * return plateIndex=1 (the Bambu Studio CLI single-plate convention).
 *
 * Schema assumption (T_db5 will validate against a real Bambu output):
 *   <config>
 *     <plate>
 *       <metadata key="index" value="1"/>
 *       <filament id="0" .../>
 *       <filament id="1" .../>
 *       ...
 *     </plate>
 *   </config>
 *
 * The extractor walks defensively: it accepts `<filament>` elements at any
 * depth and pulls slot indexes from `id`, `index`, or `slot` attributes,
 * preferring `id` when multiple are present.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { logger } from '@/logger';

const SLICE_INFO_PATH = 'Metadata/slice_info.config';

// fast-xml-parser — preserve attributes, disable entity expansion (defense
// against billion-laughs from untrusted slicer output).
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
});

export interface AmsConfig {
  /** True if the 3MF was sliced with AMS enabled. */
  useAms: boolean;
  /** Slot indexes used for the print, in order of filament change. e.g. [0, 1, 2, 3] for 4-color. Empty if useAms=false. */
  amsMapping: number[];
  /** Plate index inside the 3MF (Bambu Studio: plate_1, plate_2, ...). Default 1. */
  plateIndex: number;
  /** Subtask name — used in MQTT print command. Default = basename minus .gcode.3mf suffix. */
  subtaskName: string;
}

/**
 * Strip `.gcode.3mf` or `.3mf` suffix from a basename.
 */
function deriveSubtaskName(threeMfPath: string): string {
  const base = path.basename(threeMfPath);
  if (base.toLowerCase().endsWith('.gcode.3mf')) {
    return base.slice(0, -'.gcode.3mf'.length);
  }
  if (base.toLowerCase().endsWith('.3mf')) {
    return base.slice(0, -'.3mf'.length);
  }
  return base;
}

function safeDefaults(threeMfPath: string): AmsConfig {
  return {
    useAms: false,
    amsMapping: [],
    plateIndex: 1,
    subtaskName: deriveSubtaskName(threeMfPath),
  };
}

/**
 * Recursively collect every `<filament>` element from a parsed XML object,
 * regardless of nesting depth. fast-xml-parser represents repeated element
 * names as arrays, single occurrences as objects.
 */
function collectFilamentNodes(node: unknown, out: Record<string, unknown>[]): void {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectFilamentNodes(child, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'filament') {
      if (Array.isArray(value)) {
        for (const f of value) {
          if (f && typeof f === 'object') out.push(f as Record<string, unknown>);
        }
      } else if (value && typeof value === 'object') {
        out.push(value as Record<string, unknown>);
      }
    } else if (typeof value === 'object') {
      collectFilamentNodes(value, out);
    }
  }
}

/**
 * Pull a slot index from a filament node. Tries `id`, then `index`, then
 * `slot`. Returns null if none parse to a non-negative integer.
 */
function extractSlotIndex(filament: Record<string, unknown>): number | null {
  for (const attr of ['@_id', '@_index', '@_slot']) {
    const raw = filament[attr];
    if (raw == null) continue;
    const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}

export async function extractAmsConfig(threeMfPath: string): Promise<AmsConfig> {
  const defaults = safeDefaults(threeMfPath);

  let fileBuffer: Buffer;
  try {
    fileBuffer = await fs.readFile(threeMfPath);
  } catch (err) {
    logger.warn({ path: threeMfPath, err }, 'ams-extractor: failed to read 3MF file');
    return defaults;
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fileBuffer);
  } catch (err) {
    logger.warn({ path: threeMfPath, err }, 'ams-extractor: failed to unzip 3MF');
    return defaults;
  }

  // Spec-standard casing first; fall back to case-insensitive match.
  let entry = zip.file(SLICE_INFO_PATH);
  if (entry === null) {
    const lookup = SLICE_INFO_PATH.toLowerCase();
    const match = Object.keys(zip.files).find((name) => name.toLowerCase() === lookup);
    entry = match ? zip.file(match) : null;
  }
  if (entry === null) {
    logger.warn(
      { path: threeMfPath, entry: SLICE_INFO_PATH },
      'ams-extractor: slice_info.config not found in 3MF',
    );
    return defaults;
  }

  let xml: string;
  try {
    xml = await entry.async('string');
  } catch (err) {
    logger.warn({ path: threeMfPath, err }, 'ams-extractor: failed to read slice_info.config from zip');
    return defaults;
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch (err) {
    logger.warn({ path: threeMfPath, err }, 'ams-extractor: failed to parse slice_info.config XML');
    return defaults;
  }

  const filaments: Record<string, unknown>[] = [];
  try {
    collectFilamentNodes(parsed, filaments);
  } catch (err) {
    logger.warn({ path: threeMfPath, err }, 'ams-extractor: error walking parsed XML');
    return defaults;
  }

  const slots: number[] = [];
  for (const f of filaments) {
    const slot = extractSlotIndex(f);
    if (slot !== null) slots.push(slot);
  }

  // AMS multi-color requires 2+ filament slots. A single-filament `<filament>`
  // entry is just the active material — not AMS-driven. Treat <2 as no-AMS.
  if (slots.length < 2) {
    return defaults;
  }

  return {
    useAms: true,
    amsMapping: slots,
    plateIndex: 1,
    subtaskName: deriveSubtaskName(threeMfPath),
  };
}
