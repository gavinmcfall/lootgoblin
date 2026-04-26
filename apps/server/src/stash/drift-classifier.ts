/**
 * drift-classifier.ts — Pure drift classifier for reconciliation — V2-002-T5
 *
 * Compares a filesystem snapshot against a DB snapshot for a single stash root
 * and emits a list of drift verdicts per path. Idempotent, deterministic, no I/O.
 *
 * Algorithm:
 *   1. Build Map<path, DbLootFileEntry> from DB input.
 *   2. For each FS entry:
 *      - Not in DB map → 'added-externally'.
 *      - In DB map + no FS hash → 'matched' (can't detect content drift).
 *      - In DB map + FS hash == DB hash → 'matched'.
 *      - In DB map + FS hash != DB hash → 'content-changed'.
 *   3. For each DB entry whose path is NOT in FS → 'removed-externally'.
 *
 * Results are sorted lexicographically by path for deterministic output.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FsEntry = {
  /** Path relative to stash root. Forward slashes. */
  path: string;
  size: number;
  /**
   * Optional — caller may omit if hash computation is expensive.
   * Classifier treats absent hash as "can't detect content drift"
   * and emits 'matched' instead of 'content-changed'.
   */
  hash?: string;
  mtime: Date;
};

export type DbLootFileEntry = {
  lootFileId: string;
  lootId: string;
  /** Path relative to stash root. Forward slashes. */
  path: string;
  size: number;
  /** Required — DB always has a hash (sha256 hex). */
  hash: string;
};

export type DriftVerdict =
  | { kind: 'matched'; path: string; lootFileId: string }
  | { kind: 'added-externally'; path: string; fsEntry: FsEntry }
  | { kind: 'removed-externally'; path: string; lootFileId: string; lootId: string }
  | {
      kind: 'content-changed';
      path: string;
      lootFileId: string;
      lootId: string;
      fsEntry: FsEntry;
      dbHash: string;
    };

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify drift between a filesystem snapshot and a DB snapshot for one
 * stash root. Returns verdicts sorted lexicographically by path.
 *
 * @param fs  - Current filesystem entries under the stash root.
 * @param db  - Current DB lootFile entries for the stash root.
 * @returns   - Array of DriftVerdict, sorted by path.
 */
export function classifyDrift(fs: FsEntry[], db: DbLootFileEntry[]): DriftVerdict[] {
  // Build O(1) path lookup for DB entries.
  const dbMap = new Map<string, DbLootFileEntry>();
  for (const entry of db) {
    dbMap.set(entry.path, entry);
  }

  // Track which DB paths were matched by FS entries so we can find orphans.
  const matchedDbPaths = new Set<string>();

  const verdicts: DriftVerdict[] = [];

  for (const fsEntry of fs) {
    const dbEntry = dbMap.get(fsEntry.path);

    if (dbEntry === undefined) {
      // Path exists on FS but not in DB → added externally.
      verdicts.push({ kind: 'added-externally', path: fsEntry.path, fsEntry });
    } else {
      matchedDbPaths.add(fsEntry.path);

      if (fsEntry.hash === undefined) {
        // Caller didn't compute hash — can't detect content drift; treat as matched.
        verdicts.push({ kind: 'matched', path: fsEntry.path, lootFileId: dbEntry.lootFileId });
      } else if (fsEntry.hash === dbEntry.hash) {
        verdicts.push({ kind: 'matched', path: fsEntry.path, lootFileId: dbEntry.lootFileId });
      } else {
        verdicts.push({
          kind: 'content-changed',
          path: fsEntry.path,
          lootFileId: dbEntry.lootFileId,
          lootId: dbEntry.lootId,
          fsEntry,
          dbHash: dbEntry.hash,
        });
      }
    }
  }

  // DB entries whose path never appeared in FS → removed externally.
  for (const [path, dbEntry] of dbMap) {
    if (!matchedDbPaths.has(path)) {
      verdicts.push({
        kind: 'removed-externally',
        path,
        lootFileId: dbEntry.lootFileId,
        lootId: dbEntry.lootId,
      });
    }
  }

  // Sort lexicographically by path for deterministic output.
  verdicts.sort((a, b) => a.path.localeCompare(b.path));

  return verdicts;
}
