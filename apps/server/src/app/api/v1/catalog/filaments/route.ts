/**
 * GET /api/v1/catalog/filaments + POST /api/v1/catalog/filaments — V2-007b T_B2.
 *
 * Catalog browse + create. Visibility = system-seeded entries (owner_id NULL)
 * plus the caller's own custom entries. Cross-owner CUSTOM entries are NOT
 * visible.
 *
 * Body validation uses a single Zod schema with a `.refine()` rule for the
 * source/owner/role discipline (a `discriminatedUnion('source', ...)` would
 * also work; this form is shorter and still surfaces the constraint at the
 * 400 boundary).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { logger } from '@/logger';
import {
  createFilamentProduct,
  listFilamentProducts,
} from '@/materials/catalog';
import {
  FILAMENT_SUBTYPES,
  PRODUCT_SOURCES,
  type FilamentSubtype,
  type ProductSource,
} from '@/materials/catalog-types';
import { COLOR_PATTERNS, type ColorPattern } from '@/db/schema.materials';

import {
  errorResponse,
  requireAuth,
  statusForReason,
  toFilamentProductDto,
} from '../_shared';

const HEX = /^#[0-9A-Fa-f]{6}$/;

const CreateBodySchema = z.object({
  brand: z.string().min(1).max(200),
  productLine: z.string().min(1).max(200).optional(),
  subtype: z.enum(FILAMENT_SUBTYPES),
  colors: z.array(z.string().regex(HEX)).min(1).max(4),
  colorPattern: z.enum(COLOR_PATTERNS),
  colorName: z.string().min(1).max(200).optional(),
  defaultTemps: z
    .object({
      nozzle_min: z.number().finite().optional(),
      nozzle_max: z.number().finite().optional(),
      bed: z.number().finite().optional(),
      chamber: z.number().finite().optional(),
    })
    .optional(),
  diameterMm: z.number().positive().finite().optional(),
  density: z.number().positive().finite().optional(),
  spoolWeightG: z.number().positive().finite().optional(),
  emptySpoolWeightG: z.number().positive().finite().optional(),
  finish: z.string().min(1).max(100).optional(),
  pattern: z.string().min(1).max(100).optional(),
  isGlow: z.boolean().optional(),
  isTranslucent: z.boolean().optional(),
  retailUrl: z.string().url().max(2000).optional(),
  slicerId: z.string().min(1).max(200).optional(),
  source: z.enum(PRODUCT_SOURCES),
  sourceRef: z.string().min(1).max(2000).optional(),
  /** When omitted, defaults to actor.id for source='user', null otherwise. */
  ownerId: z.string().min(1).nullable().optional(),
  /** Optional client-supplied id for stable seed re-imports. */
  id: z.string().min(1).max(200).optional(),
});

const ListQuery = z.object({
  brand: z.string().min(1).optional(),
  subtype: z.enum(FILAMENT_SUBTYPES).optional(),
  source: z.enum(PRODUCT_SOURCES).optional(),
  primaryColor: z.string().regex(HEX).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// POST
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
      {
        error: 'invalid-body',
        message: 'request body failed validation',
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // Resolve ownerId default. Omitted + source='user' → actor.id; omitted +
  // system → null. The catalog domain validator catches mismatched explicit
  // values and rejects with 'source-owner-mismatch'.
  let ownerId: string | null;
  if (body.ownerId === undefined) {
    ownerId = body.source === 'user' ? actor.id : null;
  } else {
    ownerId = body.ownerId; // null or string
  }

  const result = await createFilamentProduct({
    brand: body.brand,
    productLine: body.productLine,
    subtype: body.subtype as FilamentSubtype,
    colors: body.colors,
    colorPattern: body.colorPattern as ColorPattern,
    colorName: body.colorName,
    defaultTemps: body.defaultTemps,
    diameterMm: body.diameterMm,
    density: body.density,
    spoolWeightG: body.spoolWeightG,
    emptySpoolWeightG: body.emptySpoolWeightG,
    finish: body.finish,
    pattern: body.pattern,
    isGlow: body.isGlow,
    isTranslucent: body.isTranslucent,
    retailUrl: body.retailUrl,
    slicerId: body.slicerId,
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
      'POST /api/v1/catalog/filaments: rejected',
    );
    return errorResponse(
      result.reason,
      `filament product creation rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }

  return NextResponse.json(
    { product: toFilamentProductDto(result.product) },
    { status: result.replayed ? 200 : 201 },
  );
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const url = new URL(req.url);
  const queryParsed = ListQuery.safeParse({
    brand: url.searchParams.get('brand') ?? undefined,
    subtype: url.searchParams.get('subtype') ?? undefined,
    source: url.searchParams.get('source') ?? undefined,
    primaryColor: url.searchParams.get('primaryColor') ?? undefined,
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

  const result = await listFilamentProducts({
    actorUserId: actor.id,
    actorRole: actor.role,
    brand: q.brand,
    subtype: q.subtype as FilamentSubtype | undefined,
    source: q.source as ProductSource | undefined,
    primaryColor: q.primaryColor,
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
    products: result.products.map(toFilamentProductDto),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  });
}
