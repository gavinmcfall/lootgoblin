/**
 * POST /api/v1/materials + GET /api/v1/materials — V2-007a-T14
 *
 * Material create + list. Mirrors the V2-003-T9 / V2-004-T9 idempotency +
 * cursor pagination patterns.
 *
 * Auth model
 * ──────────
 * `authenticateRequest` — BetterAuth session OR x-api-key 'programmatic'.
 * ACL kind 'material': admin reads ALLOWED (aggregate reporting), all writes
 * owner-only.
 *
 * Idempotency
 * ───────────
 * Optional `Idempotency-Key` header. The route claims the key on the freshly
 * created row via UPDATE; partial unique index (migration 0021) catches any
 * concurrent same-key insert. Replay with the same body returns the prior
 * row (200); replay with a different body returns 409.
 *
 * Body
 * ────
 * { ownerId? (optional — default = actor), kind, brand?, subtype?, colors,
 *   colorPattern, colorName?, density?, initialAmount, unit, purchaseData?,
 *   productId?, extra? }
 *
 * The `ownerId` field is intentionally NOT exposed — the route force-sets
 * ownerId = actor.id. Cross-owner creation is blocked.
 *
 * List
 * ────
 * GET returns the caller's materials. Filters: kind, brand, active, loaded.
 * Cursor = numeric ms string of `created_at` (descending).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
import { z } from 'zod';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';
import { createMaterial } from '@/materials/lifecycle';
import { MATERIAL_KINDS, MATERIAL_UNITS, COLOR_PATTERNS } from '@/db/schema.materials';

import {
  errorResponse,
  findByIdempotencyKey,
  requireAuth,
  statusForReason,
  toMaterialDto,
  tryClaimIdempotencyKey,
} from './_shared';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const HEX = /^#[0-9A-Fa-f]{6}$/;

const CreateBodySchema = z.object({
  kind: z.enum(MATERIAL_KINDS),
  brand: z.string().min(1).max(200).optional(),
  subtype: z.string().min(1).max(200).optional(),
  colors: z.array(z.string().regex(HEX)).min(1).max(4),
  colorPattern: z.enum(COLOR_PATTERNS),
  colorName: z.string().min(1).max(200).optional(),
  density: z.number().positive().finite().optional(),
  initialAmount: z.number().positive().finite(),
  unit: z.enum(MATERIAL_UNITS),
  purchaseData: z.record(z.string(), z.unknown()).optional(),
  productId: z.string().min(1).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

type CreateBody = z.infer<typeof CreateBodySchema>;

const ListQuery = z.object({
  kind: z.enum(MATERIAL_KINDS).optional(),
  brand: z.string().min(1).optional(),
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  loaded: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

function normalizeBody(body: CreateBody, ownerId: string): string {
  return JSON.stringify({
    ownerId,
    kind: body.kind,
    brand: body.brand ?? null,
    subtype: body.subtype ?? null,
    colors: body.colors.map((c) => c.toUpperCase()),
    colorPattern: body.colorPattern,
    colorName: body.colorName ?? null,
    density: body.density ?? null,
    initialAmount: body.initialAmount,
    unit: body.unit,
    purchaseData: body.purchaseData ?? null,
    productId: body.productId ?? null,
    extra: body.extra ?? null,
  });
}

function normalizeStored(row: typeof schema.materials.$inferSelect): string {
  return JSON.stringify({
    ownerId: row.ownerId,
    kind: row.kind,
    brand: row.brand ?? null,
    subtype: row.subtype ?? null,
    colors: (row.colors ?? []).map((c) => c.toUpperCase()),
    colorPattern: row.colorPattern ?? null,
    colorName: row.colorName ?? null,
    density: row.density ?? null,
    initialAmount: row.initialAmount,
    unit: row.unit,
    purchaseData: row.purchaseData ?? null,
    productId: row.productId ?? null,
    extra: row.extra ?? null,
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/materials
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('invalid-body', 'JSON parse failed', 400);
  }
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', message: 'request body failed validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const idempotencyKey = req.headers.get('Idempotency-Key');
  const normalized = normalizeBody(body, actor.id);

  // Idempotent replay check.
  if (idempotencyKey) {
    const prior = await findByIdempotencyKey<typeof schema.materials.$inferSelect>(
      schema.materials,
      schema.materials.ownerId,
      schema.materials.idempotencyKey,
      actor.id,
      idempotencyKey,
    );
    if (prior) {
      if (normalizeStored(prior) === normalized) {
        return NextResponse.json({ material: toMaterialDto(prior) }, { status: 200 });
      }
      return NextResponse.json(
        {
          error: 'idempotency-mismatch',
          message: 'Idempotency-Key reused with a different request body',
          materialId: prior.id,
        },
        { status: 409 },
      );
    }
  }

  // Call the pure domain helper (atomic Material + ledger event).
  const result = await createMaterial({
    ownerId: actor.id,
    kind: body.kind,
    brand: body.brand,
    subtype: body.subtype,
    colors: body.colors,
    colorPattern: body.colorPattern,
    colorName: body.colorName,
    density: body.density,
    initialAmount: body.initialAmount,
    unit: body.unit,
    purchaseData: body.purchaseData,
    productId: body.productId,
    extra: body.extra,
  });
  if (!result.ok) {
    logger.warn(
      { ownerId: actor.id, reason: result.reason },
      'POST /api/v1/materials: createMaterial rejected',
    );
    return errorResponse(
      result.reason,
      `material creation rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }

  // Claim the idempotency key post-insert. Partial unique index catches a
  // racing concurrent POST with the same key — fall back to re-reading the
  // winner's row.
  if (idempotencyKey) {
    const claim = await tryClaimIdempotencyKey(
      schema.materials,
      schema.materials.id,
      result.material.id,
      idempotencyKey,
    );
    if (!claim.ok) {
      // Race: another POST won. Best-effort delete the material we just
      // created (it's orphaned). Re-read the winner.
      const db = getServerDb();
      try {
        await db.delete(schema.materials).where(eq(schema.materials.id, result.material.id));
      } catch (cleanupErr) {
        logger.warn(
          { err: cleanupErr, materialId: result.material.id },
          'POST /api/v1/materials: failed to clean up loser of idempotency race',
        );
      }
      const winner = await findByIdempotencyKey<typeof schema.materials.$inferSelect>(
        schema.materials,
        schema.materials.ownerId,
        schema.materials.idempotencyKey,
        actor.id,
        idempotencyKey,
      );
      if (winner) {
        return NextResponse.json({ material: toMaterialDto(winner) }, { status: 200 });
      }
      logger.error(
        { err: claim.err, materialId: result.material.id },
        'POST /api/v1/materials: idempotency claim failed and no winner found',
      );
      return errorResponse('internal', 'failed to persist idempotency key', 500);
    }
  }

  return NextResponse.json({ material: toMaterialDto(result.material) }, { status: 201 });
}

// ---------------------------------------------------------------------------
// GET /api/v1/materials
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const url = new URL(req.url);
  const queryParsed = ListQuery.safeParse({
    kind: url.searchParams.get('kind') ?? undefined,
    brand: url.searchParams.get('brand') ?? undefined,
    active: url.searchParams.get('active') ?? undefined,
    loaded: url.searchParams.get('loaded') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  });
  if (!queryParsed.success) {
    return NextResponse.json(
      { error: 'invalid-query', message: 'invalid query parameters', issues: queryParsed.error.issues },
      { status: 400 },
    );
  }
  const q = queryParsed.data;

  const db = getServerDb();
  const conditions = [eq(schema.materials.ownerId, actor.id)];
  if (q.kind) conditions.push(eq(schema.materials.kind, q.kind));
  if (q.brand) conditions.push(eq(schema.materials.brand, q.brand));
  if (q.active !== undefined) conditions.push(eq(schema.materials.active, q.active));
  if (q.loaded !== undefined) {
    if (q.loaded) {
      conditions.push(isNotNull(schema.materials.loadedInPrinterRef));
    } else {
      // Postgres-friendly: `column = NULL` returns NULL; use sql here for clarity.
      // better-sqlite3 + drizzle handles eq(col, null) correctly via IS NULL.
      conditions.push(eq(schema.materials.loadedInPrinterRef, null as unknown as string));
    }
  }
  if (q.cursor) {
    const cursorMs = Number(q.cursor);
    if (!Number.isFinite(cursorMs)) {
      return errorResponse('invalid-query', 'cursor must be a numeric ms timestamp', 400);
    }
    conditions.push(lt(schema.materials.createdAt, new Date(cursorMs)));
  }

  const rows = await db
    .select()
    .from(schema.materials)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(schema.materials.createdAt))
    .limit(q.limit + 1);

  const hasMore = rows.length > q.limit;
  const sliced = hasMore ? rows.slice(0, q.limit) : rows;
  const nextCursor =
    hasMore && sliced.length > 0
      ? String(sliced[sliced.length - 1]!.createdAt.getTime())
      : undefined;

  return NextResponse.json({
    materials: sliced.map(toMaterialDto),
    ...(nextCursor ? { nextCursor } : {}),
  });
}
