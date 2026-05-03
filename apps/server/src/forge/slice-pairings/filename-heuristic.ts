/**
 * V2-005e-T_e3: Filename-similarity matcher (Tier 2 of three-tier match).
 *
 * After sidecar parsing fails (Tier 1), we strip common slicer-suffix
 * patterns from the slice basename, then run Dice's bigram coefficient
 * against every owner Loot title (also stripped). A confidence
 * >= HEURISTIC_THRESHOLD (0.7) wins; ties go to the highest score, exact
 * post-strip equality short-circuits to confidence 1.0.
 *
 * Strip patterns model real-world slicer output names:
 *   cube_PLA_0.2mm.gcode                     -> cube
 *   cube_2color_4h32m_PLA-PETG.gcode         -> cube
 *   cube_(plate1).gcode                      -> cube
 *   cube_AMS3_PETG.gcode                     -> cube
 *
 * Owner-scoped: the matcher only considers Loot rows whose collection.ownerId
 * equals the inbox owner (cross-owner accidental matches are blocked at the
 * SQL boundary). Slice rows themselves (parent_loot_id IS NOT NULL) are
 * excluded from the candidate pool — we want SOURCE Loot only.
 */

import * as path from 'node:path';
import { and, eq, isNull, ne } from 'drizzle-orm';

import { getServerDb, schema } from '../../db/client';
import { diceCoefficient } from './string-similarity';

/**
 * Slicer suffix patterns. Each pattern is anchored with `(?=_|$)` so that
 * a match terminates at an underscore boundary OR end-of-string — JS `\b`
 * does NOT work after a word char followed by `_` (because `_` is a JS
 * word character). Multi-material combos run FIRST so single-material
 * stripping doesn't carve out the leading half of a hyphenated combo.
 *
 * Exposed for unit testing.
 */
const SUFFIX_END = '(?=_|$)';
function suffixRegex(body: string): RegExp {
  return new RegExp(`_${body}${SUFFIX_END}`, 'gi');
}
export const SUFFIX_PATTERNS: readonly RegExp[] = [
  // Multi-material hyphenated combos FIRST: PLA-PETG, PLA-TPU, etc.
  suffixRegex('(?:PLA|PETG|ABS|TPU|PA|ASA|HIPS)-(?:PLA|PETG|ABS|TPU|PA|ASA|HIPS)'),
  // Single materials with optional `[A-Z]+` extension (PLA-CF, PETG-HF) +
  // optional layer-height suffix.
  suffixRegex('PLA[A-Z]*(?:_\\d+(?:\\.\\d+)?mm)?'),
  suffixRegex('PETG[A-Z]*(?:_\\d+(?:\\.\\d+)?mm)?'),
  suffixRegex('ABS[A-Z]*(?:_\\d+(?:\\.\\d+)?mm)?'),
  suffixRegex('TPU[A-Z]*(?:_\\d+(?:\\.\\d+)?mm)?'),
  // PA must require AT LEAST ONE follow-on letter (PA12, PAHT, PA-CF) so
  // the regex doesn't false-match `_plate2` (which begins with `_pla`).
  suffixRegex('PA[A-Z]+(?:_\\d+(?:\\.\\d+)?mm)?'),
  suffixRegex('ASA[A-Z]*(?:_\\d+(?:\\.\\d+)?mm)?'),
  suffixRegex('HIPS[A-Z]*(?:_\\d+(?:\\.\\d+)?mm)?'),
  // Bambu/Orca color count: 2color, 16color, color.
  suffixRegex('(?:\\d{1,2})?color'),
  // Bambu AMS slot identifier: AMS, AMS1, AMS2, AMS3.
  suffixRegex('AMS\\d?'),
  // Print-time annotation: 4h32m, 12h, 45m. The full h/m form first so it
  // wins over the half-pattern alternatives.
  suffixRegex('\\d{1,3}h\\d{1,2}m'),
  suffixRegex('\\d{1,3}h'),
  suffixRegex('\\d{1,3}m'),
  // Plate annotations: _(plate1), _plate1, _plate_2.
  /_\(plate\d+\)/gi,
  suffixRegex('plate_?\\d+'),
  // Generic parenthetical tag at end: _(any).
  /_\([\w-]+\)/g,
  // Layer-height alone: _0.2mm, _0.16mm.
  suffixRegex('\\d+(?:\\.\\d+)?mm'),
];

/**
 * Strip slicer suffixes + extension, collapse repeated underscores, drop
 * leading/trailing underscores, lowercase. The result is a comparison key
 * that survives different slicer-output naming variations.
 */
export function stripSlicerSuffixes(basename: string): string {
  // Drop extension (handles .gcode, .bgcode, .ctb, .gcode.3mf, etc.).
  let result = basename;
  if (result.toLowerCase().endsWith('.gcode.3mf')) {
    result = result.slice(0, -'.gcode.3mf'.length);
  } else {
    result = path.parse(result).name;
  }
  for (const pat of SUFFIX_PATTERNS) {
    result = result.replace(pat, '');
  }
  return result
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export interface HeuristicMatch {
  lootId: string;
  confidence: number;
  matchedTitle: string;
}

/** Confidence threshold for filename-heuristic match. */
export const HEURISTIC_THRESHOLD = 0.7;

export interface HeuristicArgs {
  ownerId: string;
  sliceBasename: string;
  /**
   * Optional Loot id to exclude from the candidate set. Used when the
   * matcher has already inserted the slice itself (parent_loot_id IS NULL
   * at that moment) to prevent the slice from matching its own title.
   */
  excludeLootId?: string;
}

export interface HeuristicOpts {
  dbUrl?: string;
}

/**
 * Returns the best Loot candidate for the given slice basename, or null
 * if no candidate clears HEURISTIC_THRESHOLD. Owner-scoped via
 * collection.ownerId; slice rows (parent_loot_id IS NOT NULL) are excluded.
 *
 * Implementation note: the candidate set is loaded into memory and scored
 * in a single pass. This is fine for v2 scale (typical libraries < a few
 * thousand source Loot rows); a future carry-forward could add an FTS5-
 * based pre-filter if libraries grow into the tens-of-thousands.
 */
export async function heuristicMatchForSlice(
  args: HeuristicArgs,
  opts: HeuristicOpts = {},
): Promise<HeuristicMatch | null> {
  const stripped = stripSlicerSuffixes(args.sliceBasename);
  if (stripped.length < 3) return null;

  const db = getServerDb(opts.dbUrl);
  const whereClauses = [
    eq(schema.collections.ownerId, args.ownerId),
    isNull(schema.loot.parentLootId),
  ];
  if (args.excludeLootId) {
    whereClauses.push(ne(schema.loot.id, args.excludeLootId));
  }
  const candidates = await db
    .select({
      id: schema.loot.id,
      title: schema.loot.title,
    })
    .from(schema.loot)
    .innerJoin(
      schema.collections,
      eq(schema.loot.collectionId, schema.collections.id),
    )
    .where(and(...whereClauses));

  let best: HeuristicMatch | null = null;
  for (const c of candidates) {
    const cStripped = stripSlicerSuffixes(c.title);
    if (cStripped.length < 2) continue;
    if (cStripped === stripped) {
      return { lootId: c.id, confidence: 1.0, matchedTitle: c.title };
    }
    const ratio = diceCoefficient(stripped, cStripped);
    if (ratio >= HEURISTIC_THRESHOLD && (!best || ratio > best.confidence)) {
      best = { lootId: c.id, confidence: ratio, matchedTitle: c.title };
    }
  }
  return best;
}
