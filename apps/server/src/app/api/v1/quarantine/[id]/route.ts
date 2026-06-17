// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * GET + DELETE /api/v1/quarantine/[id] — Quarantine HTTP Layer T3 + T4
 *
 * GET  — Returns the full DTO for a single quarantine item.
 * DELETE — Dismisses the item (sets resolved_at = NOW()). Idempotent: re-
 *          dismissing an already-resolved item returns 200 with the unchanged
 *          row (no UPDATE, no duplicate ledger event).
 *
 * Auth model
 * ──────────
 * authenticateRequest — BetterAuth session OR x-api-key 'programmatic'.
 *
 * ACL (mirrors Forge pattern — existence is hidden for denied callers)
 * ───
 * owner  → 200  (read + write)
 * admin  → 200 read only (cross-owner triage); write → 404 (no accidental cross-tenant mutation)
 * non-owner / non-admin → 404  (hides existence, never 403)
 * unknown id → 404
 */

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { resolveQuarantineAcl } from '@/acl/quarantine';
import { getServerDb, schema } from '@/db/client';
import { persistLedgerEventInTx, LedgerValidationError, type LedgerTxHandle } from '@/stash/ledger';
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

// ---------------------------------------------------------------------------
// DELETE /api/v1/quarantine/[id]
// ---------------------------------------------------------------------------

/**
 * Dismiss a quarantine item — sets resolved_at = NOW().
 *
 * Idempotency: if the item is already resolved, returns 200 with the existing
 * row and emits no second ledger event (check acl.item.resolvedAt before
 * writing).
 *
 * Atomic: the UPDATE + ledger event are executed inside a single sync
 * better-sqlite3 transaction so either both land or neither does.
 */
export async function DELETE(
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

  // ACL — 'write' action; admin cross-owner writes are denied (returns
  // not-found) to mirror the Forge consent model.
  const acl = await resolveQuarantineAcl(actor, id, 'write');
  if (!acl.allowed) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  const item = acl.item!;

  // Idempotency: already resolved — return unchanged row without touching DB.
  if (item.resolvedAt !== null) {
    return NextResponse.json(toQuarantineItemDto(item));
  }

  // Atomic UPDATE + ledger event.
  const now = new Date();
  const db = getServerDb();

  try {
    const result = (
      db as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }
    ).transaction((tx) => {
      const t = tx as ReturnType<typeof getServerDb>;

      t.update(schema.quarantineItems)
        .set({ resolvedAt: now })
        .where(eq(schema.quarantineItems.id, id))
        .run();

      persistLedgerEventInTx(t as LedgerTxHandle, {
        kind: 'quarantine.dismissed',
        actorUserId: actor.id,
        subjectType: 'quarantine_item',
        subjectId: id,
        payload: {
          stashRootId: item.stashRootId,
          reason: item.reason,
          path: item.path,
        },
        provenanceClass: 'system',
        occurredAt: now,
        ingestedAt: now,
      });

      // Return the updated row — avoids a second SELECT outside the tx.
      return { ...item, resolvedAt: now };
    });

    return NextResponse.json(toQuarantineItemDto(result));
  } catch (err) {
    if (err instanceof LedgerValidationError) {
      return NextResponse.json({ error: 'ledger-validation-failed' }, { status: 500 });
    }
    throw err;
  }
}
