/**
 * Brand alias canonicalisation — V2-007b T_B5c.
 *
 * Loads the optional `seed/brand-aliases.json` file at the seed root, and
 * applies its alias map to brand strings flowing through the seed importers
 * (T_B5a SpoolmanDB + T_B5b resin). Lookup order:
 *
 *   1. Trim input.
 *   2. Exact match in `aliases` → return mapped value.
 *   3. Case-insensitive match (lookup against lowercased keys) → mapped value.
 *   4. No match → return input as-is (preserves user-supplied spellings).
 *
 * Loading is lazy: a missing `brand-aliases.json` file returns
 * `{ aliases: {} }` (no normalization happens). This keeps the importers
 * working in a fresh checkout where the alias file hasn't been committed yet.
 *
 * The file shape is intentionally tiny — a single `aliases` map plus an
 * optional `_note` for human readers (the loader ignores anything else in
 * the JSON object).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { logger } from '../logger';

export interface BrandAliases {
  aliases: Record<string, string>;
}

/**
 * Load and parse `brand-aliases.json` from the given seed root directory.
 * Returns an empty alias map when the file is missing or unreadable; logs +
 * returns empty when the file is malformed JSON.
 *
 * `seedDir` is the seed root (e.g. `apps/server/seed`), NOT a per-kind
 * subdirectory. This matches the convention that the file is shared across
 * filament + resin importers.
 */
export async function loadBrandAliases(seedDir: string): Promise<BrandAliases> {
  const filePath = path.join(seedDir, 'brand-aliases.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      // Missing file — totally fine, just return empty.
      return { aliases: {} };
    }
    logger.warn({ filePath, err }, 'brand-canonicalize: failed to read aliases file');
    return { aliases: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      { filePath, err: err instanceof Error ? err.message : String(err) },
      'brand-canonicalize: failed to parse aliases file as JSON',
    );
    return { aliases: {} };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    logger.warn({ filePath }, 'brand-canonicalize: aliases file is not an object');
    return { aliases: {} };
  }
  const obj = parsed as Record<string, unknown>;
  const aliases = obj.aliases;
  if (typeof aliases !== 'object' || aliases === null) {
    logger.warn({ filePath }, 'brand-canonicalize: aliases.aliases is not an object');
    return { aliases: {} };
  }
  // Coerce values to strings; log + drop non-string entries.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(aliases as Record<string, unknown>)) {
    if (typeof k !== 'string' || typeof v !== 'string') {
      logger.warn({ filePath, key: k }, 'brand-canonicalize: non-string alias entry; skipping');
      continue;
    }
    out[k] = v;
  }
  return { aliases: out };
}

/**
 * Canonicalise a brand string against the loaded alias map.
 *
 * Returns the trimmed input unchanged when no match; otherwise returns the
 * mapped value. Case-insensitive fallback uses the lowercased keys of the map.
 *
 * Pure (no I/O). Safe to call in tight loops.
 */
export function canonicalizeBrand(input: string, aliases: BrandAliases): string {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (trimmed.length === 0) return trimmed;

  // Exact match.
  const map = aliases.aliases;
  if (Object.prototype.hasOwnProperty.call(map, trimmed)) {
    return map[trimmed]!;
  }

  // Case-insensitive — build a lowercased lookup once. Cheap enough per call
  // for our seed sizes (well under 100 entries); if this ever becomes hot we
  // can cache by `aliases` identity.
  const lower = trimmed.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }

  return trimmed;
}
