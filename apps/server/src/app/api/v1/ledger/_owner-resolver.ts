// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Owner resolution helpers for /api/v1/ledger/* routes — Ledger HTTP Layer
 *
 * Shared between:
 *   route.ts        — list endpoint (batchResolveOwners for pages of rows)
 *   [id]/route.ts   — detail endpoint (resolveOwnerForRow for a single row)
 *
 * ACL model (locked 2026-05-12: ownership-only for non-admins on Receipts surface)
 * ──────────────────────────────────────────────────────────────────────────────────
 * Supported subject kinds with direct ownership resolution:
 *   material         — materials.owner_id
 *   collection       — collections.owner_id
 *   loot             — loot → collections.owner_id (via join)
 *   quarantine_item  — quarantine_items → stash_roots.owner_id (via join)
 *   watchlist_subscription — watchlist_subscriptions.owner_id
 *   printer          — printers.owner_id (forge)
 *   slicer           — forge_slicers.owner_id
 *   slicer_profile   — slicer_profiles.owner_id (grimoire)
 *   print_setting    — print_settings.owner_id (grimoire)
 *
 * Kinds permanently rejected for non-admin (no ownership resolution path):
 *   dispatch_job     — no ACL kind in resolver yet; see project_acl_resolver_gaps memory
 *
 * Unknown subject kinds (e.g. 'system_event', 'stash_root', 'source_credential',
 * 'mix_batch', or any future kind not listed above): absent from result →
 * treated as no-ownership by callers → non-admins see 404.
 *
 * TODO: denormalize ledger_events.subject_owner_id at write-time so reads become
 * a simple WHERE clause (no per-row owner lookup). This removes the need for
 * this module entirely for the hot path.
 */

import { eq, inArray } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';

export type LedgerRow = typeof schema.ledgerEvents.$inferSelect;

// ---------------------------------------------------------------------------
// Batch resolution (used by list endpoint)
// ---------------------------------------------------------------------------

/**
 * For a set of (subjectType, subjectId) pairs, batch-resolve the ownerId
 * for each supported kind via one SELECT per kind.
 * Returns a Map keyed by `${subjectType}:${subjectId}` → ownerId.
 * Unsupported kinds (e.g. dispatch_job, system_event) are absent from the map
 * — callers treat absence as reject.
 */
