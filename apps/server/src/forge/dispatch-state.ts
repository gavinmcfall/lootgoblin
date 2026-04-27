/**
 * DispatchJob state machine — V2-005a-T3
 *
 * Pure-domain transition functions. Every transition uses an atomic
 * UPDATE-with-WHERE pattern (V2-003 ingest-worker discipline):
 *
 *   UPDATE dispatch_jobs
 *      SET status = '<next>', <other-fields>
 *    WHERE id = ? AND status = '<expected-current>'
 *
 * If `changes === 1`: success.
 * If `changes === 0`: a race lost OR the job is in a different state. We
 * follow up with a SELECT on the row's current state and return either
 * `wrong-state` (with the current state in the response) or `not-found`.
 *
 * Legal transitions (single source of truth):
 *
 *   pending     → converting | slicing | claimable | failed
 *   converting  → slicing | claimable | failed
 *   slicing     → claimable | failed
 *   claimable   → claimed | failed
 *   claimed     → dispatched | failed | claimable   (last = stale-recovery)
 *   dispatched  → completed | failed
 *   completed   → (terminal)
 *   failed      → (terminal)
 *
 * `pending → claimable` directly is allowed for jobs that need NO conversion
 * AND NO slicing (e.g. an STL going to OrcaSlicer — the slicer accepts STL
 * natively, no preprocessing needed).
 *
 * `claimed → claimable` is the stale-recovery transition (T4 claim loop will
 * use this on startup to recover claims left dangling by a crashed agent).
 *
 * No idempotent re-transitions: calling `markCompleted` on a job already in
 * `completed` returns `{ ok: false, reason: 'wrong-state' }`. Callers that
 * care should query state first.
 */

import { and, eq, inArray, lt } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import {
  DISPATCH_JOB_STATUSES,
  DISPATCH_FAILURE_REASONS,
  type DispatchJobStatus,
  type DispatchFailureReason,
} from '../db/schema.forge';

// ---------------------------------------------------------------------------
// State graph
// ---------------------------------------------------------------------------

/**
 * Adjacency table for the dispatch_jobs state machine. The keys are the
 * source states; the values are the set of legal target states from that
 * source. Keep in sync with the schema's DISPATCH_JOB_STATUSES enum.
 */
export const LEGAL_TRANSITIONS: ReadonlyMap<
  DispatchJobStatus,
  ReadonlySet<DispatchJobStatus>
> = new Map<DispatchJobStatus, ReadonlySet<DispatchJobStatus>>([
  ['pending', new Set<DispatchJobStatus>(['converting', 'slicing', 'claimable', 'failed'])],
  ['converting', new Set<DispatchJobStatus>(['slicing', 'claimable', 'failed'])],
  ['slicing', new Set<DispatchJobStatus>(['claimable', 'failed'])],
  ['claimable', new Set<DispatchJobStatus>(['claimed', 'failed'])],
  // claimed → claimable is the stale-recovery transition (T4 claim loop).
  ['claimed', new Set<DispatchJobStatus>(['dispatched', 'failed', 'claimable'])],
  ['dispatched', new Set<DispatchJobStatus>(['completed', 'failed'])],
  ['completed', new Set<DispatchJobStatus>()], // terminal
  ['failed', new Set<DispatchJobStatus>()], // terminal
]);

/** Terminal states. No outgoing transitions. */
export const TERMINAL_STATES: ReadonlySet<DispatchJobStatus> = new Set<DispatchJobStatus>([
  'completed',
  'failed',
]);

/** Is `from → to` a legal transition per the state graph? */
export function isLegalTransition(
  from: DispatchJobStatus,
  to: DispatchJobStatus,
): boolean {
  return LEGAL_TRANSITIONS.get(from)?.has(to) ?? false;
}

// ---------------------------------------------------------------------------
// Transition result type
// ---------------------------------------------------------------------------

export type TransitionResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'wrong-state' | 'not-found' | 'race-lost' | 'invalid-arg';
      currentState?: DispatchJobStatus;
      details?: string;
    };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ServerDb = ReturnType<typeof getServerDb>;

/**
 * Run an atomic UPDATE with `id = ? AND status IN (...)` guard. Returns the
 * better-sqlite3 `changes` count.
 */
