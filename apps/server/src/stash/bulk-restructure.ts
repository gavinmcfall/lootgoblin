/**
 * bulk-restructure.ts — Bulk Operations engine for the Stash pillar.
 *
 * User selects N Loots + a bulk action → dry-run preview (affected /
 * permission-skipped / collision) → confirm → apply in batches → emit ONE
 * Ledger event with the full manifest.
 *
 * Two action kinds for v2:
 *   move-to-collection   — move N Loots from their current Collection to a
 *                          target Collection. Files physically move via T3
 *                          copy-then-cleanup if the target uses a different
 *                          stashRootId; otherwise just DB pointer update +
 *                          re-template the path under the new Collection.
 *   change-template      — apply a template change to an explicit subset of
 *                          Loots in a single Collection (T9-style but for an
 *                          explicit subset rather than all).
 *
 * Other bulk operations (bulk-tag, bulk-license, bulk-delete) are out of
 * scope for T10. The switch-on-action-kind structure is extensible.
 *
 * V2-002-T10 (Organization Flow Variant 5)
 */

import * as path from 'node:path';

import { logger } from '../logger';
import { getDb, schema } from '../db/client';
import { eq, and, inArray } from 'drizzle-orm';

import {
  parseTemplate,
  validateTemplate,
  resolveTemplate,
  type ResolveVerdict,
} from './path-template';
import { classifyVerdict } from './template-migration';
import { linkOrCopy } from './filesystem-adapter';
import { resolveAcl } from '../acl/resolver';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Two action kinds for v2. Extensible via additional union members. */
export type BulkAction =
  | { kind: 'move-to-collection'; targetCollectionId: string }
  | { kind: 'change-template'; newTemplate: string };

export type BulkVerdict =
  /** Will apply at execute time. */
  | { kind: 'ready'; lootId: string; description: string }
  /** ACL barrier — caller lacks permission to update this Loot. */
  | { kind: 'permission-skipped'; lootId: string; reason: string }
  /** Proposed path collides with another Loot in the target location. */
  | { kind: 'collision'; lootId: string; proposedPath: string; conflictingLootIds: string[] }
  /** Nothing to do — path would not change. */
  | { kind: 'unchanged'; lootId: string }
  /** Action is structurally incompatible with this Loot (e.g. loot-not-found, template-incompatible). */
  | { kind: 'action-incompatible'; lootId: string; reason: string };

export type BulkPreview = {
  action: BulkAction;
  lootIds: string[];
  verdicts: BulkVerdict[];
  summary: {
    ready: number;
    permissionSkipped: number;
    collision: number;
    unchanged: number;
    actionIncompatible: number;
  };
};

export type BulkPlan = {
  action: BulkAction;
  /** MUST match what preview was run against; engine re-verifies ACL + verdict at apply time. */
  lootIds: string[];
  /** Default 50 — number of Loots to process per sequential batch. */
  batchSize?: number;
  /** ACL check — caller authenticates, engine applies. */
  ownerId: string;
};

export type BulkReport = {
  action: BulkAction;
  appliedAt: Date;
  totalAffected: number;
  applied: string[];                                  // lootIds successfully applied
  skipped: Array<{ lootId: string; reason: string }>; // non-ready verdicts at apply time
  failed: Array<{ lootId: string; error: string }>;   // ready but threw during apply
  ledgerEventId: string;                              // id of the single bulk ledger event
};

export type BulkLedgerEmitter = {
  /**
   * Stub for v2-002. Emits ONE event per bulk action, NOT per-item.
   * Spec: "auditability at intended granularity."
   * Future V2-007 Ledger will persist this with a real event id.
   */
  emitBulk(event: {
    action: BulkAction;
    actorOwnerId: string;
    manifest: { applied: string[]; skipped: string[]; failed: string[] };
    timestamp: Date;
  }): Promise<{ eventId: string }>;
};

export type BulkRestructureOptions = {
  ledgerEmitter?: BulkLedgerEmitter;
  /**
   * Injection seam for tests — defaults to a DB-backed owner-match check
   * built on top of the pure resolveAcl from V2-001.
   *
   * The default implementation loads the Loot row to find its owning
   * Collection's ownerId, then resolves ACL with the loot resource.
   */
  aclCheck?: (args: { ownerId: string; lootId: string; action: 'update' }) => Promise<boolean>;
  /** DATABASE_URL override (used in tests). */
  dbUrl?: string;
};

export interface BulkRestructureEngine {
  preview(args: { action: BulkAction; lootIds: string[]; ownerId: string }): Promise<BulkPreview>;
  execute(plan: BulkPlan): Promise<BulkReport>;
}

