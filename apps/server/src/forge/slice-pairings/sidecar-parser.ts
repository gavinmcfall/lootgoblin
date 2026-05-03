/**
 * V2-005e-T_e3: Slice sidecar metadata parser (Tier 1 of three-tier match).
 *
 * Two on-disk formats carry source-file hints:
 *   - `.gcode.3mf` / `.3mf`: ZIP archive with `Metadata/model_settings.config`
 *     XML naming the source file. Parsed via JSZip + fast-xml-parser with
 *     entity expansion DISABLED (billion-laughs defense — slicer output is
 *     external input).
 *   - `.gcode` / `.bgcode`: plain-text gcode header comments. Slicer
 *     conventions vary (`; thumbnail_source = X`, `; source = X`,
 *     `; original_filename = X`); we read at most the first 8 KiB.
 *
 * The returned hint feeds `findLootByBasename` in matcher.ts, which gates
 * to the owner's Loot rows. NEVER throws — failure paths log + return
 * null, and the matcher falls through to Tier 2 (filename heuristic) or
 * Tier 3 (pending-pairings queue).
 */

import * as fs from 'node:fs/promises';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { logger } from '../../logger';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Defense against billion-laughs / quadratic-blowup XML payloads. The
  // slicer-output files are external input; entity expansion stays off.
  processEntities: false,
});

export interface SidecarHint {
  /** Filename (with or without directory prefix) of the source model. */
  sourceBasename?: string;
  /** Optional 3MF object id for cross-checking when sourceBasename is fuzzy. */
  threeMfUuid?: string;
}

export async function parseSidecar(filePath: string): Promise<SidecarHint | null> {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.gcode.3mf') || lower.endsWith('.3mf')) {
    return parseThreemfSidecar(filePath);
  }
  if (lower.endsWith('.gcode') || lower.endsWith('.bgcode')) {
    return parseGcodeSidecar(filePath);
  }
  return null;
}

async function parseThreemfSidecar(filePath: string): Promise<SidecarHint | null> {
  try {
    const buf = await fs.readFile(filePath);
    const zip = await JSZip.loadAsync(buf);
    const cfgEntry = Object.keys(zip.files).find(
      (k) => k.toLowerCase() === 'metadata/model_settings.config',
    );
    if (!cfgEntry) return null;
    const xml = await zip.files[cfgEntry]!.async('string');
    const doc = xmlParser.parse(xml);
    const sourceBasename =
      findInXml(doc, 'source_file') ?? findInXml(doc, 'name') ?? undefined;
    const threeMfUuid = findInXml(doc, 'object_id') ?? undefined;
    if (!sourceBasename) return null;
    const result: SidecarHint = { sourceBasename };
    if (threeMfUuid) result.threeMfUuid = threeMfUuid;
    return result;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, filePath },
      'sidecar-parser: 3MF parse failed',
    );
    return null;
  }
}

async function parseGcodeSidecar(filePath: string): Promise<SidecarHint | null> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, 8192, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    // Match any of: thumbnail_source, source, original_filename — case
    // insensitive, anchored to a comment line.
    const sourceMatch = text.match(
      /^[ \t]*;[ \t]*(?:thumbnail_source|source|original_filename)[ \t]*=[ \t]*(.+?)[ \t]*$/im,
    );
    if (sourceMatch) {
      const sourceBasename = sourceMatch[1]!.trim();
      return sourceBasename ? { sourceBasename } : null;
    }
    return null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, filePath },
      'sidecar-parser: gcode header read failed',
    );
    return null;
  } finally {
    if (fh) await fh.close();
  }
}

/**
 * Recursively walk an fast-xml-parser document looking for a value tagged
 * with the given key. Two shapes are supported:
 *
 *   1. fast-xml-parser attribute pair:
 *        { '@_key': '<key>', '@_value': '<value>' }
 *      Bambu/OrcaSlicer model_settings.config uses this.
 *
 *   2. Direct attribute:
 *        { '@_<key>': '<value>' }
 *      Some PrusaSlicer configs use this shape.
 *
 * Returns the first matching string, or undefined. Depth-limited at 12 to
 * avoid runaway recursion on adversarial inputs.
 */
function findInXml(doc: unknown, key: string, depth = 0): string | undefined {
  if (depth > 12) return undefined;
  if (doc == null || typeof doc !== 'object') return undefined;
  if (Array.isArray(doc)) {
    for (const child of doc) {
      const got = findInXml(child, key, depth + 1);
      if (got !== undefined) return got;
    }
    return undefined;
  }
  const obj = doc as Record<string, unknown>;
  // Shape 1: { '@_key': '<key>', '@_value': '<value>' }
  if (obj['@_key'] === key && typeof obj['@_value'] === 'string') {
    return obj['@_value'];
  }
  // Shape 2: { '@_<key>': '<value>' }
  const direct = obj[`@_${key}`];
  if (typeof direct === 'string') {
    return direct;
  }
  // Recurse into children.
  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null) {
      const got = findInXml(value, key, depth + 1);
      if (got !== undefined) return got;
    }
  }
  return undefined;
}
