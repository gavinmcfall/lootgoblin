/**
 * indexer.ts — FTS5 search index + thumbnail sidecar pipeline — V2-002-T11
 *
 * Keeps two secondary data structures in sync with the Loot table:
 *
 *   1. loot_fts (FTS5 virtual table) — full-text search over title, creator,
 *      description, tags, and file formats. Updated synchronously on every
 *      indexLoot() / removeLoot() call.
 *
 *   2. loot_thumbnails (regular table) — tracks thumbnail generation state.
 *      Thumbnail generation is fire-and-forget (background Promise); callers
 *      do not need to await it.
 *
 * Thumbnail fast-path: if the primary lootFile is a .3mf containing
 * Metadata/thumbnail.png, the embedded PNG is extracted directly (no F3D
 * subprocess needed).
 *
 * Thumbnail slow-path: F3D CLI subprocess. If F3D is not installed, the
 * thumbnail status is set to 'failed' with error = 'f3d-not-found'; the Loot
 * remains fully searchable via the FTS index.
 *
 * Drizzle FTS5 note: Drizzle's sqlite-core doesn't model VIRTUAL TABLEs.
 * All loot_fts access uses raw `db.all(sql\`...\`)` / `db.run(sql\`...\`)`.
 *
 * ---------------------------------------------------------------------------
 * DB invariant: stale thumbnail_path on failed retries (by design)
 * ---------------------------------------------------------------------------
 *
 * When a previously-successful thumbnail's regeneration fails (e.g. a retry
 * after the underlying file changed), we intentionally PRESERVE the existing
 * thumbnail PNG on disk — it is still a usable image. However, the loot_thumbnails
 * row updates status='failed' and leaves `thumbnail_path` NON-NULL (pointing at
 * the previously-successful file).
 *
 * Consequence: `thumbnail_path IS NOT NULL` does NOT imply `status = 'ok'`.
 * Consumers wanting only usable thumbnails MUST filter `WHERE status = 'ok'`.
 *
 * Rationale: the physical file is the truth; the DB tracks the most recent
 * generation *outcome*. We document the stale pointer rather than destroy a
 * working image on retry failure.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { sql } from 'drizzle-orm';
import JSZip from 'jszip';
import { logger } from '../logger';
import { getDb, schema } from '../db/client';
import { eq, asc } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ThumbnailStatus = 'pending' | 'ok' | 'failed';
export type ThumbnailSource = 'f3d-cli' | '3mf-embedded';

export type ThumbnailResult =
  | { status: 'ok'; path: string; source: ThumbnailSource }
  | { status: 'failed'; error: string };

export type IndexerOptions = {
  /**
   * Database URL. Defaults to process.env.DATABASE_URL.
   */
  dbUrl?: string;

  /**
   * Path to F3D CLI executable. Default: 'f3d' (resolved from PATH).
   */
  f3dPath?: string;

  /**
   * Seconds to wait for F3D before SIGKILL. Default: 30.
   */
  f3dTimeoutSec?: number;

  /**
   * Thumbnail dimensions in pixels (square). Default: 512.
   */
  thumbnailSize?: number;

  /**
   * Injection seam for the F3D runner. Defaults to the real subprocess runner.
   * Tests supply a stub here.
   */
  f3dRunner?: (args: {
    source: string;
    destination: string;
    size: number;
    timeoutSec: number;
  }) => Promise<ThumbnailResult>;
};

// ---------------------------------------------------------------------------
// IndexerEngine interface
// ---------------------------------------------------------------------------

export interface IndexerEngine {
  /** Re-index a Loot's FTS row and schedule thumbnail regen. Idempotent. */
  indexLoot(lootId: string): Promise<void>;

  /** Remove a Loot from FTS and delete its thumbnail sidecar. Idempotent. */
  removeLoot(lootId: string): Promise<void>;