function runGuardedUpdate(
  db: ServerDb,
  id: string,
  expectedStates: DispatchJobStatus[],
  patch: Partial<typeof schema.dispatchJobs.$inferInsert>,
): number {
  // Drizzle better-sqlite3 doesn't expose `changes` on the awaited promise of
  // .update().set().where() in the same shape as workers/ingest-worker.ts —
  // we use `.run()` (sync) to access it, mirroring that pattern.
  const where =
    expectedStates.length === 1
      ? and(
          eq(schema.dispatchJobs.id, id),
          eq(schema.dispatchJobs.status, expectedStates[0]!),
        )
      : and(
          eq(schema.dispatchJobs.id, id),
          inArray(schema.dispatchJobs.status, expectedStates as unknown as string[]),
        );

  const result = db
    .update(schema.dispatchJobs)
    .set(patch)
    .where(where)
    .run();
  return (result as unknown as { changes?: number }).changes ?? 0;
}

/** Look up the current row state for the wrong-state / not-found follow-up. */
async function lookupCurrentState(
  db: ServerDb,
  id: string,
): Promise<DispatchJobStatus | null> {
  const rows = await db
    .select({ status: schema.dispatchJobs.status })
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.id, id))
    .limit(1);
  if (rows.length === 0) return null;
  const status = rows[0]!.status;
  // The DB column is plain text; coerce via the type guard's union.
  return status as DispatchJobStatus;
}

/**
 * Build the `{ ok: false, reason: ... }` result for a transition that
 * affected zero rows. Distinguishes `not-found` from `wrong-state`.
 */
async function explainMiss(
  db: ServerDb,
  id: string,
  attempted: DispatchJobStatus,
): Promise<TransitionResult> {
  const current = await lookupCurrentState(db, id);
  if (current === null) {
    return { ok: false, reason: 'not-found' };
  }
  return {
    ok: false,
    reason: 'wrong-state',
    currentState: current,
    details: `cannot transition to '${attempted}' from '${current}'`,
  };
}

// ---------------------------------------------------------------------------
// Per-transition functions
// ---------------------------------------------------------------------------

/**
 * pending → converting. Used when the job needs format conversion before
 * slicing/claiming.
 */
export async function markConverting(
  args: { jobId: string },
  opts?: { dbUrl?: string },
): Promise<TransitionResult> {
  const db = getServerDb(opts?.dbUrl);
  const changes = runGuardedUpdate(db, args.jobId, ['pending'], {
    status: 'converting',
  });
  if (changes === 1) return { ok: true };
  return explainMiss(db, args.jobId, 'converting');
}

/**
 * pending|converting → slicing. The caller must specify the expected source
 * state (pending or converting).
 */
export async function markSlicing(
  args: { jobId: string; from: 'pending' | 'converting' },
  opts?: { dbUrl?: string },
): Promise<TransitionResult> {
  if (args.from !== 'pending' && args.from !== 'converting') {
    return {
      ok: false,
      reason: 'invalid-arg',
      details: `markSlicing.from must be 'pending' or 'converting'; got '${args.from}'`,
    };
  }
  const db = getServerDb(opts?.dbUrl);
  const changes = runGuardedUpdate(db, args.jobId, [args.from], {
    status: 'slicing',
  });
  if (changes === 1) return { ok: true };
  return explainMiss(db, args.jobId, 'slicing');
}

/**
 * pending|converting|slicing → claimable. The caller must specify the
 * expected source state.
 */
export async function markClaimable(
  args: { jobId: string; from: 'pending' | 'converting' | 'slicing' },
  opts?: { dbUrl?: string },
): Promise<TransitionResult> {
  if (
    args.from !== 'pending' &&
    args.from !== 'converting' &&
    args.from !== 'slicing'
  ) {
    return {
      ok: false,
      reason: 'invalid-arg',
      details: `markClaimable.from must be 'pending' | 'converting' | 'slicing'; got '${args.from}'`,
    };
  }
  const db = getServerDb(opts?.dbUrl);
  const changes = runGuardedUpdate(db, args.jobId, [args.from], {
    status: 'claimable',
  });
  if (changes === 1) return { ok: true };
  return explainMiss(db, args.jobId, 'claimable');
}

/**
 * claimable → claimed. Stamps `claim_marker = agentId` and `claimed_at = now`
 * atomically with the status flip. Race-safe by the WHERE clause.
 */
export async function markClaimed(
  args: { jobId: string; agentId: string },
  opts?: { dbUrl?: string; now?: Date },
): Promise<TransitionResult> {
  const db = getServerDb(opts?.dbUrl);
  const now = opts?.now ?? new Date();
  const changes = runGuardedUpdate(db, args.jobId, ['claimable'], {
    status: 'claimed',
    claimMarker: args.agentId,
    claimedAt: now,
  });
  if (changes === 1) return { ok: true };
  return explainMiss(db, args.jobId, 'claimed');
}

