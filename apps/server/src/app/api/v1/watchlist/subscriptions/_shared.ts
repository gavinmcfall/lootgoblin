/**
 * Shared helpers for /api/v1/watchlist/subscriptions/* routes — V2-004-T9.
 *
 * Centralises:
 *   - Zod schemas for body parsing (POST + PATCH) and per-kind discriminated
 *     parameters union — mirrors `WatchlistSubscriptionParameters` in
 *     `src/watchlist/types.ts` exactly so a misalignment between the API
 *     surface and the dispatch layer is caught by tsc.
 *   - Auth + ownership guard that loads the row + ACL-checks it in one place
 *     (every route except POST/list goes through this).
 *   - Capability validation against the SubscribableAdapter registry.
 *   - DTO mapper that translates the DB row into the route response shape
 *     (parameters JSON-decoded, timestamps ISO).
 *
 * Auth model
 * ──────────
 * Watchlist subscriptions are owner-only — see `src/acl/resolver.ts`. The
 * existing `watchlist_subscription` ACL kind says admin CANNOT access another
 * user's subscription (matches `grimoire_entry`). T9 honours that contract:
 * even an admin gets 404 when probing another user's subscription. This
 * differs from ingest_jobs where admins are read-allowed.
 *
 * Idempotency
 * ───────────
 * POST accepts the same `Idempotency-Key` header pattern as /api/v1/ingest.
 * Persisted on a new `watchlist_subscriptions.idempotency_key` column added
 * in migration 0017.
 */

import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
  type AuthenticatedActor,
} from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';
import { getServerDb, schema } from '@/db/client';
import { defaultRegistry, hasCapability, type SourceId } from '@/scavengers';
import type {
  WatchlistSubscriptionKind,
  WatchlistSubscriptionParameters,
} from '@/watchlist/types';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** 60 seconds. Below this, every scheduler tick re-fires the subscription. */
export const MIN_CADENCE_SECONDS = 60;
/** 7 days. Past this, the user almost certainly wants a different mechanism. */
export const MAX_CADENCE_SECONDS = 86_400 * 7;
/** Default cadence applied when the body omits `cadence_seconds`. */
export const DEFAULT_CADENCE_SECONDS = 3_600;

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/**
 * Per-kind parameters discriminated union — kept in lockstep with
 * `WatchlistSubscriptionParameters` in `src/watchlist/types.ts`. The route
 * layer is the only place that translates the API JSON surface into the
 * stored `parameters` column, so the discriminator MUST validate here.
 */
export const ParametersSchema: z.ZodType<WatchlistSubscriptionParameters> =
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('creator'), creatorId: z.string().min(1) }),
    z.object({ kind: z.literal('tag'), tag: z.string().min(1) }),
    z.object({ kind: z.literal('saved_search'), query: z.string().min(1) }),
    z.object({ kind: z.literal('url_watch'), url: z.string().url() }),
    z.object({ kind: z.literal('folder_watch'), folderId: z.string().min(1) }),
  ]);

const KindSchema = z.enum(['creator', 'tag', 'saved_search', 'url_watch', 'folder_watch']);

const CadenceSchema = z
  .number()
  .int()
  .min(MIN_CADENCE_SECONDS)
  .max(MAX_CADENCE_SECONDS);

/** POST body — create subscription. */
export const CreateBodySchema = z
  .object({
    kind: KindSchema,
    source_adapter_id: z.string().min(1),
    parameters: ParametersSchema,
    cadence_seconds: CadenceSchema.optional(),
    default_collection_id: z.string().uuid(),
  })
  .refine((v) => v.kind === v.parameters.kind, {
    message: 'parameters.kind must match top-level kind',
    path: ['parameters', 'kind'],
  });

/**
 * PATCH body — only mutable fields. `kind` and `source_adapter_id` are
 * structural identity and cannot be changed — change those by deleting +
 * re-creating the subscription.
 */
export const UpdateBodySchema = z
  .object({
    cadence_seconds: CadenceSchema.optional(),
    default_collection_id: z.string().uuid().optional(),
    active: z.boolean().optional(),
    parameters: ParametersSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'at least one mutable field is required',
  });

