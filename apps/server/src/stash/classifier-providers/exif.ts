/**
 * exif.ts — EXIF extraction from image files — V2-002-T6
 *
 * Uses `exifr` to parse EXIF metadata from JPEG, PNG, TIFF images.
 * Maps EXIF fields to ClassificationResult fields with moderate confidence
 * (0.5–0.7) — EXIF is reliable when present but often absent or incorrect
 * for 3D model previews.
 *
 * EXIF field mappings:
 *   Artist or Creator → creator (confidence 0.7)
 *   ImageDescription  → description (confidence 0.5)
 *   Copyright         → license (confidence 0.5)
 *
 * If no image files are in the input, returns empty without error.
 * Parse errors are caught and logged as warnings — EXIF is best-effort.
 */

import * as path from 'node:path';
import { logger } from '../../logger';
import type { ClassifierProvider, ClassifierInput, PartialClassification } from '../classifier';

// Image extensions we attempt to parse.
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']);

type ExifrOutput = {
  Artist?: string;
  Creator?: string | string[];
  ImageDescription?: string;
  Copyright?: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Lazy import helper — exifr is an ESM module
// ---------------------------------------------------------------------------

async function parseExif(absolutePath: string): Promise<ExifrOutput | null> {
  try {
    // Dynamic import to satisfy ESM — exifr is a pure ESM package.
    const exifr = await import('exifr');
    // exifr.parse returns null or undefined when no EXIF data present.
    const result = await exifr.parse(absolutePath, {
      // Only parse EXIF IFD0 + XMP — we don't need GPS or thumbnail.
      tiff: true,
      xmp: true,
      icc: false,
      iptc: false,
      jfif: false,
    });
    return (result as ExifrOutput | null | undefined) ?? null;
  } catch (err) {
    logger.warn({ path: absolutePath, err }, 'exif: failed to parse EXIF data');
    return null;
  }
}

function coerceString(v: string | string[] | undefined): string | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v[0]?.trim() || undefined;
  return v.trim() || undefined;
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createExifProvider(): ClassifierProvider {
  return {
    name: 'exif',

    async classify(input: ClassifierInput): Promise<PartialClassification> {
      const imageFiles = input.files.filter(
        (f) => IMAGE_EXTENSIONS.has(path.extname(f.relativePath).toLowerCase()),
      );

      if (imageFiles.length === 0) return {};

      // Try each image until we find one with useful EXIF data.
      const partial: PartialClassification = {};
      let found = false;

      for (const file of imageFiles) {
        const exif = await parseExif(file.absolutePath);
        if (exif === null) continue;

        const artist = coerceString(exif.Artist as string | string[] | undefined);
        const creator = coerceString(exif.Creator as string | string[] | undefined);
        const imageDescription = coerceString(exif.ImageDescription as string | string[] | undefined);
        const copyright = coerceString(exif.Copyright as string | string[] | undefined);

        const creatorValue = artist ?? creator;

        if (creatorValue) {
          partial.creator = { value: creatorValue, confidence: 0.7 };
          found = true;
        }
        if (imageDescription) {
          partial.description = { value: imageDescription, confidence: 0.5 };
          found = true;
        }
        if (copyright) {
          partial.license = { value: copyright, confidence: 0.5 };
          found = true;
        }

        if (found) break;
      }

      return partial;
    },
  };
}
