/**
 * V2-005e-T_e3: Pending-pairings resolve API.
 *
 * Tier 3 of the slice-source association is a queue. The HTTP routes call
 * into:
 *   - listPendingPairings(ownerId) — owner-or-admin scoped backlog.
 *   - resolvePending(...)          — apply user's source-Loot pick atomically.
 *
 * resolvePending ensures the loot.parent_loot_id update + the
 * forge_pending_pairings.resolved_at update happen in ONE transaction so a
 * concurrent retry never double-resolves or leaves the parent_loot_id
 * stamped without the pending row closed.
 */

import { and, eq, isNull } from 'drizzle-orm';

import { getServerDb, schema } from '../../db/client';

export interface ListPendingArgs {
  /** undefined = list across all owners (admin path). */
  ownerId?: string;
}

export interface PendingPairingDto {
  id: string;
  sliceLootId: string;
  ownerId: string;
  sourceFilenameHint: string | null;
  ingestedAt: number;
}

export interface PairingsOpts {
  dbUrl?: string;
}

export async function listPendingPairings(
  args: ListPendingArgs,
  opts: PairingsOpts = {},
): Promise<PendingPairingDto[]> {
  const db = getServerDb(opts.dbUrl);
  const baseWhere = args.ownerId
    ? and(
        isNull(schema.forgePendingPairings.resolvedAt),
        eq(schema.collections.ownerId, args.ownerId),
      )
    : isNull(schema.forgePendingPairings.resolvedAt);

  const rows = await db
    .select({
      id: schema.forgePendingPairings.id,
      sliceLootId: schema.forgePendingPairings.sliceLootId,
      ownerId: schema.collections.ownerId,
      sourceFilenameHint: schema.forgePendingPairings.sourceFilenameHint,
      ingestedAt: schema.forgePendingPairings.ingestedAt,
    })
    .from(schema.forgePendingPairings)
    .innerJoin(
      schema.loot,
      eq(schema.loot.id, schema.forgePendingPairings.sliceLootId),
    )
    .innerJoin(
      schema.collections,
      eq(schema.collections.id, schema.loot.collectionId),
    )
    .where(baseWhere);

  return rows.map((r) => ({
    id: r.id,
    sliceLootId: r.sliceLootId,
    ownerId: r.ownerId,
    sourceFilenameHint: r.sourceFilenameHint ?? null,
    ingestedAt: r.ingestedAt.getTime(),
  }));
}

export interface ResolvePendingArgs {
  pendingPairingId: string;
  sourceLootId: string;
  /** Caller's user id — used by the route layer for ACL only. */
  userId: string;
}

export type ResolvePendingResult =
  | { ok: true; sliceLootId: string }
  | {
      ok: false;
      reason:
        | 'pending-pairing-not-found'
        | 'pending-pairing-already-resolved'
        | 'source-loot-not-found';
    };

export async function resolvePending(
  args: ResolvePendingArgs,
  opts: PairingsOpts = {},
): Promise<ResolvePendingResult> {
  const db = getServerDb(opts.dbUrl);

  const pendingRows = await db
    .select()
    .from(schema.forgePendingPairings)
    .where(eq(schema.forgePendingPairings.id, args.pendingPairingId))
    .limit(1);
  const pending = pendingRows[0];
  if (!pending) {
    return { ok: false, reason: 'pending-pairing-not-found' };
  }
  if (pending.resolvedAt !== null) {
    return { ok: false, reason: 'pending-pairing-already-resolved' };
  }

  const sourceRows = await db
    .select({ id: schema.loot.id })
    .from(schema.loot)
    .where(eq(schema.loot.id, args.sourceLootId))
    .limit(1);
  if (sourceRows.length === 0) {
    return { ok: false, reason: 'source-loot-not-found' };
  }

  const now = new Date();
  await db.transaction((tx) => {
    tx.update(schema.forgePendingPairings)
      .set({ resolvedAt: now, resolvedToLootId: args.sourceLootId })
      .where(eq(schema.forgePendingPairings.id, args.pendingPairingId))
      .run();
    tx.update(schema.loot)
      .set({ parentLootId: args.sourceLootId })
      .where(eq(schema.loot.id, pending.sliceLootId))
      .run();
  });

  return { ok: true, sliceLootId: pending.sliceLootId };
}

/**
 * Look up a single pending-pairings row + its slice-Loot owner, suitable
 * for ACL gating in HTTP routes. Returns null when the row does not exist
 * (route layer treats null as 404 to prevent id-existence leaks).
 */
export async function getPendingPairingForActor(args: {
  pendingPairingId: string;
  actorId: string;
  actorRole: 'admin' | 'user';
  dbUrl?: string;
}): Promise<{
  id: string;
  sliceLootId: string;
  ownerId: string;
  resolvedAt: Date | null;
} | null> {
  const db = getServerDb(args.dbUrl);
  const rows = await db
    .select({
      id: schema.forgePendingPairings.id,
      sliceLootId: schema.forgePendingPairings.sliceLootId,
      ownerId: schema.collections.ownerId,
      resolvedAt: schema.forgePendingPairings.resolvedAt,
    })
    .from(schema.forgePendingPairings)
    .innerJoin(
      schema.loot,
      eq(schema.loot.id, schema.forgePendingPairings.sliceLootId),
    )
    .innerJoin(
      schema.collections,
      eq(schema.collections.id, schema.loot.collectionId),
    )
    .where(eq(schema.forgePendingPairings.id, args.pendingPairingId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (args.actorRole !== 'admin' && row.ownerId !== args.actorId) return null;
  return {
    id: row.id,
    sliceLootId: row.sliceLootId,
    ownerId: row.ownerId,
    resolvedAt: row.resolvedAt ?? null,
  };
}
