/**
 * POST /api/v1/grimoire/slicer-profiles + GET — V2-007a-T14
 *
 * Owner-scoped CRUD on SlicerProfile (T10 createSlicerProfile / list).
 * Filters on GET: slicerKind, printerKind, materialKind. Cursor pagination
 * by id (matches T10 listSlicerProfiles).
 *
 * Body
 * ────
 * { name, slicerKind, printerKind, materialKind, settingsPayload, notes? }
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';
import {
  createSlicerProfile,
  listSlicerProfiles,
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
} from '../_shared';

const CreateBodySchema = z.object({
  name: z.string().min(1).max(200),
  slicerKind: z.enum(SLICER_KINDS),
  printerKind: z.enum(PRINTER_KINDS),
  materialKind: z.enum(PROFILE_MATERIAL_KINDS),
  settingsPayload: z.record(z.string(), z.unknown()),
  notes: z.string().max(2000).optional(),
});

type CreateBody = z.infer<typeof CreateBodySchema>;

const ListQuery = z.object({
  slicerKind: z.enum(SLICER_KINDS).optional(),
  printerKind: z.enum(PRINTER_KINDS).optional(),
  materialKind: z.enum(PROFILE_MATERIAL_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

function normalizeBody(body: CreateBody, ownerId: string): string {
  return JSON.stringify({
    ownerId,
    name: body.name.trim(),
    slicerKind: body.slicerKind,
    printerKind: body.printerKind,
    materialKind: body.materialKind,
    settingsPayload: body.settingsPayload,
    notes: body.notes ?? null,
  });
}

function normalizeStored(row: typeof schema.slicerProfiles.$inferSelect): string {
  return JSON.stringify({
    ownerId: row.ownerId,
    name: row.name,
    slicerKind: row.slicerKind,
    printerKind: row.printerKind,
    materialKind: row.materialKind,
    settingsPayload: row.settingsPayload,
    notes: row.notes ?? null,
  });
}

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

  const db = getServerDb();

  if (idempotencyKey) {
    const prior = await db
      .select()
      .from(schema.slicerProfiles)
      .where(eq(schema.slicerProfiles.idempotencyKey, idempotencyKey))
      .limit(1);
    const priorRow = prior[0];
    if (priorRow && priorRow.ownerId === actor.id) {
      const incoming = normalizeBody(body, actor.id);
      if (normalizeStored(priorRow) === incoming) {
        return NextResponse.json({ profile: toSlicerProfileDto(priorRow) }, { status: 200 });
      }
      return NextResponse.json(
        {
          error: 'idempotency-mismatch',
          message: 'Idempotency-Key reused with a different request body',
          profileId: priorRow.id,
        },
        { status: 409 },
      );
    }
  }

  const result = await createSlicerProfile({
    ownerId: actor.id,
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
      `slicer profile creation rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }

  if (idempotencyKey) {
    try {
      await db
        .update(schema.slicerProfiles)
        .set({ idempotencyKey })
        .where(eq(schema.slicerProfiles.id, result.profileId));
    } catch (err) {
      try {
        await db.delete(schema.slicerProfiles).where(eq(schema.slicerProfiles.id, result.profileId));
      } catch {
        /* best-effort */
      }
      const winnerRows = await db
        .select()
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.idempotencyKey, idempotencyKey))
        .limit(1);
      if (winnerRows.length > 0 && winnerRows[0]!.ownerId === actor.id) {
        return NextResponse.json({ profile: toSlicerProfileDto(winnerRows[0]!) }, { status: 200 });
      }
      logger.error({ err }, 'slicer-profiles: idempotency claim failed');
      return errorResponse('internal', 'failed to persist idempotency key', 500);
    }
  }

  const refreshed = await db
    .select()
    .from(schema.slicerProfiles)
    .where(eq(schema.slicerProfiles.id, result.profileId))
    .limit(1);
  return NextResponse.json({ profile: toSlicerProfileDto(refreshed[0]!) }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const url = new URL(req.url);
  const queryParsed = ListQuery.safeParse({
    slicerKind: url.searchParams.get('slicerKind') ?? undefined,
    printerKind: url.searchParams.get('printerKind') ?? undefined,
    materialKind: url.searchParams.get('materialKind') ?? undefined,
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

  const result = await listSlicerProfiles({
    ownerId: actor.id,
    slicerKind: q.slicerKind,
    printerKind: q.printerKind,
    materialKind: q.materialKind,
    limit: q.limit,
    cursor: q.cursor,
  });

  return NextResponse.json({
    profiles: result.profiles.map(toSlicerProfileDto),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  });
}
