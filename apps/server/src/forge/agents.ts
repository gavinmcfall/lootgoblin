/**
 * Forge Agent CRUD — V2-005a-T2
 *
 * Pure-domain functions for managing `agents` rows. Mirrors the discriminated-
 * union return-shape pattern used by SlicerProfile (V2-007a-T10) — every
 * mutating function returns `{ ok: true, ... }` or `{ ok: false, reason, details? }`.
 *
 * Agents are NOT user-owned (see schema.forge.ts header). They are
 * instance-scoped infrastructure entities; auth/admin gating happens at the
 * HTTP route layer (`/api/v1/agents/*`). This module deliberately accepts no
 * `actorId`/`role` argument — it is the *layer below* the ACL.
 *
 * Idempotency:
 *   - `createAgent` accepts an optional `id`. If a row with that id already
 *     exists AND its body matches, returns `{ ok: true, agentId }` (idempotent).
 *     If the body differs, returns `{ ok: false, reason: 'id-conflict' }`.
 *   - `central_worker` rows can NOT be created via this function — only via
 *     `bootstrapCentralWorker()`. Returns `reason: 'central-worker-via-bootstrap'`.
 *
 * Delete safety:
 *   - Refuses to delete an agent that is the target of one or more
 *     `printer_reachable_via` rows — the caller must remove the reachability
 *     bindings first. Returns `reason: 'agent-has-reachable-printers'`.
 *   - Refuses to delete the LAST `central_worker` — the bootstrap is supposed
 *     to be the floor of the system. Returns `reason: 'cannot-delete-bootstrap-agent'`.
 *
 * Heartbeat:
 *   - Updates `last_seen_at = now()` on the targeted agent. Idempotent.
 *   - Expected QPS: tens of writes/second per agent on a busy system (claim
 *     loop ticks ~1-2s; couriers will be similar). SQLite WAL handles this
 *     comfortably; no batching/coalescing needed in v2.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import { logger } from '../logger';
import { AGENT_KINDS, type AgentKind } from '../db/schema.forge';
import { isAgentKind } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateAgentInput {
  kind: AgentKind;
  pairCredentialRef?: string | null;
  reachableLanHint?: string | null;
  /** For idempotent re-creates / tests. If omitted, a random UUID is generated. */
  id?: string;
}

export type CreateAgentResult =
  | { ok: true; agentId: string }
  | { ok: false; reason: string; details?: string };

export interface UpdateAgentInput {
  id: string;
  /** Explicit null clears the column; omitted preserves the existing value. */
  pairCredentialRef?: string | null;
  /** Explicit null clears the column; omitted preserves the existing value. */
  reachableLanHint?: string | null;
}

export type UpdateAgentResult =
  | { ok: true }
  | { ok: false; reason: string; details?: string };

export interface DeleteAgentInput {
  id: string;
}

export type DeleteAgentResult =
  | { ok: true }
  | { ok: false; reason: string; details?: string };

export interface ListAgentsInput {
  kind?: AgentKind;
  limit?: number;
  /** Last id from prior page (keyset pagination on `id` ASC). */
  cursor?: string;
}

export interface ListAgentsResult {
  agents: Array<typeof schema.agents.$inferSelect>;
  nextCursor?: string;
}

export interface RecordHeartbeatInput {
  id: string;
}

export type RecordHeartbeatResult =
  | { ok: true }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function normalizeNullable(v: string | null | undefined): string | null | undefined {
  // `undefined` means "not provided / preserve existing"; `null` means "clear".
  return v;
}

function bodyMatches(
  row: typeof schema.agents.$inferSelect,
  input: CreateAgentInput,
): boolean {
  if (row.kind !== input.kind) return false;
  const inputPair = input.pairCredentialRef ?? null;
  const inputHint = input.reachableLanHint ?? null;
  if ((row.pairCredentialRef ?? null) !== inputPair) return false;
  if ((row.reachableLanHint ?? null) !== inputHint) return false;
  return true;
}

