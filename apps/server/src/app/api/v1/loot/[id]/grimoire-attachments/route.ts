/**
 * GET / POST /api/v1/loot/:id/grimoire-attachments — V2-007a-T14
 *
 * Wraps T11 attachToLoot + listAttachmentsForLoot. Owner-mediated via the
 * Loot's collection (see attachment.ts). Cross-owner Loot → 404.
 *
 * NOTE: this route lives under /loot/[id]/grimoire-attachments to fit the
 * Stash CRUD route tree; the task spec called the param `lootId` but
 * Next.js route groups can't have two different param names at the same
 * directory level — `[id]` is the existing convention and we honour it.
 *
 * POST body
 * ─────────
 * Exactly one of slicerProfileId / printSettingId must be set.
 *   { slicerProfileId, note? }  OR  { printSettingId, note? }
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  attachToLoot,
  listAttachmentsForLoot,
} from '@/grimoire/attachment';

import {
  errorResponse,
  requireAuth,
  statusForReason,
  toGrimoireAttachmentDto,
} from '../../../grimoire/_shared';

const AttachBodySchema = z
  .object({
    slicerProfileId: z.string().min(1).optional(),
    printSettingId: z.string().min(1).optional(),
    note: z.string().max(500).optional(),
  })
  .refine(
    (v) =>
      (v.slicerProfileId !== undefined ? 1 : 0) +
        (v.printSettingId !== undefined ? 1 : 0) ===
      1,
    {
      message: 'exactly one of slicerProfileId / printSettingId must be set',
      path: ['slicerProfileId'],
    },
  );

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id: lootId } = await context.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('invalid-body', 'JSON parse failed', 400);
  }
  const parsed = AttachBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', message: 'request body failed validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const result = await attachToLoot({
    ownerId: auth.actor.id,
    lootId,
    slicerProfileId: body.slicerProfileId,
    printSettingId: body.printSettingId,
    note: body.note,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `attachment rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }
  return NextResponse.json({ attachmentId: result.attachmentId }, { status: 201 });
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id: lootId } = await context.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const rows = await listAttachmentsForLoot({
    lootId,
    ownerId: auth.actor.id,
  });
  return NextResponse.json({
    attachments: rows.map(toGrimoireAttachmentDto),
  });
}
