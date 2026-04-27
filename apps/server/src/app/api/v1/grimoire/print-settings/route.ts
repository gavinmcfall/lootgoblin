/**
 * POST /api/v1/grimoire/print-settings + GET — V2-007a-T14
 *
 * Owner-scoped CRUD on PrintSetting. Sparse override JSON; opaque to
 * lootgoblin in v2-007a (V2-005 Forge merges at dispatch time). Cursor
 * pagination by id (matches T10 listPrintSettings).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';
import {
  createPrintSetting,
  listPrintSettings,
} from '@/grimoire/print-setting';

import {
  errorResponse,
  requireAuth,
  statusForReason,
  toPrintSettingDto,
} from '../_shared';

const CreateBodySchema = z.object({
  name: z.string().min(1).max(200),
  settingsPayload: z.record(z.string(), z.unknown()),
  notes: z.string().max(2000).optional(),
});

type CreateBody = z.infer<typeof CreateBodySchema>;

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

function normalizeBody(body: CreateBody, ownerId: string): string {
  return JSON.stringify({
    ownerId,
    name: body.name.trim(),
    settingsPayload: body.settingsPayload,
    notes: body.notes ?? null,
  });
}

function normalizeStored(row: typeof schema.printSettings.$inferSelect): string {
  return JSON.stringify({
    ownerId: row.ownerId,
    name: row.name,
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
      .from(schema.printSettings)
      .where(eq(schema.printSettings.idempotencyKey, idempotencyKey))
      .limit(1);
    const priorRow = prior[0];
    if (priorRow && priorRow.ownerId === actor.id) {
      const incoming = normalizeBody(body, actor.id);
      if (normalizeStored(priorRow) === incoming) {
        return NextResponse.json({ setting: toPrintSettingDto(priorRow) }, { status: 200 });
      }
      return NextResponse.json(
        {
          error: 'idempotency-mismatch',
          message: 'Idempotency-Key reused with a different request body',
          settingId: priorRow.id,
        },
        { status: 409 },
      );
    }
  }

  const result = await createPrintSetting({
    ownerId: actor.id,
    name: body.name,
    settingsPayload: body.settingsPayload,
    notes: body.notes,
  });
  if (!result.ok) {
    return errorResponse(
      result.reason,
      `print setting creation rejected: ${result.reason}`,
      statusForReason(result.reason),
      result.details,
    );
  }

  if (idempotencyKey) {
    try {
      await db
        .update(schema.printSettings)
        .set({ idempotencyKey })
        .where(eq(schema.printSettings.id, result.settingId));
    } catch (err) {
      try {
        await db.delete(schema.printSettings).where(eq(schema.printSettings.id, result.settingId));
      } catch {
        /* best-effort */
      }
      const winnerRows = await db
        .select()
        .from(schema.printSettings)
        .where(eq(schema.printSettings.idempotencyKey, idempotencyKey))
        .limit(1);
      if (winnerRows.length > 0 && winnerRows[0]!.ownerId === actor.id) {
        return NextResponse.json({ setting: toPrintSettingDto(winnerRows[0]!) }, { status: 200 });
      }
      logger.error({ err }, 'print-settings: idempotency claim failed');
      return errorResponse('internal', 'failed to persist idempotency key', 500);
    }
  }

  const refreshed = await db
    .select()
    .from(schema.printSettings)
    .where(eq(schema.printSettings.id, result.settingId))
    .limit(1);
  return NextResponse.json({ setting: toPrintSettingDto(refreshed[0]!) }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const url = new URL(req.url);
  const queryParsed = ListQuery.safeParse({
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
  const result = await listPrintSettings({
    ownerId: actor.id,
    limit: q.limit,
    cursor: q.cursor,
  });

  return NextResponse.json({
    settings: result.settings.map(toPrintSettingDto),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  });
}
