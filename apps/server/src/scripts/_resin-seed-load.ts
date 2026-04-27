/**
 * Resin seed file loader — V2-007b T_B5b.
 *
 * Reads all `*.json` brand files in `apps/server/seed/resins/` (or any
 * caller-provided directory) and returns parsed `ResinSeedFile` objects in
 * a deterministic, alphabetical order. Files starting with `_` (e.g.
 * `_index.json`) are skipped — reserved for non-product metadata.
 *
 * The loader is JSON-shape agnostic on purpose: shape validation is the
 * transform's job (resin-seed-transform.ts). The loader just hands back
 * `unknown`-typed payloads cast to `ResinSeedFile`. Bad shapes flow
 * through to the transform, which logs + drops per product.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { logger } from '../logger';
import type { ResinSeedFile } from './_resin-seed-transform';

export interface LoadedResinSeedFile {
  /** Filename stem (no extension), e.g. "anycubic". Used for --brand filter. */
  stem: string;
  /** Absolute file path on disk. */
  filePath: string;
  /** Parsed JSON body. Shape NOT validated here. */
  file: ResinSeedFile;
}

/**
 * Load and parse all brand seed files in `seedDir`.
 *
 * - Skips files whose basename starts with `_` (reserved).
 * - Skips files that aren't `*.json`.
 * - Throws on directory-not-found (caller's responsibility to surface).
 * - Logs (warn) + skips files that fail to parse.
 */
export async function loadResinSeedFiles(
  seedDir: string,
): Promise<LoadedResinSeedFile[]> {
  const entries = await fs.readdir(seedDir, { withFileTypes: true });
  const candidates = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .filter((name) => !name.startsWith('_'))
    .sort((a, b) => a.localeCompare(b));

  const out: LoadedResinSeedFile[] = [];
  for (const name of candidates) {
    const filePath = path.join(seedDir, name);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      logger.warn({ filePath, err }, 'resin-seed-load: failed to read file; skipping');
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn(
        { filePath, err: err instanceof Error ? err.message : String(err) },
        'resin-seed-load: failed to parse JSON; skipping file',
      );
      continue;
    }
    const stem = name.replace(/\.json$/i, '');
    out.push({ stem, filePath, file: parsed as ResinSeedFile });
  }
  return out;
}
