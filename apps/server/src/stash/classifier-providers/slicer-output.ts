/**
 * slicer-output.ts — Slicer-output classifier provider — V2-005e-T_e2
 *
 * Tags files arriving on disk as `slicerOutput: true` when their extension
 * matches a known slicer-output format (gcode / .gcode.3mf / .bgcode / .ctb
 * / .cbddlp / .jxs / .sl1 / .sl1s). Used by the Forge inbox watcher
 * (forge/inboxes/ingest.ts) to route slice files into the dispatch-target
 * path rather than the source-model adoption path.
 *
 * Compound `.gcode.3mf` MUST beat plain `.3mf`. A Bambu Studio `.gcode.3mf`
 * is slicer output (contains gcode + plate metadata); a plain `.3mf` is a
 * source 3MF model. Detection by lowercase basename ending. The companion
 * narrowing in three-mf.ts skips `.gcode.3mf` so primaryFormat is not
 * conflated with the source 3MF format.
 *
 * Confidence: 1.0 — the extension list is unambiguous, and the discriminator
 * is binary (true = slicer output, absence = not slicer output).
 *
 * primaryFormat is also set to the format token (e.g. 'gcode', 'gcode.3mf',
 * 'bgcode') with confidence 0.95 so downstream code that already gates on
 * primaryFormat picks the slicer format up.
 */

import * as path from 'node:path';
import type {
  ClassifierProvider,
  ClassifierInput,
  PartialClassification,
} from '../classifier';

/**
 * Compound extension prefixes (longest match first — `.gcode.3mf` is checked
 * before plain `.3mf` and before plain `.gcode`).
 */
const COMPOUND_EXTENSIONS: ReadonlyArray<{ ext: string; format: string }> = [
  { ext: '.gcode.3mf', format: 'gcode.3mf' },
];

/**
 * Single-segment slicer-output extensions.
 */
const SINGLE_EXTENSIONS: ReadonlyArray<{ ext: string; format: string }> = [
  { ext: '.gcode', format: 'gcode' },
  { ext: '.bgcode', format: 'bgcode' },
  { ext: '.ctb', format: 'ctb' },
  { ext: '.cbddlp', format: 'cbddlp' },
  { ext: '.jxs', format: 'jxs' },
  { ext: '.sl1', format: 'sl1' },
  { ext: '.sl1s', format: 'sl1s' },
];

/**
 * Returns the slicer-output format token if the basename matches a known
 * slicer-output extension, or null otherwise.
 *
 * Exported for use by three-mf.ts (compound .gcode.3mf narrowing) and by
 * the inbox-ingest watcher's classifier-hint path.
 */
export function detectSlicerOutputFormat(basename: string): string | null {
  const lower = basename.toLowerCase();
  for (const { ext, format } of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(ext)) return format;
  }
  // path.extname returns the last segment only; that's correct for
  // single-extension matches and avoids re-matching `.3mf` after the
  // compound check above passed/failed.
  const lastExt = path.extname(lower);
  for (const { ext, format } of SINGLE_EXTENSIONS) {
    if (lastExt === ext) return format;
  }
  return null;
}

export function createSlicerOutputProvider(): ClassifierProvider {
  return {
    name: 'slicer-output',

    async classify(input: ClassifierInput): Promise<PartialClassification> {
      // First match wins — a Loot candidate is slicer-output if ANY of its
      // files has a slicer-output extension. In practice the inbox watcher
      // calls this with a single file at a time.
      for (const file of input.files) {
        const basename = path.basename(file.relativePath);
        const format = detectSlicerOutputFormat(basename);
        if (format !== null) {
          return {
            slicerOutput: { value: true, confidence: 1.0 },
            primaryFormat: { value: format, confidence: 0.95 },
          };
        }
      }
      return {};
    },
  };
}
