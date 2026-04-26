/**
 * GET / PATCH / DELETE /api/v1/grimoire/print-settings/:id — V2-007a-T14
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  deletePrintSetting,
  getPrintSetting,
  updatePrintSetting,
} from '@/grimoire/print-setting';

import {
  errorResponse,
  requireAuth,
  statusForReason,
  toPrintSettingDto,
} from '../../_shared';

const PatchBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
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
  const row = await getPrintSetting({ id, ownerId: auth.actor.id });
  if (!row) {
    return errorResponse('not-found', 'setting-not-found', 404);
  }
  return NextResponse.json({ setting: toPrintSettingDto(row) });
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

  const result = await updatePrintSetting({
    id,
    ownerId: auth.actor.id,
    name: body.name,
    settingsPayload: body.settingsPayload,
    notes: body.notes,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `print setting update rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }

  const refreshed = await getPrintSetting({ id, ownerId: auth.actor.id });
  if (!refreshed) {
    return errorResponse('internal', 'post-update read failed', 500);
  }
  return NextResponse.json({ setting: toPrintSettingDto(refreshed) });
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const result = await deletePrintSetting({ id, ownerId: auth.actor.id });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `print setting deletion rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }
  return NextResponse.json({ deletedAttachments: result.deletedAttachments }, { status: 200 });
}