/**
 * claimed → dispatched. Stamps `started_at = now` to mark the moment the
 * adapter handed the job off to the printer/slicer.
 */
export async function markDispatched(
  args: { jobId: string },
  opts?: { dbUrl?: string; now?: Date },
): Promise<TransitionResult> {
  const db = getServerDb(opts?.dbUrl);
  const now = opts?.now ?? new Date();
  const changes = runGuardedUpdate(db, args.jobId, ['claimed'], {
    status: 'dispatched',
    startedAt: now,
  });
  if (changes === 1) return { ok: true };
  return explainMiss(db, args.jobId, 'dispatched');
}

/**
 * dispatched → completed. Terminal-success transition. Stamps
 * `completed_at = now`.
 */
export async function markCompleted(
  args: { jobId: string },
  opts?: { dbUrl?: string; now?: Date },
): Promise<TransitionResult> {
  const db = getServerDb(opts?.dbUrl);
  const now = opts?.now ?? new Date();
  const changes = runGuardedUpdate(db, args.jobId, ['dispatched'], {
    status: 'completed',
    completedAt: now,
  });
  if (changes === 1) return { ok: true };
  return explainMiss(db, args.jobId, 'completed');
}

/**
 * any non-terminal → failed. Accepts pending|converting|slicing|claimable|
 * claimed|dispatched as source. Stamps `completed_at`, `failure_reason`,
 * `failure_details`.
 */
export async function markFailed(
  args: { jobId: string; reason: DispatchFailureReason; details?: string },
  opts?: { dbUrl?: string; now?: Date },
): Promise<TransitionResult> {
  if (!(DISPATCH_FAILURE_REASONS as readonly string[]).includes(args.reason)) {
    return {
      ok: false,
      reason: 'invalid-arg',
      details: `failure reason must be one of ${DISPATCH_FAILURE_REASONS.join(', ')}; got '${args.reason}'`,
    };
  }
  const db = getServerDb(opts?.dbUrl);
  const now = opts?.now ?? new Date();
  const nonTerminal: DispatchJobStatus[] = [
    'pending',
    'converting',
    'slicing',
    'claimable',
    'claimed',
    'dispatched',
  ];
  const changes = runGuardedUpdate(db, args.jobId, nonTerminal, {
    status: 'failed',
    completedAt: now,
    failureReason: args.reason,
    failureDetails: args.details ?? null,
  });
  if (changes === 1) return { ok: true };
  return explainMiss(db, args.jobId, 'failed');
}

/**
 * Stale-claim recovery. claimed → claimable IFF
 *   `claim_marker = agentId AND claimed_at < now - claimTimeoutMs`.
 *
 * Called by T4's claim loop on startup so an agent can reclaim its own
 * abandoned jobs (e.g. after a crash + restart). NULLs out `claim_marker`
 * and `claimed_at` so the next claim cycle starts clean.
 *
 * Returns `wrong-state` with the current state if the job isn't in
 * `claimed`, or `not-found` if the row is gone, or `wrong-state` (with
 * `currentState='claimed'`) when the job IS claimed but the caller's claim
 * predicate (agent + age) doesn't match — distinguishing those last two
 * isn't load-bearing for callers, since both mean "don't try to recover".
 */
export async function unclaimStaleJob(
  args: { jobId: string; agentId: string; claimTimeoutMs: number },
  opts?: { dbUrl?: string; now?: Date },
): Promise<TransitionResult> {
  const db = getServerDb(opts?.dbUrl);
  const now = opts?.now ?? new Date();
  const cutoff = new Date(now.getTime() - args.claimTimeoutMs);

  const result = db
    .update(schema.dispatchJobs)
    .set({
      status: 'claimable',
      claimMarker: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(schema.dispatchJobs.id, args.jobId),
        eq(schema.dispatchJobs.status, 'claimed'),
        eq(schema.dispatchJobs.claimMarker, args.agentId),
        lt(schema.dispatchJobs.claimedAt, cutoff),
      ),
    )
    .run();
  const changes = (result as unknown as { changes?: number }).changes ?? 0;
  if (changes === 1) return { ok: true };
  return explainMiss(db, args.jobId, 'claimable');
}

// ---------------------------------------------------------------------------
// Re-exports for callers
// ---------------------------------------------------------------------------

export { DISPATCH_JOB_STATUSES };
