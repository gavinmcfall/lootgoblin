/**
 * Shared helpers for /api/v1/forge/* routes — V2-005a-T5
 *
 * Centralises:
 *   - Auth guard (mirrors materials/_shared.ts)
 *   - Printer / Slicer / DispatchJob loaders + ACL gates
 *   - DTO mappers (DB row → public JSON shape; Date → ms epoch)
 *   - Idempotency helpers (look up + claim post-insert)
 *   - Error envelope: `{error: 'kebab-code', message: 'Human-readable text'}`
 *
 * Auth model
 * ──────────
 * BetterAuth session OR `programmatic` x-api-key (mirrors materials,
 * watchlist, ingest). Forge resources are user-owned for printers + slicers
 * (admin reads ALLOWED for fleet visibility; admin writes NOT permitted —
 * the printer/slicer ACL resolver enforces owner-consent).
 *
 * Owner-mismatch policy
 * ─────────────────────
 * For PATCH / DELETE / POST-action / GET-by-id endpoints we return 404
 * (not 403) when the row is owned by another user — same approach as
 * /api/v1/materials/:id and /api/v1/watchlist/subscriptions/:id, so
 * resource ids do not leak across users. Admins are the exception: admin
 * reads return the row.
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

/** Authenticate the request and return either a live actor or a 401 response. */
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
// Error envelope
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Printer loader + ACL gate
// ---------------------------------------------------------------------------

export type PrinterRow = typeof schema.printers.$inferSelect;

export type LoadPrinterOk = {
  ok: true;
  actor: AuthenticatedActor;
  row: PrinterRow;
};
export type LoadPrinterErr = { ok: false; response: Response };
export type LoadPrinterResult = LoadPrinterOk | LoadPrinterErr;

/**
 * Authenticate + load printer + ACL-check ownership for the requested action.
 *
 * Returns 404 (not 403) on owner mismatch so printer ids don't leak across
 * users. Admin can read; admin write/delete is NOT permitted (consent model
 * — see acl/resolver.ts header). For `push` we honor explicit aclGrantees.
 *
 * NOTE: ACL grantees on printers are surfaced via printer_acls rows. The
 * resolver only sees grantees if the caller provides them; we hydrate them
 * inline here for the `push` action.
 */
export async function loadPrinterForActor(
  req: Request,
  id: string,
  action: 'read' | 'update' | 'delete' | 'push',
): Promise<LoadPrinterResult> {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth;

  if (typeof id !== 'string' || id.length === 0) {
    return {
      ok: false,
      response: errorResponse('invalid-path', 'missing printer id', 400),
    };
  }

  const db = getServerDb();
  const rows = await db
    .select()
    .from(schema.printers)
    .where(eq(schema.printers.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      response: errorResponse('not-found', 'printer-not-found', 404),
    };
  }

  // Hydrate ACL grantees only when needed (push action).
  let aclGrantees: string[] | undefined;
  if (action === 'push') {
    const grants = await db
      .select({ userId: schema.printerAcls.userId })
      .from(schema.printerAcls)
      .where(eq(schema.printerAcls.printerId, id));
    aclGrantees = grants.map((g) => g.userId);
  }

  // Route-layer scoping (V2-005a-T5 architectural decision):
  //   Read: owner sees their own; admin sees all. The global ACL resolver's
  //   `printer.read` is fleet-visible (`ALLOW` for all authenticated users),
  //   but the Forge HTTP surface deliberately scopes reads to owner+admin so
  //   that printer ids do not leak across users on multi-tenant instances.
  if (action === 'read') {
    if (auth.actor.role !== 'admin' && row.ownerId !== auth.actor.id) {
      return {
        ok: false,
        response: errorResponse('not-found', 'printer-not-found', 404),
      };
    }
    return { ok: true, actor: auth.actor, row };
  }

  const decision = resolveAcl({
    user: auth.actor,
    resource: { kind: 'printer', ownerId: row.ownerId, id, ...(aclGrantees ? { aclGrantees } : {}) },
    action,
  });
  if (!decision.allowed) {
    return {
      ok: false,
      response: errorResponse('not-found', 'printer-not-found', 404),
    };
  }
  return { ok: true, actor: auth.actor, row };
}

// ---------------------------------------------------------------------------
// Slicer loader + ACL gate
// ---------------------------------------------------------------------------

export type SlicerRow = typeof schema.forgeSlicers.$inferSelect;

export type LoadSlicerOk = {
  ok: true;
  actor: AuthenticatedActor;
  row: SlicerRow;
};
export type LoadSlicerErr = { ok: false; response: Response };
export type LoadSlicerResult = LoadSlicerOk | LoadSlicerErr;