// ---------------------------------------------------------------------------
// createAgent
// ---------------------------------------------------------------------------

/**
 * Create a new Agent row. Validates kind against AGENT_KINDS, blocks
 * `central_worker` creation (use `bootstrapCentralWorker` for that), and
 * supports idempotent re-creates when an explicit id is supplied.
 */
export async function createAgent(
  input: CreateAgentInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<CreateAgentResult> {
  if (!isAgentKind(input.kind)) {
    return {
      ok: false,
      reason: 'invalid-kind',
      details: `kind must be one of ${AGENT_KINDS.join(', ')}; got '${input.kind}'`,
    };
  }
  if (input.kind === 'central_worker') {
    return {
      ok: false,
      reason: 'central-worker-via-bootstrap',
      details: 'central_worker agents are created by bootstrapCentralWorker(); not via createAgent()',
    };
  }

  const db = getServerDb(opts?.dbUrl);
  const id = input.id ?? randomUUID();

  // Idempotent re-create path.
  if (input.id) {
    const existing = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, input.id))
      .limit(1);
    if (existing.length > 0) {
      const row = existing[0]!;
      if (bodyMatches(row, input)) {
        return { ok: true, agentId: row.id };
      }
      return {
        ok: false,
        reason: 'id-conflict',
        details: `agent ${input.id} already exists with a different body`,
      };
    }
  }

  const now = opts?.now ?? new Date();
  try {
    await db.insert(schema.agents).values({
      id,
      kind: input.kind,
      pairCredentialRef: normalizeNullable(input.pairCredentialRef) ?? null,
      reachableLanHint: normalizeNullable(input.reachableLanHint) ?? null,
      lastSeenAt: now,
      createdAt: now,
    });
  } catch (err) {
    logger.error({ err, id, kind: input.kind }, 'createAgent: insert failed');
    return {
      ok: false,
      reason: 'insert-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, agentId: id };
}

// ---------------------------------------------------------------------------
// updateAgent
// ---------------------------------------------------------------------------

/**
 * Update mutable fields on an Agent row. Only `pairCredentialRef` and
 * `reachableLanHint` are mutable; `kind` is structural identity. Pass
 * `null` explicitly to clear a column; omit a field to preserve it.
 */
export async function updateAgent(
  args: UpdateAgentInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<UpdateAgentResult> {
  const db = getServerDb(opts?.dbUrl);

  const existing = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, args.id))
    .limit(1);
  if (existing.length === 0) {
    return { ok: false, reason: 'not-found' };
  }

  const patch: Partial<typeof schema.agents.$inferInsert> = {};
  if (args.pairCredentialRef !== undefined) patch.pairCredentialRef = args.pairCredentialRef;
  if (args.reachableLanHint !== undefined) patch.reachableLanHint = args.reachableLanHint;

  if (Object.keys(patch).length === 0) {
    // No-op update. Leave the row alone.
    return { ok: true };
  }

  await db.update(schema.agents).set(patch).where(eq(schema.agents.id, args.id));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// deleteAgent
// ---------------------------------------------------------------------------

/**
 * Delete an Agent row. Refuses if the agent is referenced by
 * `printer_reachable_via` rows (caller must clean up reachability first), or
 * if it would leave the system without a `central_worker`.
 */
export async function deleteAgent(
  args: DeleteAgentInput,
  opts?: { dbUrl?: string },
): Promise<DeleteAgentResult> {
  const db = getServerDb(opts?.dbUrl);

  const existing = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, args.id))
    .limit(1);
  if (existing.length === 0) {
    return { ok: false, reason: 'not-found' };
  }
  const row = existing[0]!;

  // Reachable-via guard.
  const reach = await db
    .select({ printerId: schema.printerReachableVia.printerId })
    .from(schema.printerReachableVia)
    .where(eq(schema.printerReachableVia.agentId, args.id))
    .limit(1);
  if (reach.length > 0) {
    return {
      ok: false,
      reason: 'agent-has-reachable-printers',
      details: 'remove printer_reachable_via bindings before deleting this agent',
    };
  }

  // Last-central-worker guard.
  if (row.kind === 'central_worker') {
    const remaining = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.kind, 'central_worker'));
    if (remaining.length <= 1) {
      return {
        ok: false,
        reason: 'cannot-delete-bootstrap-agent',
        details: 'create a replacement central_worker before deleting the last one',
      };
    }
  }

  await db.delete(schema.agents).where(eq(schema.agents.id, args.id));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// getAgent
