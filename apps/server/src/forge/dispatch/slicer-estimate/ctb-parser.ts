/**
 * ctb-parser.ts — V2-005f-T_dcf2
 *
 * Parse the CTB resin-printer binary header to extract the slicer-estimated
 * resin volume, used by Phrozen / Uniformation / Elegoo (legacy) printers.
 *
 * Header layout (unencrypted CTB v3, per ChiTuBox file-receiver
 * reverse-engineering):
 *   offset 0x00  uint32 LE  magic = 0x12FD0019
 *   offset 0x04  uint32 LE  version
 *   ...
 *   offset 0x84  float32 LE resin_volume_ml
 *
 * Encrypted CTB v4 (`magic = 0x12FD90C1`) has a different layout — full
 * decryption is V2-005f-CF-7 and intentionally NOT attempted here.
 *
 * Resin printers are single-material per print (no multi-slot AMS), so the
 * output always has a single `slot_index=0` slot.
 *
 * Density assumption: photopolymer resins typically range 1.05–1.15 g/ml.
 * We use 1.1 g/ml as a default. Real values vary by formulation; this is a
 * planning estimate, not an exact measurement.
 *
 * No print-time field is reliably extractable from the header in the early
 * bytes — `slicer_estimate_print_time_min` is left undefined.
 *
 * NEVER throws. Returns null for: encrypted CTB, unknown magic, file
 * shorter than the header, or out-of-range volume.
 */

import * as fs from 'node:fs/promises';
import type { SlicerEstimate } from './types';

const HEADER_BYTES = 256;
const MAGIC_UNENCRYPTED_V3 = 0x12fd0019;
const MAGIC_ENCRYPTED_V4 = 0x12fd90c1;
const RESIN_VOLUME_OFFSET = 0x84;
const RESIN_DENSITY_G_PER_ML = 1.1;
const MAX_REASONABLE_VOLUME_ML = 1000;

/**
 * Parse a CTB resin print file and return its slicer estimate.
 *
 * @param filePath absolute path to a `.ctb` / `.cbddlp` / `.jxs` file
 * @returns SlicerEstimate with one slot, or null if the file isn't a
 *          parseable unencrypted CTB.
 */
export async function parseCtbFile(filePath: string): Promise<SlicerEstimate | null> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(filePath, 'r');
    const stat = await fh.stat();
    if (stat.size < HEADER_BYTES) return null;

    const buf = Buffer.alloc(HEADER_BYTES);
    await fh.read(buf, 0, HEADER_BYTES, 0);

    const magic = buf.readUInt32LE(0);
    if (magic === MAGIC_ENCRYPTED_V4) {
      // Encrypted CTB v4 — V2-005f-CF-7 carry-forward. Don't attempt.
      return null;
    }
    if (magic !== MAGIC_UNENCRYPTED_V3) {
      return null;
    }

    const volume_ml = buf.readFloatLE(RESIN_VOLUME_OFFSET);
    if (!Number.isFinite(volume_ml) || volume_ml <= 0 || volume_ml > MAX_REASONABLE_VOLUME_ML) {
      return null;
    }

    const grams = volume_ml * RESIN_DENSITY_G_PER_ML;

    return {
      slots: [
        {
          slot_index: 0,
          estimated_grams: grams,
          estimated_volume_ml: volume_ml,
        },
      ],
      total_grams: grams,
    };
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
