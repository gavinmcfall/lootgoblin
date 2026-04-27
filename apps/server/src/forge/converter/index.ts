/**
 * converter/index.ts — V2-005b T_b1
 *
 * Format-converter framework entrypoint. Dispatches by (inputFormat,
 * outputFormat) pair to the right backend:
 *   - Image pairs (jpeg/png/webp ↔ each other) → sharp-images
 *   - Archive formats (zip/rar/7z) → sevenzip-archives (output is
 *     the special 'archive-extract' sentinel)
 *   - Mesh formats (stl/3mf/obj/fbx/glb/...) → blender-mesh-stub
 *     (returns 'not-implemented' until T_b2)
 *   - Anything else → 'unsupported-pair'
 *
 * Format normalization (lowercase, strip leading '.') matches
 * TargetCompatibilityMatrix's `normalizeFormat`. 'jpg' and 'jpeg' are both
 * accepted on input; sharp output always uses 'jpeg' as the toFormat
 * argument and the `.jpg` filename extension (matching sharp's defaults).
 *
 * Output directory: caller can supply `opts.outputDir`. When omitted, we
 * mint a fresh temp dir under `os.tmpdir()/forge-conv-<uuid>/`. Caller
 * owns cleanup either way — the framework never deletes outputs.
 */

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { convertImage, isSupportedImageFormat } from './sharp-images';
import { extractArchive } from './sevenzip-archives';
import { convertMesh, isMeshFormat } from './blender-mesh-stub';
import { runCommand as defaultRunCommand, type RunCommand } from './run-command';
import type { ConversionResult } from './types';

export type {
  ConversionFormat,
  ConversionFailureReason,
  ConversionResult,
} from './types';
export { runCommand } from './run-command';
export type { RunCommand, RunCommandResult, RunCommandOptions } from './run-command';
export { isToolAvailable, resetToolAvailabilityCache } from './tool-availability';

export interface ConversionInput {
  inputPath: string;
  /** Case-insensitive; '.STL' / 'STL' / 'stl' all accepted. */
  inputFormat: string;
  /** For archives, pass 'archive-extract'. */
  outputFormat: string;
  /** Default: `os.tmpdir() / forge-conv-<uuid>/`. */
  outputDir?: string;
}

export interface ConvertFileOptions {
  /** Override the production exec wrapper. Used by tests. */
  runCommand?: RunCommand;
}

const ARCHIVE_INPUT_FORMATS = new Set(['zip', 'rar', '7z']);
const ARCHIVE_OUTPUT_SENTINEL = 'archive-extract';

/** Lowercase + strip a leading dot. Mirrors target-compatibility.ts. */
export function normalizeFormat(format: string): string {
  return format.replace(/^\./, '').toLowerCase();
}

/**
 * Coerce common aliases to their canonical form. Sharp accepts 'jpeg' but
 * users say 'jpg'; we normalize on the way in so the rest of the code
 * doesn't need to care.
 */
function canonicalImageFormat(format: string): string {
  if (format === 'jpg') return 'jpeg';
  return format;
}

export async function convertFile(
  input: ConversionInput,
  opts?: ConvertFileOptions,
): Promise<ConversionResult> {
  const inputFormat = canonicalImageFormat(normalizeFormat(input.inputFormat));
  const outputFormat = canonicalImageFormat(normalizeFormat(input.outputFormat));
  const runCmd = opts?.runCommand ?? defaultRunCommand;

  // Reject same-format no-ops up front — caller should detect this and
  // skip the converter entirely. We surface 'unsupported-pair' rather than
  // silently echoing the input back.
  if (inputFormat === outputFormat) {
    return {
      ok: false,
      reason: 'unsupported-pair',
      details: `Input and output formats are both '${inputFormat}'; no conversion needed`,
    };
  }

  const outputDir = await resolveOutputDir(input.outputDir);

  // ---- Archive extraction ------------------------------------------------
  if (ARCHIVE_INPUT_FORMATS.has(inputFormat)) {
    if (outputFormat !== ARCHIVE_OUTPUT_SENTINEL) {
      return {
        ok: false,
        reason: 'unsupported-pair',
        details: `Archive '${inputFormat}' must convert to '${ARCHIVE_OUTPUT_SENTINEL}', got '${outputFormat}'`,
      };
    }
    return extractArchive(
      { inputPath: input.inputPath, outputDir },
      { runCommand: runCmd },
    );
  }

  // ---- Image conversion --------------------------------------------------
  if (isSupportedImageFormat(inputFormat) && isSupportedImageFormat(outputFormat)) {
    return convertImage({
      inputPath: input.inputPath,
      inputFormat,
      outputFormat,
      outputDir,
    });
  }

  // ---- Mesh conversion (stubbed in T_b1) ---------------------------------
  if (isMeshFormat(inputFormat) || isMeshFormat(outputFormat)) {
    return convertMesh({
      inputPath: input.inputPath,
      inputFormat,
      outputFormat,
      outputDir,
    });
  }

  // ---- No matching backend -----------------------------------------------
  return {
    ok: false,
    reason: 'unsupported-pair',
    details: `No converter registered for '${inputFormat}' → '${outputFormat}'`,
  };
}

async function resolveOutputDir(supplied?: string): Promise<string> {
  if (supplied) {
    await mkdir(supplied, { recursive: true });
    return supplied;
  }
  const dir = path.join(tmpdir(), `forge-conv-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