// ---------------------------------------------------------------------------

/** Fetch a single Agent row by id, or `null` if absent. */
export async function getAgent(
  args: { id: string },
  opts?: { dbUrl?: string },
): Promise<typeof schema.agents.$inferSelect | null> {
  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, args.id))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// listAgents
// ---------------------------------------------------------------------------

/**
 * List agents with optional kind filter + keyset pagination on `id` ASC.
 * Returns up to `limit` rows (default 50, max 200) and a `nextCursor` if
 * more rows are available.
 */
export async function listAgents(
  args?: ListAgentsInput,
  opts?: { dbUrl?: string },
): Promise<ListAgentsResult> {
  const db = getServerDb(opts?.dbUrl);
  const limit = Math.min(args?.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const conditions = [];
  if (args?.kind) conditions.push(eq(schema.agents.kind, args.kind));
  if (args?.cursor) conditions.push(gt(schema.agents.id, args.cursor));

  const where =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
      ? conditions[0]
      : and(...conditions);

  const rows = await (where
    ? db.select().from(schema.agents).where(where).orderBy(asc(schema.agents.id)).limit(limit + 1)
    : db.select().from(schema.agents).orderBy(asc(schema.agents.id)).limit(limit + 1));

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && sliced.length > 0 ? sliced[sliced.length - 1]!.id : undefined;
  return { agents: sliced, ...(nextCursor ? { nextCursor } : {}) };
}

// ---------------------------------------------------------------------------
// recordHeartbeat
// ---------------------------------------------------------------------------

/**
 * Bump `last_seen_at` to now() on the targeted agent. Idempotent — every call
 * advances the timestamp.
 *
 * Expected QPS: ~10s of writes/second per agent on a busy system (claim loop
 * tick cadence is 1-2s; couriers similar). Well within SQLite WAL tolerance;
 * no batching needed in v2.
 */
export async function recordHeartbeat(
  args: RecordHeartbeatInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<RecordHeartbeatResult> {
  const db = getServerDb(opts?.dbUrl);
  const existing = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.id, args.id))
    .limit(1);
  if (existing.length === 0) {
    return { ok: false, reason: 'not-found' };
  }

  const now = opts?.now ?? new Date();
  await db
    .update(schema.agents)
    .set({ lastSeenAt: now })
    .where(eq(schema.agents.id, args.id));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// computeAgentLiveness — V2-006a-T9
// ---------------------------------------------------------------------------

/**
 * How long (ms) after the last heartbeat before we consider a courier offline.
 * Default: 3 × 30-second heartbeat interval = 90_000 ms.
 * Override via COURIER_OFFLINE_AFTER_MS environment variable.
 */
export const OFFLINE_AFTER_MS: number = (() => {
  const env = process.env.COURIER_OFFLINE_AFTER_MS;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 90_000; // 3 × 30s heartbeat default
})();

/**
 * Pure function — no DB access.
 *
 * An agent is `'online'` when it sent a heartbeat within `OFFLINE_AFTER_MS`
 * of `now`. It is `'offline'` when `lastSeenAt` is null (never heartbeated)
 * OR when the elapsed time since `lastSeenAt` exceeds `OFFLINE_AFTER_MS`.
 */
export function computeAgentLiveness(
  lastSeenAt: Date | null,
  now: Date,
): 'online' | 'offline' {
  if (lastSeenAt === null) return 'offline';
  const elapsed = now.getTime() - lastSeenAt.getTime();
  return elapsed <= OFFLINE_AFTER_MS ? 'online' : 'offline';
}

// ---------------------------------------------------------------------------
// listJobsBlockedByOfflineCourier — V2-006a-T9
// ---------------------------------------------------------------------------

export interface BlockedJobRow {
  jobId: string;
  printerId: string;
  agentId: string;
}

/**
 * Returns `dispatch_jobs` rows that are `status='claimable'` AND whose target
 * printer is reachable ONLY via couriers that are currently offline.
 *
 * A job is NOT blocked when:
 *   - At least one `central_worker` has a `printer_reachable_via` row for the
 *     printer (central workers are always considered reachable).
 *   - At least one courier agent in the job's `printer_reachable_via` set is
 *     currently online (heartbeat within OFFLINE_AFTER_MS).
 *
 * The function returns one row per (job, blocking offline agent) pair, so a
 * job with two offline-courier reachability entries will appear twice — callers
 * that want unique job IDs should deduplicate.
 */
export async function listJobsBlockedByOfflineCourier(
  opts?: { now?: Date; dbUrl?: string },
): Promise<BlockedJobRow[]> {
  const db = getServerDb(opts?.dbUrl);
  const now = opts?.now ?? new Date();

  // 1. Fetch all claimable jobs.
  const claimableJobs = await db
    .select({
      id: schema.dispatchJobs.id,
      targetId: schema.dispatchJobs.targetId,
      targetKind: schema.dispatchJobs.targetKind,
    })
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.status, 'claimable'));

  if (claimableJobs.length === 0) return [];

  // Only consider printer-target jobs (slicer-target jobs don't route via couriers).
  const printerJobs = claimableJobs.filter((j) => j.targetKind === 'printer');
  if (printerJobs.length === 0) return [];

  const printerIds = [...new Set(printerJobs.map((j) => j.targetId))];

  // 2. Fetch all printer_reachable_via rows for these printers, joined with agent kind + lastSeenAt.
  const reachRows = await db
    .select({
      printerId: schema.printerReachableVia.printerId,
      agentId: schema.printerReachableVia.agentId,
      agentKind: schema.agents.kind,
      lastSeenAt: schema.agents.lastSeenAt,
    })
    .from(schema.printerReachableVia)
    .innerJoin(schema.agents, eq(schema.printerReachableVia.agentId, schema.agents.id))
    .where(inArray(schema.printerReachableVia.printerId, printerIds));

  // 3. Group by printer: determine which printers are blocked.
  //    A printer is blocked iff every agent that can reach it is an offline courier.
  const printerAgentMap = new Map<string, Array<{ agentId: string; agentKind: string; lastSeenAt: Date | null }>>();
  for (const row of reachRows) {
    const list = printerAgentMap.get(row.printerId) ?? [];
    list.push({ agentId: row.agentId, agentKind: row.agentKind, lastSeenAt: row.lastSeenAt });
    printerAgentMap.set(row.printerId, list);
  }

  const result: BlockedJobRow[] = [];

  for (const job of printerJobs) {
    const agents = printerAgentMap.get(job.targetId) ?? [];
    if (agents.length === 0) continue; // no reachability rows → not our concern

    // If any agent is a central_worker or an online courier → not blocked.
    const hasUnblockedPath = agents.some((a) => {
      if (a.agentKind === 'central_worker') return true;
      return computeAgentLiveness(a.lastSeenAt, now) === 'online';
    });

    if (hasUnblockedPath) continue;

    // All agents are offline couriers — emit one row per offline agent.
    for (const a of agents) {
      result.push({ jobId: job.id, printerId: job.targetId, agentId: a.agentId });
    }
  }

  return result;
}
