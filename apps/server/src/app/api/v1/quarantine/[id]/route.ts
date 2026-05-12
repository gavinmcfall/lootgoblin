/**
 * GET /api/v1/quarantine/[id] — Quarantine HTTP Layer T3
 *
 * Returns the full DTO for a single quarantine item.
 *
 * Auth model
 * ──────────
 * authenticateRequest — BetterAuth session OR x-api-key 'programmatic'.
 *
 * ACL (mirrors Forge pattern — existence is hidden for denied callers)
 * ───
 * owner  → 200
 * admin  → 200 (cross-owner read for triage)
 * non-owner / non-admin → 404  (hides existence, never 403)
 * unknown id → 404
 */

import { NextResponse } from 'next/server';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { resolveQuarantineAcl } from '@/acl/quarantine';
import { toQuarantineItemDto } from '../_shared';

// ---------------------------------------------------------------------------
// GET /api/v1/quarantine/[id]
// ---------------------------------------------------------------------------

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  // Auth
  const authResult = await authenticateRequest(req);
  if (!authResult || authResult === INVALID_API_KEY) {
    return unauthenticatedResponse(authResult as null | typeof INVALID_API_KEY);
  }
  const actor = authResult;

  // ACL — resolveQuarantineAcl does the DB lookup internally and returns
  // { allowed: false, reason: 'not-found' } for all deny cases (owner hiding
  // included), so we never expose a 403 to a non-owner.
  // On the allowed path it also returns the loaded row, so no second SELECT
  // is needed.
  const acl = await resolveQuarantineAcl(actor, id, 'read');
  if (!acl.allowed) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  return NextResponse.json(toQuarantineItemDto(acl.item!));
}
