/**
 * template-migration.ts — Template Migration engine for the Stash pillar.
 *
 * Given an existing Collection with a chosen pathTemplate, allow the user to
 * change the template. The engine computes a dry-run preview per Loot, the
 * user approves, the engine executes moves via T3's copy-then-cleanup, updates
 * DB references, and emits a Ledger event per completed move. Per-move failures
 * roll back that single move and continue with the rest.
 *
 * V2-002-T9 (Organization Flow Variant 4)
 */

import * as path from 'node:path';

import { logger } from '../logger';
import { getDb, schema } from '../db/client';
import { persistLedgerEvent } from './ledger';
import { eq, and, inArray } from 'drizzle-orm';

import {
  parseTemplate,
  validateTemplate,
  resolveTemplate,
  type ResolveVerdict,
} from './path-template';
import { linkOrCopy } from './filesystem-adapter';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MigrationVerdict =
  | { kind: 'unchanged'; lootId: string; lootFileId: string; path: string }
  | { kind: 'simple-move'; lootId: string; lootFileId: string; currentPath: string; proposedPath: string }
  | { kind: 'collision'; lootId: string; lootFileId: string; currentPath: string; proposedPath: string; conflictingLootIds: string[] }
  | { kind: 'template-incompatible'; lootId: string; lootFileId: string; currentPath: string; reason: 'missing-field' | 'empty-segment' }
  | { kind: 'os-incompatible'; lootId: string; lootFileId: string; currentPath: string; reason: 'forbidden-character' | 'reserved-name' | 'path-too-long' | 'segment-too-long' | 'unknown-transform' };

export type MigrationPreview = {
  collectionId: string;
  currentTemplate: string;
  proposedTemplate: string;
  verdicts: MigrationVerdict[];
  summary: {
    unchanged: number;
    simpleMove: number;
    collision: number;
    templateIncompatible: number;
    osIncompatible: number;
  };
};

export type MigrationPlan = {
  collectionId: string;
  proposedTemplate: string;
  /** Subset of verdicts the user approved for migration. Only 'simple-move' verdicts can be approved. */
  approvedVerdicts: Array<{ lootId: string; lootFileId: string }>;
};

export type MigrationReport = {
  collectionId: string;
  executedAt: Date;
  oldTemplate: string;
  newTemplate: string;
  filesMigrated: number;
  filesSkipped: Array<{ lootId: string; lootFileId: string; reason: string }>;
  filesFailed: Array<{ lootId: string; lootFileId: string; error: string }>;
};

export type LedgerEmitter = {
  emitMigration(event: {
    collectionId: string;
    lootId: string;
    lootFileId: string;
    oldPath: string;
    newPath: string;
    timestamp: Date;
  }): Promise<void>;
};

export type ReferenceUpdater = {
  /**
   * Stub for v2-002. Later plans (V2-004 Watchlist, V2-007 Grimoire, V2-007 Ledger)
   * will implement real reference-updating here. For now, just a no-op with a pino log
   * so we can see what WOULD have updated.
   */
  updatePathReferences(oldPath: string, newPath: string, lootId: string): Promise<void>;
};

export type TemplateMigrationOptions = {
  ledgerEmitter?: LedgerEmitter;        // default: no-op + pino log
  referenceUpdater?: ReferenceUpdater;  // default: no-op + pino log
  /** DATABASE_URL override (used in tests). */
  dbUrl?: string;
};

export interface TemplateMigrationEngine {
  preview(args: { collectionId: string; proposedTemplate: string }): Promise<MigrationPreview>;
  execute(plan: MigrationPlan): Promise<MigrationReport>;
}

// ---------------------------------------------------------------------------
// Default stubs
// ---------------------------------------------------------------------------

function createDefaultLedgerEmitter(dbUrl?: string): LedgerEmitter {
  return {
    async emitMigration(event) {
      try {
        await persistLedgerEvent(
          {
            kind: 'migration.execute',
            resourceType: 'loot',
            resourceId: event.lootId,
            payload: {
              lootFileId: event.lootFileId,
              collectionId: event.collectionId,
              oldPath: event.oldPath,
              newPath: event.newPath,
              timestamp: event.timestamp.toISOString(),
            },
          },
          dbUrl,
        );
      } catch (err) {
        // Defense-in-depth: persistLedgerEvent itself never throws, but guard anyway.
        logger.warn({ err, event }, 'template-migration: ledger persist wrapper caught — primary op unaffected');
      }
    },
  };
}

