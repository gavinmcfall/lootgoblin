/**
 * Shared helpers for /api/v1/materials/* routes — V2-007a-T14
 *
 * Centralises:
 *   - Auth + ACL guard that loads the row + checks ownership in one shot.
 *   - DTO mappers that translate DB rows into the public-facing JSON shape
 *     (Date → ISO string).
 *   - Idempotency helpers: normalize-create-body + replay/mismatch resolution.
 *   - Time-window parser for the consumption reports route.
 *
 * Auth model (mirrors V2-003-T9 / V2-004-T9)
 * ──────────
 * `authenticateRequest` accepts BetterAuth session OR a `programmatic`
 * x-api-key. ACL is `{ kind: 'material', ownerId }` — admins MAY read but
 * NOT write (the ACL resolver allows admin reads on materials for aggregate
 * reporting).
 *
 * Owner-mismatch policy
 * ─────────────────────
 * For PATCH / DELETE / POST-action endpoints we return 404 (not 403) when
 * the row is owned by another user — same approach as
 * /api/v1/watchlist/subscriptions/:id, so material ids do not leak across
 * users.
 *
 * Idempotency
 * ───────────
 * POST endpoints accept an optional `Idempotency-Key` header. The
 * idempotency_key column (migration 0021) is partial-unique on
 * (owner_id, idempotency_key). Replay with the same body returns the prior
 * row (200); replay with a different body returns 409.
 */

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
  type AuthenticatedActor,
} from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';
import { getServerDb, schema } from '@/db/client';

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

export type AuthOk = { ok: true; actor: AuthenticatedActor };
export type AuthErr = { ok: false; response: Response };
export type AuthResult = AuthOk | AuthErr;

/**
 * Authenticate the request and return either a live actor or a 401 response.
 */
export async function requireAuth(req: Request): Promise<AuthResult> {
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return {
      ok: false,
      response: unauthenticatedResponse(actor as null | typeof INVALID_API_KEY),
    };
  }
  return { ok: true, actor };
}

// ---------------------------------------------------------------------------
// Material loader + ACL gate
// ---------------------------------------------------------------------------

export type MaterialRow = typeof schema.materials.$inferSelect;

export type LoadMaterialOk = {
  ok: true;
  actor: AuthenticatedActor;
  row: MaterialRow;
};
export type LoadMaterialErr = { ok: false; response: Response };
export type LoadMaterialResult = LoadMaterialOk | LoadMaterialErr;

/**
 * Authenticate + load material + ACL-check ownership.
 *
 * Returns 404 (not 403) on owner mismatch so material ids don't leak across
 * users. `action` selects the ACL action (`read` | `update` | `delete`).
 */
export async function loadMaterialForActor(
  req: Request,
  id: string,
  action: 'read' | 'update' | 'delete' = 'update',
): Promise<LoadMaterialResult> {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth;

  if (typeof id !== 'string' || id.length === 0) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'invalid-path', message: 'missing material id' },
        { status: 400 },
      ),
    };
  }

  const db = getServerDb();
  const rows = await db
    .select()
    .from(schema.materials)
    .where(eq(schema.materials.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'not-found', message: 'material-not-found' },
        { status: 404 },
      ),
    };
  }

  const acl = resolveAcl({
    user: auth.actor,
    resource: { kind: 'material', ownerId: row.ownerId },
    action,
  });
  if (!acl.allowed) {
    // Mutating actions: 404 to avoid id leakage. Read: same — admin read is
    // ALL OWED by the ACL resolver, so we only get here on a real cross-owner
    // miss.
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'not-found', message: 'material-not-found' },
        { status: 404 },
      ),
    };
  }

  return { ok: true, actor: auth.actor, row };
}

// ---------------------------------------------------------------------------
// DTO mappers
// ---------------------------------------------------------------------------

export interface MaterialDto {
  id: string;
  ownerId: string;
  kind: string;
  productId: string | null;
  brand: string | null;
  subtype: string | null;
  colors: string[] | null;
  colorPattern: string | null;
  colorName: string | null;
  density: number | null;
  initialAmount: number;
  remainingAmount: number;
  unit: string;
  purchaseData: Record<string, unknown> | null;
  loadedInPrinterRef: string | null;
  active: boolean;
  retirementReason: string | null;
  retiredAt: string | null;
  extra: Record<string, unknown> | null;
  createdAt: string;
}

