/**
 * GET / PATCH / DELETE /api/v1/catalog/resins/:id — V2-007b T_B2.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  deleteResinProduct,
  getResinProduct,
  updateResinProduct,
} from '@/materials/catalog';
import {
  RESIN_SUBTYPES,
  RESIN_MATERIAL_CLASSES,
  type ResinSubtype,
  type ResinMaterialClass,
} from '@/materials/catalog-types';

import {
  errorResponse,
  requireAuth,
  statusForReason,
  toResinProductDto,
} from '../../_shared';

const HEX = /^#[0-9A-Fa-f]{6}$/;

const PatchBodySchema = z
  .object({
    brand: z.string().min(1).max(200).optional(),
    productLine: z.string().min(1).max(200).nullable().optional(),
    subtype: z.enum(RESIN_SUBTYPES).optional(),
    colors: z.array(z.string().regex(HEX)).min(1).max(4).nullable().optional(),
    colorName: z.string().min(1).max(200).nullable().optional(),
    defaultExposure: z
      .object({
        layer_height_mm: z.number().positive().finite().optional(),
        exposure_seconds: z.number().positive().finite().optional(),
        bottom_layers: z.number().int().nonnegative().optional(),
        bottom_exposure_seconds: z.number().positive().finite().optional(),
        lift_speed_mm_min: z.number().positive().finite().optional(),
      })
      .nullable()
      .optional(),
    densityGMl: z.number().positive().finite().nullable().optional(),
    viscosityCps: z.number().positive().finite().nullable().optional(),
    bottleVolumeMl: z.number().positive().finite().nullable().optional(),
    compatibility: z
      .object({
        wavelength_nm: z.number().positive().finite().optional(),
        printer_compat: z.array(z.string().min(1)).optional(),
      })
      .nullable()
      .optional(),
    materialClass: z.enum(RESIN_MATERIAL_CLASSES).nullable().optional(),
    retailUrl: z.string().url().max(2000).nullable().optional(),
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
  const result = await getResinProduct({
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
  return NextResponse.json({ product: toResinProductDto(result.product) });
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

  const result = await updateResinProduct({
    id,
    actorUserId: auth.actor.id,
    actorRole: auth.actor.role,
    patch: {
      brand: body.brand,
      productLine: body.productLine ?? undefined,
      subtype: body.subtype as ResinSubtype | undefined,
      colors: body.colors ?? undefined,
      colorName: body.colorName ?? undefined,
      defaultExposure: body.defaultExposure ?? undefined,
      densityGMl: body.densityGMl ?? undefined,
      viscosityCps: body.viscosityCps ?? undefined,
      bottleVolumeMl: body.bottleVolumeMl ?? undefined,
      compatibility: body.compatibility ?? undefined,
      materialClass: body.materialClass as ResinMaterialClass | null | undefined,
      retailUrl: body.retailUrl ?? undefined,
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
  return NextResponse.json({ product: toResinProductDto(result.product) });
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const result = await deleteResinProduct({
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
