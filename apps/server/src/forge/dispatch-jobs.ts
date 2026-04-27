/**
 * DispatchJob entry-point — V2-005a-T3
 *
 * Pure-domain functions for creating + reading dispatch_jobs rows. The
 * state-transition functions live in dispatch-state.ts; this file owns the
 * `pending`-row genesis path + the read APIs (get, list).
 *
 * Validation responsibilities here:
 *   - targetKind is one of DISPATCH_TARGET_KINDS
 *   - initialStatus (when supplied) is one of DISPATCH_JOB_STATUSES
 *   - lootId exists AND its collection.ownerId === input.ownerId
 *     (cross-owner → returns 'not-found' so we don't leak existence)
 *   - targetId exists in the right table (printers OR forge_slicers) AND its
 *     ownerId === input.ownerId (cross-owner → 'not-found')
 *
 * No ledger event emitted in T3 — T5 (HTTP routes) or T7 (e2e) may add one
 * later. Keeping this layer pure-domain.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import { logger } from '../logger';
import {
  DISPATCH_JOB_STATUSES,
  DISPATCH_TARGET_KINDS,
  type DispatchJobStatus,
  type DispatchTargetKind,
} from '../db/schema.forge';
import { isDispatchJobStatus, isDispatchTargetKind } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateDispatchJobInput {
  ownerId: string;
  lootId: string;
  /** 'printer' | 'slicer' — discriminator for the targetId poly-FK. */
  targetKind: DispatchTargetKind;
  targetId: string;
  /**
   * Initial status. Default 'pending'. Tests/imports may pass 'claimable'
   * directly to skip preprocessing (e.g. STL → OrcaSlicer needs no
   * conversion or slicing).
   */
  initialStatus?: DispatchJobStatus;
}

export type CreateDispatchJobResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: string; details?: string };

// ---------------------------------------------------------------------------
// createDispatchJob
// ---------------------------------------------------------------------------

/**
 * Create a new DispatchJob row. Default status is 'pending'; callers can
 * override via `initialStatus` (e.g. for STL → slicer, where no
 * conversion/slicing is needed → 'claimable').
 */
export async function createDispatchJob(
  input: CreateDispatchJobInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<CreateDispatchJobResult> {
  // Validate enums first (cheap, no DB hit).
  if (!isDispatchTargetKind(input.targetKind)) {
    return {
      ok: false,
      reason: 'invalid-target-kind',
      details: `targetKind must be one of ${DISPATCH_TARGET_KINDS.join(', ')}; got '${input.targetKind}'`,
    };
  }
  const initialStatus = input.initialStatus ?? 'pending';
  if (!isDispatchJobStatus(initialStatus)) {
    return {
      ok: false,
      reason: 'invalid-status',
      details: `initialStatus must be one of ${DISPATCH_JOB_STATUSES.join(', ')}; got '${initialStatus}'`,
    };
  }

  const db = getServerDb(opts?.dbUrl);

  // Verify the loot exists + belongs to the owner. Loot ownership flows
  // through collections.ownerId — JOIN inline (no helper extracted; only
  // use site).
  const lootRows = await db
    .select({
      lootId: schema.loot.id,
      ownerId: schema.collections.ownerId,
    })
    .from(schema.loot)
    .innerJoin(schema.collections, eq(schema.loot.collectionId, schema.collections.id))
    .where(eq(schema.loot.id, input.lootId))
    .limit(1);
  if (lootRows.length === 0 || lootRows[0]!.ownerId !== input.ownerId) {
    // Cross-owner deliberately collapses to 'not-found' — don't leak existence.
    return {
      ok: false,
      reason: 'loot-not-found',
      details: `loot ${input.lootId} not found for owner ${input.ownerId}`,
    };
  }

  // Verify the target exists + belongs to the owner.
  if (input.targetKind === 'printer') {
    const rows = await db
      .select({ ownerId: schema.printers.ownerId })
      .from(schema.printers)
      .where(eq(schema.printers.id, input.targetId))
      .limit(1);
    if (rows.length === 0 || rows[0]!.ownerId !== input.ownerId) {
      return {
        ok: false,
        reason: 'target-not-found',
        details: `printer ${input.targetId} not found for owner ${input.ownerId}`,
      };
    }
  } else {
    // 'slicer'
    const rows = await db
      .select({ ownerId: schema.forgeSlicers.ownerId })
      .from(schema.forgeSlicers)
      .where(eq(schema.forgeSlicers.id, input.targetId))
      .limit(1);
    if (rows.length === 0 || rows[0]!.ownerId !== input.ownerId) {
      return {
        ok: false,
        reason: 'target-not-found',
        details: `slicer ${input.targetId} not found for owner ${input.ownerId}`,
      };
    }
  }

  const id = randomUUID();
  const now = opts?.now ?? new Date();
  try {
    await db.insert(schema.dispatchJobs).values({
      id,
      ownerId: input.ownerId,
      lootId: input.lootId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      status: initialStatus,
      createdAt: now,
    });
  } catch (err) {
    logger.error(
      { err, id, lootId: input.lootId, targetKind: input.targetKind },
      'createDispatchJob: insert failed',
    );
    return {
      ok: false,
      reason: 'insert-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, jobId: id };
}

// ---------------------------------------------------------------------------
// getDispatchJob
// ---------------------------------------------------------------------------

/**
 * Fetch a single DispatchJob row by id. When `ownerId` is supplied, scopes
 * the lookup to that owner (cross-owner returns null).
 */
export async function getDispatchJob(
  args: { id: string; ownerId?: string },
  opts?: { dbUrl?: string },
): Promise<typeof schema.dispatchJobs.$inferSelect | null> {
  const db = getServerDb(opts?.dbUrl);
  const where = args.ownerId
    ? and(eq(schema.dispatchJobs.id, args.id), eq(schema.dispatchJobs.ownerId, args.ownerId))
    : eq(schema.dispatchJobs.id, args.id);
  const rows = await db
    .select()
    .from(schema.dispatchJobs)
    .where(where)
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// listDispatchJobs
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface ListDispatchJobsArgs {
  ownerId: string;
  status?: DispatchJobStatus;
  limit?: number;
  /** Last id from prior page (keyset pagination on `id` ASC). */
  cursor?: string;
}

export interface ListDispatchJobsResult {
  jobs: Array<typeof schema.dispatchJobs.$inferSelect>;
  nextCursor?: string;
}

/**
 * List a user's dispatch jobs with optional status filter + keyset
 * pagination on `id` ASC. Returns up to `limit` rows (default 50, max 200)
 * and a `nextCursor` if more rows are available.
 */
export async function listDispatchJobs(
  args: ListDispatchJobsArgs,
  opts?: { dbUrl?: string },
): Promise<ListDispatchJobsResult> {
  const db = getServerDb(opts?.dbUrl);
  const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const conditions = [eq(schema.dispatchJobs.ownerId, args.ownerId)];
  if (args.status) conditions.push(eq(schema.dispatchJobs.status, args.status));
  if (args.cursor) conditions.push(gt(schema.dispatchJobs.id, args.cursor));

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const rows = await db
    .select()
    .from(schema.dispatchJobs)
    .where(where)
    .orderBy(asc(schema.dispatchJobs.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && sliced.length > 0 ? sliced[sliced.length - 1]!.id : undefined;
  return { jobs: sliced, ...(nextCursor ? { nextCursor } : {}) };
}
