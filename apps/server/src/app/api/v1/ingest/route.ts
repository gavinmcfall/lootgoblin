/**
 * POST /api/v1/ingest + GET /api/v1/ingest — V2-003-T9
 *
 * Async ingest contract
 * ─────────────────────
 * POST /api/v1/ingest enqueues an ingest_jobs row and returns IMMEDIATELY
 * with `{ jobId, status: 'queued', sourceId }`. The shared ingest pipeline
 * (V2-003-T2) runs out-of-band and updates the row's `status` over time.
 * Callers poll GET /api/v1/ingest/:jobId for terminal state.
 *
 * Idempotency
 * ───────────
 * Optional `Idempotency-Key` header — if present, a second POST with the
 * same `(owner_id, idempotency_key)` either returns the existing jobId
 * (when the body normalizes to the same target) or 409 (when the body
 * differs). Persisted via the partial unique index added in migration 0013.
 *
 * Auth boundary
 * ─────────────
 * v2 has TWO API-key boundaries:
 *
 *   1. BetterAuth `apikey` table — user-bound, scope-bearing. Scopes used
 *      by V2-003 are `ingest:write` (POST) and `ingest:read` (GET). Web UI
 *      sessions also work (session cookie maps to a user with role-based ACL).
 *
 *   2. Custom `api_keys` Drizzle table — legacy from v1. Documented as
 *      DEPRECATED for T9+ routes; the shared `authenticateRequest` helper
 *      currently accepts `programmatic` keys from this table for transitional
 *      compatibility. New consumers should use BetterAuth apikey scopes.
 *
 * The legacy /api/v1/source-credentials/[source]/route.ts (cookie-jar
 * uploads from the extension) coexists — see the route-header comment
 * there for the v2 successor at /api/v1/source-auth/:sourceId/*.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, desc, eq, lt } from 'drizzle-orm';

import { authenticateRequest, INVALID_API_KEY, unauthenticatedResponse } from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';
import { getServerDb, schema } from '@/db/client';
import { defaultRegistry, type SourceId } from '@/scavengers';
import { logger } from '@/logger';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const UrlBody = z.object({
  url: z.string().min(1).url(),
  collectionId: z.string().uuid(),
});

const SourceItemIdBody = z.object({
  sourceId: z.string().min(1),
  sourceItemId: z.string().min(1),
  collectionId: z.string().uuid(),
});

const IngestBody = z.union([UrlBody, SourceItemIdBody]);

// Status whitelist for GET / list filter.
const ListQuery = z.object({
  status: z
    .enum(['queued', 'fetching', 'placing', 'completed', 'failed', 'quarantined', 'paused-auth', 'rate-limit-deferred'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Body normalization — for idempotency match
// ---------------------------------------------------------------------------

/**
 * Normalize a parsed IngestBody to a stable string used for idempotency
 * matching. Two POSTs with the same Idempotency-Key + same normalized body
 * are idempotent; same key + different body → 409.
 */