export async function batchResolveOwners(
  rows: LedgerRow[],
): Promise<Map<string, string | null>> {
  const db = getServerDb();
  const result = new Map<string, string | null>();

  // Group row subjectIds by subjectType
  const byKind = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = byKind.get(row.subjectType) ?? new Set<string>();
    ids.add(row.subjectId);
    byKind.set(row.subjectType, ids);
  }

  for (const [kind, ids] of byKind) {
    const idList = Array.from(ids);
    const key = (id: string) => `${kind}:${id}`;

    switch (kind) {
      case 'material': {
        const rows2 = await db
          .select({ id: schema.materials.id, ownerId: schema.materials.ownerId })
          .from(schema.materials)
          .where(inArray(schema.materials.id, idList));
        for (const r of rows2) {
          result.set(key(r.id), r.ownerId ?? null);
        }
        break;
      }

      case 'collection': {
        const rows2 = await db
          .select({ id: schema.collections.id, ownerId: schema.collections.ownerId })
          .from(schema.collections)
          .where(inArray(schema.collections.id, idList));
        for (const r of rows2) {
          result.set(key(r.id), r.ownerId ?? null);
        }
        break;
      }

      case 'loot': {
        // loot has no direct ownerId — inherit from parent collection
        const rows2 = await db
          .select({ id: schema.loot.id, ownerId: schema.collections.ownerId })
          .from(schema.loot)
          .innerJoin(schema.collections, eq(schema.loot.collectionId, schema.collections.id))
          .where(inArray(schema.loot.id, idList));
        for (const r of rows2) {
          result.set(key(r.id), r.ownerId ?? null);
        }
        break;
      }

      case 'quarantine_item': {
        // quarantine_items → stash_roots.owner_id
        const rows2 = await db
          .select({ id: schema.quarantineItems.id, ownerId: schema.stashRoots.ownerId })
          .from(schema.quarantineItems)
          .innerJoin(schema.stashRoots, eq(schema.quarantineItems.stashRootId, schema.stashRoots.id))
          .where(inArray(schema.quarantineItems.id, idList));
        for (const r of rows2) {
          result.set(key(r.id), r.ownerId ?? null);
        }
        break;
      }

      case 'watchlist_subscription': {
        const rows2 = await db
          .select({ id: schema.watchlistSubscriptions.id, ownerId: schema.watchlistSubscriptions.ownerId })
          .from(schema.watchlistSubscriptions)
          .where(inArray(schema.watchlistSubscriptions.id, idList));
        for (const r of rows2) {
          result.set(key(r.id), r.ownerId ?? null);
        }
        break;
      }

      case 'printer': {
        const rows2 = await db
          .select({ id: schema.printers.id, ownerId: schema.printers.ownerId })
          .from(schema.printers)
          .where(inArray(schema.printers.id, idList));
        for (const r of rows2) {
          result.set(key(r.id), r.ownerId ?? null);
        }
        break;
      }

      case 'slicer': {
        const rows2 = await db
          .select({ id: schema.forgeSlicers.id, ownerId: schema.forgeSlicers.ownerId })
          .from(schema.forgeSlicers)
          .where(inArray(schema.forgeSlicers.id, idList));
        for (const r of rows2) {
          result.set(key(r.id), r.ownerId ?? null);
        }
        break;
      }

      case 'slicer_profile': {
        const rows2 = await db
          .select({ id: schema.slicerProfiles.id, ownerId: schema.slicerProfiles.ownerId })
          .from(schema.slicerProfiles)
          .where(inArray(schema.slicerProfiles.id, idList));
        for (const r of rows2) {
          result.set(key(r.id), r.ownerId ?? null);
        }
        break;
      }

      case 'print_setting': {
        const rows2 = await db
          .select({ id: schema.printSettings.id, ownerId: schema.printSettings.ownerId })
          .from(schema.printSettings)
          .where(inArray(schema.printSettings.id, idList));
        for (const r of rows2) {
          result.set(key(r.id), r.ownerId ?? null);
        }
        break;
      }

      default:
        // Unknown kind — entries absent from result map → will be rejected by callers.
        break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Single-row resolution (used by detail endpoint)
// ---------------------------------------------------------------------------

/**
 * Resolve the ownerId for a single (subjectType, subjectId) pair.
 *
 * Returns:
 *   string  — the resolved ownerId (subject found and has an owner)
 *   null    — subject found but ownerId is NULL (rare edge-case)
 *   'reject' — subjectType is dispatch_job (explicit policy reject, no lookup)
 *   undefined — subjectType is unsupported/unknown, OR subject not found in DB
 *
 * Callers should treat 'reject' and undefined as "non-admin cannot access".
 */
export async function resolveOwnerForRow(
  subjectType: string,
  subjectId: string,
): Promise<string | null | 'reject' | undefined> {
  // dispatch_job is explicitly rejected for non-admin (no resolver path yet).
  if (subjectType === 'dispatch_job') return 'reject';

  const db = getServerDb();

  switch (subjectType) {
    case 'material': {
      const rows = await db
        .select({ ownerId: schema.materials.ownerId })
        .from(schema.materials)
        .where(eq(schema.materials.id, subjectId))
        .limit(1);
      const r0 = rows[0];
      if (!r0) return undefined;
      return r0.ownerId ?? null;
    }

    case 'collection': {
      const rows = await db
        .select({ ownerId: schema.collections.ownerId })
        .from(schema.collections)
        .where(eq(schema.collections.id, subjectId))
        .limit(1);
      const r0 = rows[0];
      if (!r0) return undefined;
      return r0.ownerId ?? null;
    }

    case 'loot': {
      const rows = await db
        .select({ ownerId: schema.collections.ownerId })
        .from(schema.loot)
        .innerJoin(schema.collections, eq(schema.loot.collectionId, schema.collections.id))
        .where(eq(schema.loot.id, subjectId))
        .limit(1);
      const r0 = rows[0];
      if (!r0) return undefined;
      return r0.ownerId ?? null;
    }

    case 'quarantine_item': {
      const rows = await db
        .select({ ownerId: schema.stashRoots.ownerId })
        .from(schema.quarantineItems)
        .innerJoin(schema.stashRoots, eq(schema.quarantineItems.stashRootId, schema.stashRoots.id))
        .where(eq(schema.quarantineItems.id, subjectId))
        .limit(1);
      const r0 = rows[0];
      if (!r0) return undefined;
      return r0.ownerId ?? null;
    }

    case 'watchlist_subscription': {
      const rows = await db
        .select({ ownerId: schema.watchlistSubscriptions.ownerId })
        .from(schema.watchlistSubscriptions)
        .where(eq(schema.watchlistSubscriptions.id, subjectId))
        .limit(1);
      const r0 = rows[0];
      if (!r0) return undefined;
      return r0.ownerId ?? null;
    }

    case 'printer': {
      const rows = await db
        .select({ ownerId: schema.printers.ownerId })
        .from(schema.printers)
        .where(eq(schema.printers.id, subjectId))
        .limit(1);
      const r0 = rows[0];
      if (!r0) return undefined;
      return r0.ownerId ?? null;
    }

    case 'slicer': {
      const rows = await db
        .select({ ownerId: schema.forgeSlicers.ownerId })
        .from(schema.forgeSlicers)
        .where(eq(schema.forgeSlicers.id, subjectId))
        .limit(1);
      const r0 = rows[0];
      if (!r0) return undefined;
      return r0.ownerId ?? null;
    }

    case 'slicer_profile': {
      const rows = await db
        .select({ ownerId: schema.slicerProfiles.ownerId })
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.id, subjectId))
        .limit(1);
      const r0 = rows[0];
      if (!r0) return undefined;
      return r0.ownerId ?? null;
    }

    case 'print_setting': {
      const rows = await db
        .select({ ownerId: schema.printSettings.ownerId })
        .from(schema.printSettings)
        .where(eq(schema.printSettings.id, subjectId))
        .limit(1);
      const r0 = rows[0];
      if (!r0) return undefined;
      return r0.ownerId ?? null;
    }

    default:
      // Unknown kind → non-admin cannot access.
      return undefined;
  }
}
