/**
 * GET    /api/v1/forge/printers/:id
 * PATCH  /api/v1/forge/printers/:id
 * DELETE /api/v1/forge/printers/:id
 *
 * V2-005a-T5. Mutable fields: name, connectionConfig, active. Immutable:
 * id, ownerId, kind. See ../route.ts for the auth + idempotency model.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';

import {
  errorResponse,
  loadPrinterForActor,
  toPrinterDto,
} from '../../_shared';

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  connectionConfig: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const loaded = await loadPrinterForActor(req, id, 'read');
  if (!loaded.ok) return loaded.response;
  return NextResponse.json({ printer: toPrinterDto(loaded.row) });
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('invalid-body', 'JSON parse failed', 400);
  }

  // Reject any attempt to mutate immutable fields up front (clearer than a
  // generic Zod error). id, ownerId, kind are NOT patchable.
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    for (const immutable of ['id', 'ownerId', 'owner_id', 'kind']) {
      if (immutable in r) {
        return errorResponse(
          'invalid-body',
          `field '${immutable}' is immutable`,
          400,
        );
      }
    }
  }

  const parsed = PatchBody.safeParse(raw);
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

  const loaded = await loadPrinterForActor(req, id, 'update');
  if (!loaded.ok) return loaded.response;

  const patch: Partial<typeof schema.printers.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.connectionConfig !== undefined) patch.connectionConfig = body.connectionConfig;
  if (body.active !== undefined) patch.active = body.active;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ printer: toPrinterDto(loaded.row) });
  }

  const db = getServerDb();
  try {
    await db.update(schema.printers).set(patch).where(eq(schema.printers.id, id));
  } catch (err) {
    logger.error({ err, id }, 'PATCH /api/v1/forge/printers/:id: update failed');
    return errorResponse(
      'internal',
      'failed to update printer',
      500,
      err instanceof Error ? err.message : String(err),
    );
  }

  const refreshed = await db
    .select()
    .from(schema.printers)
    .where(eq(schema.printers.id, id))
    .limit(1);
  return NextResponse.json({ printer: toPrinterDto(refreshed[0]!) });
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const loaded = await loadPrinterForActor(req, id, 'delete');
  if (!loaded.ok) return loaded.response;

  const db = getServerDb();
  try {
    // CASCADE on FKs handles printer_acls + printer_reachable_via.
    await db.delete(schema.printers).where(eq(schema.printers.id, id));
  } catch (err) {
    logger.error({ err, id }, 'DELETE /api/v1/forge/printers/:id: delete failed');
    return errorResponse(
      'internal',
      'failed to delete printer',
      500,
      err instanceof Error ? err.message : String(err),
    );
  }
  return new Response(null, { status: 204 });
}
