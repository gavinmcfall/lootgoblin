/**
 * GET /api/v1/watchlist/subscriptions/:id
 * PATCH /api/v1/watchlist/subscriptions/:id
 * DELETE /api/v1/watchlist/subscriptions/:id
 *
 * V2-004-T9 — single-subscription endpoints. See `../route.ts` for the
 * collection-level POST/list documentation, including the auth model and
 * the owner-only ACL contract (admins do NOT get write access; they get
 * `?owner_id=` read access on the list endpoint only).
 *
 * Owner-mismatch returns 404 (NOT 403) so subscription ids do not leak.
 *
 * PATCH mutable fields: `cadence_seconds`, `default_collection_id`, `active`,
 * `parameters`. Attempts to mutate `kind` or `source_adapter_id` are 400 —
 * those fields are structural identity (changing them would invalidate the
 * adapter's stored cursor). The user can delete + re-create instead.
 *
 * DELETE is hard-delete. FK cascades:
 *   - watchlist_jobs rows → CASCADE (delete with the subscription)
 *   - ingest_jobs.parent_subscription_id → SET NULL (children survive)
 * In-flight watchlist_jobs (status='running'/'claimed') are NOT special-cased
 * here; they terminate normally per the worker logic and the cascade fires
 * on the trailing DELETE attempt. (SQLite's referential integrity does not
 * actually delete the row mid-update — the row vanishes once the worker's
 * SELECT-by-id sees the cascade gap; the worker tolerates this.)
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';
import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';

import {
  ensureCollectionWritable,
  loadSubscriptionForActor,
  toSubscriptionDto,
  UpdateBodySchema,
} from '../_shared';

// ---------------------------------------------------------------------------
// GET /api/v1/watchlist/subscriptions/:id
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  // Read-only path — admin can read another user's subscription via the
  // collection-level `?owner_id=` query, but the by-id path enforces strict
  // ownership (404 on mismatch). This avoids id-leakage across users.
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return unauthenticatedResponse(actor as null | typeof INVALID_API_KEY);
  }
  if (!id) {
    return NextResponse.json(
      { error: 'invalid-path', reason: 'missing subscription id' },
      { status: 400 },
    );
  }

  const db = getServerDb();
  const rows = await db
    .select()
    .from(schema.watchlistSubscriptions)
    .where(eq(schema.watchlistSubscriptions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json(
      { error: 'not-found', reason: 'subscription-not-found' },
      { status: 404 },
    );
  }

  // ACL — owner-only. Even admin gets 404 here (matches PATCH/DELETE).
  const acl = resolveAcl({
    user: actor,
    resource: { kind: 'watchlist_subscription', ownerId: row.ownerId },
    action: 'read',
  });
  if (!acl.allowed) {
    return NextResponse.json(
      { error: 'not-found', reason: 'subscription-not-found' },
      { status: 404 },
    );
  }

  return NextResponse.json({ subscription: toSubscriptionDto(row) });
}

// ---------------------------------------------------------------------------
// PATCH /api/v1/watchlist/subscriptions/:id
// ---------------------------------------------------------------------------

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  // Auth + load the subscription first so we don't consume body parse paths
  // for unauthorised callers. The immutable-field rejection happens after.
  const loaded = await loadSubscriptionForActor(req, id);
  if (!loaded.ok) return loaded.response;
  const { actor, row } = loaded;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid-body', reason: 'JSON parse failed' },
      { status: 400 },
    );
  }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if ('kind' in r) {
      return NextResponse.json(
        {
          error: 'invalid-body',
          reason: 'kind is structural and cannot be patched — delete + recreate the subscription',
        },
        { status: 400 },
      );
    }
    if ('source_adapter_id' in r) {
      return NextResponse.json(
        {
          error: 'invalid-body',
          reason:
            'source_adapter_id is structural and cannot be patched — delete + recreate the subscription',
        },
        { status: 400 },
      );
    }
  }

  const parsed = UpdateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const update = parsed.data;

  // If user is changing default_collection_id, re-validate ACL on the new one.
  if (
    update.default_collection_id &&
    update.default_collection_id !== row.defaultCollectionId
  ) {
    const collGate = await ensureCollectionWritable(actor, update.default_collection_id);
    if (!collGate.ok) return collGate.response;
  }

  // If user is changing parameters, ensure parameters.kind matches the row's
  // stored kind — the body validator only enforces internal-consistency.
  if (update.parameters && update.parameters.kind !== row.kind) {
    return NextResponse.json(
      {
        error: 'invalid-body',
        reason: `parameters.kind '${update.parameters.kind}' does not match subscription kind '${row.kind}'`,
      },
      { status: 400 },
    );
  }

  const now = new Date();
  const patch: Partial<typeof schema.watchlistSubscriptions.$inferInsert> = {
    updatedAt: now,
  };
  if (update.cadence_seconds !== undefined) patch.cadenceSeconds = update.cadence_seconds;
  if (update.default_collection_id !== undefined) {
    patch.defaultCollectionId = update.default_collection_id;
  }
  if (update.active !== undefined) patch.active = update.active ? 1 : 0;
  if (update.parameters !== undefined) {
    patch.parameters = JSON.stringify(update.parameters);
  }

  const db = getServerDb();
  await db
    .update(schema.watchlistSubscriptions)
    .set(patch)
    .where(eq(schema.watchlistSubscriptions.id, id));

  const refreshed = await db
    .select()
    .from(schema.watchlistSubscriptions)
    .where(eq(schema.watchlistSubscriptions.id, id))
    .limit(1);
  const updated = refreshed[0];
  if (!updated) {
    logger.error({ id }, 'watchlist-subs: post-update SELECT returned no row');
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
  return NextResponse.json({ subscription: toSubscriptionDto(updated) });
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/watchlist/subscriptions/:id
// ---------------------------------------------------------------------------

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const loaded = await loadSubscriptionForActor(req, id);
  if (!loaded.ok) return loaded.response;

  const db = getServerDb();
  await db
    .delete(schema.watchlistSubscriptions)
    .where(eq(schema.watchlistSubscriptions.id, id));

  return new Response(null, { status: 204 });
}