// ---------------------------------------------------------------------------
// Default stubs
// ---------------------------------------------------------------------------

function createNoOpLedgerEmitter(): BulkLedgerEmitter {
  return {
    async emitBulk(event) {
      const eventId = `bulk-stub-${Date.now()}`;
      logger.debug(
        {
          action: event.action,
          actorOwnerId: event.actorOwnerId,
          applied: event.manifest.applied.length,
          skipped: event.manifest.skipped.length,
          failed: event.manifest.failed.length,
          timestamp: event.timestamp,
          eventId,
        },
        'bulk-restructure: ledger emitter stub — would emit bulk event',
      );
      return { eventId };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the metadata record used for template resolution from a Loot row.
 * Field names match the template field names used in the path-template engine.
 * (Mirror of template-migration.ts buildLootMetadata — kept local to avoid
 * coupling internal helpers across modules.)
 */
function buildLootMetadata(lootRow: typeof schema.loot.$inferSelect): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  meta['title'] = lootRow.title;
  if (lootRow.creator !== null) meta['creator'] = lootRow.creator;
  if (lootRow.description !== null) meta['description'] = lootRow.description;
  if (lootRow.license !== null) meta['license'] = lootRow.license;
  if (lootRow.tags !== null && Array.isArray(lootRow.tags)) meta['tags'] = lootRow.tags;
  return meta;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBulkRestructureEngine(
  options: BulkRestructureOptions = {},
): BulkRestructureEngine {
  const ledgerEmitter = options.ledgerEmitter ?? createNoOpLedgerEmitter();
  const dbUrl = options.dbUrl;

  type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

  function db(): DB {
    return getDb(dbUrl) as DB;
  }

  /**
   * Default ACL check: load the Loot row → find its Collection's ownerId →
   * call the pure resolveAcl function. Injected aclCheck replaces this entirely.
   *
   * The ownerId parameter here is the *caller's* userId (the actor performing
   * the bulk action). We need to determine whether that actor may update the
   * loot. Because Loot rows don't have a direct ownerId column, we resolve
   * via the owning Collection's ownerId.
   */
  async function defaultAclCheck(args: {
    ownerId: string;
    lootId: string;
    action: 'update';
  }): Promise<boolean> {
    const lootRows = await db()
      .select({ collectionId: schema.loot.collectionId })
      .from(schema.loot)
      .where(eq(schema.loot.id, args.lootId));

    const lootRow = lootRows[0];
    if (!lootRow) return false; // loot not found → deny

    const collectionRows = await db()
      .select({ ownerId: schema.collections.ownerId })
      .from(schema.collections)
      .where(eq(schema.collections.id, lootRow.collectionId));

    const collectionRow = collectionRows[0];
    if (!collectionRow) return false; // collection not found → deny

    const decision = resolveAcl({
      user: { id: args.ownerId, role: 'user' }, // treat as plain user; admin bypass not applicable for bulk
      resource: { kind: 'loot', ownerId: collectionRow.ownerId },
      action: 'update',
    });

    return decision.allowed;
  }

  const aclCheck = options.aclCheck ?? defaultAclCheck;

  // ── preview ────────────────────────────────────────────────────────────────

  async function preview(args: {
    action: BulkAction;
    lootIds: string[];
    ownerId: string;
  }): Promise<BulkPreview> {
    const { action, lootIds, ownerId } = args;

    const verdicts: BulkVerdict[] = [];

    if (action.kind === 'move-to-collection') {
      await previewMoveToCollection({ action, lootIds, ownerId, verdicts });
    } else if (action.kind === 'change-template') {
      await previewChangeTemplate({ action, lootIds, ownerId, verdicts });
    } else {
      // Exhaustiveness guard — TypeScript will flag unhandled cases.
      const _never: never = action;
      void _never;
    }

    const summary = buildSummary(verdicts);

    logger.info(
      { action, lootCount: lootIds.length, summary },
      'bulk-restructure: preview complete',
    );

    return { action, lootIds, verdicts, summary };
  }

  // ── preview: move-to-collection ───────────────────────────────────────────

  async function previewMoveToCollection(args: {
    action: Extract<BulkAction, { kind: 'move-to-collection' }>;
    lootIds: string[];
    ownerId: string;
    verdicts: BulkVerdict[];
  }): Promise<void> {
    const { action, lootIds, ownerId, verdicts } = args;
    const { targetCollectionId } = action;

    // Load target Collection
    const targetCollectionRows = await db()
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, targetCollectionId));

    const targetCollection = targetCollectionRows[0];
    if (!targetCollection) {
      // Target collection doesn't exist — all loots are action-incompatible
      for (const lootId of lootIds) {
        verdicts.push({
          kind: 'action-incompatible',
          lootId,
          reason: `Target collection "${targetCollectionId}" not found`,
        });
      }
      return;
    }

    // Parse + validate the target collection's path template
    let targetParsed: ReturnType<typeof parseTemplate>;
    try {
      targetParsed = parseTemplate(targetCollection.pathTemplate);
    } catch (err) {
      for (const lootId of lootIds) {
        verdicts.push({
          kind: 'action-incompatible',
          lootId,
          reason: `Target collection "${targetCollectionId}" has invalid path template: ${(err as Error).message}`,
        });
      }
      return;
    }

    // Load target stash root
    const targetStashRootRows = await db()
      .select()
      .from(schema.stashRoots)
      .where(eq(schema.stashRoots.id, targetCollection.stashRootId));

    const targetStashRoot = targetStashRootRows[0];
    if (!targetStashRoot) {
      for (const lootId of lootIds) {
        verdicts.push({
          kind: 'action-incompatible',
          lootId,
          reason: `Target collection's stash root "${targetCollection.stashRootId}" not found`,
        });
      }
      return;
    }

    // Load all Loot rows for the requested lootIds in batches
    const BATCH = 500;
    const allLootRows: (typeof schema.loot.$inferSelect)[] = [];
    for (let i = 0; i < lootIds.length; i += BATCH) {
      const batchIds = lootIds.slice(i, i + BATCH);
      const rows = await db()
        .select()
        .from(schema.loot)
        .where(inArray(schema.loot.id, batchIds));
      allLootRows.push(...rows);
    }
    const lootMap = new Map(allLootRows.map((l) => [l.id, l]));

    // Load lootFiles for loots that exist
    const existingLootIds = Array.from(lootMap.keys());
    const allLootFiles: (typeof schema.lootFiles.$inferSelect)[] = [];
    if (existingLootIds.length > 0) {
      for (let i = 0; i < existingLootIds.length; i += BATCH) {
        const batchIds = existingLootIds.slice(i, i + BATCH);
        const rows = await db()
          .select()
          .from(schema.lootFiles)
          .where(inArray(schema.lootFiles.lootId, batchIds));
        allLootFiles.push(...rows);
      }
    }

    // Group lootFiles by lootId
    const filesByLootId = new Map<string, (typeof schema.lootFiles.$inferSelect)[]>();
    for (const f of allLootFiles) {
      const arr = filesByLootId.get(f.lootId) ?? [];
      arr.push(f);
      filesByLootId.set(f.lootId, arr);
    }

    // Load existing paths in target collection to detect collisions against non-moving files
    const targetFilePaths = new Set<string>();
    if (existingLootIds.length > 0) {
      // We need all loot in the target collection, not just the ones we're moving
      const targetLootRows = await db()
        .select({ id: schema.loot.id })
        .from(schema.loot)
        .where(eq(schema.loot.collectionId, targetCollectionId));

      const targetLootIds = targetLootRows.map((r) => r.id);
      if (targetLootIds.length > 0) {
        for (let i = 0; i < targetLootIds.length; i += BATCH) {
          const batchIds = targetLootIds.slice(i, i + BATCH);
          const rows = await db()
            .select({ path: schema.lootFiles.path })
            .from(schema.lootFiles)
            .where(inArray(schema.lootFiles.lootId, batchIds));
          for (const r of rows) targetFilePaths.add(r.path);
        }
      }
    }

    // Per-loot pre-collision classification
    // proposedPath → [lootId, ...] for self-collision detection
    const proposedPathToLootIds = new Map<string, string[]>();

    // We track the "ready" verdicts with their proposed paths for collision pass
    type ReadyCandidate = {
      lootId: string;
      proposedPath: string;
      description: string;
    };
    const readyCandidates: ReadyCandidate[] = [];
    // Track loots that got a non-ready verdict (not collision) to emit those directly
    const nonReadyVerdicts: BulkVerdict[] = [];

    for (const lootId of lootIds) {
      const lootRow = lootMap.get(lootId);
      if (!lootRow) {
        nonReadyVerdicts.push({
          kind: 'action-incompatible',
          lootId,
          reason: 'loot-not-found',
        });
        continue;
      }

      // ACL check
      const allowed = await aclCheck({ ownerId, lootId, action: 'update' });
      if (!allowed) {
        nonReadyVerdicts.push({
          kind: 'permission-skipped',
          lootId,
          reason: 'ACL denied: caller does not own this Loot',
        });
        continue;
      }

      // If loot is already in the target collection, unchanged
      if (lootRow.collectionId === targetCollectionId) {
        nonReadyVerdicts.push({ kind: 'unchanged', lootId });
        continue;
      }

      // Resolve proposed path(s) for all files of this loot under the target template.
      // For the bulk-level verdict we use the PRIMARY file (first by path sort) to
      // represent the loot's proposed location. If the loot has no files yet, use
      // title-only resolution.
      const metadata = buildLootMetadata(lootRow);
      const resolveResult = resolveTemplate(targetParsed, { metadata, targetOS: 'linux' as const });

      if (!resolveResult.ok) {
        nonReadyVerdicts.push({
          kind: 'action-incompatible',
          lootId,
          reason: `Template resolution failed: ${resolveResult.reason} — ${resolveResult.details}`,
        });
        continue;
      }

      // Use the representative file extension (primary file) or empty string if no files
      const lootFileList = filesByLootId.get(lootId) ?? [];
      const primaryFile = lootFileList[0];
      const ext = primaryFile ? path.extname(primaryFile.path) : '';
      const proposedPath = `${resolveResult.path}${ext}`;

      // Track for collision detection
      const existing = proposedPathToLootIds.get(proposedPath) ?? [];
      existing.push(lootId);
      proposedPathToLootIds.set(proposedPath, existing);

      readyCandidates.push({
        lootId,
        proposedPath,
        description: `Move to collection "${targetCollection.name}" at "${proposedPath}"`,
      });
    }

    // Collision detection pass
    for (const candidate of readyCandidates) {
      const { lootId, proposedPath, description } = candidate;

      // Collision against existing non-moving files in target collection
      if (targetFilePaths.has(proposedPath)) {
        verdicts.push({
          kind: 'collision',
          lootId,
          proposedPath,
          conflictingLootIds: [], // existing file path — we don't resolve back to lootId here
        });
        continue;
      }

      // Self-collision among the bulk set
      const samePath = proposedPathToLootIds.get(proposedPath) ?? [];
      if (samePath.length > 1) {
        const conflictingLootIds = samePath.filter((id) => id !== lootId);
        verdicts.push({
          kind: 'collision',
          lootId,
          proposedPath,
          conflictingLootIds,
        });
        continue;
      }

      verdicts.push({ kind: 'ready', lootId, description });
    }

    // Append non-ready verdicts in input order (they were accumulated above)
    verdicts.push(...nonReadyVerdicts);
  }

  // ── preview: change-template ───────────────────────────────────────────────

  async function previewChangeTemplate(args: {
    action: Extract<BulkAction, { kind: 'change-template' }>;
    lootIds: string[];
    ownerId: string;
    verdicts: BulkVerdict[];
  }): Promise<void> {
    const { action, lootIds, ownerId, verdicts } = args;
    const { newTemplate } = action;

    // Parse + validate the new template upfront
    let parsed: ReturnType<typeof parseTemplate>;
    try {
      parsed = parseTemplate(newTemplate);
    } catch (err) {
      for (const lootId of lootIds) {
        verdicts.push({
          kind: 'action-incompatible',
          lootId,
          reason: `Invalid template: ${(err as Error).message}`,
        });
      }
      return;
    }

    const staticValidation = validateTemplate(parsed, 'linux' as const);
    if (staticValidation !== null) {
      for (const lootId of lootIds) {
        verdicts.push({
          kind: 'action-incompatible',
          lootId,
          reason: `Template fails static validation: ${staticValidation.reason} — ${staticValidation.details}`,
        });
      }
      return;
    }

    // Load all Loot rows
    const BATCH = 500;
    const allLootRows: (typeof schema.loot.$inferSelect)[] = [];
    for (let i = 0; i < lootIds.length; i += BATCH) {
      const batchIds = lootIds.slice(i, i + BATCH);
      const rows = await db()
        .select()
        .from(schema.loot)
        .where(inArray(schema.loot.id, batchIds));
      allLootRows.push(...rows);
    }
    const lootMap = new Map(allLootRows.map((l) => [l.id, l]));

    // Load lootFiles for existing loots
    const existingLootIds = Array.from(lootMap.keys());
    const allLootFiles: (typeof schema.lootFiles.$inferSelect)[] = [];
    if (existingLootIds.length > 0) {
      for (let i = 0; i < existingLootIds.length; i += BATCH) {
        const batchIds = existingLootIds.slice(i, i + BATCH);
        const rows = await db()
          .select()
          .from(schema.lootFiles)
          .where(inArray(schema.lootFiles.lootId, batchIds));
        allLootFiles.push(...rows);
      }
    }

    // Group lootFiles by lootId
    const filesByLootId = new Map<string, (typeof schema.lootFiles.$inferSelect)[]>();
    for (const f of allLootFiles) {
      const arr = filesByLootId.get(f.lootId) ?? [];
      arr.push(f);
      filesByLootId.set(f.lootId, arr);
    }

    // proposed path → [lootId] for self-collision detection
    const proposedPathToLootIds = new Map<string, string[]>();
    type ReadyCandidate = { lootId: string; proposedPath: string };
    const readyCandidates: ReadyCandidate[] = [];
    const nonReadyVerdicts: BulkVerdict[] = [];

    for (const lootId of lootIds) {
      const lootRow = lootMap.get(lootId);
      if (!lootRow) {
        nonReadyVerdicts.push({
          kind: 'action-incompatible',
          lootId,
          reason: 'loot-not-found',
        });
        continue;
      }

      // ACL check
      const allowed = await aclCheck({ ownerId, lootId, action: 'update' });
      if (!allowed) {
        nonReadyVerdicts.push({
          kind: 'permission-skipped',
          lootId,
          reason: 'ACL denied: caller does not own this Loot',
        });
        continue;
      }

      const metadata = buildLootMetadata(lootRow);
      const resolveResult = resolveTemplate(parsed, { metadata, targetOS: 'linux' as const });

      // Use T9's classifyVerdict for consistency
      const lootFileList = filesByLootId.get(lootId) ?? [];
      const primaryFile = lootFileList[0];

      if (!primaryFile) {
        // No files — if template resolution fails it's incompatible; otherwise unchanged
        if (!resolveResult.ok) {
          nonReadyVerdicts.push({
            kind: 'action-incompatible',
            lootId,
            reason: `Template resolution failed: ${resolveResult.reason} — ${resolveResult.details}`,
          });
        } else {
          nonReadyVerdicts.push({ kind: 'unchanged', lootId });
        }
        continue;
      }

      const ext = path.extname(primaryFile.path);
      const proposedPathWithExt: string | null = resolveResult.ok
        ? `${resolveResult.path}${ext}`
        : null;

      // Use T9's classifyVerdict to get the per-file verdict kind
      const migrationVerdict = classifyVerdict(
        lootId,
        primaryFile.id,
        primaryFile.path,
        resolveResult,
        proposedPathWithExt,
      );

      if (migrationVerdict.kind === 'unchanged') {
        nonReadyVerdicts.push({ kind: 'unchanged', lootId });
        continue;
      }

      if (migrationVerdict.kind === 'template-incompatible' || migrationVerdict.kind === 'os-incompatible') {
        nonReadyVerdicts.push({
          kind: 'action-incompatible',
          lootId,
          reason: `${migrationVerdict.kind}: ${migrationVerdict.reason}`,
        });
        continue;
      }

      // simple-move — track for collision detection
      const proposedPath = migrationVerdict.proposedPath;
      const existing = proposedPathToLootIds.get(proposedPath) ?? [];
      existing.push(lootId);
      proposedPathToLootIds.set(proposedPath, existing);
      readyCandidates.push({ lootId, proposedPath });
    }

    // Collision detection: among ready candidates
    for (const candidate of readyCandidates) {
      const { lootId, proposedPath } = candidate;
      const samePath = proposedPathToLootIds.get(proposedPath) ?? [];
      if (samePath.length > 1) {
        const conflictingLootIds = samePath.filter((id) => id !== lootId);
        verdicts.push({ kind: 'collision', lootId, proposedPath, conflictingLootIds });
        continue;
      }
      verdicts.push({
        kind: 'ready',
        lootId,
        description: `Apply template "${newTemplate}" → "${proposedPath}"`,
      });
    }

    verdicts.push(...nonReadyVerdicts);
  }

  // ── execute ───────────────────────────────────────────────────────────────

  async function execute(plan: BulkPlan): Promise<BulkReport> {
    const { action, lootIds, ownerId } = plan;
    const batchSize = plan.batchSize ?? 50;
    const appliedAt = new Date();

    const applied: string[] = [];
    const skipped: Array<{ lootId: string; reason: string }> = [];
    const failed: Array<{ lootId: string; error: string }> = [];

    // Edge case: empty lootIds — emit 0 events, return empty report.
    // Rationale: nothing was requested; emitting a Ledger event for an empty
    // manifest would create noise with no audit value.
    if (lootIds.length === 0) {
      logger.info({ action }, 'bulk-restructure: execute called with empty lootIds — no-op');
      return {
        action,
        appliedAt,
        totalAffected: 0,
        applied,
        skipped,
        failed,
        ledgerEventId: '',
      };
    }

    // Split into sequential batches
    const batches: string[][] = [];
    for (let i = 0; i < lootIds.length; i += batchSize) {
      batches.push(lootIds.slice(i, i + batchSize));
    }

    logger.info(
      { action, totalLoots: lootIds.length, batchCount: batches.length, batchSize },
      'bulk-restructure: execute starting',
    );

    // Process each batch sequentially
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      if (!batch) continue; // TypeScript narrowing — batches[batchIdx] is always defined here
      logger.debug(
        { action, batchIdx, batchLootCount: batch.length },
        'bulk-restructure: processing batch',
      );

      for (const lootId of batch) {
        // Re-verify ACL at apply time (post-preview ACL changes must be respected)
        const allowed = await aclCheck({ ownerId, lootId, action: 'update' });
        if (!allowed) {
          skipped.push({ lootId, reason: 'ACL denied at apply time' });
          continue;
        }

        if (action.kind === 'move-to-collection') {
          await executeMoveToCollection({
            action,
            lootId,
            ownerId,
            applied,
            skipped,
            failed,
          });
        } else if (action.kind === 'change-template') {
          await executeChangeTemplate({
            action,
            lootId,
            applied,
            skipped,
            failed,
          });
        }
      }
    }

    // Emit ONE Ledger event for the full batch
    const { eventId } = await ledgerEmitter.emitBulk({
      action,
      actorOwnerId: ownerId,
      manifest: {
        applied,
        skipped: skipped.map((s) => s.lootId),
        failed: failed.map((f) => f.lootId),
      },
      timestamp: appliedAt,
    });

    const report: BulkReport = {
      action,
      appliedAt,
      totalAffected: applied.length,
      applied,
      skipped,
      failed,
      ledgerEventId: eventId,
    };

    logger.info(
      {
        action,
        applied: applied.length,
        skipped: skipped.length,
        failed: failed.length,
        ledgerEventId: eventId,
      },
      'bulk-restructure: execute complete',
    );

    return report;
  }

  // ── execute: move-to-collection ────────────────────────────────────────────

  async function executeMoveToCollection(args: {
    action: Extract<BulkAction, { kind: 'move-to-collection' }>;
    lootId: string;
    ownerId: string;
    applied: string[];
    skipped: Array<{ lootId: string; reason: string }>;
    failed: Array<{ lootId: string; error: string }>;
  }): Promise<void> {
    const { action, lootId, skipped, applied, failed } = args;
    const { targetCollectionId } = action;

    try {
      // Load Loot
      const lootRows = await db()
        .select()
        .from(schema.loot)
        .where(eq(schema.loot.id, lootId));

      const lootRow = lootRows[0];
      if (!lootRow) {
        skipped.push({ lootId, reason: 'Loot not found at apply time' });
        return;
      }

      // If already in target collection, skip
      if (lootRow.collectionId === targetCollectionId) {
        skipped.push({ lootId, reason: 'Loot is already in target collection' });
        return;
      }

      // Load source collection + stash root
      const sourceCollectionRows = await db()
        .select()
        .from(schema.collections)
        .where(eq(schema.collections.id, lootRow.collectionId));
      const sourceCollection = sourceCollectionRows[0];
      if (!sourceCollection) {
        skipped.push({ lootId, reason: 'Source collection not found at apply time' });
        return;
      }

      // Load target collection + stash root
      const targetCollectionRows = await db()
        .select()
        .from(schema.collections)
        .where(eq(schema.collections.id, targetCollectionId));
      const targetCollection = targetCollectionRows[0];
      if (!targetCollection) {
        skipped.push({ lootId, reason: 'Target collection not found at apply time' });
        return;
      }

      const sourceStashRootRows = await db()
        .select()
        .from(schema.stashRoots)
        .where(eq(schema.stashRoots.id, sourceCollection.stashRootId));
      const sourceStashRoot = sourceStashRootRows[0];
      if (!sourceStashRoot) {
        skipped.push({ lootId, reason: 'Source stash root not found at apply time' });
        return;
      }

      const targetStashRootRows = await db()
        .select()
        .from(schema.stashRoots)
        .where(eq(schema.stashRoots.id, targetCollection.stashRootId));
      const targetStashRoot = targetStashRootRows[0];
      if (!targetStashRoot) {
        skipped.push({ lootId, reason: 'Target stash root not found at apply time' });
        return;
      }

      const samePath = sourceCollection.stashRootId === targetCollection.stashRootId;

      // Parse target path template
      let targetParsed: ReturnType<typeof parseTemplate>;
      try {
        targetParsed = parseTemplate(targetCollection.pathTemplate);
      } catch (err) {
        skipped.push({
          lootId,
          reason: `Target collection has invalid path template: ${(err as Error).message}`,
        });
        return;
      }

      // Re-resolve the template at apply time
      const metadata = buildLootMetadata(lootRow);
      const resolveResult = resolveTemplate(targetParsed, { metadata, targetOS: 'linux' as const });
      if (!resolveResult.ok) {
        skipped.push({
          lootId,
          reason: `Template re-resolve failed: ${resolveResult.reason} — ${resolveResult.details}`,
        });
        return;
      }

      // Load all LootFiles for this loot
      const lootFiles = await db()
        .select()
        .from(schema.lootFiles)
        .where(eq(schema.lootFiles.lootId, lootId));

      if (samePath) {
        // Same stashRoot — DB pointer update only; no physical file move needed
        // We still re-template the path for naming consistency
        for (const lf of lootFiles) {
          const ext = path.extname(lf.path);
          const newPath = `${resolveResult.path}${ext}`;
          await db()
            .update(schema.lootFiles)
            .set({ path: newPath })
            .where(eq(schema.lootFiles.id, lf.id));
        }

        // Update Loot.collectionId
        await db()
          .update(schema.loot)
          .set({ collectionId: targetCollectionId, updatedAt: new Date() })
          .where(eq(schema.loot.id, lootId));

        applied.push(lootId);
        logger.info(
          { lootId, fromCollection: lootRow.collectionId, toCollection: targetCollectionId, samePath },
          'bulk-restructure: move-to-collection applied (same stash root)',
        );
        return;
      }

      // Cross-stashRoot — physical file move via T3 linkOrCopy, then DB update
      // Move each file; if ANY file move fails, we record failure but update the
      // loot.collectionId anyway (partial move) since some files may have moved.
      // This mirrors T9's "continue on per-file failure" approach.
      let anyFileMoved = false;
      let anyFileFailed = false;

      for (const lf of lootFiles) {
        const ext = path.extname(lf.path);
        const newRelativePath = `${resolveResult.path}${ext}`;
        const source = path.join(sourceStashRoot.path, lf.path);
        const destination = path.join(targetStashRoot.path, newRelativePath);

        const moveResult = await linkOrCopy({
          source,
          destination,
          cleanupPolicy: 'immediate',
          // Force copy for cross-stashRoot moves (T3 handles EXDEV natively,
          // but we explicitly signal cross-device to skip the hardlink attempt).
          _forceExdev: !samePath,
          onAfterDestinationVerified: async () => {
            await db()
              .update(schema.lootFiles)
              .set({ path: newRelativePath })
              .where(eq(schema.lootFiles.id, lf.id));
          },
        });

        if (moveResult.status === 'failed') {
          logger.warn(
            { lootId, lootFileId: lf.id, source, destination, reason: moveResult.reason },
            'bulk-restructure: file move failed during cross-stash move',
          );
          anyFileFailed = true;
          // Continue with other files
        } else {
          anyFileMoved = true;
        }
      }

      if (anyFileFailed && !anyFileMoved) {
        failed.push({ lootId, error: 'All file moves failed during cross-stash move' });
        return;
      }

      // Update Loot.collectionId regardless of partial file failures
      // (partial is better than leaving the record pointing at the source collection
      // when some files are already at the destination)
      await db()
        .update(schema.loot)
        .set({ collectionId: targetCollectionId, updatedAt: new Date() })
        .where(eq(schema.loot.id, lootId));

      if (anyFileFailed) {
        // Partial move — record as failed so operator knows to fix orphaned files
        failed.push({
          lootId,
          error: 'Some files failed to move during cross-stash move; collectionId updated but check file paths',
        });
      } else {
        applied.push(lootId);
        logger.info(
          { lootId, fromCollection: lootRow.collectionId, toCollection: targetCollectionId, samePath },
          'bulk-restructure: move-to-collection applied (cross stash root)',
        );
      }
    } catch (err) {
      failed.push({ lootId, error: String((err as Error).message ?? err) });
      logger.error({ lootId, err }, 'bulk-restructure: unhandled error during move-to-collection');
    }
  }

  // ── execute: change-template ───────────────────────────────────────────────

  async function executeChangeTemplate(args: {
    action: Extract<BulkAction, { kind: 'change-template' }>;
    lootId: string;
    applied: string[];
    skipped: Array<{ lootId: string; reason: string }>;
    failed: Array<{ lootId: string; error: string }>;
  }): Promise<void> {
    const { action, lootId, applied, skipped, failed } = args;
    const { newTemplate } = action;

    try {
      // Load Loot
      const lootRows = await db()
        .select()
        .from(schema.loot)
        .where(eq(schema.loot.id, lootId));

      const lootRow = lootRows[0];
      if (!lootRow) {
        skipped.push({ lootId, reason: 'Loot not found at apply time' });
        return;
      }

      // Load collection + stash root
      const collectionRows = await db()
        .select()
        .from(schema.collections)
        .where(eq(schema.collections.id, lootRow.collectionId));
      const collection = collectionRows[0];
      if (!collection) {
        skipped.push({ lootId, reason: 'Collection not found at apply time' });
        return;
      }

      const stashRootRows = await db()
        .select()
        .from(schema.stashRoots)
        .where(eq(schema.stashRoots.id, collection.stashRootId));
      const stashRoot = stashRootRows[0];
      if (!stashRoot) {
        skipped.push({ lootId, reason: 'StashRoot not found at apply time' });
        return;
      }

      // Parse + resolve new template
      let parsed: ReturnType<typeof parseTemplate>;
      try {
        parsed = parseTemplate(newTemplate);
      } catch (err) {
        skipped.push({
          lootId,
          reason: `Invalid template at apply time: ${(err as Error).message}`,
        });
        return;
      }

      const metadata = buildLootMetadata(lootRow);
      const resolveResult = resolveTemplate(parsed, { metadata, targetOS: 'linux' as const });

      if (!resolveResult.ok) {
        skipped.push({
          lootId,
          reason: `Template re-resolve failed: ${resolveResult.reason} — ${resolveResult.details}`,
        });
        return;
      }

      // Load LootFiles
      const lootFiles = await db()
        .select()
        .from(schema.lootFiles)
        .where(eq(schema.lootFiles.lootId, lootId));

      if (lootFiles.length === 0) {
        skipped.push({ lootId, reason: 'Loot has no files to migrate' });
        return;
      }

      let anyMoved = false;
      let anyFailed = false;

      for (const lf of lootFiles) {
        const ext = path.extname(lf.path);
        const proposedRelativePath = `${resolveResult.path}${ext}`;

        // Skip if already at proposed path
        if (proposedRelativePath === lf.path) {
          continue;
        }

        const source = path.join(stashRoot.path, lf.path);
        const destination = path.join(stashRoot.path, proposedRelativePath);

        const moveResult = await linkOrCopy({
          source,
          destination,
          cleanupPolicy: 'immediate',
          onAfterDestinationVerified: async () => {
            await db()
              .update(schema.lootFiles)
              .set({ path: proposedRelativePath })
              .where(eq(schema.lootFiles.id, lf.id));
          },
        });

        if (moveResult.status === 'failed') {
          logger.warn(
            { lootId, lootFileId: lf.id, source, destination, reason: moveResult.reason },
            'bulk-restructure: file move failed during change-template',
          );
          anyFailed = true;
        } else {
          anyMoved = true;
        }
      }

      if (anyFailed && !anyMoved) {
        failed.push({ lootId, error: 'All file moves failed during change-template' });
      } else if (anyFailed) {
        failed.push({
          lootId,
          error: 'Some files failed to move during change-template; check file paths',
        });
      } else {
        applied.push(lootId);
        logger.info(
          { lootId, newTemplate },
          'bulk-restructure: change-template applied',
        );
      }
    } catch (err) {
      failed.push({ lootId, error: String((err as Error).message ?? err) });
      logger.error({ lootId, err }, 'bulk-restructure: unhandled error during change-template');
    }
  }

  // ── summary helper ─────────────────────────────────────────────────────────

  function buildSummary(verdicts: BulkVerdict[]): BulkPreview['summary'] {
    const summary = {
      ready: 0,
      permissionSkipped: 0,
      collision: 0,
      unchanged: 0,
      actionIncompatible: 0,
    };
    for (const v of verdicts) {
      if (v.kind === 'ready') summary.ready++;
      else if (v.kind === 'permission-skipped') summary.permissionSkipped++;
      else if (v.kind === 'collision') summary.collision++;
      else if (v.kind === 'unchanged') summary.unchanged++;
      else if (v.kind === 'action-incompatible') summary.actionIncompatible++;
    }
    return summary;
  }

  return { preview, execute };
}
