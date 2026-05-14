/**
 * proposal-cache.ts — Server-side adoption proposal cache
 *
 * Stores in-progress AdoptionProposal records in process-local memory so that
 * the multi-step adoption wizard can pass a lightweight `proposalId` between
 * HTTP requests instead of re-running the expensive Scan + Classify phases.
 *
 * Design constraints:
 *   - Process-local (V2 is a monolith; no Redis).
 *   - Scoped to (userId, stashRootId) — both re-checked on every step.
 *   - TTL: 30 min of inactivity (lastAccessedAt).
 *   - Max 4 proposals per user — LRU-evict oldest on overflow.
 *   - Sweeper: lazy setInterval (only started on first put), runs every 5 min.
 *
 * NOTE ON NAME COLLISION:
 *   The orchestrator in `adoption.ts` also exports an `AdoptionProposal` type,
 *   but that type is the *scan result* (stashRootId + candidates + templateOptions
 *   + noPatternDetected). This module's `AdoptionProposal` is the *cache wrapper*
 *   (adds id, userId, createdAt, lastAccessedAt, and uses derivedTemplates instead
 *   of templateOptions). They are intentionally different types serving different
 *   layers. Import with an alias if both are needed in the same file:
 *
 *     import type { AdoptionProposal as CacheProposal } from './proposal-cache';
 *     import type { AdoptionProposal as ScanProposal } from '../adoption';
 */

import type { AdoptionCandidate } from '../adoption';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AdoptionProposal {
  /** UUID, returned to client as proposalId. */
  id: string;
  /** Owner — ACL re-check on every step. */
  userId: string;
  /** Re-checked on every step. */
  stashRootId: string;
  createdAt: Date;
  /** Updated to `now` on every successful getProposal call. */
  lastAccessedAt: Date;
  candidates: AdoptionCandidate[];
  derivedTemplates: { templates: string[]; patternDetected: boolean };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 30-minute TTL from last access. */
export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

/** Maximum proposals kept per user; LRU-evict oldest when exceeded. */
export const PROPOSAL_MAX_PER_USER = 4;

/** Sweeper interval in ms (5 minutes). */
export const PROPOSAL_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

/** Primary store: proposalId → AdoptionProposal */
const proposals = new Map<string, AdoptionProposal>();

/** Secondary index: userId → Set<proposalId> (for fast per-user LRU lookups). */
const userIndex = new Map<string, Set<string>>();

/** Lazy sweeper — only created on first put. */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureUserSet(userId: string): Set<string> {
  let set = userIndex.get(userId);
  if (!set) {
    set = new Set();
    userIndex.set(userId, set);
  }
  return set;
}

/**
 * Removes an entry from both the primary store and the secondary index.
 * Does nothing if the id is unknown.
 */
function evict(id: string): void {
  const entry = proposals.get(id);
  if (!entry) return;
  proposals.delete(id);
  const set = userIndex.get(entry.userId);
  if (set) {
    set.delete(id);
    if (set.size === 0) userIndex.delete(entry.userId);
  }
}

/**
 * For a user that is at or above PROPOSAL_MAX_PER_USER, evicts the single
 * proposal with the oldest `lastAccessedAt`. Called before inserting a new
 * proposal for that user.
 */
function evictLruForUser(userId: string): void {
  const set = userIndex.get(userId);
  if (!set || set.size < PROPOSAL_MAX_PER_USER) return;

  let lruId: string | null = null;
  let lruTime = Infinity;

  for (const id of set) {
    const entry = proposals.get(id);
    if (!entry) continue;
    const t = entry.lastAccessedAt.getTime();
    if (t < lruTime) {
      lruTime = t;
      lruId = id;
    }
  }

  if (lruId !== null) evict(lruId);
}

/** Sweeps all entries whose lastAccessedAt is older than PROPOSAL_TTL_MS. */
function sweep(): void {
  const cutoff = Date.now() - PROPOSAL_TTL_MS;
  for (const [id, entry] of proposals) {
    if (entry.lastAccessedAt.getTime() < cutoff) {
      evict(id);
    }
  }
}

/** Starts the sweeper lazily (called on first put). */
function ensureSweeper(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(sweep, PROPOSAL_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stores a proposal.
 *
 * If the user already has PROPOSAL_MAX_PER_USER proposals, the one with the
 * oldest `lastAccessedAt` is evicted first (LRU policy).
 *
 * Lazily starts the TTL sweeper on the first call.
 */
export function putProposal(p: AdoptionProposal): void {
  ensureSweeper();

  // LRU eviction before inserting if the user is already at the limit.
  evictLruForUser(p.userId);

  proposals.set(p.id, p);
  ensureUserSet(p.userId).add(p.id);
}

/**
 * Retrieves a proposal by id, verifying both the userId and stashRootId match.
 *
 * Returns `null` if:
 *   - The id is unknown.
 *   - The userId does not match.
 *   - The stashRootId does not match.
 *
 * On a successful lookup, updates `lastAccessedAt` to now.
 */
export function getProposal(
  id: string,
  userId: string,
  stashRootId: string,
): AdoptionProposal | null {
  const entry = proposals.get(id);
  if (!entry) return null;
  if (entry.userId !== userId) return null;
  if (entry.stashRootId !== stashRootId) return null;

  entry.lastAccessedAt = new Date();
  return entry;
}

/**
 * Removes a proposal from the cache.
 * No-op if the id is unknown.
 */
export function deleteProposal(id: string): void {
  evict(id);
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * Clears all cache state and cancels the sweeper.
 * ONLY call from tests — mirrors the `resetDbCache` pattern.
 *
 * @internal
 */
export function __resetProposalCacheForTests(): void {
  proposals.clear();
  userIndex.clear();
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
