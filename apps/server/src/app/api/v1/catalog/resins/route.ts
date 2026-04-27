/**
 * GET /api/v1/catalog/resins + POST /api/v1/catalog/resins — V2-007b T_B2.
 *
 * Catalog browse + create for resin products. Same visibility rules as
 * filaments: system entries are visible to all, user-custom only to its
 * owner. Resin `colors` is nullable.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { logger } from '@/logger';
import {
  createResinProduct,
  listResinProducts,
} from '@/materials/catalog';
import {
  RESIN_SUBTYPES,
  RESIN_MATERIAL_CLASSES,
  PRODUCT_SOURCES,
  type ResinSubtype,
  type ResinMaterialClass,
  type ProductSource,
} from '@/materials/catalog-types';

import {
  errorResponse,
  requireAuth,
  statusForReason,
  toResinProductDto,
} from '../_shared';

const HEX = /^#[0-9A-Fa-f]{6}$/;

const CreateBodySchema = z.object({
  brand: z.string().min(1).max(200),
  productLine: z.string().min(1).max(200).optional(),
  subtype: z.enum(RESIN_SUBTYPES),
  /** Resin colors: nullable; if present, 1-4 hex entries. */
  colors: z.array(z.string().regex(HEX)).min(1).max(4).nullable().optional(),
  colorName: z.string().min(1).max(200).optional(),
  defaultExposure: z
    .object({
      layer_height_mm: z.number().positive().finite().optional(),
      exposure_seconds: z.number().positive().finite().optional(),
      bottom_layers: z.number().int().nonnegative().optional(),
      bottom_exposure_seconds: z.number().positive().finite().optional(),
      lift_speed_mm_min: z.number().positive().finite().optional(),
    })
    .optional(),
  densityGMl: z.number().positive().finite().optional(),
  viscosityCps: z.number().positive().finite().optional(),
  bottleVolumeMl: z.number().positive().finite().optional(),
  compatibility: z
    .object({
      wavelength_nm: z.number().positive().finite().optional(),
      printer_compat: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  materialClass: z.enum(RESIN_MATERIAL_CLASSES).optional(),
  retailUrl: z.string().url().max(2000).optional(),
  source: z.enum(PRODUCT_SOURCES),
  sourceRef: z.string().min(1).max(2000).optional(),
  ownerId: z.string().min(1).nullable().optional(),
  id: z.string().min(1).max(200).optional(),
});

const ListQuery = z.object({
  brand: z.string().min(1).optional(),
  subtype: z.enum(RESIN_SUBTYPES).optional(),
  source: z.enum(PRODUCT_SOURCES).optional(),
  materialClass: z.enum(RESIN_MATERIAL_CLASSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

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
      {
        error: 'invalid-body',
        message: 'request body failed validation',
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }
  const body = parsed.data;

  let ownerId: string | null;
  if (body.ownerId === undefined) {
    ownerId = body.source === 'user' ? actor.id : null;
  } else {
    ownerId = body.ownerId;
  }

  const result = await createResinProduct({
    brand: body.brand,
    productLine: body.productLine,
    subtype: body.subtype as ResinSubtype,
    colors: body.colors ?? null,
    colorName: body.colorName,
    defaultExposure: body.defaultExposure,
    densityGMl: body.densityGMl,
    viscosityCps: body.viscosityCps,
    bottleVolumeMl: body.bottleVolumeMl,
    compatibility: body.compatibility,
    materialClass: body.materialClass as ResinMaterialClass | undefined,
    retailUrl: body.retailUrl,
    source: body.source as ProductSource,
    sourceRef: body.sourceRef,
    ownerId,
    actorUserId: actor.id,
    actorRole: actor.role,
    id: body.id,
  });
  if (!result.ok) {
    logger.warn(
      { actorId: actor.id, reason: result.reason, source: body.source },
      'POST /api/v1/catalog/resins: rejected',
    );
    return errorResponse(
      result.reason,
      `resin product creation rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }
  return NextResponse.json(
    { product: toResinProductDto(result.product) },
    { status: result.replayed ? 200 : 201 },
  );
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const url = new URL(req.url);
  const queryParsed = ListQuery.safeParse({
    brand: url.searchParams.get('brand') ?? undefined,
    subtype: url.searchParams.get('subtype') ?? undefined,
    source: url.searchParams.get('source') ?? undefined,
    materialClass: url.searchParams.get('materialClass') ?? undefined,
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

  const result = await listResinProducts({
    actorUserId: actor.id,
    actorRole: actor.role,
    brand: q.brand,
    subtype: q.subtype as ResinSubtype | undefined,
    source: q.source as ProductSource | undefined,
    materialClass: q.materialClass as ResinMaterialClass | undefined,
    limit: q.limit,
    cursor: q.cursor,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `list rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }
  return NextResponse.json({
    products: result.products.map(toResinProductDto),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  });
}