function normalizeBody(parsed: z.infer<typeof IngestBody>, sourceId: string): string {
  if ('url' in parsed) {
    return JSON.stringify({ kind: 'url', url: parsed.url, sourceId, collectionId: parsed.collectionId });
  }
  return JSON.stringify({
    kind: 'source-item-id',
    sourceId: parsed.sourceId,
    sourceItemId: parsed.sourceItemId,
    collectionId: parsed.collectionId,
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/ingest
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  // TODO(scope-enforcement): once the BetterAuth `apikey` plugin is wired,
  // require the `ingest:write` scope here instead of accepting any programmatic key.
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return unauthenticatedResponse(actor as null | typeof INVALID_API_KEY);
  }

  // ── 2. Parse body ────────────────────────────────────────────────────────
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid-body', reason: 'JSON parse failed' }, { status: 400 });
  }

  const parsed = IngestBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // ── 3. Resolve adapter (URL form vs source-item-id form) ─────────────────
  let resolvedSourceId: SourceId;
  let targetKind: 'url' | 'source-item-id';
  let targetPayload: string;

  if ('url' in parsed.data) {
    const adapter = defaultRegistry.resolveUrl(parsed.data.url);
    if (!adapter) {
      return NextResponse.json(
        { error: 'unsupported-source', reason: 'no adapter claims this URL' },
        { status: 422 },
      );
    }
    resolvedSourceId = adapter.id;
    targetKind = 'url';
    targetPayload = JSON.stringify({ kind: 'url', url: parsed.data.url });
  } else {
    const adapter = defaultRegistry.getById(parsed.data.sourceId as SourceId);
    if (!adapter) {
      return NextResponse.json(
        { error: 'unsupported-source', reason: `unknown sourceId: ${parsed.data.sourceId}` },
        { status: 422 },
      );
    }
    resolvedSourceId = adapter.id;
    targetKind = 'source-item-id';
    targetPayload = JSON.stringify({ kind: 'source-item-id', sourceItemId: parsed.data.sourceItemId });
  }

  const collectionId = parsed.data.collectionId;
  const idempotencyKey = req.headers.get('Idempotency-Key');
  const normalized = normalizeBody(parsed.data, resolvedSourceId);

  const db = getServerDb();

  // ── 4. Collection existence + ACL ────────────────────────────────────────
  const collectionRows = await db
    .select({ ownerId: schema.collections.ownerId })
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
    .limit(1);

  const collectionRow = collectionRows[0];
  if (!collectionRow) {
    return NextResponse.json({ error: 'not-found', reason: 'collection-not-found' }, { status: 404 });
  }

  const acl = resolveAcl({
    user: actor,
    resource: { kind: 'collection', ownerId: collectionRow.ownerId },
    action: 'update',
  });
  if (!acl.allowed) {
    return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });
  }

  // ── 5. Idempotency-Key handling ──────────────────────────────────────────
  if (idempotencyKey) {
    const prior = await db
      .select({
        id: schema.ingestJobs.id,
        status: schema.ingestJobs.status,
        sourceId: schema.ingestJobs.sourceId,
        targetKind: schema.ingestJobs.targetKind,
        targetPayload: schema.ingestJobs.targetPayload,
        collectionId: schema.ingestJobs.collectionId,
      })
      .from(schema.ingestJobs)
      .where(
        and(
          eq(schema.ingestJobs.ownerId, actor.id),
          eq(schema.ingestJobs.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    const priorRow = prior[0];
    if (priorRow) {
      // Reconstruct normalized body of the prior request from stored columns.
      const priorTarget = JSON.parse(priorRow.targetPayload) as
        | { kind: 'url'; url: string }
        | { kind: 'source-item-id'; sourceItemId: string };
      const priorNormalized = (() => {
        if (priorTarget.kind === 'url') {
          return JSON.stringify({
            kind: 'url',
            url: priorTarget.url,
            sourceId: priorRow.sourceId,
            collectionId: priorRow.collectionId,
          });
        }
        return JSON.stringify({
          kind: 'source-item-id',
          sourceId: priorRow.sourceId,
          sourceItemId: priorTarget.sourceItemId,
          collectionId: priorRow.collectionId,
        });
      })();

      if (priorNormalized === normalized) {
        // Same body — return existing job (idempotent replay).
        return NextResponse.json(
          { jobId: priorRow.id, status: priorRow.status, sourceId: priorRow.sourceId },
          { status: 200 },
        );
      }

      // Different body — RFC 7240-style mismatch.
      return NextResponse.json(
        {
          error: 'idempotency-mismatch',
          reason: 'Idempotency-Key reused with a different request body',
          jobId: priorRow.id,
        },
        { status: 409 },
      );
    }
  }

  // ── 6. Insert ingest_jobs row ────────────────────────────────────────────
  const jobId = randomUUID();
  const now = new Date();
  try {
    await db.insert(schema.ingestJobs).values({
      id: jobId,
      ownerId: actor.id,
      sourceId: resolvedSourceId,
      targetKind,
      targetPayload,
      collectionId,
      status: 'queued',
      lootId: null,
      quarantineItemId: null,
      failureReason: null,
      failureDetails: null,
      attempt: 1,
      idempotencyKey: idempotencyKey ?? null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    // Race: another concurrent POST inserted the same idempotency_key.
    // Re-read and return that row.
    if (idempotencyKey) {
      const racePrior = await db
        .select({
          id: schema.ingestJobs.id,
          status: schema.ingestJobs.status,
          sourceId: schema.ingestJobs.sourceId,
        })
        .from(schema.ingestJobs)
        .where(
          and(
            eq(schema.ingestJobs.ownerId, actor.id),
            eq(schema.ingestJobs.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      const raceRow = racePrior[0];
      if (raceRow) {
        return NextResponse.json(
          { jobId: raceRow.id, status: raceRow.status, sourceId: raceRow.sourceId },
          { status: 200 },
        );
      }
    }
    logger.error({ err, jobId }, 'ingest: failed to insert ingest_jobs row');
    return NextResponse.json(
      { error: 'internal', reason: 'failed to enqueue job' },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { jobId, status: 'queued', sourceId: resolvedSourceId },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// GET /api/v1/ingest — list (paginated)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  // TODO(scope-enforcement): once the BetterAuth `apikey` plugin is wired,
  // require the `ingest:read` scope here instead of accepting any programmatic key.
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return unauthenticatedResponse(actor as null | typeof INVALID_API_KEY);
  }

  const url = new URL(req.url);
  const queryRaw = {
    status: url.searchParams.get('status') ?? undefined,
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
  const { status, limit, cursor } = queryParsed.data;

  const db = getServerDb();

  const conditions = [eq(schema.ingestJobs.ownerId, actor.id)];
  if (status) conditions.push(eq(schema.ingestJobs.status, status));
  if (cursor) {
    const cursorMs = Number(cursor);
    if (!Number.isFinite(cursorMs)) {
      return NextResponse.json({ error: 'invalid-query', reason: 'cursor must be a numeric ms timestamp' }, { status: 400 });
    }
    conditions.push(lt(schema.ingestJobs.createdAt, new Date(cursorMs)));
  }

  // Fetch limit + 1 to detect whether more rows exist.
  const rows = await db
    .select({
      id: schema.ingestJobs.id,
      sourceId: schema.ingestJobs.sourceId,
      collectionId: schema.ingestJobs.collectionId,
      status: schema.ingestJobs.status,
      lootId: schema.ingestJobs.lootId,
      failureReason: schema.ingestJobs.failureReason,
      failureDetails: schema.ingestJobs.failureDetails,
      createdAt: schema.ingestJobs.createdAt,
      updatedAt: schema.ingestJobs.updatedAt,
    })
    .from(schema.ingestJobs)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(schema.ingestJobs.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && sliced.length > 0
    ? String(sliced[sliced.length - 1]!.createdAt!.getTime())
    : undefined;

  const jobs = sliced.map((r) => ({
    jobId: r.id,
    status: r.status,
    sourceId: r.sourceId,
    collectionId: r.collectionId,
    createdAt: r.createdAt?.toISOString(),
    updatedAt: r.updatedAt?.toISOString(),
    ...(r.lootId ? { lootId: r.lootId } : {}),
    ...(r.failureReason ? { failureReason: r.failureReason } : {}),
    ...(r.failureDetails ? { failureDetails: r.failureDetails } : {}),
  }));

  return NextResponse.json({
    jobs,
    ...(nextCursor ? { nextCursor } : {}),
  });
}
