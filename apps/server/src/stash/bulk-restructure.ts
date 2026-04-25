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
import { eq, and, inArray, notInArray } from 'drizzle-orm';

import {
  parseTemplate,
  validateTemplate,
  resolveTemplate,
  type ResolveVerdict,
} from './path-template';
import { classifyVerdict } from './template-migration';
import { linkOrCopy } from './filesystem-adapter';
import { resolveAcl } from '../acl/resolver';
import { persistLedgerEvent } from './ledger';

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
  ledgerEventId: string;                              // id of the single bulk ledger event; '' when lootIds was empty (no bulk event emitted for audit no-op)
};

export type BulkLedgerEmitter = {
  /**
   * ONE event per bulk action, NOT per-item ("auditability at intended granularity").
   * Default implementation persists via `persistLedgerEvent` from T13.
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

function createDefaultLedgerEmitter(dbUrl?: string): BulkLedgerEmitter {
  return {
    async emitBulk(event) {
      try {
        // Choose resourceType + resourceId so `(resource_type, resource_id)`
        // audit queries don't return cross-type false hits.
        //
        //   move-to-collection → resourceType='collection', resourceId=targetCollectionId
        //     (the canonical resource acted on)
        //   change-template    → resourceType='bulk-action', resourceId=synthetic
        //     `bulk-${actorOwnerId}-${timestamp}`
        //     (V2-002 T10 carry-forward: previously used actorOwnerId as
        //      resourceId with resourceType='collection', which polluted
        //      collection audit queries and made user-id lookups hit bulk
        //      events by accident. 'bulk-action' is a synthetic type name
        //      reserved for multi-collection bulks that have no single
        //      canonical resource.)
        let resourceType: string;
        let resourceId: string;
        if (event.action.kind === 'move-to-collection') {
          resourceType = 'collection';
          resourceId = event.action.targetCollectionId;
        } else {
          resourceType = 'bulk-action';
          resourceId = `bulk-${event.actorOwnerId}-${event.timestamp.getTime()}`;
        }
        const result = await persistLedgerEvent(
          {
            kind: `bulk.${event.action.kind}`,
            actorId: event.actorOwnerId,
            resourceType,
            resourceId,
            payload: {
              action: event.action,
              manifest: event.manifest,
              timestamp: event.timestamp.toISOString(),
            },
          },
          dbUrl,
        );
        // persistLedgerEvent returns { eventId: null } on failure — map to sentinel.
        return { eventId: result.eventId ?? '' };
      } catch (err) {
        // Defense-in-depth: persistLedgerEvent itself never throws, but guard anyway.
        logger.warn({ err }, 'bulk-restructure: ledger persist wrapper caught — primary op unaffected');
        return { eventId: '' };
      }
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
  const ledgerEmitter = options.ledgerEmitter ?? createDefaultLedgerEmitter(options.dbUrl);
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

    // Load paths of lootFiles in the SAME collections that are NOT in the bulk set.
    // These represent "non-moving" loot whose current paths a proposed path could
    // collide with (mirrors T9's preview collision semantics).
    const bulkCollectionIds = Array.from(new Set(allLootRows.map((l) => l.collectionId)));
    const nonMovingPaths = new Set<string>();
    if (bulkCollectionIds.length > 0 && existingLootIds.length > 0) {
      for (let i = 0; i < bulkCollectionIds.length; i += BATCH) {
        const collectionBatch = bulkCollectionIds.slice(i, i + BATCH);
        // For each collection chunk, find loots NOT in the bulk set and fetch their files
        const nonMovingLootRows = await db()
          .select({ id: schema.loot.id })
          .from(schema.loot)
          .where(
            and(
              inArray(schema.loot.collectionId, collectionBatch),
              notInArray(schema.loot.id, existingLootIds),
            ),
          );
        const nonMovingLootIds = nonMovingLootRows.map((r) => r.id);
        if (nonMovingLootIds.length === 0) continue;
        for (let j = 0; j < nonMovingLootIds.length; j += BATCH) {
          const idBatch = nonMovingLootIds.slice(j, j + BATCH);
          const pathRows = await db()
            .select({ path: schema.lootFiles.path })
            .from(schema.lootFiles)
            .where(inArray(schema.lootFiles.lootId, idBatch));
          for (const r of pathRows) nonMovingPaths.add(r.path);
        }
      }
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

    // Collision detection: among ready candidates + against non-moving loot paths
    for (const candidate of readyCandidates) {
      const { lootId, proposedPath } = candidate;

      // Check collision against non-moving loot in same collection(s)
      // (mirrors T9's preview semantics — a proposed path that hits a current
      // path of a loot NOT in the bulk set is a collision)
      if (nonMovingPaths.has(proposedPath)) {
        verdicts.push({
          kind: 'collision',
          lootId,
          proposedPath,
          conflictingLootIds: [], // non-moving loot IDs aren't resolved back here
        });
        continue;
      }

      // Check self-collision among the bulk set
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

    // Emit ONE Ledger event for the full batch.
    // Defense-in-depth: the default emitter delegates to persistLedgerEvent (which never throws),
    // but an injected test-only or future custom emitter may throw. Ledger failure MUST NOT
    // abort the primary op — all file moves + DB updates have already committed above.
    let eventId = '';
    try {
      const result = await ledgerEmitter.emitBulk({
        action,
        actorOwnerId: ownerId,
        manifest: {
          applied,
          skipped: skipped.map((s) => s.lootId),
          failed: failed.map((f) => f.lootId),
        },
        timestamp: appliedAt,
      });
      eventId = result.eventId;
    } catch (bulkLedgerErr) {
      logger.warn(
        { bulkLedgerErr, action: action.kind },
        'bulk-restructure: ledger emit failed — primary op unaffected',
      );
    }

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

      const sameStashRoot = sourceCollection.stashRootId === targetCollection.stashRootId;

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

      // Per-file move loop. ADR-009: every relocation goes through linkOrCopy,
      // regardless of same-vs-cross stashRoot. T3 tries hardlink first (zero
      // bytes for same-fs) and falls back to byte-copy only on EXDEV.
      // The only case where NO file mutation is needed is when the absolute
      // source path equals the absolute destination path (same stashRoot AND
      // re-resolved template produces the same relative path as the lootFile
      // already has).
      //
      // Multi-file atomicity (Fix 1 from code review): `loot.collectionId`
      // MUST flip to the target BEFORE any file's path is persisted, so a
      // mid-loop failure doesn't leave `collectionId` pointing at the source
      // while some lootFiles already live under the target's stashRoot. We
      // can't wrap the whole operation in a `db.transaction(...)` because
      // better-sqlite3 transaction callbacks are synchronous but T3's
      // `linkOrCopy` hook is async (fs.promises + stream pipeline). The
      // workaround: piggyback the `loot.collectionId` UPDATE onto the FIRST
      // successful file's hook, so it commits atomically with that first
      // lootFiles.path update. Subsequent files' hooks only touch their own
      // path. Any mid-loop failure leaves `collectionId = target`, which
      // matches reality (some files are at destination) and is easy to
      // detect + clean up via the drift-reconciler. This is strictly better
      // than the previous ordering (collectionId set AFTER the loop), which
      // produced an "all-or-nothing" illusion that silently violated the
      // invariant when file 2 of 3 failed.
      let anyFileMoved = false;
      let anyFileFailed = false;
      let anyFileChanged = false; // true if at least one file's absolute path differs
      let collectionIdCommitted = false;

      for (const lf of lootFiles) {
        const ext = path.extname(lf.path);
        const newRelativePath = `${resolveResult.path}${ext}`;
        const absSrcPath = path.join(sourceStashRoot.path, lf.path);
        const absDstPath = path.join(targetStashRoot.path, newRelativePath);

        if (absSrcPath === absDstPath) {
          // No-op at the file level: same absolute path. Nothing to move.
          // The lootFile.path record already matches; only the owning
          // loot.collectionId may need to change (handled after the loop).
          continue;
        }

        anyFileChanged = true;

        const shouldCommitCollectionId = !collectionIdCommitted;

        const moveResult = await linkOrCopy({
          source: absSrcPath,
          destination: absDstPath,
          cleanupPolicy: 'immediate',
          // Do NOT force EXDEV — let T3 attempt hardlink first. For same-fs
          // (including same-stashRoot on a single device) this is zero-byte.
          // For cross-fs (different mounts/devices), T3 catches EXDEV and
          // falls back to byte-copy + hash verification.
          onAfterDestinationVerified: async () => {
            await db()
              .update(schema.lootFiles)
              .set({ path: newRelativePath })
              .where(eq(schema.lootFiles.id, lf.id));

            // Atomic-with-first-file pattern: flip collectionId inside the
            // hook for the first successful move. If this throws, T3 rolls
            // back the destination and leaves source + DB intact.
            if (shouldCommitCollectionId) {
              await db()
                .update(schema.loot)
                .set({ collectionId: targetCollectionId, updatedAt: new Date() })
                .where(eq(schema.loot.id, lootId));
            }
          },
        });

        if (moveResult.status === 'failed') {
          logger.warn(
            { lootId, lootFileId: lf.id, source: absSrcPath, destination: absDstPath, reason: moveResult.reason },
            'bulk-restructure: file move failed during move-to-collection',
          );
          anyFileFailed = true;
          // Continue with other files
        } else {
          anyFileMoved = true;
          if (shouldCommitCollectionId) {
            // Hook succeeded — collectionId is now persisted on target
            collectionIdCommitted = true;
          }
        }
      }

      // If no file's absolute path changed but we still need to move collectionId
      // (same stashRoot + template resolves to current path), that's a pure
      // DB-only collection pointer swap — safe because no file is orphaned.
      if (!anyFileChanged) {
        await db()
          .update(schema.loot)
          .set({ collectionId: targetCollectionId, updatedAt: new Date() })
          .where(eq(schema.loot.id, lootId));

        applied.push(lootId);
        logger.info(
          { lootId, fromCollection: lootRow.collectionId, toCollection: targetCollectionId, sameStashRoot },
          'bulk-restructure: move-to-collection applied (no file paths changed)',
        );
        return;
      }

      if (anyFileFailed && !anyFileMoved) {
        // No file succeeded → collectionId was never committed (first-hook
        // pattern). The Loot is still in the source Collection. Record the
        // failure and return.
        failed.push({ lootId, error: 'All file moves failed during move-to-collection' });
        return;
      }

      // At this point at least one file moved successfully, and (by the
      // first-hook pattern) `collectionId` has already been flipped to the
      // target in the same transaction as that first file's path update.
      // No post-loop `UPDATE loot SET collectionId` is required.

      if (anyFileFailed) {
        // Partial move — record as failed so operator knows to fix orphaned files.
        // collectionId already reflects the target (from the first successful
        // file's hook), so the DB and FS states are consistent with a
        // partial-move scenario and the drift-reconciler can flag unmoved files.
        failed.push({
          lootId,
          error: 'Some files failed to move during move-to-collection; collectionId updated but check file paths',
        });
      } else {
        applied.push(lootId);
        logger.info(
          { lootId, fromCollection: lootRow.collectionId, toCollection: targetCollectionId, sameStashRoot },
          'bulk-restructure: move-to-collection applied',
        );
      }
    } catch (err) {
      failed.push({ lootId, error: err instanceof Error ? err.message : String(err) });
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

      // Stamp loot.updatedAt whenever at least one file actually moved so
      // downstream consumers (indexer, UI listings ordered by updatedAt) see
      // the change. Only skipping when no file moved avoids false-positive
      // "modified" signals for all-unchanged plans.
      if (anyMoved) {
        await db()
          .update(schema.loot)
          .set({ updatedAt: new Date() })
          .where(eq(schema.loot.id, lootId));
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
      failed.push({ lootId, error: err instanceof Error ? err.message : String(err) });
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
