/**
 * extractor.ts — V2-005f-T_dcf2
 *
 * Public entry point for the SlicerEstimateExtractor framework. Routes a
 * file to the right format-specific parser based on extension (or an
 * explicit `formatHint`), wraps the parser in defensive try/catch so a
 * malformed file never throws into the dispatch worker, and returns
 * `null` when nothing useful can be extracted.
 *
 * Supported formats:
 *   - gcode  (.gcode, .g)
 *   - 3mf    (.3mf, .gcode.3mf)
 *   - ctb    (.ctb, .cbddlp, .jxs)
 *
 * Binary gcode (`.bgcode`) is NOT supported in this iteration — the format
 * is rare in our pipeline and would require an additional binary parser.
 *
 * Wired into the worker by T_dcf11 / claim-worker (a later task in this
 * plan); T_dcf2 only ships the framework.
 */

import * as path from 'node:path';
import { logger } from '@/logger';
import type { SlicerEstimate } from './types';
import { parseGcodeFile } from './gcode-parser';
import { parseCtbFile } from './ctb-parser';
import { parseThreemfFile } from './threemf-parser';

export type SlicerEstimateFormat = 'gcode' | 'ctb' | '3mf';

export interface ExtractSlicerEstimateInput {
  filePath: string;
  /**
   * Override extension-based format detection (e.g. forced 'gcode' for a
   * `.bgcode`-renamed file or a stream tagged manually upstream).
   */
  formatHint?: SlicerEstimateFormat;
}

/**
 * Detect the slicer format from a filename. Returns null for unsupported /
 * unknown extensions.
 */
export function detectFormat(filePath: string): SlicerEstimateFormat | null {
  const lower = filePath.toLowerCase();
  // Check compound extension first.
  if (lower.endsWith('.gcode.3mf')) return '3mf';
  const ext = path.extname(lower);
  switch (ext) {
    case '.gcode':
    case '.g':
      return 'gcode';
    case '.3mf':
      return '3mf';
    case '.ctb':
    case '.cbddlp':
    case '.jxs':
      return 'ctb';
    default:
      return null;
  }
}

/**
 * Extract a SlicerEstimate from a sliced print file. Dispatches to the
 * right format parser; never throws — returns null on any failure path
 * and logs a warning if a parser unexpectedly throws.
 */
export async function extractSlicerEstimate(
  input: ExtractSlicerEstimateInput,
): Promise<SlicerEstimate | null> {
  const { filePath, formatHint } = input;
  const format = formatHint ?? detectFormat(filePath);
  if (!format) return null;

  try {
    switch (format) {
      case 'gcode':
        return await parseGcodeFile(filePath);
      case '3mf':
        return await parseThreemfFile(filePath);
      case 'ctb':
        return await parseCtbFile(filePath);
      default:
        return null;
    }
  } catch (err) {
    logger.warn(
      { filePath, format, err },
      'slicer-estimate: parser threw unexpectedly — returning null',
    );
    return null;
  }
}
