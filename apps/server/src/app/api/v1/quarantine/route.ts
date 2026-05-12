/**
 * GET /api/v1/quarantine — Quarantine HTTP Layer T2
 *
 * List quarantine items with filter + cursor pagination (DESC by createdAt).
 *
 * Auth model
 * ──────────
 * authenticateRequest — BetterAuth session OR x-api-key 'programmatic'.
 *
 * Owner scoping
 * ─────────────
 * Non-admin callers: see only items whose parent stashRoot.ownerId === actor.id.
 * Admin without ?owner_id=: see all items across all owners.
 * Admin with ?owner_id=: see only that owner's items.
 * Non-admin passing ?owner_id= → 403.
 *
 * Filters
 * ───────
 * ?stash_root_id= — filter to a specific stash root (uuid)
 * ?reason=        — filter by reason enum value
 * ?resolved=false — resolvedAt IS NULL  (pending items only)
 * ?resolved=true  — resolvedAt IS NOT NULL (resolved items only)
 * ?owner_id=      — admin-only: filter by stash root owner
 * ?limit=         — page size (1–100, default 50)
 * ?cursor=        — opaque numeric ms timestamp for createdAt DESC pagination
 *
 * Response
 * ────────
 * { items: QuarantineItemDto[], nextCursor?: string }
 */

import { NextResponse, type NextRequest } from 'next/server';
import { and, asc, desc, eq, isNotNull, isNull, lt, type SQL } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import {
  ListQuery,
  toQuarantineItemDto,
} from './_shared';

// ---------------------------------------------------------------------------
// GET /api/v1/quarantine
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  // Auth
  const authResult = await authenticateRequest(req);
  if (!authResult || authResult === INVALID_API_KEY) {
    return unauthenticatedResponse(authResult as null | typeof INVALID_API_KEY);
  }
  const actor = authResult;

  // Parse query params
  const url = new URL(req.url);
  const queryParsed = ListQuery.safeParse({
    stash_root_id: url.searchParams.get('stash_root_id') ?? undefined,
    reason: url.searchParams.get('reason') ?? undefined,
    resolved: url.searchParams.get('resolved') ?? undefined,
    owner_id: url.searchParams.get('owner_id') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  });
  if (!queryParsed.success) {
    return NextResponse.json(
      {
        error: 'invalid-query',
        message: 'invalid query parameters',
        issues: queryParsed.error.issues,
      },
      { status: 400 },
    );
  }
  const q = queryParsed.data;

  // ACL: non-admin must not pass owner_id
  if (q.owner_id !== undefined && actor.role !== 'admin') {
    return NextResponse.json(
      { error: 'forbidden', message: 'owner_id filter is admin-only' },
      { status: 403 },
    );
  }

  const db = getServerDb();

  // Build WHERE conditions.
  // We need to JOIN quarantineItems → stashRoots for owner filtering.
  const conditions: SQL[] = [];

  // Owner scoping
  if (actor.role !== 'admin') {
    // Non-admin: restrict to own stash roots only.
    // We use a subquery-style approach: join on stashRoots and filter ownerId.
    conditions.push(eq(schema.stashRoots.ownerId, actor.id));
  } else if (q.owner_id !== undefined) {
    // Admin with explicit owner_id filter
    conditions.push(eq(schema.stashRoots.ownerId, q.owner_id));
  }
  // Admin without owner_id: no owner constraint — sees everything.

  // Optional filters on quarantineItems
  if (q.stash_root_id !== undefined) {
    conditions.push(eq(schema.quarantineItems.stashRootId, q.stash_root_id));
  }
  if (q.reason !== undefined) {
    conditions.push(eq(schema.quarantineItems.reason, q.reason));
  }
  if (q.resolved === false) {
    conditions.push(isNull(schema.quarantineItems.resolvedAt));
  } else if (q.resolved === true) {
    conditions.push(isNotNull(schema.quarantineItems.resolvedAt));
  }

  // Cursor: numeric ms timestamp of createdAt (same as materials)
  if (q.cursor !== undefined) {
    const cursorMs = Number(q.cursor);
    if (!Number.isFinite(cursorMs)) {
      return NextResponse.json(
        { error: 'invalid-query', message: 'cursor must be a numeric ms timestamp' },
        { status: 400 },
      );
    }
    conditions.push(lt(schema.quarantineItems.createdAt, new Date(cursorMs)));
  }

  // Query — JOIN quarantineItems → stashRoots for owner scoping.
  const whereClause = conditions.length === 0 ? undefined : and(...conditions);

  const rows = await db
    .select({ qi: schema.quarantineItems })
    .from(schema.quarantineItems)
    .innerJoin(
      schema.stashRoots,
      eq(schema.quarantineItems.stashRootId, schema.stashRoots.id),
    )
    .where(whereClause)
    .orderBy(desc(schema.quarantineItems.createdAt), asc(schema.quarantineItems.id))
    .limit(q.limit + 1);

  const hasMore = rows.length > q.limit;
  const sliced = hasMore ? rows.slice(0, q.limit) : rows;
  const nextCursor =
    hasMore && sliced.length > 0
      ? String(sliced[sliced.length - 1]!.qi.createdAt.getTime())
      : undefined;

  return NextResponse.json({
    items: sliced.map((r) => toQuarantineItemDto(r.qi)),
    ...(nextCursor ? { nextCursor } : {}),
  });
}
