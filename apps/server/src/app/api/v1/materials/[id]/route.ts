/**
 * GET /api/v1/materials/:id + PATCH /api/v1/materials/:id — V2-007a-T14
 *
 * Single-material endpoints. Owner-mismatch returns 404 (id-leak prevention).
 *
 * PATCH is for COSMETIC updates only:
 *   - brand, subtype, colors+colorPattern (re-validated together), colorName,
 *     density, purchaseData, productId, extra.
 *
 * Immutable via PATCH (other endpoints handle these):
 *   - kind, ownerId, initialAmount, unit (structural)
 *   - remainingAmount (decrements via consumption events only)
 *   - active / retiredAt / retirementReason (use POST :id/retire)
 *   - loadedInPrinterRef (use POST :id/load + :id/unload)
 *   - id, createdAt, idempotencyKey
 *
 * No DELETE — retire is the lifecycle exit. A DELETE on this URL returns
 * Next.js's default 405 (no DELETE export).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';
import { COLOR_PATTERNS } from '@/db/schema.materials';
import { validateColors } from '@/materials/validate';

import {
  errorResponse,
  fetchCurrentLoadoutsByMaterialIds,
  loadMaterialForActor,
  toMaterialDto,
} from '../_shared';

const HEX = /^#[0-9A-Fa-f]{6}$/;

const PatchBodySchema = z
  .object({
    brand: z.string().min(1).max(200).nullable().optional(),
    subtype: z.string().min(1).max(200).nullable().optional(),
    colors: z.array(z.string().regex(HEX)).min(1).max(4).optional(),
    colorPattern: z.enum(COLOR_PATTERNS).optional(),
    colorName: z.string().min(1).max(200).nullable().optional(),
    density: z.number().positive().finite().nullable().optional(),
    purchaseData: z.record(z.string(), z.unknown()).nullable().optional(),
    productId: z.string().min(1).nullable().optional(),
    extra: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'at least one mutable field is required',
  })
  .refine(
    (v) => (v.colors === undefined) === (v.colorPattern === undefined),
    { message: 'colors and colorPattern must be supplied together', path: ['colors'] },
  );

const IMMUTABLE_KEYS = [
  'id',
  'ownerId',
  'kind',
  'unit',
  'initialAmount',
  'remainingAmount',
  'active',
  'retiredAt',
  'retirementReason',
  // V2-005f-CF-1 T_g1: `loadedInPrinterRef` was dropped from materials in
  // migration 0030. Load state now lives in `printer_loadouts`; PATCH cannot
  // touch it via either name.
  'idempotencyKey',
  'createdAt',
] as const;

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const loaded = await loadMaterialForActor(req, id, 'read');
  if (!loaded.ok) return loaded.response;
  const loadouts = await fetchCurrentLoadoutsByMaterialIds([loaded.row.id]);
  return NextResponse.json({
    material: toMaterialDto(loaded.row, loadouts.get(loaded.row.id) ?? null),
  });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const loaded = await loadMaterialForActor(req, id, 'update');
  if (!loaded.ok) return loaded.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('invalid-body', 'JSON parse failed', 400);
  }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    for (const key of IMMUTABLE_KEYS) {
      if (key in r) {
        return errorResponse(
          'invalid-body',
          `${key} is not patchable; use the dedicated endpoint or recreate`,
          400,
        );
      }
    }
  }

  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', message: 'request body failed validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // Re-validate colors+pattern together if either was supplied.
  if (body.colors !== undefined && body.colorPattern !== undefined) {
    const c = validateColors(body.colors, body.colorPattern);
    if (!c.ok) {
      return errorResponse(c.reason, `color validation failed: ${c.reason}`, 400);
    }
  }

  const patch: Partial<typeof schema.materials.$inferInsert> = {};
  if (body.brand !== undefined) patch.brand = body.brand;
  if (body.subtype !== undefined) patch.subtype = body.subtype;
  if (body.colors !== undefined) patch.colors = body.colors.map((c) => c.toUpperCase());
  if (body.colorPattern !== undefined) patch.colorPattern = body.colorPattern;
  if (body.colorName !== undefined) patch.colorName = body.colorName;
  if (body.density !== undefined) patch.density = body.density;
  if (body.purchaseData !== undefined) {
    patch.purchaseData =
      body.purchaseData === null
        ? undefined
        : (body.purchaseData as Record<string, unknown>);
  }
  if (body.productId !== undefined) patch.productId = body.productId;
  if (body.extra !== undefined) {
    patch.extra =
      body.extra === null ? undefined : (body.extra as Record<string, unknown>);
  }

  const db = getServerDb();
  await db.update(schema.materials).set(patch).where(eq(schema.materials.id, id));

  const refreshed = await db
    .select()
    .from(schema.materials)
    .where(eq(schema.materials.id, id))
    .limit(1);
  const updated = refreshed[0];
  if (!updated) {
    logger.error({ id }, 'materials: post-update SELECT returned no row');
    return errorResponse('internal', 'post-update read failed', 500);
  }
  const loadouts = await fetchCurrentLoadoutsByMaterialIds([updated.id]);
  return NextResponse.json({
    material: toMaterialDto(updated, loadouts.get(updated.id) ?? null),
  });
}