export function toMaterialDto(row: MaterialRow): MaterialDto {
  return {
    id: row.id,
    ownerId: row.ownerId,
    kind: row.kind,
    productId: row.productId ?? null,
    brand: row.brand ?? null,
    subtype: row.subtype ?? null,
    colors: row.colors ?? null,
    colorPattern: row.colorPattern ?? null,
    colorName: row.colorName ?? null,
    density: row.density ?? null,
    initialAmount: row.initialAmount,
    remainingAmount: row.remainingAmount,
    unit: row.unit,
    purchaseData: row.purchaseData ?? null,
    // TODO V2-005f-CF-1 T_g4: replace stub with LEFT JOIN to printer_loadouts
    // (current open loadout for this material). Until T_g4 lands, the DTO
    // surfaces null so the v1 API contract still names the field.
    loadedInPrinterRef: null,
    active: row.active === true,
    retirementReason: row.retirementReason ?? null,
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    extra: row.extra ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface MixRecipeDto {
  id: string;
  ownerId: string;
  name: string;
  components: Array<{ materialProductRef: string; ratioOrGrams: number }>;
  notes: string | null;
  createdAt: string;
}

export function toMixRecipeDto(
  row: typeof schema.mixRecipes.$inferSelect,
): MixRecipeDto {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    components: row.components,
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface MixBatchDto {
  id: string;
  recipeId: string;
  materialId: string;
  ownerId: string | null;
  totalVolume: number;
  perComponentDraws: Array<{
    sourceMaterialId: string;
    drawAmount: number;
    provenanceClass: string;
  }>;
  createdAt: string;
}

export function toMixBatchDto(
  row: typeof schema.mixBatches.$inferSelect,
): MixBatchDto {
  return {
    id: row.id,
    recipeId: row.recipeId,
    materialId: row.materialId,
    ownerId: row.ownerId ?? null,
    totalVolume: row.totalVolume,
    perComponentDraws: row.perComponentDraws,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface RecycleEventDto {
  id: string;
  ownerId: string;
  inputs: Array<{
    sourceMaterialId: string | null;
    weight: number;
    provenanceClass: string;
    note?: string;
  }>;
  outputSpoolId: string;
  notes: string | null;
  createdAt: string;
}

export function toRecycleEventDto(
  row: typeof schema.recycleEvents.$inferSelect,
): RecycleEventDto {
  return {
    id: row.id,
    ownerId: row.ownerId,
    inputs: row.inputs,
    outputSpoolId: row.outputSpoolId,
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Idempotency helpers
// ---------------------------------------------------------------------------

/**
 * Look up an existing row inserted under (ownerId, idempotencyKey). Used by
 * POST handlers to detect replays before doing the insert.
 */
export async function findByIdempotencyKey<
  TRow extends { idempotencyKey?: string | null },
>(
  table:
    | typeof schema.materials
    | typeof schema.mixRecipes
    | typeof schema.mixBatches
    | typeof schema.recycleEvents
    | typeof schema.slicerProfiles
    | typeof schema.printSettings,
  ownerColumn:
    | typeof schema.materials.ownerId
    | typeof schema.mixRecipes.ownerId
    | typeof schema.mixBatches.ownerId
    | typeof schema.recycleEvents.ownerId
    | typeof schema.slicerProfiles.ownerId
    | typeof schema.printSettings.ownerId,
  keyColumn:
    | typeof schema.materials.idempotencyKey
    | typeof schema.mixRecipes.idempotencyKey
    | typeof schema.mixBatches.idempotencyKey
    | typeof schema.recycleEvents.idempotencyKey
    | typeof schema.slicerProfiles.idempotencyKey
    | typeof schema.printSettings.idempotencyKey,
  ownerId: string,
  idempotencyKey: string,
): Promise<TRow | null> {
  const db = getServerDb();
  const rows = await db
    .select()
    .from(table)
    .where(and(eq(ownerColumn, ownerId), eq(keyColumn, idempotencyKey)))
    .limit(1);
  return (rows[0] ?? null) as TRow | null;
}

/**
 * Update a freshly created row's idempotency_key column.
 * Called from POST handlers AFTER the domain function inserts the row, so
 * that the (ownerId, idempotencyKey) uniqueness is preserved.
 *
 * The pattern: domain helpers (T4-T11) don't know about idempotency keys;
 * the route writes them post-hoc with a single UPDATE. A concurrent INSERT
 * with the same key would fail the partial unique index AT THE UPDATE step
 * (not the INSERT step) — see updateIdempotencyKey + race recovery in each
 * POST.
 */
export async function tryClaimIdempotencyKey(
  table:
    | typeof schema.materials
    | typeof schema.mixRecipes
    | typeof schema.mixBatches
    | typeof schema.recycleEvents
    | typeof schema.slicerProfiles
    | typeof schema.printSettings,
  idColumn:
    | typeof schema.materials.id
    | typeof schema.mixRecipes.id
    | typeof schema.mixBatches.id
    | typeof schema.recycleEvents.id
    | typeof schema.slicerProfiles.id
    | typeof schema.printSettings.id,
  rowId: string,
  idempotencyKey: string,
): Promise<{ ok: true } | { ok: false; err: unknown }> {
  try {
    const db = getServerDb();
    await db
      .update(table)
      .set({ idempotencyKey })
      .where(eq(idColumn, rowId));
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

// ---------------------------------------------------------------------------
// Error response helper
// ---------------------------------------------------------------------------

/**
 * Canonical error envelope used across /api/v1/materials/*.
 * `error` is the kebab-case code; `message` is human-readable; optional
 * `details` for extra context (matches V2-003-T9 ingest pattern).
 */
export function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: string,
): Response {
  const body: Record<string, unknown> = { error: code, message };
  if (details !== undefined) body.details = details;
  return NextResponse.json(body, { status });
}

/**
 * Map domain-layer reason codes (from materials/* helpers) to HTTP status.
 * Validation failures → 400; not-found-likes → 404; idempotent collisions
 * are surfaced separately (see normalizeStoredRow patterns).
 */
export function statusForReason(reason: string): number {
  if (reason === 'persist-failed') return 500;
  if (reason === 'not-implemented') return 501;
  if (reason === 'material-not-found') return 404;
  if (reason === 'recipe-not-found') return 404;
  if (reason === 'source-not-found') return 404;
  if (reason === 'already-retired') return 409;
  if (reason === 'loaded-in-printer-no-ack') return 409;
  if (reason === 'active-dispatch') return 409;
  if (reason === 'material-retired') return 409;
  if (reason === 'printer-slot-occupied') return 409;
  if (reason === 'not-loaded') return 409;
  if (reason === 'output-anomaly-no-ack') return 409;
  // All remaining validation reasons → 400.
  return 400;
}

// ---------------------------------------------------------------------------
// Time-window parser (used by /api/v1/reports/consumption)
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 30;

export interface ParsedTimeWindow {
  ok: true;
  since: Date;
  until: Date;
}

export interface TimeWindowError {
  ok: false;
  response: Response;
}

export function parseTimeWindow(
  searchParams: URLSearchParams,
  now: Date = new Date(),
): ParsedTimeWindow | TimeWindowError {
  const sinceRaw = searchParams.get('since');
  const untilRaw = searchParams.get('until');

  let since: Date;
  let until: Date;

  if (untilRaw === null) {
    until = now;
  } else {
    const parsed = new Date(untilRaw);
    if (Number.isNaN(parsed.getTime())) {
      return {
        ok: false,
        response: errorResponse(
          'invalid-query',
          'until must be an ISO 8601 timestamp',
          400,
        ),
      };
    }
    until = parsed;
  }

  if (sinceRaw === null) {
    since = new Date(until.getTime() - DEFAULT_WINDOW_DAYS * 86400_000);
  } else {
    const parsed = new Date(sinceRaw);
    if (Number.isNaN(parsed.getTime())) {
      return {
        ok: false,
        response: errorResponse(
          'invalid-query',
          'since must be an ISO 8601 timestamp',
          400,
        ),
      };
    }
    since = parsed;
  }

  if (since.getTime() >= until.getTime()) {
    return {
      ok: false,
      response: errorResponse(
        'invalid-query',
        'since must be earlier than until',
        400,
      ),
    };
  }

  return { ok: true, since, until };
}