function createNoOpReferenceUpdater(): ReferenceUpdater {
  return {
    async updatePathReferences(oldPath, newPath, lootId) {
      logger.debug(
        { oldPath, newPath, lootId },
        'template-migration: reference updater stub — would update path references',
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Verdict classification helper (pure, exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Classify a single file's resolve verdict into a MigrationVerdict kind.
 *
 * This pure function does NOT perform collision detection — that requires
 * cross-file state and is handled in preview() after all single-file verdicts
 * are computed.
 *
 * @param lootId          The owning Loot row ID.
 * @param lootFileId      The LootFile row ID.
 * @param currentPath     Current relative path (from lootFiles.path).
 * @param resolveVerdict  The result of resolveTemplate() for the proposed template.
 * @param proposedPathWithExt  The proposed path with extension appended.
 * @returns A MigrationVerdict (kind will be one of: unchanged, simple-move,
 *          template-incompatible, os-incompatible). Collision is computed
 *          later in preview().
 */
export function classifyVerdict(
  lootId: string,
  lootFileId: string,
  currentPath: string,
  resolveVerdict: ResolveVerdict,
  proposedPathWithExt: string | null,
): Exclude<MigrationVerdict, { kind: 'collision' }> {
  if (!resolveVerdict.ok) {
    // resolveVerdict.reason is now narrowed to ResolveReason — no casts needed.
    const reason = resolveVerdict.reason;

    // template-incompatible reasons
    if (reason === 'missing-field' || reason === 'empty-segment') {
      return {
        kind: 'template-incompatible',
        lootId,
        lootFileId,
        currentPath,
        reason,
      };
    }

    // everything else → os-incompatible
    return {
      kind: 'os-incompatible',
      lootId,
      lootFileId,
      currentPath,
      reason,
    };
  }

  // Resolution succeeded
  if (proposedPathWithExt === null) {
    // Should not happen when ok: true, but guard defensively
    return { kind: 'unchanged', lootId, lootFileId, path: currentPath };
  }

  if (proposedPathWithExt === currentPath) {
    return { kind: 'unchanged', lootId, lootFileId, path: currentPath };
  }

  return {
    kind: 'simple-move',
    lootId,
    lootFileId,
    currentPath,
    proposedPath: proposedPathWithExt,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTemplateMigrationEngine(
  options: TemplateMigrationOptions = {},
): TemplateMigrationEngine {
  const ledgerEmitter = options.ledgerEmitter ?? createDefaultLedgerEmitter(options.dbUrl);
  const referenceUpdater = options.referenceUpdater ?? createNoOpReferenceUpdater();
  const dbUrl = options.dbUrl;

  type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

  function db(): DB {
    return getDb(dbUrl) as DB;
  }

  // ── preview ──────────────────────────────────────────────────────────────

  async function preview(args: {
    collectionId: string;
    proposedTemplate: string;
  }): Promise<MigrationPreview> {
    const { collectionId, proposedTemplate } = args;

    // Load Collection
    const collectionRows = await db()
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, collectionId));

    const collection = collectionRows[0];
    if (!collection) {
      throw new Error(`Collection "${collectionId}" not found`);
    }

    const currentTemplate = collection.pathTemplate;

    // Parse + validate proposed template — fail fast on global syntax errors
    let parsed: ReturnType<typeof parseTemplate>;
    try {
      parsed = parseTemplate(proposedTemplate);
    } catch (err) {
      throw new Error(
        `Invalid proposed template "${proposedTemplate}": ${(err as Error).message}`,
      );
    }

    // TODO: derive from stashRoot.platform when that column is added
    const staticValidation = validateTemplate(parsed, 'linux' as const);
    if (staticValidation !== null) {
      throw new Error(
        `Proposed template "${proposedTemplate}" fails static validation: ${staticValidation.reason} — ${staticValidation.details}`,
      );
    }

    // Load all Loot rows in the Collection
    const lootRows = await db()
      .select()
      .from(schema.loot)
      .where(eq(schema.loot.collectionId, collectionId));

    // Build loot ID → row map
    const lootMap = new Map(lootRows.map((l) => [l.id, l]));

    // Load all LootFile rows for those Loot rows in one pass.
    // Batch in groups of 500 to stay under SQLite's SQLITE_MAX_VARIABLE_NUMBER
    // limit (default 999). inArray from drizzle-orm emits SQL IN (...) natively.
    const allLootFiles: (typeof schema.lootFiles.$inferSelect)[] = [];
    if (lootRows.length > 0) {
      const BATCH = 500;
      const lootIds = lootRows.map((l) => l.id);
      for (let i = 0; i < lootIds.length; i += BATCH) {
        const batchIds = lootIds.slice(i, i + BATCH);
        const batchRows = await db()
          .select()
          .from(schema.lootFiles)
          .where(inArray(schema.lootFiles.lootId, batchIds));
        allLootFiles.push(...batchRows);
      }
    }

    // Build initial verdicts (no collision detection yet)
    type PreCollisionVerdict = Exclude<MigrationVerdict, { kind: 'collision' }>;
    const preCollisionVerdicts: PreCollisionVerdict[] = [];

    for (const lootFile of allLootFiles) {
      const lootRow = lootMap.get(lootFile.lootId);
      if (!lootRow) {
        // Orphaned lootFile — skip
        logger.warn(
          { lootFileId: lootFile.id, lootId: lootFile.lootId },
          'template-migration: preview found orphaned lootFile (no loot row); skipping',
        );
        continue;
      }

      // Build resolution metadata from the Loot row
      const metadata = buildLootMetadata(lootRow);

      // Resolve proposed template
      // TODO: derive from stashRoot.platform when that column is added
      const resolveResult = resolveTemplate(parsed, { metadata, targetOS: 'linux' as const });

      // Compute proposed path with extension
      const ext = path.extname(lootFile.path);
      const proposedPathWithExt: string | null = resolveResult.ok
        ? `${resolveResult.path}${ext}`
        : null;

      const verdict = classifyVerdict(
        lootFile.lootId,
        lootFile.id,
        lootFile.path,
        resolveResult,
        proposedPathWithExt,
      );

      preCollisionVerdicts.push(verdict);
    }

    // Collect the set of paths already in this collection that are NOT being migrated
    // (i.e. paths of files whose verdicts are NOT simple-move)
    const nonMovingPaths = new Set<string>(
      preCollisionVerdicts
        .filter((v) => v.kind !== 'simple-move')
        .map((v) => (v.kind === 'unchanged' ? v.path : v.currentPath)),
    );

    // Collision detection among simple-move verdicts
    // Group by proposed path
    const proposedPathToVerdicts = new Map<string, PreCollisionVerdict[]>();
    for (const verdict of preCollisionVerdicts) {
      if (verdict.kind !== 'simple-move') continue;
      const key = verdict.proposedPath;
      const existing = proposedPathToVerdicts.get(key) ?? [];
      existing.push(verdict);
      proposedPathToVerdicts.set(key, existing);
    }

    // Final verdicts with collision resolution
    const finalVerdicts: MigrationVerdict[] = [];

    for (const verdict of preCollisionVerdicts) {
      if (verdict.kind !== 'simple-move') {
        finalVerdicts.push(verdict);
        continue;
      }

      const proposedPath = verdict.proposedPath;

      // Check collision with an existing non-migrating file's path
      const collidesWithExisting = nonMovingPaths.has(proposedPath);

      // Check self-collision (multiple simple-move verdicts resolving to the same path)
      const samePath = proposedPathToVerdicts.get(proposedPath) ?? [];

      if (collidesWithExisting) {
        // Collision with an existing file — all conflicting IDs are those
        // lootFiles currently holding that path (they are NOT in the
        // simple-move set, so we look them up by path)
        const existingFilesAtPath = preCollisionVerdicts
          .filter((v) => v.kind !== 'simple-move' && (v.kind === 'unchanged' ? v.path : v.currentPath) === proposedPath)
          .map((v) => v.lootId);

        finalVerdicts.push({
          kind: 'collision',
          lootId: verdict.lootId,
          lootFileId: verdict.lootFileId,
          currentPath: verdict.currentPath,
          proposedPath,
          conflictingLootIds: existingFilesAtPath,
        });
        continue;
      }

      if (samePath.length > 1) {
        // Self-collision among simple-move verdicts
        const conflictingLootIds = samePath
          .filter((v) => v.lootFileId !== verdict.lootFileId)
          .map((v) => v.lootId);

        finalVerdicts.push({
          kind: 'collision',
          lootId: verdict.lootId,
          lootFileId: verdict.lootFileId,
          currentPath: verdict.currentPath,
          proposedPath,
          conflictingLootIds,
        });
        continue;
      }

      // No collision
      finalVerdicts.push(verdict);
    }

    // Build summary
    const summary = {
      unchanged: 0,
      simpleMove: 0,
      collision: 0,
      templateIncompatible: 0,
      osIncompatible: 0,
    };
    for (const v of finalVerdicts) {
      if (v.kind === 'unchanged') summary.unchanged++;
      else if (v.kind === 'simple-move') summary.simpleMove++;
      else if (v.kind === 'collision') summary.collision++;
      else if (v.kind === 'template-incompatible') summary.templateIncompatible++;
      else if (v.kind === 'os-incompatible') summary.osIncompatible++;
    }

    logger.info(
      { collectionId, proposedTemplate, summary },
      'template-migration: preview complete',
    );

    return {
      collectionId,
      currentTemplate,
      proposedTemplate,
      verdicts: finalVerdicts,
      summary,
    };
  }

  // ── execute ───────────────────────────────────────────────────────────────

  async function execute(plan: MigrationPlan): Promise<MigrationReport> {
    const { collectionId, proposedTemplate, approvedVerdicts } = plan;
    const executedAt = new Date();

    const report: MigrationReport = {
      collectionId,
      executedAt,
      oldTemplate: '',
      newTemplate: proposedTemplate,
      filesMigrated: 0,
      filesSkipped: [],
      filesFailed: [],
    };

    // Load Collection
    const collectionRows = await db()
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, collectionId));

    const collection = collectionRows[0];
    if (!collection) {
      throw new Error(`Collection "${collectionId}" not found`);
    }

    report.oldTemplate = collection.pathTemplate;

    // Load the stash root to get the absolute path
    const stashRootRows = await db()
      .select()
      .from(schema.stashRoots)
      .where(eq(schema.stashRoots.id, collection.stashRootId));

    const stashRoot = stashRootRows[0];
    if (!stashRoot) {
      throw new Error(`StashRoot "${collection.stashRootId}" not found`);
    }

    const stashRootPath = stashRoot.path;

    // Parse proposed template (trust the plan — re-resolve at apply time for robustness)
    let parsed: ReturnType<typeof parseTemplate>;
    try {
      parsed = parseTemplate(proposedTemplate);
    } catch (err) {
      throw new Error(
        `Invalid proposed template "${proposedTemplate}": ${(err as Error).message}`,
      );
    }

    // Process each approved verdict
    for (const approved of approvedVerdicts) {
      const { lootId, lootFileId } = approved;

      // Load Loot row
      const lootRows = await db()
        .select()
        .from(schema.loot)
        .where(and(eq(schema.loot.id, lootId), eq(schema.loot.collectionId, collectionId)));

      const lootRow = lootRows[0];
      if (!lootRow) {
        report.filesSkipped.push({
          lootId,
          lootFileId,
          reason: `Loot "${lootId}" not found in collection "${collectionId}"`,
        });
        continue;
      }

      // Load LootFile row
      const lootFileRows = await db()
        .select()
        .from(schema.lootFiles)
        .where(and(eq(schema.lootFiles.id, lootFileId), eq(schema.lootFiles.lootId, lootId)));

      const lootFile = lootFileRows[0];
      if (!lootFile) {
        report.filesSkipped.push({
          lootId,
          lootFileId,
          reason: `LootFile "${lootFileId}" not found for loot "${lootId}"`,
        });
        continue;
      }

      // Re-resolve at apply time (robust against Loot metadata changes between preview and execute)
      const metadata = buildLootMetadata(lootRow);
      // TODO: derive from stashRoot.platform when that column is added
      const resolveResult = resolveTemplate(parsed, { metadata, targetOS: 'linux' as const });

      if (!resolveResult.ok) {
        report.filesSkipped.push({
          lootId,
          lootFileId,
          reason: `Template re-resolve failed: ${resolveResult.reason} — ${resolveResult.details}`,
        });
        continue;
      }

      const ext = path.extname(lootFile.path);
      const proposedRelativePath = `${resolveResult.path}${ext}`;

      // Skip if unchanged (Loot metadata changed so new path == current path)
      if (proposedRelativePath === lootFile.path) {
        report.filesSkipped.push({
          lootId,
          lootFileId,
          reason: `Re-resolved path equals current path (metadata may have changed since preview)`,
        });
        continue;
      }

      // Build absolute paths
      const source = path.join(stashRootPath, lootFile.path);
      const destination = path.join(stashRootPath, proposedRelativePath);

      const oldPath = lootFile.path;
      const newPath = proposedRelativePath;

      // Execute move via T3 linkOrCopy
      // DB update + ledger + reference update happen inside the hook (transactional safety)
      const moveResult = await linkOrCopy({
        source,
        destination,
        cleanupPolicy: 'immediate',
        onAfterDestinationVerified: async () => {
          // Update lootFiles.path in the DB — INSIDE the hook so the adapter can
          // roll back the destination if this throws (per learning #69)
          await db()
            .update(schema.lootFiles)
            .set({ path: newPath })
            .where(eq(schema.lootFiles.id, lootFileId));

          // Emit ledger event — FIRE-AND-CONTINUE.
          // Ledger failure must NOT abort the primary op (DB update already committed above).
          try {
            await ledgerEmitter.emitMigration({
              collectionId,
              lootId,
              lootFileId,
              oldPath,
              newPath,
              timestamp: executedAt,
            });
          } catch (ledgerErr) {
            logger.warn({ ledgerErr, lootId, lootFileId }, 'template-migration: ledger emit failed — primary op unaffected');
          }

          // Update path references (stub for now)
          await referenceUpdater.updatePathReferences(oldPath, newPath, lootId);
        },
      });

      if (moveResult.status === 'failed') {
        // NOTE: source-cleanup-failed is a PARTIAL success for migration: the DB row
        // reflects the new path (hook ran, UPDATE committed) and the destination exists.
        // Only the source unlink failed — the file now exists at both old and new paths.
        // We report this as `filesFailed` so an operator can manually remove the
        // orphaned source file; the DB does NOT need fixing.
        const errorMessage =
          moveResult.reason === 'db-commit-failed'
            ? `DB update failed (destination rolled back): ${String((moveResult.error as Error | undefined)?.message ?? 'unknown')}`
            : moveResult.reason === 'source-cleanup-failed'
              ? `${moveResult.reason}: ${moveResult.details} — DB updated to new path; source file still exists at ${oldPath} and must be removed manually`
              : `${moveResult.reason}: ${moveResult.details}`;

        logger.warn(
          {
            collectionId,
            lootId,
            lootFileId,
            source,
            destination,
            reason: moveResult.reason,
            rollbackError: moveResult.rollbackError,
          },
          'template-migration: file move failed',
        );

        report.filesFailed.push({ lootId, lootFileId, error: errorMessage });
        // Per-move failure: continue with remaining files
        continue;
      }

      report.filesMigrated++;

      logger.info(
        { collectionId, lootId, lootFileId, oldPath, newPath },
        'template-migration: file migrated',
      );
    }

    // Update the stored template to the new convention even when some files failed
    // migration. Rationale: the template reflects the user's chosen organization going
    // forward; failed files retain their old paths and are surfaced in `filesFailed`
    // for manual retry. An all-or-nothing approach would strand successful migrations
    // if a single file's move hit a transient error.
    if (report.filesMigrated > 0) {
      await db()
        .update(schema.collections)
        .set({ pathTemplate: proposedTemplate, updatedAt: executedAt })
        .where(eq(schema.collections.id, collectionId));

      logger.info(
        { collectionId, oldTemplate: report.oldTemplate, newTemplate: proposedTemplate },
        'template-migration: collection pathTemplate updated',
      );
    }

    logger.info(
      {
        collectionId,
        filesMigrated: report.filesMigrated,
        filesSkipped: report.filesSkipped.length,
        filesFailed: report.filesFailed.length,
      },
      'template-migration: execute complete',
    );

    return report;
  }

  return { preview, execute };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the metadata record used for template resolution from a Loot row.
 * Field names match the template field names used in the path-template engine.
 */
function buildLootMetadata(lootRow: typeof schema.loot.$inferSelect): Record<string, unknown> {
  const meta: Record<string, unknown> = {};

  meta['title'] = lootRow.title;

  if (lootRow.creator !== null) {
    meta['creator'] = lootRow.creator;
  }
  if (lootRow.description !== null) {
    meta['description'] = lootRow.description;
  }
  if (lootRow.license !== null) {
    meta['license'] = lootRow.license;
  }
  if (lootRow.tags !== null && Array.isArray(lootRow.tags)) {
    meta['tags'] = lootRow.tags;
  }

  return meta;
}

