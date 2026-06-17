// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * GET /api/v1/ledger — Ledger HTTP Layer T2
 *
 * Read-only list of ledger_events with filter + composite cursor pagination
 * (DESC by ingestedAt, then DESC by id for same-millisecond stability).
 *
 * Auth model
 * ──────────
 * authenticateRequest — BetterAuth session OR x-api-key 'programmatic'.
 *
 * ACL model (locked 2026-05-12: admin + subject-owner)
 * ──────────────────────────────────────────────────────
 * Admin: reads all events.
 * Non-admin: reads events WHERE the subject resource is DIRECTLY OWNED by the caller.
 *
 * Non-admin Receipts policy: ownership-only. Even for kinds that are fleet-readable
 * via resolveAcl (loot, collection, printer, slicer), the Receipts surface filters by
 * direct ownership. This matches the *arr History pattern and the multi-household
 * privacy model — your housemate's actions on shared fleet resources don't appear in
 * your receipts.
 *
 * Owner resolution is batched per subjectType (one SELECT IN per kind). Supported
 * kinds with ownership resolution:
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
 * Kinds rejected for non-admin (no ownership path):
 *   dispatch_job     — no ACL kind in resolver yet; see project_acl_resolver_gaps memory
 *
 * Unknown subject kinds (e.g. 'system_event', 'bulk-action', 'loot-file',
 * 'stash_root', 'source_credential', 'mix_batch', or any future kind not listed
 * above): filtered out for non-admins. This is a safe default — non-admins
 * cannot see events whose ownership cannot be determined.
 *
 * TODO: denormalize ledger_events.subject_owner_id at write-time so reads become
 * a simple WHERE clause (no per-row owner lookup). This is required for true
 * pagination correctness — the current over-fetch is a best-effort heuristic.
 *
 * Over-fetch — PREMATURE TERMINATION POSSIBLE
 * ─────────────────────────────────────────────
 * Non-admin: fetch (limit+1)*OWNER_FILTER_OVERFETCH rows from DB to absorb
 * post-filter rejection. Factor OWNER_FILTER_OVERFETCH (currently 4) is a pragmatic
 * estimate for a ~25% per-user fraction in a 3-household instance.
 *
 * WARNING: This heuristic can prematurely terminate pagination. If a non-admin owns
 * very few resources and the over-fetched window is entirely cross-owner, nextCursor
 * will be null even though more owned events exist further back in the timeline. For
 * true correctness, denormalize subject_owner_id at write-time.
 *
 * If pagination feels sparse in practice, tune OWNER_FILTER_OVERFETCH to 8 or
 * denormalize.
 *
 * Cursor codec
 * ────────────
 * encodeCursor(ts, id) = base64url(`${ts.getTime()}|${id}`)
 * decodeCursor(cursor) → {ingestedAt: Date, id: string} | null (null = restart list)
 * Compound form: OR(lt(ingestedAt, c.ts), AND(eq(ingestedAt, c.ts), lt(id, c.id)))
 * handles same-millisecond stability correctly.
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, gte, lt, or, type SQL } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import type { AuthenticatedActor } from '@/auth/request-auth';
import { ListQuery, toLedgerEventDto } from './_shared';
import { batchResolveOwners } from './_owner-resolver';
import type { LedgerRow } from './_owner-resolver';
import { encodeCursor, decodeCursor } from './_cursor';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Over-fetch multiplier for non-admin pagination.
 * See header docstring for the PREMATURE TERMINATION caveat.
 */
const OWNER_FILTER_OVERFETCH = 4;

/**
 * Filter rows to only those the given non-admin user directly owns.
 *
 * Non-admin Receipts policy: ownership-only. We do NOT delegate to resolveAcl
 * because resolveAcl returns ALLOW for fleet-readable kinds (loot, collection,
 * printer, slicer) for any authenticated user — but Receipts must show only
 * the caller's own events even on those shared kinds.
 *
 * Unknown subject kinds and resources not found in ownerByKey are rejected.
 */