/** Resume body (catch-up flag). */
export const ResumeBodySchema = z
  .object({ catch_up: z.boolean().optional() })
  .strict()
  .or(z.undefined());

// ---------------------------------------------------------------------------
// Auth + load helper
// ---------------------------------------------------------------------------

/**
 * Authenticate + load a subscription by id + ACL-check ownership in one shot.
 *
 * Returns one of three shapes — the route handler pattern-matches on `ok`:
 *   - { ok: true, actor, row } — keep going
 *   - { ok: false, response } — short-circuit with this Response
 *
 * On owner mismatch we return 404 (NOT 403) so we don't leak that a given
 * subscription id exists for someone else — same approach as
 * `/api/v1/ingest/:jobId`.
 */
export type SubscriptionRow = typeof schema.watchlistSubscriptions.$inferSelect;

export type LoadOk = { ok: true; actor: AuthenticatedActor; row: SubscriptionRow };
export type LoadErr = { ok: false; response: Response };
export type LoadResult = LoadOk | LoadErr;

export async function loadSubscriptionForActor(
  req: Request,
  id: string,
): Promise<LoadResult> {
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return { ok: false, response: unauthenticatedResponse(actor as null | typeof INVALID_API_KEY) };
  }

  if (!id) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'invalid-path', reason: 'missing subscription id' },
        { status: 400 },
      ),
    };
  }

  const db = getServerDb();
  const rows = await db
    .select()
    .from(schema.watchlistSubscriptions)
    .where(eq(schema.watchlistSubscriptions.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'not-found', reason: 'subscription-not-found' },
        { status: 404 },
      ),
    };
  }

  // ACL: owner-only. Admin DOES NOT bypass — see resolver header. Treat the
  // miss as 404 (not 403) so subscription ids do not leak across users.
  const acl = resolveAcl({
    user: actor,
    resource: { kind: 'watchlist_subscription', ownerId: row.ownerId },
    action: 'update',
  });
  if (!acl.allowed) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'not-found', reason: 'subscription-not-found' },
        { status: 404 },
      ),
    };
  }

  return { ok: true, actor, row };
}

// ---------------------------------------------------------------------------
// Capability check
// ---------------------------------------------------------------------------

/**
 * Validate that the registry knows about `sourceAdapterId` and that the
 * adapter declares the watchlist `kind` capability. Returns either:
 *   - { ok: true } — adapter exists and supports the kind
 *   - { ok: false, response } — short-circuit with the response (404 unknown
 *     source, 422 unsupported kind)
 */
export type CapOk = { ok: true };
export type CapErr = { ok: false; response: Response };
export type CapResult = CapOk | CapErr;

export function validateCapability(
  sourceAdapterId: string,
  kind: WatchlistSubscriptionKind,
): CapResult {
  const adapter = defaultRegistry.getSubscribable(sourceAdapterId as SourceId);
  if (!adapter) {
    // 422 (unsupported-source) — same status as /api/v1/ingest's "unknown
    // sourceId" branch. The id may exist as a ScavengerAdapter but lack a
    // SubscribableAdapter; the user-visible result is the same.
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'unsupported-source',
          reason: `unknown or non-subscribable sourceId: ${sourceAdapterId}`,
        },
        { status: 422 },
      ),
    };
  }
  if (!hasCapability(adapter, kind)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'unsupported-capability',
          reason: `adapter '${sourceAdapterId}' does not support kind '${kind}'`,
        },
        { status: 422 },
      ),
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Collection ACL guard
// ---------------------------------------------------------------------------

/**
 * Ensure a collection exists AND the actor has `update` ACL on it.
 *
 * Returns:
 *   - { ok: true } — collection exists and actor may write to it
 *   - { ok: false, response } — 404 (missing) or 403 (forbidden)
 */
export type CollectionOk = { ok: true };
export type CollectionErr = { ok: false; response: Response };
export type CollectionResult = CollectionOk | CollectionErr;

