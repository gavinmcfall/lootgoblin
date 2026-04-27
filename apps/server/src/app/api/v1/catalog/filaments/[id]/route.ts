/**
 * GET / PATCH / DELETE /api/v1/catalog/filaments/:id — V2-007b T_B2.
 *
 * Cross-owner reads → 404 (id-leak prevention; matches the materials pattern).
 * Cross-owner write attempts on user-custom rows → 404. Non-admin write
 * attempts on system rows → 403 ('admin-required'). DELETE returns 204.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  deleteFilamentProduct,
  getFilamentProduct,
  updateFilamentProduct,
} from '@/materials/catalog';
import {
  FILAMENT_SUBTYPES,
  type FilamentSubtype,
} from '@/materials/catalog-types';
import { COLOR_PATTERNS, type ColorPattern } from '@/db/schema.materials';

import {
  errorResponse,
  requireAuth,
  statusForReason,
  toFilamentProductDto,
} from '../../_shared';

const HEX = /^#[0-9A-Fa-f]{6}$/;

const PatchBodySchema = z
  .object({
    brand: z.string().min(1).max(200).optional(),
    productLine: z.string().min(1).max(200).nullable().optional(),
    subtype: z.enum(FILAMENT_SUBTYPES).optional(),
    colors: z.array(z.string().regex(HEX)).min(1).max(4).optional(),
    colorPattern: z.enum(COLOR_PATTERNS).optional(),
    colorName: z.string().min(1).max(200).nullable().optional(),
    defaultTemps: z
      .object({
        nozzle_min: z.number().finite().optional(),
        nozzle_max: z.number().finite().optional(),
        bed: z.number().finite().optional(),
        chamber: z.number().finite().optional(),
      })
      .nullable()
      .optional(),
    diameterMm: z.number().positive().finite().nullable().optional(),
    density: z.number().positive().finite().nullable().optional(),
    spoolWeightG: z.number().positive().finite().nullable().optional(),
    emptySpoolWeightG: z.number().positive().finite().nullable().optional(),
    finish: z.string().min(1).max(100).nullable().optional(),
    pattern: z.string().min(1).max(100).nullable().optional(),
    isGlow: z.boolean().nullable().optional(),
    isTranslucent: z.boolean().nullable().optional(),
    retailUrl: z.string().url().max(2000).nullable().optional(),
    slicerId: z.string().min(1).max(200).nullable().optional(),
    sourceRef: z.string().min(1).max(2000).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'at least one mutable field is required',
  });

const IMMUTABLE_KEYS = ['id', 'ownerId', 'source', 'createdAt', 'updatedAt'] as const;

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const result = await getFilamentProduct({
    id,
    actorUserId: auth.actor.id,
    actorRole: auth.actor.role,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `get rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }
  return NextResponse.json({ product: toFilamentProductDto(result.product) });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;

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
          `${key} is not patchable`,
          400,
        );
      }
    }
  }

  const parsed = PatchBodySchema.safeParse(raw);
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

  const result = await updateFilamentProduct({
    id,
    actorUserId: auth.actor.id,
    actorRole: auth.actor.role,
    patch: {
      brand: body.brand,
      productLine: body.productLine ?? undefined,
      subtype: body.subtype as FilamentSubtype | undefined,
      colors: body.colors,
      colorPattern: body.colorPattern as ColorPattern | undefined,
      colorName: body.colorName ?? undefined,
      defaultTemps: body.defaultTemps ?? undefined,
      diameterMm: body.diameterMm ?? undefined,
      density: body.density ?? undefined,
      spoolWeightG: body.spoolWeightG ?? undefined,
      emptySpoolWeightG: body.emptySpoolWeightG ?? undefined,
      finish: body.finish ?? undefined,
      pattern: body.pattern ?? undefined,
      isGlow: body.isGlow ?? undefined,
      isTranslucent: body.isTranslucent ?? undefined,
      retailUrl: body.retailUrl ?? undefined,
      slicerId: body.slicerId ?? undefined,
      sourceRef: body.sourceRef ?? undefined,
    },
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `patch rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }
  return NextResponse.json({ product: toFilamentProductDto(result.product) });
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const result = await deleteFilamentProduct({
    id,
    actorUserId: auth.actor.id,
    actorRole: auth.actor.role,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `delete rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }
  return new Response(null, { status: 204 });
}