async function filterRowsByOwnership(
  rows: LedgerRow[],
  user: AuthenticatedActor,
): Promise<LedgerRow[]> {
  if (rows.length === 0) return [];

  const ownerByKey = await batchResolveOwners(rows);

  return rows.filter((row) => {
    switch (row.subjectType) {
      case 'dispatch_job':
        // Rejected for non-admin: resolveAcl has no 'dispatch_job' kind yet (see project_acl_resolver_gaps memory).
        // When the resolver is extended, also add dispatch_job back to batchResolveOwners.
        return false;
      default: {
        const ownerId = ownerByKey.get(`${row.subjectType}:${row.subjectId}`);
        if (ownerId == null) return false; // unknown subjectType or resource not found → reject
        return ownerId === user.id;  // owner-only, ignoring resolveAcl's fleet-visible read policy
      }
    }
  });
}

// ---------------------------------------------------------------------------
// GET /api/v1/ledger
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  // Auth
  const authResult = await authenticateRequest(req);
  if (!authResult || authResult === INVALID_API_KEY) {
    return unauthenticatedResponse(authResult as null | typeof INVALID_API_KEY);
  }
  const user = authResult;
  const isAdmin = user.role === 'admin';

  // Parse query params
  const url = new URL(req.url);
  const parsed = ListQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-query', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const q = parsed.data;

  const db = getServerDb();
  const conditions: SQL[] = [];

  if (q.subject_type) conditions.push(eq(schema.ledgerEvents.subjectType, q.subject_type));
  if (q.subject_id) conditions.push(eq(schema.ledgerEvents.subjectId, q.subject_id));
  if (q.kind) conditions.push(eq(schema.ledgerEvents.kind, q.kind));
  if (q.actor_user_id) conditions.push(eq(schema.ledgerEvents.actorUserId, q.actor_user_id));
  if (q.occurred_after) conditions.push(gte(schema.ledgerEvents.occurredAt, new Date(q.occurred_after)));
  if (q.occurred_before) conditions.push(lt(schema.ledgerEvents.occurredAt, new Date(q.occurred_before)));
  if (q.ingested_after) conditions.push(gte(schema.ledgerEvents.ingestedAt, new Date(q.ingested_after)));
  if (q.ingested_before) conditions.push(lt(schema.ledgerEvents.ingestedAt, new Date(q.ingested_before)));

  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (c) {
      conditions.push(
        or(
          lt(schema.ledgerEvents.ingestedAt, c.ingestedAt),
          and(
            eq(schema.ledgerEvents.ingestedAt, c.ingestedAt),
            lt(schema.ledgerEvents.id, c.id),
          ),
        ) as SQL,
      );
    }
    // If cursor is malformed, decodeCursor returns null — list starts fresh (no cursor condition)
  }

  // Over-fetch by OWNER_FILTER_OVERFETCH for non-admin to absorb post-filter rejection.
  // See header docstring for the PREMATURE TERMINATION caveat.
  // TODO: denormalize ledger_events.subject_owner_id at write-time so this becomes
  // a simple WHERE clause. Captured as future-optimization.
  const fetchLimit = isAdmin ? q.limit + 1 : (q.limit + 1) * OWNER_FILTER_OVERFETCH;

  const rows = await db
    .select()
    .from(schema.ledgerEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.ledgerEvents.ingestedAt), desc(schema.ledgerEvents.id))
    .limit(fetchLimit);

  const visible = isAdmin
    ? rows
    : await filterRowsByOwnership(rows, user);

  const hasMore = visible.length > q.limit;
  const page = hasMore ? visible.slice(0, q.limit) : visible;
  const items = page.map(toLedgerEventDto);
  const tail = items[items.length - 1];
  const nextCursor =
    hasMore && tail
      ? encodeCursor(new Date(tail.ingestedAt), tail.id)
      : null;

  return NextResponse.json({ items, nextCursor });
}
