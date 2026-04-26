/**
 * GrimoireAttachment routes — V2-007a-T11
 *
 * Pure-domain functions that link a Loot to either a SlicerProfile or a
 * PrintSetting (XOR — exactly one per row). The HTTP surface comes in T14;
 * this module is the validated, owner-scoped core.
 *
 * Architectural decisions (LOCKED):
 *   - XOR enforcement at app layer via `isExactlyOneAttachmentTarget` (T2).
 *   - Owner-scoped at every function: input always carries `ownerId`. The
 *     function verifies that the Loot, the SlicerProfile/PrintSetting, AND
 *     the attachment row itself belong to that owner. Loot ownership flows
 *     through the Collection (V2-002 pattern — `loot` has no direct
 *     `ownerId` column).
 *   - NO ledger emission (matches T10 reasoning — attachments are config,
 *     not a domain operation).
 *   - Multiple attachments per Loot allowed. T11 doesn't enforce uniqueness;
 *     T14 HTTP routes can layer optional uniqueness if needed.
 *
 * Reason codes (mutations):
 *   attachment-target-xor-violation — both or neither of profile/setting set
 *   loot-not-found                  — missing OR cross-owner (404 semantics)
 *   profile-not-found               — missing OR cross-owner
 *   setting-not-found               — missing OR cross-owner
 *   attachment-not-found            — missing OR cross-owner
 *   invalid-note                    — empty after trim
 *   persist-failed                  — DB raised
 */

import * as crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import { logger } from '../logger';
import { isExactlyOneAttachmentTarget } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttachToLootInput {
  ownerId: string;
  lootId: string;
  slicerProfileId?: string | null;
  printSettingId?: string | null;
  note?: string;
}

export type AttachToLootResult =
  | { ok: true; attachmentId: string }
  | { ok: false; reason: string; details?: string };

export interface DetachFromLootInput {
  attachmentId: string;
  ownerId: string;
}

export type DetachFromLootResult =
  | { ok: true }
  | { ok: false; reason: string; details?: string };

// ---------------------------------------------------------------------------
// Internal: loot ownership check
// ---------------------------------------------------------------------------

/**
 * Verify the given lootId belongs (transitively, via collection) to ownerId.
 * Returns true iff the loot exists AND its collection.ownerId === ownerId.
 *
 * Loot has no direct `ownerId` column — ownership flows through the
 * Collection. Mirrors V2-002 T12 routes (apps/server/src/app/api/v1/loot/[id]/route.ts).
 */
async function lootBelongsToOwner(
  db: ReturnType<typeof getServerDb>,
  lootId: string,
  ownerId: string,
): Promise<boolean> {
  const rows = await db
    .select({ collectionOwnerId: schema.collections.ownerId })
    .from(schema.loot)
    .innerJoin(schema.collections, eq(schema.collections.id, schema.loot.collectionId))
    .where(eq(schema.loot.id, lootId))
    .limit(1);
  if (rows.length === 0) return false;
  return rows[0]!.collectionOwnerId === ownerId;
}

// ---------------------------------------------------------------------------
// attachToLoot
// ---------------------------------------------------------------------------

/**
 * Create a new GrimoireAttachment linking a Loot to either a SlicerProfile
 * or a PrintSetting (XOR).
 *
 * Validation order (cheapest first):
 *   1. XOR check on slicerProfileId / printSettingId (no DB)
 *   2. note trim + non-empty (if provided)
 *   3. Loot ownership (collection-mediated)
 *   4. Profile/setting ownership
 *   5. Insert attachment row
 */