  /**
   * Full-table FTS rebuild from current loot state. Use after bulk structural
   * changes or schema migration.
   */
  rebuildFts(): Promise<{ indexed: number }>;

  /**
   * Query FTS5 for matching Loot ids, ordered by rank.
   * Returns an empty array for queries that match nothing.
   */
  search(query: string, options?: { limit?: number; offset?: number }): Promise<string[]>;

  /**
   * Force-regenerate thumbnail for a specific Loot. Bypasses the idempotency
   * check — always runs generation even if status is already 'ok'.
   */
  regenerateThumbnail(lootId: string): Promise<ThumbnailResult>;
}

// ---------------------------------------------------------------------------
// Internal helpers — FTS row building
// ---------------------------------------------------------------------------

/**
 * Build the FTS columns for a loot + its files.
 * Exported for unit testing.
 */
export function buildFtsRow(
  lootRow: {
    id: string;
    title: string;
    creator: string | null;
    description: string | null;
    tags: string[] | null;
  },
  lootFileRows: { format: string }[],
): {
  loot_id: string;
  title: string;
  creator: string;
  description: string;
  tags: string;
  formats: string;
} {
  const tags = (lootRow.tags ?? []).join(' ');
  const formats = [...new Set(lootFileRows.map((f) => f.format.toLowerCase()))].join(' ');
  return {
    loot_id: lootRow.id,
    title: lootRow.title,
    creator: lootRow.creator ?? '',
    description: lootRow.description ?? '',
    tags,
    formats,
  };
}

// ---------------------------------------------------------------------------
// Default F3D runner (real subprocess)
// ---------------------------------------------------------------------------

function defaultF3dRunner(f3dPath: string) {
  return async (args: {
    source: string;
    destination: string;
    size: number;
    timeoutSec: number;
  }): Promise<ThumbnailResult> => {
    const { source, destination, size, timeoutSec } = args;
    const cliArgs = [
      '--output', destination,
      '--resolution', `${size}x${size}`,
      '--no-background',
      source,
    ];

    // Timeout implemented via AbortController for consistency with the rest
    // of the codebase (and to make the "user cancelled" extension point
    // obvious — a future caller could pass an external AbortSignal here).
    const abortCtrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abortCtrl.abort();
    }, timeoutSec * 1000);

    return new Promise((resolve) => {
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(f3dPath, cliArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          signal: abortCtrl.signal,
        });
      } catch (err: unknown) {
        clearTimeout(timer);
        // ENOENT = f3d not found on PATH
        const code = (err as NodeJS.ErrnoException).code;
        resolve({
          status: 'failed',
          error: code === 'ENOENT' ? 'f3d-not-found' : `f3d-spawn-error: ${String(err)}`,
        });
        return;
      }

      const stderrChunks: Buffer[] = [];
      proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      proc.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ status: 'failed', error: 'f3d-timeout' });
          return;
        }
        // AbortController.abort() raises ERR_ABORT_ERR via the 'error' event;
        // if it fires without timedOut set, it was an external abort (future
        // extension point) — surface it as a cancellation.
        if (err.name === 'AbortError') {
          resolve({ status: 'failed', error: 'f3d-aborted' });
          return;
        }
        const code = err.code;
        resolve({
          status: 'failed',
          error: code === 'ENOENT' ? 'f3d-not-found' : `f3d-error: ${err.message}`,
        });
      });

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ status: 'failed', error: 'f3d-timeout' });
          return;
        }
        if (exitCode === 0) {
          resolve({ status: 'ok', path: destination, source: 'f3d-cli' });
        } else {
          const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 200).trim();
          resolve({ status: 'failed', error: stderr || `f3d-exit-${exitCode}` });
        }
      });
    });
  };
}

// ---------------------------------------------------------------------------
// 3MF embedded thumbnail extractor
// ---------------------------------------------------------------------------

/**
 * Attempt to extract an embedded thumbnail from a 3MF archive.
 * Returns the raw PNG buffer if found; null otherwise.
 */
