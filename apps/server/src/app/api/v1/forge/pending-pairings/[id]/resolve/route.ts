/**
 * POST /api/v1/forge/pending-pairings/:id/resolve
 *
 * V2-005e-T_e3 — user picks the source Loot for a queued slice. ACL is
 * owner-or-admin on BOTH the pending pairing (via slice Loot's collection
 * ownership) AND the picked source Loot. Cross-owner pairing returns 404
 * to prevent slice/source id-existence leaks.
 *
 * Failure → 4xx mapping:
 *   pending-pairing-not-found        → 404
 *   pending-pairing-already-resolved → 409
 *   source-loot-not-found            → 404
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import {
  getPendingPairingForActor,
  resolvePending,
} from '@/forge/slice-pairings/lifecycle';

import { errorResponse, requireAuth } from '../../../_shared';

const Body = z
  .object({
    sourceLootId: z.string().min(1),
  })
  .strict();

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('invalid-body', 'JSON parse failed', 400);
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid-body',
        message: 'request body failed validation',
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // ACL gate: caller must own (or be admin over) the slice's pending row.
  const pending = await getPendingPairingForActor({
    pendingPairingId: id,
    actorId: actor.id,
    actorRole: actor.role,
  });
  if (!pending) {
    return errorResponse('not-found', 'pending-pairing-not-found', 404);
  }
  if (pending.resolvedAt !== null) {
    return errorResponse('conflict', 'pending-pairing-already-resolved', 409);
  }

  // ACL gate: caller must also own (or be admin over) the picked source Loot.
  // Cross-owner picking is rejected with 404 to mirror the slice-side leak
  // policy.
  const db = getServerDb();
  const sourceRows = await db
    .select({ id: schema.loot.id, ownerId: schema.collections.ownerId })
    .from(schema.loot)
    .innerJoin(
      schema.collections,
      eq(schema.loot.collectionId, schema.collections.id),
    )
    .where(eq(schema.loot.id, body.sourceLootId))
    .limit(1);
  const source = sourceRows[0];
  if (!source) {
    return errorResponse('not-found', 'source-loot-not-found', 404);
  }
  if (actor.role !== 'admin' && source.ownerId !== actor.id) {
    return errorResponse('not-found', 'source-loot-not-found', 404);
  }

  const result = await resolvePending({
    pendingPairingId: id,
    sourceLootId: body.sourceLootId,
    userId: actor.id,
  });
  if (!result.ok) {
    const status =
      result.reason === 'pending-pairing-already-resolved' ? 409 : 404;
    return errorResponse(result.reason, result.reason, status);
  }
  return NextResponse.json({ sliceLootId: result.sliceLootId });
}
