/**
 * threemf-parser.ts — V2-005f-T_dcf2
 *
 * Extract slicer estimates from a Bambu Studio / OrcaSlicer `.gcode.3mf`
 * archive. Two strategies, in order:
 *
 *   1. Read `Metadata/slice_info.config` XML and pull per-filament `used_g`
 *      attributes (with optional `type` for material hint).
 *   2. If slice_info.config is missing or lacks per-filament grams (older
 *      Orca builds), extract `Metadata/plate_*.gcode` from the zip and
 *      delegate to gcode-parser.parseGcodeContent — same metadata-comment
 *      convention as a standalone gcode export.
 *
 * Multi-plate handling: prefer `plate_1` (the Bambu Studio CLI single-
 * plate convention). Multi-plate selection is a future carry-forward
 * (V2-005d-b T_db2 already routes plate_index — wiring it here is
 * deferred to a later task).
 *
 * NEVER throws. Returns null if neither strategy yields data.
 *
 * Reuses the JSZip + fast-xml-parser pattern from
 * `apps/server/src/forge/dispatch/bambu/ams-extractor.ts`. The XML parser
 * config disables entity expansion (defense against billion-laughs from
 * untrusted slicer output).
 */

import * as fs from 'node:fs/promises';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type { SlicerEstimate, SlicerEstimateSlot } from './types';
import { parseGcodeContent } from './gcode-parser';

const SLICE_INFO_PATH = 'Metadata/slice_info.config';
const PLATE_GCODE_RE = /^Metadata\/plate_(\d+)\.gcode$/i;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
});

/**
 * Recursively collect every `<filament>` element from a parsed XML object.
 * fast-xml-parser represents repeated element names as arrays, single
 * occurrences as objects.
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

function readAttrNumber(node: Record<string, unknown>, attr: string): number | null {
  const raw = node[attr];
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return Number.isFinite(n) ? n : null;
}

function readAttrString(node: Record<string, unknown>, attr: string): string | null {
  const raw = node[attr];
  if (raw == null) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

function readAttrInt(node: Record<string, unknown>, attr: string): number | null {
  const raw = node[attr];
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Attempt to parse `slice_info.config` XML into per-slot grams. Returns
 * null if no `used_g` attributes are found.
 */
function parseSliceInfo(xml: string): SlicerEstimate | null {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch {
    return null;
  }

  const filaments: Record<string, unknown>[] = [];
  collectFilamentNodes(parsed, filaments);
  if (filaments.length === 0) return null;

  const slots: SlicerEstimateSlot[] = [];
  for (const f of filaments) {
    const g = readAttrNumber(f, '@_used_g');
    if (g === null || g <= 0) continue;
    const idx = readAttrInt(f, '@_id') ?? readAttrInt(f, '@_index') ?? slots.length;
    const slot: SlicerEstimateSlot = {
      slot_index: idx,
      estimated_grams: g,
    };
    const type_hint = readAttrString(f, '@_type');
    if (type_hint) slot.material_hint = type_hint;
    slots.push(slot);
  }

  if (slots.length === 0) return null;

  const total_grams = slots.reduce((acc, s) => acc + s.estimated_grams, 0);
  return { slots, total_grams };
}

/**
 * Parse a `.3mf` (or `.gcode.3mf`) file path and return its slicer
 * estimate, or null on failure.
 */
export async function parseThreemfFile(filePath: string): Promise<SlicerEstimate | null> {
  let fileBuffer: Buffer;
  try {
    fileBuffer = await fs.readFile(filePath);
  } catch {
    return null;
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fileBuffer);
  } catch {
    return null;
  }

  // Strategy 1: slice_info.config — case-insensitive match.
  const sliceEntry =
    zip.file(SLICE_INFO_PATH) ??
    (() => {
      const lookup = SLICE_INFO_PATH.toLowerCase();
      const match = Object.keys(zip.files).find((name) => name.toLowerCase() === lookup);
      return match ? zip.file(match) : null;
    })();

  if (sliceEntry) {
    let xml: string | null = null;
    try {
      xml = await sliceEntry.async('string');
    } catch {
      xml = null;
    }
    if (xml) {
      const fromSliceInfo = parseSliceInfo(xml);
      if (fromSliceInfo) return fromSliceInfo;
    }
  }

  // Strategy 2: extract plate gcode and delegate. Prefer plate_1.
  const plateEntries: { idx: number; name: string }[] = [];
  for (const name of Object.keys(zip.files)) {
    const m = name.match(PLATE_GCODE_RE);
    if (m && m[1] !== undefined) plateEntries.push({ idx: parseInt(m[1], 10), name });
  }
  if (plateEntries.length === 0) return null;
  plateEntries.sort((a, b) => a.idx - b.idx);
  const preferred = plateEntries.find((p) => p.idx === 1) ?? plateEntries[0];
  if (!preferred) return null;
  const plateEntry = zip.file(preferred.name);
  if (!plateEntry) return null;

  let plateContent: string | null = null;
  try {
    plateContent = await plateEntry.async('string');
  } catch {
    plateContent = null;
  }
  if (!plateContent) return null;
  return parseGcodeContent(plateContent);
}