export async function attachToLoot(
  input: AttachToLootInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<AttachToLootResult> {
  if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    return { ok: false, reason: 'owner-required' };
  }
  if (typeof input.lootId !== 'string' || input.lootId.length === 0) {
    return { ok: false, reason: 'loot-not-found' };
  }

  // Normalise empty strings to null for the XOR check — empty string ===
  // not-set per spec (test 5).
  const slicerProfileId =
    typeof input.slicerProfileId === 'string' && input.slicerProfileId.length > 0
      ? input.slicerProfileId
      : null;
  const printSettingId =
    typeof input.printSettingId === 'string' && input.printSettingId.length > 0
      ? input.printSettingId
      : null;

  if (!isExactlyOneAttachmentTarget({ slicerProfileId, printSettingId })) {
    return { ok: false, reason: 'attachment-target-xor-violation' };
  }

  // Note: optional, free-form. Empty-after-trim is rejected (rare).
  let note: string | null = null;
  if (input.note !== undefined) {
    if (typeof input.note !== 'string') {
      return { ok: false, reason: 'invalid-note' };
    }
    const trimmed = input.note.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: 'invalid-note' };
    }
    note = trimmed;
  }

  const db = getServerDb(opts?.dbUrl);

  // Loot ownership (collection-mediated).
  const lootOwned = await lootBelongsToOwner(db, input.lootId, input.ownerId);
  if (!lootOwned) {
    return { ok: false, reason: 'loot-not-found' };
  }

  // Profile/setting ownership — only the one that's actually set.
  if (slicerProfileId !== null) {
    const profileRows = await db
      .select({ id: schema.slicerProfiles.id })
      .from(schema.slicerProfiles)
      .where(
        and(
          eq(schema.slicerProfiles.id, slicerProfileId),
          eq(schema.slicerProfiles.ownerId, input.ownerId),
        ),
      )
      .limit(1);
    if (profileRows.length === 0) {
      return { ok: false, reason: 'profile-not-found' };
    }
  } else if (printSettingId !== null) {
    const settingRows = await db
      .select({ id: schema.printSettings.id })
      .from(schema.printSettings)
      .where(
        and(
          eq(schema.printSettings.id, printSettingId),
          eq(schema.printSettings.ownerId, input.ownerId),
        ),
      )
      .limit(1);
    if (settingRows.length === 0) {
      return { ok: false, reason: 'setting-not-found' };
    }
  }

  const id = crypto.randomUUID();
  const now = opts?.now ?? new Date();

  try {
    await db.insert(schema.grimoireAttachments).values({
      id,
      lootId: input.lootId,
      slicerProfileId,
      printSettingId,
      note,
      ownerId: input.ownerId,
      attachedAt: now,
    });
    return { ok: true, attachmentId: id };
  } catch (err) {
    logger.warn(
      { err, attachmentId: id, ownerId: input.ownerId, lootId: input.lootId },
      'attachToLoot: persist failed',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// detachFromLoot
// ---------------------------------------------------------------------------

/**
 * Hard delete of a GrimoireAttachment row.
 *
 * Reason codes:
 *   attachment-not-found — missing OR cross-owner (404 semantics)
 *   persist-failed
 */
export async function detachFromLoot(
  input: DetachFromLootInput,
  opts?: { dbUrl?: string },
): Promise<DetachFromLootResult> {
  if (typeof input.attachmentId !== 'string' || input.attachmentId.length === 0) {
    return { ok: false, reason: 'attachment-not-found' };
  }
  if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    return { ok: false, reason: 'owner-required' };
  }

  const db = getServerDb(opts?.dbUrl);

  const existing = await db
    .select({ id: schema.grimoireAttachments.id })
    .from(schema.grimoireAttachments)
    .where(
      and(
        eq(schema.grimoireAttachments.id, input.attachmentId),
        eq(schema.grimoireAttachments.ownerId, input.ownerId),
      ),
    )
    .limit(1);
  if (existing.length === 0) {
    return { ok: false, reason: 'attachment-not-found' };
  }

  try {
    await db
      .delete(schema.grimoireAttachments)
      .where(
        and(
          eq(schema.grimoireAttachments.id, input.attachmentId),
          eq(schema.grimoireAttachments.ownerId, input.ownerId),
        ),
      );
    return { ok: true };
  } catch (err) {
    logger.warn(
      { err, attachmentId: input.attachmentId, ownerId: input.ownerId },
      'detachFromLoot: persist failed',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// getAttachment
// ---------------------------------------------------------------------------

/**
 * Owner-scoped fetch by id. Cross-owner returns null (don't leak existence).
 */
export async function getAttachment(
  args: { id: string; ownerId: string },
  opts?: { dbUrl?: string },
): Promise<typeof schema.grimoireAttachments.$inferSelect | null> {
  if (typeof args.id !== 'string' || args.id.length === 0) return null;
  if (typeof args.ownerId !== 'string' || args.ownerId.length === 0) return null;

  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select()
    .from(schema.grimoireAttachments)
    .where(
      and(
        eq(schema.grimoireAttachments.id, args.id),
        eq(schema.grimoireAttachments.ownerId, args.ownerId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// listAttachmentsForLoot
// ---------------------------------------------------------------------------

/**
 * Forward lookup: every attachment row pinned to a given Loot, owner-scoped.
 * Sorted by attachedAt DESC (most recent first). Cross-owner Loot → empty
 * array (not error).
 */
export async function listAttachmentsForLoot(
  args: { lootId: string; ownerId: string },
  opts?: { dbUrl?: string },
): Promise<Array<typeof schema.grimoireAttachments.$inferSelect>> {
  if (typeof args.lootId !== 'string' || args.lootId.length === 0) return [];
  if (typeof args.ownerId !== 'string' || args.ownerId.length === 0) return [];

  const db = getServerDb(opts?.dbUrl);

  // Owner-scope at the attachment level — defence-in-depth even though the
  // FK + collection-ownership relationship should guarantee parity.
  const rows = await db
    .select()
    .from(schema.grimoireAttachments)
    .where(
      and(
        eq(schema.grimoireAttachments.lootId, args.lootId),
        eq(schema.grimoireAttachments.ownerId, args.ownerId),
      ),
    )
    .orderBy(desc(schema.grimoireAttachments.attachedAt));
  return rows;
}

// ---------------------------------------------------------------------------
// listAttachmentsForProfile
// ---------------------------------------------------------------------------

/**
 * Reverse lookup: which attachments reference this SlicerProfile?
 * Owner-scoped — cross-owner profile → empty array.
 * Sorted by attachedAt DESC.
 */
export async function listAttachmentsForProfile(
  args: { slicerProfileId: string; ownerId: string },
  opts?: { dbUrl?: string },
): Promise<Array<typeof schema.grimoireAttachments.$inferSelect>> {
  if (typeof args.slicerProfileId !== 'string' || args.slicerProfileId.length === 0) return [];
  if (typeof args.ownerId !== 'string' || args.ownerId.length === 0) return [];

  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select()
    .from(schema.grimoireAttachments)
    .where(
      and(
        eq(schema.grimoireAttachments.slicerProfileId, args.slicerProfileId),
        eq(schema.grimoireAttachments.ownerId, args.ownerId),
      ),
    )
    .orderBy(desc(schema.grimoireAttachments.attachedAt));
  return rows;
}

// ---------------------------------------------------------------------------
// listAttachmentsForSetting
// ---------------------------------------------------------------------------

/**
 * Reverse lookup: which attachments reference this PrintSetting?
 * Owner-scoped — cross-owner setting → empty array.
 * Sorted by attachedAt DESC.
 */
export async function listAttachmentsForSetting(
  args: { printSettingId: string; ownerId: string },
  opts?: { dbUrl?: string },
): Promise<Array<typeof schema.grimoireAttachments.$inferSelect>> {
  if (typeof args.printSettingId !== 'string' || args.printSettingId.length === 0) return [];
  if (typeof args.ownerId !== 'string' || args.ownerId.length === 0) return [];

  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select()
    .from(schema.grimoireAttachments)
    .where(
      and(
        eq(schema.grimoireAttachments.printSettingId, args.printSettingId),
        eq(schema.grimoireAttachments.ownerId, args.ownerId),
      ),
    )
    .orderBy(desc(schema.grimoireAttachments.attachedAt));
  return rows;
}
