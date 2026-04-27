/**
 * POST /api/v1/watchlist/subscriptions + GET /api/v1/watchlist/subscriptions — V2-004-T9
 *
 * Watchlist subscription create + list. Mirrors the async-job style + idempotency
 * + cursor pagination from /api/v1/ingest.
 *
 * Auth model
 * ──────────
 * Same `authenticateRequest` shim as /api/v1/ingest — accepts BetterAuth
 * session OR an `x-api-key` programmatic key. Watchlist subscriptions are
 * owner-only (see `src/acl/resolver.ts` `watchlist_subscription` kind);
 * even an admin cannot read or write another user's subscriptions. The
 * existing ACL contract is intentional and matches `grimoire_entry`.
 *
 * Idempotency
 * ───────────
 * Optional `Idempotency-Key` header — same shape as POST /api/v1/ingest.
 * Persisted on `watchlist_subscriptions.idempotency_key` (migration 0017).
 * Replay with the same body → 200 + same subscription. Replay with a
 * different body → 409.
 *
 * Capability validation
 * ─────────────────────
 * The route checks `defaultRegistry.getSubscribable(source_adapter_id)` and
 * `hasCapability(adapter, kind)` BEFORE inserting. Adapters declare which
 * kinds they support (creator/tag/saved_search/url_watch/folder_watch); a
 * mismatch is 422 (unsupported-capability).
 *
 * default_collection_id
 * ─────────────────────
 * Required at create time. Schema column is nullable (T1 shipped before the
 * column existed) but the application contract is non-NULL on creation —
 * the watchlist worker will fail the firing if it ever sees NULL at runtime.
 * The route also checks the actor's write-ACL on the target collection.
 *
 * Cadence
 * ───────
 * `cadence_seconds` ∈ [60, 86400 × 7]. Default 3600 (1 hour). The scheduler
 * polls every 60s by default, so values < 60s would re-fire on every tick.
 *
 * List
 * ────
 * GET returns the caller's subscriptions only. Cursor = numeric ms string
 * of `created_at` (descending order, like /api/v1/ingest). Optional filters:
 * `active`, `source_adapter_id`, `kind`. Admins MAY pass `?owner_id=` to
 * scope to another user (this is the one place where admin overrides the
 * owner-only rule — for support/diagnostics, never for write operations).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';

import {
  CreateBodySchema,
  DEFAULT_CADENCE_SECONDS,
  ensureCollectionWritable,
  normalizeCreateBody,
  normalizeStoredRow,
  toSubscriptionDto,
  validateCapability,
} from './_shared';
import { registerGdriveChannel } from '@/watchlist/gdrive-channels-register';

// ---------------------------------------------------------------------------
// List query schema
// ---------------------------------------------------------------------------

const ListQuery = z.object({
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  source_adapter_id: z.string().min(1).optional(),
  kind: z.enum(['creator', 'tag', 'saved_search', 'url_watch', 'folder_watch']).optional(),
  owner_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

// ---------------------------------------------------------------------------
// POST /api/v1/watchlist/subscriptions
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return unauthenticatedResponse(actor as null | typeof INVALID_API_KEY);
  }

  // ── 2. Parse body ────────────────────────────────────────────────────────
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid-body', reason: 'JSON parse failed' },
      { status: 400 },
    );
  }
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // ── 3. Adapter + capability ──────────────────────────────────────────────
  const cap = validateCapability(body.source_adapter_id, body.kind);
  if (!cap.ok) return cap.response;

  // ── 4. Collection existence + ACL ────────────────────────────────────────
  const collGate = await ensureCollectionWritable(actor, body.default_collection_id);
  if (!collGate.ok) return collGate.response;

  const idempotencyKey = req.headers.get('Idempotency-Key');
  const normalized = normalizeCreateBody(body);
  const cadenceSeconds = body.cadence_seconds ?? DEFAULT_CADENCE_SECONDS;

  const db = getServerDb();

  // ── 5. Idempotency-Key handling ──────────────────────────────────────────
  if (idempotencyKey) {
    const prior = await db
      .select()
      .from(schema.watchlistSubscriptions)
      .where(
        and(
          eq(schema.watchlistSubscriptions.ownerId, actor.id),
          eq(schema.watchlistSubscriptions.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    const priorRow = prior[0];
    if (priorRow) {
      if (normalizeStoredRow(priorRow) === normalized) {
        return NextResponse.json(
          { subscription: toSubscriptionDto(priorRow) },
          { status: 200 },
        );
      }
      return NextResponse.json(
        {
          error: 'idempotency-mismatch',
          reason: 'Idempotency-Key reused with a different request body',
          subscriptionId: priorRow.id,
        },
        { status: 409 },
      );
    }
  }

  // ── 6. Insert subscription ───────────────────────────────────────────────
  const id = randomUUID();
  const now = new Date();
  try {
    await db.insert(schema.watchlistSubscriptions).values({
      id,
      ownerId: actor.id,
      kind: body.kind,
      sourceAdapterId: body.source_adapter_id,
      parameters: JSON.stringify(body.parameters),
      cadenceSeconds,
      lastFiredAt: null,
      cursorState: null,
      active: 1,
      errorStreak: 0,
      defaultCollectionId: body.default_collection_id,
      idempotencyKey: idempotencyKey ?? null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    // Race: a concurrent POST inserted the same idempotency_key. Re-read.
    if (idempotencyKey) {
      const racePrior = await db
        .select()
        .from(schema.watchlistSubscriptions)
        .where(
          and(
            eq(schema.watchlistSubscriptions.ownerId, actor.id),
            eq(schema.watchlistSubscriptions.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      const raceRow = racePrior[0];
      if (raceRow) {
        return NextResponse.json(
          { subscription: toSubscriptionDto(raceRow) },
          { status: 200 },
        );
      }
    }
    logger.error({ err, id }, 'watchlist-subs: failed to insert subscription');
    return NextResponse.json(
      { error: 'internal', reason: 'failed to create subscription' },
      { status: 500 },
    );
  }

  // Fetch the inserted row to get the canonical column values.
  const inserted = await db
    .select()
    .from(schema.watchlistSubscriptions)
    .where(eq(schema.watchlistSubscriptions.id, id))
    .limit(1);
  const row = inserted[0];
  if (!row) {
    // Should never happen — INSERT returned, then SELECT empty.
    logger.error({ id }, 'watchlist-subs: post-insert SELECT returned no row');
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }

  // ── 7. GDrive push registration (V2-004b-T2) ────────────────────────────
  // Best-effort. If anything fails, we WARN and let the subscription fall
  // back to cadence-based polling. Push is an optimisation, not a contract.
  if (body.kind === 'folder_watch' && body.source_adapter_id === 'google-drive') {
    const publicUrl = process.env.INSTANCE_PUBLIC_URL ?? process.env.BETTER_AUTH_URL;
    if (publicUrl) {
      const webhookAddress = `${publicUrl.replace(/\/+$/, '')}/api/v1/watchlist/gdrive/notification`;
      try {
        const result = await registerGdriveChannel({
          subscriptionId: row.id,
          ownerId: actor.id,
          webhookAddress,
        });
        if (!result.ok) {
          logger.warn(
            { subscriptionId: row.id, reason: result.reason, details: result.details },
            'gdrive-channel-register: failed; subscription will fall back to polling',
          );
        }
      } catch (regErr) {
        logger.warn(
          { subscriptionId: row.id, err: regErr },
          'gdrive-channel-register: threw unexpectedly; subscription will fall back to polling',
        );
      }
    } else {
      logger.info(
        { subscriptionId: row.id },
        'gdrive-channel-register: INSTANCE_PUBLIC_URL not set; polling-only',
      );
    }
  }

  return NextResponse.json(
    { subscription: toSubscriptionDto(row) },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// GET /api/v1/watchlist/subscriptions — list (paginated)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return unauthenticatedResponse(actor as null | typeof INVALID_API_KEY);
  }

  const url = new URL(req.url);
  const queryRaw = {
    active: url.searchParams.get('active') ?? undefined,
    source_adapter_id: url.searchParams.get('source_adapter_id') ?? undefined,
    kind: url.searchParams.get('kind') ?? undefined,
    owner_id: url.searchParams.get('owner_id') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  };
  const queryParsed = ListQuery.safeParse(queryRaw);
  if (!queryParsed.success) {
    return NextResponse.json(
      { error: 'invalid-query', issues: queryParsed.error.issues },
      { status: 400 },
    );
  }
  const q = queryParsed.data;

  // Owner scope: default to caller; admin may set ?owner_id= to scope to
  // someone else (see route header — the one explicit admin-override case
  // for diagnostics; mutation routes do NOT honour this parameter).
  let scopeOwnerId = actor.id;
  if (q.owner_id && q.owner_id !== actor.id) {
    if (actor.role !== 'admin') {
      return NextResponse.json(
        { error: 'forbidden', reason: 'owner_id scope requires admin role' },
        { status: 403 },
      );
    }
    scopeOwnerId = q.owner_id;
  }

  const db = getServerDb();
  const conditions = [eq(schema.watchlistSubscriptions.ownerId, scopeOwnerId)];
  if (q.active !== undefined) {
    conditions.push(eq(schema.watchlistSubscriptions.active, q.active ? 1 : 0));
  }
  if (q.source_adapter_id) {
    conditions.push(eq(schema.watchlistSubscriptions.sourceAdapterId, q.source_adapter_id));
  }
  if (q.kind) {
    conditions.push(eq(schema.watchlistSubscriptions.kind, q.kind));
  }
  if (q.cursor) {
    const cursorMs = Number(q.cursor);
    if (!Number.isFinite(cursorMs)) {
      return NextResponse.json(
        { error: 'invalid-query', reason: 'cursor must be a numeric ms timestamp' },
        { status: 400 },
      );
    }
    conditions.push(lt(schema.watchlistSubscriptions.createdAt, new Date(cursorMs)));
  }

  // Fetch limit + 1 to detect more rows.
  const rows = await db
    .select()
    .from(schema.watchlistSubscriptions)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(schema.watchlistSubscriptions.createdAt))
    .limit(q.limit + 1);

  const hasMore = rows.length > q.limit;
  const sliced = hasMore ? rows.slice(0, q.limit) : rows;
  const nextCursor =
    hasMore && sliced.length > 0
      ? String(sliced[sliced.length - 1]!.createdAt.getTime())
      : undefined;

  return NextResponse.json({
    subscriptions: sliced.map(toSubscriptionDto),
    ...(nextCursor ? { nextCursor } : {}),
  });
}
