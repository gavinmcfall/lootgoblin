/**
 * Loot primary-format detection — V2-005a-T6
 *
 * Resolves the "what format is this Loot?" question that the
 * TargetCompatibilityMatrix needs. Used by:
 *   - GET /api/v1/forge/dispatch/compatibility (per-target verdict).
 *   - POST /api/v1/forge/dispatch (gate creation when band='unsupported').
 *
 * Detection rules (in order):
 *   1. If the Loot has any lootFiles, take the *first* one ordered by
 *      (createdAt asc, id asc) and use its `format` column. The schema
 *      doesn't yet expose a `loot.primary_file_id`; "first by ord" is the
 *      least-surprising fallback and matches V2-002 ingest behaviour
 *      (ingested files are appended in arrival order).
 *   2. If the lootFile's `format` column is empty/missing, derive from the
 *      `path` extension.
 *   3. If there are no lootFiles, return 'no-files'.
 *
 * Multiple files with conflicting formats: the API surface labels this
 * `'mixed-format'` so callers can decide whether to 422 or pick the first.
 * The dispatch compatibility route returns the FIRST file's format and
 * sets `mixedFormat: true` in the response so the UI can show a warning;
 * we deliberately do NOT 422 here because Loot-with-many-files is the
 * common case (e.g. an STL + the matching 3mf project + a plate gcode).
 */

import { and, asc, eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';

export interface LootFormatDetection {
  /** The chosen format (lowercased, no leading dot). */
  format: string;
  /** True if more than one file existed AND they had different formats. */
  mixedFormat: boolean;
  /** True if no files existed at all. format will be ''. */
  noFiles: boolean;
}

/** Lower-case + strip leading dot. Mirrors target-compatibility's normalizer. */
function normalize(format: string): string {
  return format.replace(/^\./, '').toLowerCase();
}

/** Derive a format from a path extension. Returns '' if the path has none. */
function formatFromPath(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot === path.length - 1) return '';
  return normalize(path.slice(dot + 1));
}

/**
 * Look up the primary-format detection for a Loot. Caller is responsible
 * for ownership checks; this function only reads.
 */
export async function detectLootPrimaryFormat(
  lootId: string,
  opts?: { dbUrl?: string },
): Promise<LootFormatDetection> {
  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select({
      id: schema.lootFiles.id,
      format: schema.lootFiles.format,
      path: schema.lootFiles.path,
      createdAt: schema.lootFiles.createdAt,
    })
    .from(schema.lootFiles)
    .where(eq(schema.lootFiles.lootId, lootId))
    .orderBy(asc(schema.lootFiles.createdAt), asc(schema.lootFiles.id));

  if (rows.length === 0) {
    return { format: '', mixedFormat: false, noFiles: true };
  }

  const formats = new Set<string>();
  let primary = '';
  for (const r of rows) {
    const fmt = r.format ? normalize(r.format) : formatFromPath(r.path);
    if (!fmt) continue;
    if (!primary) primary = fmt;
    formats.add(fmt);
  }

  // No file had a recognisable extension and no format column was set.
  if (!primary) {
    return { format: '', mixedFormat: false, noFiles: false };
  }
  return {
    format: primary,
    mixedFormat: formats.size > 1,
    noFiles: false,
  };
}

/**
 * Returns the lootId IF the loot exists AND the supplied owner owns it
 * (via collection.ownerId). Returns null on cross-owner / not-found, so
 * callers can collapse both into 404 without leaking existence.
 */
export async function getLootForOwner(
  lootId: string,
  ownerId: string,
  opts?: { dbUrl?: string },
): Promise<{ id: string } | null> {
  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select({ id: schema.loot.id })
    .from(schema.loot)
    .innerJoin(schema.collections, eq(schema.loot.collectionId, schema.collections.id))
    .where(and(eq(schema.loot.id, lootId), eq(schema.collections.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}
