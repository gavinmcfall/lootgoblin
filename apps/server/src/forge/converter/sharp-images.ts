/**
 * sharp-images.ts — V2-005b T_b1
 *
 * Image-format conversion via the `sharp` npm package (libvips bindings,
 * bundled prebuilt — no shell-out, no tool-availability check).
 *
 * Supported pairs (T_b1): jpeg ↔ png, jpeg ↔ webp, png ↔ webp.
 *
 * Output filename: `<basename>-<8-hex>.<ext>` in `outputDir`. The short hex
 * suffix prevents collisions when the same input is converted multiple
 * times into the same outputDir (which is the realistic shape — caller
 * picks `os.tmpdir()/forge-conv-<uuid>/` and may invoke convertFile
 * repeatedly within that scope).
 */

import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import type { ConversionResult } from './types';

/** Sharp's `toFormat` accepts these strings — narrowed for type safety. */
type SharpFormat = 'jpeg' | 'png' | 'webp';

const SUPPORTED_IMAGE_FORMATS: ReadonlyArray<SharpFormat> = ['jpeg', 'png', 'webp'];

export function isSupportedImageFormat(format: string): format is SharpFormat {
  return (SUPPORTED_IMAGE_FORMATS as readonly string[]).includes(format);
}

export interface ConvertImageInput {
  inputPath: string;
  inputFormat: SharpFormat;
  outputFormat: SharpFormat;
  outputDir: string;
}

export async function convertImage(
  input: ConvertImageInput,
): Promise<ConversionResult> {
  const { inputPath, outputFormat, outputDir } = input;

  await mkdir(outputDir, { recursive: true });

  const basename = path.basename(inputPath, path.extname(inputPath));
  const suffix = randomBytes(4).toString('hex');
  const ext = outputFormat === 'jpeg' ? 'jpg' : outputFormat;
  const outputPath = path.join(outputDir, `${basename}-${suffix}.${ext}`);

  try {
    // toFormat() coerces both encoding and decoding when the input format
    // matches a sharp-recognized signature. Sharp validates the input on
    // pipeline run, so corrupt files reject here with an Error.
    await sharp(inputPath).toFormat(outputFormat).toFile(outputPath);
  } catch (err) {
    return {
      ok: false,
      reason: 'tool-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ok: true,
    outputPaths: [outputPath],
    outputFormat,
  };
}
