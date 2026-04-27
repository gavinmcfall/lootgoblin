/**
 * GET / PATCH / DELETE /api/v1/grimoire/slicer-profiles/:id — V2-007a-T14
 *
 * Owner-scoped CRUD; cross-owner returns 404 (T10's `profile-not-found`).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  deleteSlicerProfile,
  getSlicerProfile,
  updateSlicerProfile,
} from '@/grimoire/slicer-profile';
import {
  PRINTER_KINDS,
  PROFILE_MATERIAL_KINDS,
  SLICER_KINDS,
} from '@/db/schema.grimoire';

import {
  errorResponse,
  requireAuth,
  statusForReason,
  toSlicerProfileDto,
} from '../../_shared';

const PatchBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    slicerKind: z.enum(SLICER_KINDS).optional(),
    printerKind: z.enum(PRINTER_KINDS).optional(),
    materialKind: z.enum(PROFILE_MATERIAL_KINDS).optional(),
    settingsPayload: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'at least one mutable field is required',
  });

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const row = await getSlicerProfile({ id, ownerId: auth.actor.id });
  if (!row) {
    return errorResponse('not-found', 'profile-not-found', 404);
  }
  return NextResponse.json({ profile: toSlicerProfileDto(row) });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('invalid-body', 'JSON parse failed', 400);
  }
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', message: 'request body failed validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const result = await updateSlicerProfile({
    id,
    ownerId: auth.actor.id,
    name: body.name,
    slicerKind: body.slicerKind,
    printerKind: body.printerKind,
    materialKind: body.materialKind,
    settingsPayload: body.settingsPayload,
    notes: body.notes,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `slicer profile update rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }

  const refreshed = await getSlicerProfile({ id, ownerId: auth.actor.id });
  if (!refreshed) {
    return errorResponse('internal', 'post-update read failed', 500);
  }
  return NextResponse.json({ profile: toSlicerProfileDto(refreshed) });
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const result = await deleteSlicerProfile({ id, ownerId: auth.actor.id });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `slicer profile deletion rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }
  return NextResponse.json({ deletedAttachments: result.deletedAttachments }, { status: 200 });
}
