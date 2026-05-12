/**
 * ACL resolver for quarantine_items — Quarantine HTTP Layer
 *
 * Quarantine items are owned by whoever owns the parent stashRoot.
 * This resolver does the DB lookup (quarantine_items → stash_roots.ownerId)
 * and applies the permission rules:
 *
 *   owner  → read + write allowed
 *   admin  → read allowed (cross-owner visibility for triage)
 *   admin write cross-owner → denied (not-found) — avoids accidental cross-tenant mutation
 *   non-owner non-admin → denied (not-found) — hides item existence (no 403 leak)
 *
 * All deny paths return reason: 'not-found' to avoid leaking the existence
 * of a quarantine item the caller is not permitted to see.
 */

import { eq } from 'drizzle-orm';
import { getServerDb, schema } from '../db/client';
import type { AuthenticatedActor } from '../auth/request-auth';

export interface QuarantineAclResult {
  allowed: boolean;
  reason?: 'not-found';
  /** The ownerId of the parent stashRoot — populated when allowed:true. */
  ownerId?: string;
}

/**
 * Resolves whether `actor` may perform `action` on the given quarantine item.
 *
 * @param actor    Authenticated caller from authenticateRequest().
 * @param itemId   PK of the quarantine_items row.
 * @param action   'read' or 'write'.
 * @param dbUrl    Optional DB URL override (for tests). Defaults to env.DATABASE_URL.
 */
export async function resolveQuarantineAcl(
  actor: AuthenticatedActor,
  itemId: string,
  action: 'read' | 'write',
  dbUrl?: string,
): Promise<QuarantineAclResult> {
  const db = getServerDb(dbUrl);

  // Look up the quarantine item to find its parent stashRoot.
  const itemRows = await db
    .select({
      id: schema.quarantineItems.id,
      stashRootId: schema.quarantineItems.stashRootId,
    })
    .from(schema.quarantineItems)
    .where(eq(schema.quarantineItems.id, itemId))
    .limit(1);

  if (itemRows.length === 0) {
    return { allowed: false, reason: 'not-found' };
  }

  // Look up the owning stashRoot.
  const rootRows = await db
    .select({ ownerId: schema.stashRoots.ownerId })
    .from(schema.stashRoots)
    .where(eq(schema.stashRoots.id, itemRows[0]!.stashRootId))
    .limit(1);

  if (rootRows.length === 0) {
    // Orphaned quarantine item (should not happen with FK cascade, but be safe).
    return { allowed: false, reason: 'not-found' };
  }

  const ownerId = rootRows[0]!.ownerId;

  // Owner can read and write.
  if (ownerId === actor.id) {
    return { allowed: true, ownerId };
  }

  // Admin can read cross-owner (for triage), but NOT write (avoid accidental
  // cross-tenant mutation — mirrors the Forge printer consent model).
  if (actor.role === 'admin' && action === 'read') {
    return { allowed: true, ownerId };
  }

  // Everyone else (including admin writes to non-owned items) → not-found.
  // Return 'not-found' rather than 'not-owner' to hide item existence.
  return { allowed: false, reason: 'not-found' };
}
