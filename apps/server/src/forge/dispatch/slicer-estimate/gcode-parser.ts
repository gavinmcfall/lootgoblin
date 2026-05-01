/**
 * gcode-parser.ts — V2-005f-T_dcf2
 *
 * Parse PrusaSlicer / OrcaSlicer / Bambu Studio gcode metadata comments to
 * derive a SlicerEstimate (per-slot grams, optional volume + material hint,
 * total grams, and slicer-estimated print time).
 *
 * Slicers emit metadata at the END of the file as semicolon-prefixed
 * comments, e.g.:
 *
 *     ; filament used [g] = 38.42
 *     ; filament used [cm3] = 31.97
 *     ; filament_type = PLA
 *     ; estimated printing time (normal mode) = 1h 23m 45s
 *
 * Multi-material variants (Bambu AMS / MMU3 / Anycubic Color Box) emit
 * comma- or semicolon-separated entries:
 *
 *     ; filament used [g] = 12.34, 25.67, 0.00, 0.00
 *     ; filament_type = PLA;PETG;PLA;PLA
 *
 * Slots with 0g are inactive AMS lanes — they're skipped in the output.
 *
 * NEVER throws. Returns `null` if no `filament used [g]` line is found.
 *
 * Performance: gcode files can be 100MB+. `parseGcodeFile` only reads the
 * trailing ~32KB of the file (where slicer metadata lives), so files of any
 * size cost the same. Use `parseGcodeContent` for in-memory strings (e.g.
 * gcode extracted from a 3MF zip entry).
 */

import * as fs from 'node:fs/promises';
import type { SlicerEstimate, SlicerEstimateSlot } from './types';

const TAIL_BYTES = 32 * 1024;

/**
 * Split a metadata value on either ',' or ';'. Slicers vary:
 * PrusaSlicer/Orca use ', ', Bambu Studio sometimes uses ';'.
 */
function splitMulti(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Find the LAST occurrence of a `; <key> = ...` comment in the content.
 * Slicers may emit some keys both early (config block) and late (final
 * estimate) — the late one is the authoritative summary.
 */
function findLastComment(content: string, key: string): string | null {
  const lines = content.split(/\r?\n/);
  // Match ; <key> = <value> with flexible whitespace + optional []
  // We escape regex metacharacters in `key` since it may contain '[]'.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*;\\s*${escaped}\\s*=\\s*(.+)$`, 'i');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = line.match(re);
    if (m && m[1] !== undefined) return m[1].trim();
  }
  return null;
}

/**
 * Parse a slicer time string like '1h 23m 45s', '83m 45s', or '45s' into
 * minutes. Returns null on parse failure.
 */
export function parsePrintTimeToMinutes(raw: string): number | null {
  // Match optional Hh, optional Mm, optional Ss components.
  const re = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/i;
  const m = raw.match(re);
  if (!m) return null;
  if (!m[1] && !m[2] && !m[3]) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const s = m[3] ? parseFloat(m[3]) : 0;
  return h * 60 + min + s / 60;
}

/**
 * Pure parser — takes gcode content as a string, returns a SlicerEstimate
 * or null if the required `filament used [g]` line is missing.
 */
export function parseGcodeContent(content: string): SlicerEstimate | null {
  const gramsRaw = findLastComment(content, 'filament used [g]');
  if (!gramsRaw) return null;

  const gramsTokens = splitMulti(gramsRaw);
  const grams = gramsTokens.map((t) => parseFloat(t));
  if (grams.length === 0 || grams.every((g) => !Number.isFinite(g))) return null;

  const volumeRaw = findLastComment(content, 'filament used [cm3]');
  const volumes = volumeRaw
    ? splitMulti(volumeRaw).map((t) => parseFloat(t))
    : [];

  const typeRaw = findLastComment(content, 'filament_type');
  const types = typeRaw ? splitMulti(typeRaw) : [];

  const slots: SlicerEstimateSlot[] = [];
  for (let i = 0; i < grams.length; i += 1) {
    const g = grams[i];
    if (g === undefined || !Number.isFinite(g) || g <= 0) continue; // inactive AMS lane
    const slot: SlicerEstimateSlot = {
      slot_index: i,
      estimated_grams: g,
    };
    const v = volumes[i];
    if (v !== undefined && Number.isFinite(v) && v > 0) {
      slot.estimated_volume_ml = v;
    }
    const t = types[i];
    if (t && t.length > 0) {
      slot.material_hint = t;
    }
    slots.push(slot);
  }

  if (slots.length === 0) return null;

  const total_grams = slots.reduce((acc, s) => acc + s.estimated_grams, 0);

  const timeRaw = findLastComment(content, 'estimated printing time (normal mode)');
  let print_time_min: number | undefined;
  if (timeRaw) {
    const parsed = parsePrintTimeToMinutes(timeRaw);
    if (parsed !== null) print_time_min = parsed;
  }

  const result: SlicerEstimate = {
    slots,
    total_grams,
  };
  if (print_time_min !== undefined) {
    result.slicer_estimate_print_time_min = print_time_min;
  }
  return result;
}

/**
 * Read the trailing TAIL_BYTES of a gcode file (where slicer metadata
 * lives) and parse it. For files smaller than TAIL_BYTES, reads the whole
 * file. Returns null on read or parse failure.
 */
export async function parseGcodeFile(filePath: string): Promise<SlicerEstimate | null> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(filePath, 'r');
    const stat = await fh.stat();
    const size = stat.size;
    const readLen = Math.min(TAIL_BYTES, size);
    const offset = size - readLen;
    const buf = Buffer.alloc(readLen);
    await fh.read(buf, 0, readLen, offset);
    const content = buf.toString('utf8');
    return parseGcodeContent(content);
  } catch {
    return null;
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
        /* ignore */
      }
    }
  }
}