async function extract3mfThumbnail(source: string): Promise<Buffer | null> {
  let fileBuffer: Buffer;
  try {
    fileBuffer = await fs.readFile(source);
  } catch {
    return null;
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fileBuffer);
  } catch {
    return null;
  }

  // Spec-standard path: Metadata/thumbnail.png
  // Also try case-insensitive match for non-conforming producers.
  const THUMBNAIL_PATH = 'Metadata/thumbnail.png';
  let thumbnailFile = zip.file(THUMBNAIL_PATH);
  if (thumbnailFile === null) {
    const lookupName = THUMBNAIL_PATH.toLowerCase();
    const match = Object.keys(zip.files).find((name) => name.toLowerCase() === lookupName);
    thumbnailFile = match ? zip.file(match) : null;
  }
  if (thumbnailFile === null) return null;

  try {
    const raw = await thumbnailFile.async('nodebuffer');
    return Buffer.from(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createIndexerEngine(options?: IndexerOptions): IndexerEngine {
  const dbUrl = options?.dbUrl ?? process.env.DATABASE_URL;
  const f3dPath = options?.f3dPath ?? 'f3d';
  const f3dTimeoutSec = options?.f3dTimeoutSec ?? 30;
  const thumbnailSize = options?.thumbnailSize ?? 512;
  const runner = options?.f3dRunner ?? defaultF3dRunner(f3dPath);

  function db() {
    return getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
  }

  // -------------------------------------------------------------------------
  // Internal: ensure loot_thumbnails row exists (pending) for a loot.
  // -------------------------------------------------------------------------
  async function ensureThumbnailRow(lootId: string): Promise<void> {
    const now = Date.now();
    // INSERT OR IGNORE — no-op if row already exists.
    db().run(
      sql`INSERT OR IGNORE INTO loot_thumbnails (loot_id, status, updated_at)
          VALUES (${lootId}, 'pending', ${now})`,
    );
  }

  // -------------------------------------------------------------------------
  // Internal: build + upsert FTS row for a loot.
  // -------------------------------------------------------------------------
  async function upsertFtsRow(lootId: string): Promise<void> {
    // Fetch loot row.
    const lootRows = await db()
      .select({
        id: schema.loot.id,
        title: schema.loot.title,
        creator: schema.loot.creator,
        description: schema.loot.description,
        tags: schema.loot.tags,
        collectionId: schema.loot.collectionId,
      })
      .from(schema.loot)
      .where(eq(schema.loot.id, lootId))
      .limit(1);

    if (lootRows.length === 0) {
      logger.debug({ lootId }, 'indexer: loot not found, skipping FTS upsert');
      return;
    }

    const lootRow = lootRows[0]!;

    // Fetch files for format set.
    const fileRows = await db()
      .select({ format: schema.lootFiles.format })
      .from(schema.lootFiles)
      .where(eq(schema.lootFiles.lootId, lootId));

    const row = buildFtsRow(lootRow, fileRows);

    // FTS5 doesn't support UPSERT — delete-then-insert.
    db().run(sql`DELETE FROM loot_fts WHERE loot_id = ${lootId}`);
    db().run(
      sql`INSERT INTO loot_fts (loot_id, title, creator, description, tags, formats)
          VALUES (${row.loot_id}, ${row.title}, ${row.creator}, ${row.description}, ${row.tags}, ${row.formats})`,
    );
  }

  // -------------------------------------------------------------------------
  // indexLoot
  // -------------------------------------------------------------------------
  async function indexLoot(lootId: string): Promise<void> {
    await upsertFtsRow(lootId);
    await ensureThumbnailRow(lootId);
    // Fire-and-forget thumbnail regen.
    void regenerateThumbnail(lootId).catch((err) => {
      logger.warn({ lootId, err }, 'indexer: background thumbnail regen failed');
    });
  }

  // -------------------------------------------------------------------------
  // Internal: resolve the absolute stash root path for a given Loot.
  // Walks loot → collection → stashRoot. Returns null if any row is missing
  // (e.g. loot was deleted or collection was reassigned).
  // -------------------------------------------------------------------------
  async function resolveStashRootPathForLoot(lootId: string): Promise<string | null> {
    const lootRows = await db()
      .select({ collectionId: schema.loot.collectionId })
      .from(schema.loot)
      .where(eq(schema.loot.id, lootId))
      .limit(1);
    if (lootRows.length === 0) return null;

    const collectionRows = await db()
      .select({ stashRootId: schema.collections.stashRootId })
      .from(schema.collections)
      .where(eq(schema.collections.id, lootRows[0]!.collectionId))
      .limit(1);
    if (collectionRows.length === 0) return null;

    const stashRootRows = await db()
      .select({ path: schema.stashRoots.path })
      .from(schema.stashRoots)
      .where(eq(schema.stashRoots.id, collectionRows[0]!.stashRootId))
      .limit(1);
    if (stashRootRows.length === 0) return null;

    return stashRootRows[0]!.path;
  }

  // -------------------------------------------------------------------------
  // removeLoot
  //
  // Order-of-operations note: we resolve the stash root path via joins BEFORE
  // deleting the loot rows, because the loot row may already be deleted by
  // the caller in some flows (cascade has fired). If the loot is gone we
  // can't resolve its stash root — the thumbnail sidecar will leak. This is
  // logged (not silently ignored) so ops can clean up if it ever happens.
  // -------------------------------------------------------------------------
  async function removeLoot(lootId: string): Promise<void> {
    // 1. Find existing thumbnail relative-path for cleanup. thumbnail_path
    //    is stored RELATIVE to the stash root (e.g. 'thumbnails/abc-123.png')
    //    so we must resolve it to an absolute path before calling fs.unlink,
    //    otherwise Node resolves it against process.cwd() and the unlink
    //    fails with ENOENT — leaking the sidecar file on disk forever.
    const rows = db().all(
      sql`SELECT thumbnail_path FROM loot_thumbnails WHERE loot_id = ${lootId}`,
    ) as Array<{ thumbnail_path: string | null }>;
    const thumbnailRelativePath = rows[0]?.thumbnail_path ?? null;

    // 2. Resolve the stash root path (must happen BEFORE we delete the loot
    //    row below; a later delete + cascade would remove the collection FK
    //    lookup target).
    const stashRootPath = thumbnailRelativePath
      ? await resolveStashRootPathForLoot(lootId)
      : null;

    // 3. Remove from FTS.
    db().run(sql`DELETE FROM loot_fts WHERE loot_id = ${lootId}`);

    // 4. Delete thumbnail sidecar file (best-effort).
    if (thumbnailRelativePath) {
      if (stashRootPath) {
        const absolutePath = path.isAbsolute(thumbnailRelativePath)
          ? thumbnailRelativePath
          : path.join(stashRootPath, thumbnailRelativePath);
        try {
          await fs.unlink(absolutePath);
        } catch (err) {
          logger.warn(
            { lootId, absolutePath, err },
            'indexer: failed to unlink thumbnail sidecar',
          );
        }
      } else {
        logger.warn(
          { lootId, thumbnailRelativePath },
          'indexer: cannot resolve stash root for thumbnail cleanup — sidecar will leak on disk',
        );
      }
    }

    // 5. Remove loot_thumbnails row.
    db().run(sql`DELETE FROM loot_thumbnails WHERE loot_id = ${lootId}`);
  }

  // -------------------------------------------------------------------------
  // rebuildFts
  // -------------------------------------------------------------------------
  async function rebuildFts(): Promise<{ indexed: number }> {
    // Purge entire FTS index.
    db().run(sql`DELETE FROM loot_fts`);

    // Fetch all loot rows in batches of 500.
    const BATCH_SIZE = 500;
    let offset = 0;
    let indexed = 0;

    while (true) {
      const batch = await db()
        .select({
          id: schema.loot.id,
          title: schema.loot.title,
          creator: schema.loot.creator,
          description: schema.loot.description,
          tags: schema.loot.tags,
          collectionId: schema.loot.collectionId,
        })
        .from(schema.loot)
        .orderBy(asc(schema.loot.id))
        .limit(BATCH_SIZE)
        .offset(offset);

      if (batch.length === 0) break;

      // Fetch all files for this batch of loots.
      const lootIds = batch.map((l) => l.id);
      const allFiles = await db()
        .select({ lootId: schema.lootFiles.lootId, format: schema.lootFiles.format })
        .from(schema.lootFiles)
        .where(sql`loot_id IN (${sql.join(lootIds.map((id) => sql`${id}`), sql`, `)})`);

      const filesByLoot = new Map<string, { format: string }[]>();
      for (const f of allFiles) {
        const arr = filesByLoot.get(f.lootId) ?? [];
        arr.push({ format: f.format });
        filesByLoot.set(f.lootId, arr);
      }

      for (const lootRow of batch) {
        const files = filesByLoot.get(lootRow.id) ?? [];
        const row = buildFtsRow(lootRow, files);
        db().run(
          sql`INSERT INTO loot_fts (loot_id, title, creator, description, tags, formats)
              VALUES (${row.loot_id}, ${row.title}, ${row.creator}, ${row.description}, ${row.tags}, ${row.formats})`,
        );
        indexed++;
      }

      if (batch.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }

    return { indexed };
  }

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------
  async function search(
    query: string,
    options?: { limit?: number; offset?: number },
  ): Promise<string[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const rows = db().all(
      sql`SELECT loot_id FROM loot_fts WHERE loot_fts MATCH ${query} ORDER BY rank LIMIT ${limit} OFFSET ${offset}`,
    ) as Array<{ loot_id: string }>;

    return rows.map((r) => r.loot_id);
  }

  // -------------------------------------------------------------------------
  // regenerateThumbnail
  // -------------------------------------------------------------------------
  async function regenerateThumbnail(lootId: string): Promise<ThumbnailResult> {
    const now = Date.now();

    // 1. Find the primary lootFile (first by id, stable ordering).
    const files = await db()
      .select({
        id: schema.lootFiles.id,
        path: schema.lootFiles.path,
        lootId: schema.lootFiles.lootId,
        format: schema.lootFiles.format,
      })
      .from(schema.lootFiles)
      .where(eq(schema.lootFiles.lootId, lootId))
      .orderBy(asc(schema.lootFiles.id))
      .limit(1);

    if (files.length === 0) {
      const result: ThumbnailResult = { status: 'failed', error: 'no-files' };
      const nowMs = Date.now();
      db().run(
        sql`INSERT INTO loot_thumbnails (loot_id, status, thumbnail_path, source_kind, error, updated_at)
            VALUES (${lootId}, 'failed', NULL, NULL, 'no-files', ${nowMs})
            ON CONFLICT(loot_id) DO UPDATE SET
              status = 'failed',
              thumbnail_path = NULL,
              source_kind = NULL,
              error = 'no-files',
              updated_at = ${nowMs}`,
      );
      return result;
    }

    const primaryFile = files[0]!;

    // 2. Resolve stash root path via loot → collection → stashRoot.
    const rootPath = await resolveStashRootPathForLoot(lootId);
    if (rootPath === null) {
      return { status: 'failed', error: 'no-stash-root' };
    }
    const absoluteSource = path.join(rootPath, primaryFile.path);
    const thumbnailsDir = path.join(rootPath, 'thumbnails');
    const thumbnailFilename = `${lootId}.png`;
    const absoluteDestination = path.join(thumbnailsDir, thumbnailFilename);
    const relativeDestination = path.join('thumbnails', thumbnailFilename);

    // Ensure thumbnails/ directory exists.
    try {
      await fs.mkdir(thumbnailsDir, { recursive: true });
    } catch {
      // Ignore — already exists.
    }

    // 3. Fast path: 3MF with embedded thumbnail.
    const ext = path.extname(primaryFile.path).toLowerCase();
    if (ext === '.3mf') {
      const pngBuffer = await extract3mfThumbnail(absoluteSource);
      if (pngBuffer !== null) {
        try {
          await fs.writeFile(absoluteDestination, pngBuffer);
          const successResult: ThumbnailResult = {
            status: 'ok',
            path: absoluteDestination,
            source: '3mf-embedded',
          };
          db().run(
            sql`INSERT INTO loot_thumbnails (loot_id, status, thumbnail_path, source_kind, error, generated_at, updated_at)
                VALUES (${lootId}, 'ok', ${relativeDestination}, '3mf-embedded', NULL, ${now}, ${now})
                ON CONFLICT(loot_id) DO UPDATE SET
                  status = 'ok',
                  thumbnail_path = ${relativeDestination},
                  source_kind = '3mf-embedded',
                  error = NULL,
                  generated_at = ${now},
                  updated_at = ${now}`,
          );
          return successResult;
        } catch (err) {
          logger.warn({ lootId, err }, 'indexer: failed to write 3mf embedded thumbnail');
          // Fall through to slow path.
        }
      }
    }

    // 4. Slow path: F3D CLI.
    let runnerResult: ThumbnailResult;
    try {
      runnerResult = await runner({
        source: absoluteSource,
        destination: absoluteDestination,
        size: thumbnailSize,
        timeoutSec: f3dTimeoutSec,
      });
    } catch (err) {
      runnerResult = { status: 'failed', error: `f3d-runner-threw: ${String(err)}` };
    }

    if (runnerResult.status === 'ok') {
      const nowMs = Date.now();
      const result: ThumbnailResult = {
        status: 'ok',
        path: absoluteDestination,
        source: 'f3d-cli',
      };
      db().run(
        sql`INSERT INTO loot_thumbnails (loot_id, status, thumbnail_path, source_kind, error, generated_at, updated_at)
            VALUES (${lootId}, 'ok', ${relativeDestination}, 'f3d-cli', NULL, ${nowMs}, ${nowMs})
            ON CONFLICT(loot_id) DO UPDATE SET
              status = 'ok',
              thumbnail_path = ${relativeDestination},
              source_kind = 'f3d-cli',
              error = NULL,
              generated_at = ${nowMs},
              updated_at = ${nowMs}`,
      );
      return result;
    }

    // Failure: do NOT delete an existing thumbnail file (non-destructive on
    // retry). The INSERT branch (first-ever failure for this loot) writes
    // thumbnail_path = NULL. The ON CONFLICT DO UPDATE branch intentionally
    // does NOT touch thumbnail_path — if a prior success left a non-null
    // pointer, we leave it alone so the file on disk remains discoverable.
    // This creates a documented invariant violation: status='failed' with
    // thumbnail_path!=NULL means "retry failed, previous thumbnail preserved".
    // Consumers MUST filter WHERE status='ok' if they want only usable
    // thumbnails. See module JSDoc for full rationale.
    const failureError = runnerResult.error;
    const nowMs = Date.now();
    db().run(
      sql`INSERT INTO loot_thumbnails (loot_id, status, thumbnail_path, source_kind, error, updated_at)
          VALUES (${lootId}, 'failed', NULL, NULL, ${failureError}, ${nowMs})
          ON CONFLICT(loot_id) DO UPDATE SET
            status = 'failed',
            source_kind = NULL,
            error = ${failureError},
            updated_at = ${nowMs}`,
    );
    return runnerResult;
  }

  return {
    indexLoot,
    removeLoot,
    rebuildFts,
    search,
    regenerateThumbnail,
  };
}