export async function ensureCollectionWritable(
  actor: AuthenticatedActor,
  collectionId: string,
): Promise<CollectionResult> {
  const db = getServerDb();
  const rows = await db
    .select({ ownerId: schema.collections.ownerId })
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'not-found', reason: 'collection-not-found' },
        { status: 404 },
      ),
    };
  }
  const acl = resolveAcl({
    user: actor,
    resource: { kind: 'collection', ownerId: row.ownerId },
    action: 'update',
  });
  if (!acl.allowed) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'forbidden', reason: acl.reason },
        { status: 403 },
      ),
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// DTO mapper
// ---------------------------------------------------------------------------

/**
 * Translate a `watchlist_subscriptions` row into the JSON shape returned by
 * the routes. `parameters` is JSON-decoded and emitted as a structured object
 * so callers don't need to re-parse the string column.
 *
 * Robust against legacy rows whose `parameters` column may not parse — emits
 * `parameters: null` rather than throwing, so list/get pages keep rendering.
 */
export function toSubscriptionDto(row: SubscriptionRow): {
  id: string;
  ownerId: string;
  kind: string;
  sourceAdapterId: string;
  parameters: WatchlistSubscriptionParameters | null;
  cadenceSeconds: number;
  active: boolean;
  defaultCollectionId: string | null;
  cursorState: string | null;
  errorStreak: number;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
} {
  let parameters: WatchlistSubscriptionParameters | null = null;
  try {
    const parsed = JSON.parse(row.parameters) as unknown;
    const validated = ParametersSchema.safeParse(parsed);
    parameters = validated.success ? validated.data : null;
  } catch {
    parameters = null;
  }
  return {
    id: row.id,
    ownerId: row.ownerId,
    kind: row.kind,
    sourceAdapterId: row.sourceAdapterId,
    parameters,
    cadenceSeconds: row.cadenceSeconds,
    active: row.active === 1,
    defaultCollectionId: row.defaultCollectionId ?? null,
    cursorState: row.cursorState ?? null,
    errorStreak: row.errorStreak,
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Idempotency normalization
// ---------------------------------------------------------------------------

/**
 * Stable string used to compare two POSTs that share an Idempotency-Key.
 * Two POSTs with the same key + same normalized body are idempotent; same
 * key + different body → 409.
 */
export function normalizeCreateBody(body: z.infer<typeof CreateBodySchema>): string {
  return JSON.stringify({
    kind: body.kind,
    sourceAdapterId: body.source_adapter_id,
    parameters: body.parameters,
    cadenceSeconds: body.cadence_seconds ?? DEFAULT_CADENCE_SECONDS,
    defaultCollectionId: body.default_collection_id,
  });
}

/**
 * Reconstruct the normalized form from a stored row — used to compare a
 * replayed POST against the original request body.
 */
export function normalizeStoredRow(row: SubscriptionRow): string {
  let parsedParameters: WatchlistSubscriptionParameters | null = null;
  try {
    const parsed = JSON.parse(row.parameters) as unknown;
    const validated = ParametersSchema.safeParse(parsed);
    parsedParameters = validated.success ? validated.data : null;
  } catch {
    parsedParameters = null;
  }
  return JSON.stringify({
    kind: row.kind,
    sourceAdapterId: row.sourceAdapterId,
    parameters: parsedParameters,
    cadenceSeconds: row.cadenceSeconds,
    defaultCollectionId: row.defaultCollectionId,
  });
}

// ---------------------------------------------------------------------------
// In-flight job lookup (used by fire-now)
// ---------------------------------------------------------------------------

/** Watchlist statuses that count as "in-flight" — matches scheduler/T3. */
export const IN_FLIGHT_STATUSES = ['queued', 'claimed', 'running'] as const;

export async function findInFlightJob(
  subscriptionId: string,
): Promise<{ id: string; status: string } | null> {
  const db = getServerDb();
  const rows = await db
    .select({
      id: schema.watchlistJobs.id,
      status: schema.watchlistJobs.status,
    })
    .from(schema.watchlistJobs)
    .where(
      and(
        eq(schema.watchlistJobs.subscriptionId, subscriptionId),
        inArray(
          schema.watchlistJobs.status,
          IN_FLIGHT_STATUSES as unknown as string[],
        ),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
