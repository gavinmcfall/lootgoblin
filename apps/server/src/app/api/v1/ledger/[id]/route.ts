/**
 * GET /api/v1/ledger/[id] — Ledger HTTP Layer T3
 *
 * Returns the full LedgerEventDto for a single ledger event.
 *
 * Auth model
 * ──────────
 * authenticateRequest — BetterAuth session OR x-api-key 'programmatic'.
 *
 * ACL model (locked 2026-05-12: hide-existence for denied callers)
 * ─────────────────────────────────────────────────────────────────
 * Admin   → 200 for any event (cross-owner visibility).
 * Owner   → 200 if the event's subject is DIRECTLY OWNED by the caller
 *           (ownerId === user.id; does NOT delegate to resolveAcl because some
 *           kinds are fleet-readable there but Receipts must be ownership-only).
 * Non-owner / non-admin → 404 (existence hidden — mirrors Forge + Quarantine patterns).
 *
 * Plan text deviation: plan said "non-admin → 403". Corrected to 404 at T3
 * to match the hide-existence principle established by Quarantine (T3) and Forge
 * ([id] routes). The T2 ACL lock confirms the ownership-only model. 403 was a
 * copy-paste from an earlier draft.
 *
 * dispatch_job subjectType → 404 for non-admin (no resolver path; see
 * project_acl_resolver_gaps memory). Will be revisited when dispatch_job is
 * added to the owner resolver.
 *
 * Unknown subjectTypes (e.g. 'system_event', 'stash_root', 'mix_batch') →
 * 404 for non-admin. Safe default — cannot determine ownership.
 *
 * Unknown id → 404 for any caller.
 * Unauthenticated → 401.
 */

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getServerDb, schema } from '@/db/client';
import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { toLedgerEventDto } from '../_shared';
import { resolveOwnerForRow } from '../_owner-resolver';

// ---------------------------------------------------------------------------
// GET /api/v1/ledger/[id]
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
  const user = authResult;
  const isAdmin = user.role === 'admin';

  // Fetch the row
  const db = getServerDb();
  const rows = await db
    .select()
    .from(schema.ledgerEvents)
    .where(eq(schema.ledgerEvents.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  // Admin can read any event.
  if (isAdmin) {
    return NextResponse.json(toLedgerEventDto(row));
  }

  // Non-admin: resolve ownership and hide existence on deny.
  const ownerId = await resolveOwnerForRow(row.subjectType, row.subjectId);

  // 'reject' = explicitly blocked kind (dispatch_job)
  // undefined = unknown subjectType or resource not found in DB
  // null = subject exists but ownerId is NULL (treat as no-owner)
  if (ownerId === 'reject' || ownerId == null || ownerId !== user.id) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  return NextResponse.json(toLedgerEventDto(row));
}