export async function loadSlicerForActor(
  req: Request,
  id: string,
  action: 'read' | 'update' | 'delete' | 'push',
): Promise<LoadSlicerResult> {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth;

  if (typeof id !== 'string' || id.length === 0) {
    return {
      ok: false,
      response: errorResponse('invalid-path', 'missing slicer id', 400),
    };
  }

  const db = getServerDb();
  const rows = await db
    .select()
    .from(schema.forgeSlicers)
    .where(eq(schema.forgeSlicers.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      response: errorResponse('not-found', 'slicer-not-found', 404),
    };
  }

  let aclGrantees: string[] | undefined;
  if (action === 'push') {
    const grants = await db
      .select({ userId: schema.slicerAcls.userId })
      .from(schema.slicerAcls)
      .where(eq(schema.slicerAcls.slicerId, id));
    aclGrantees = grants.map((g) => g.userId);
  }

  // Same route-layer read scoping as printers — see loadPrinterForActor.
  if (action === 'read') {
    if (auth.actor.role !== 'admin' && row.ownerId !== auth.actor.id) {
      return {
        ok: false,
        response: errorResponse('not-found', 'slicer-not-found', 404),
      };
    }
    return { ok: true, actor: auth.actor, row };
  }

  const decision = resolveAcl({
    user: auth.actor,
    resource: { kind: 'slicer', ownerId: row.ownerId, id, ...(aclGrantees ? { aclGrantees } : {}) },
    action,
  });
  if (!decision.allowed) {
    return {
      ok: false,
      response: errorResponse('not-found', 'slicer-not-found', 404),
    };
  }
  return { ok: true, actor: auth.actor, row };
}

// ---------------------------------------------------------------------------
// DTO mappers
// ---------------------------------------------------------------------------

export interface PrinterDto {
  id: string;
  ownerId: string;
  kind: string;
  name: string;
  connectionConfig: Record<string, unknown>;
  statusLastSeen: number | null;
  active: boolean;
  createdAt: number;
}

export function toPrinterDto(row: PrinterRow): PrinterDto {
  return {
    id: row.id,
    ownerId: row.ownerId,
    kind: row.kind,
    name: row.name,
    connectionConfig: row.connectionConfig,
    statusLastSeen: row.statusLastSeen ? row.statusLastSeen.getTime() : null,
    active: row.active === true,
    createdAt: row.createdAt.getTime(),
  };
}

export interface SlicerDto {
  id: string;
  ownerId: string;
  kind: string;
  name: string;
  invocationMethod: string;
  deviceId: string | null;
  createdAt: number;
}

export function toSlicerDto(row: SlicerRow): SlicerDto {
  return {
    id: row.id,
    ownerId: row.ownerId,
    kind: row.kind,
    name: row.name,
    invocationMethod: row.invocationMethod,
    deviceId: row.deviceId ?? null,
    createdAt: row.createdAt.getTime(),
  };
}

export type DispatchJobRow = typeof schema.dispatchJobs.$inferSelect;

export interface DispatchJobDto {
  id: string;
  ownerId: string;
  lootId: string;
  targetKind: string;
  targetId: string;
  status: string;
  convertedFileId: string | null;
  slicedFileId: string | null;
  claimMarker: string | null;
  claimedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  failureReason: string | null;
  failureDetails: string | null;
  createdAt: number;
}

export function toDispatchJobDto(row: DispatchJobRow): DispatchJobDto {
  return {
    id: row.id,
    ownerId: row.ownerId,
    lootId: row.lootId,
    targetKind: row.targetKind,
    targetId: row.targetId,
    status: row.status,
    convertedFileId: row.convertedFileId ?? null,
    slicedFileId: row.slicedFileId ?? null,
    claimMarker: row.claimMarker ?? null,
    claimedAt: row.claimedAt ? row.claimedAt.getTime() : null,
    startedAt: row.startedAt ? row.startedAt.getTime() : null,
    completedAt: row.completedAt ? row.completedAt.getTime() : null,
    failureReason: row.failureReason ?? null,
    failureDetails: row.failureDetails ?? null,
    createdAt: row.createdAt.getTime(),
  };
}

// ---------------------------------------------------------------------------
// Idempotency helpers
// ---------------------------------------------------------------------------

type IdempotencyTable =
  | typeof schema.printers
  | typeof schema.forgeSlicers
  | typeof schema.dispatchJobs;

type IdempotencyOwnerColumn =
  | typeof schema.printers.ownerId
  | typeof schema.forgeSlicers.ownerId
  | typeof schema.dispatchJobs.ownerId;

type IdempotencyKeyColumn =
  | typeof schema.printers.idempotencyKey
  | typeof schema.forgeSlicers.idempotencyKey
  | typeof schema.dispatchJobs.idempotencyKey;

type IdempotencyIdColumn =
  | typeof schema.printers.id
  | typeof schema.forgeSlicers.id
  | typeof schema.dispatchJobs.id;

export async function findByIdempotencyKey<TRow>(
  table: IdempotencyTable,
  ownerColumn: IdempotencyOwnerColumn,
  keyColumn: IdempotencyKeyColumn,
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

export async function tryClaimIdempotencyKey(
  table: IdempotencyTable,
  idColumn: IdempotencyIdColumn,
  rowId: string,
  idempotencyKey: string,
): Promise<{ ok: true } | { ok: false; err: unknown }> {
  try {
    const db = getServerDb();
    await db.update(table).set({ idempotencyKey }).where(eq(idColumn, rowId));
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
