/**
 * GET /api/v1/forge/pending-pairings — list slice rows awaiting source pick.
 *
 * V2-005e-T_e3. ACL mirrors /forge/inboxes (owner-or-admin):
 *   - admin (no ?ownerId): list across every user's queue.
 *   - admin with ?ownerId=<id>: list that owner's queue.
 *   - non-admin: always scoped to caller.
 *
 * Returns DTOs only — slice + source Loot are not joined-in here. The UI
 * fetches matching candidates separately via /api/v1/loot search.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { listPendingPairings } from '@/forge/slice-pairings/lifecycle';

import { errorResponse, requireAuth } from '../_shared';

const ListQuery = z
  .object({
    ownerId: z.string().min(1).optional(),
  })
  .strict();

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const url = new URL(req.url);
  const queryParsed = ListQuery.safeParse({
    ownerId: url.searchParams.get('ownerId') ?? undefined,
  });
  if (!queryParsed.success) {
    return errorResponse('invalid-query', 'invalid query parameters', 400);
  }
  const q = queryParsed.data;

  let pairings;
  if (actor.role === 'admin') {
    pairings = await listPendingPairings({ ownerId: q.ownerId });
  } else {
    pairings = await listPendingPairings({ ownerId: actor.id });
  }
  return NextResponse.json({ pairings });
}
