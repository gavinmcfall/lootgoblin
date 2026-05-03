/**
 * GET  /api/v1/forge/inboxes — list caller's inboxes (admin: all)
 * POST /api/v1/forge/inboxes — create an inbox + start its watcher
 *
 * V2-005e-T_e2 — Forge inbox HTTP surface.
 *
 * Auth: BetterAuth session OR programmatic API key (matches V2-005a Forge
 *       routes via `requireAuth` from `_shared.ts`).
 *
 * ACL deviation from /forge/printers: inbox CRUD is owner-or-admin (not
 * owner-only). Inboxes are per-user filesystem watchers — admin override is
 * appropriate for fleet operators who want to inspect/repair user state on
 * a multi-tenant instance. Cross-owner access still returns 404 (no id leak).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import { logger } from '@/logger';
import { getServerDb, schema } from '@/db/client';
import {
  createInbox,
  listAllInboxes,
  listInboxesForOwner,
} from '@/forge/inboxes/lifecycle';
import { startInboxWatcher } from '@/forge/inboxes/ingest';
import {
  ForgeInboxCreateBody,
  toForgeInboxDto,
} from '@/forge/inboxes/types';

import { errorResponse, requireAuth } from '../_shared';

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

  const parsed = ForgeInboxCreateBody.safeParse(raw);
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

  // If a default printer is supplied, validate that the owner actually owns
  // it (no cross-owner pinning). Admin tightens this too: an admin creating
  // an inbox for themselves can't claim a printer they don't own.
  if (body.defaultPrinterId) {
    const db = getServerDb();
    const printerRows = await db
      .select({ ownerId: schema.printers.ownerId })
      .from(schema.printers)
      .where(eq(schema.printers.id, body.defaultPrinterId))
      .limit(1);
    const printer = printerRows[0];
    if (!printer) {
      return errorResponse('invalid-body', 'unknown defaultPrinterId', 422);
    }
    if (printer.ownerId !== actor.id && actor.role !== 'admin') {
      return errorResponse('invalid-body', 'unknown defaultPrinterId', 422);
    }
  }

  let row;
  try {
    row = await createInbox({ ...body, ownerId: actor.id });
  } catch (err) {
    logger.error(
      { err, ownerId: actor.id },
      'POST /api/v1/forge/inboxes: insert failed',
    );
    return errorResponse(
      'internal',
      'failed to create inbox',
      500,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Best-effort watcher start. If chokidar fails (path missing, permissions),
  // the row stays — startInboxWatcher logs + drops the in-memory entry. The
  // user can fix the path via PATCH; the next start attempt picks it up.
  await startInboxWatcher(row);

  return NextResponse.json({ inbox: toForgeInboxDto(row) }, { status: 201 });
}

// ---------------------------------------------------------------------------
// GET — list
// ---------------------------------------------------------------------------

const ListQuery = z.object({
  ownerId: z.string().min(1).optional(),
});

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const url = new URL(req.url);
  const queryParsed = ListQuery.safeParse({
    ownerId: url.searchParams.get('ownerId') ?? undefined,
  });
  if (!queryParsed.success) {
    return errorResponse('invalid-query', 'invalid query parameters', 400);
  }
  const q = queryParsed.data;

  // Admins can request a specific owner; non-admins always see only their own.
  let rows;
  if (actor.role === 'admin') {
    if (q.ownerId) {
      rows = await listInboxesForOwner(q.ownerId);
    } else {
      rows = await listAllInboxes();
    }
  } else {
    rows = await listInboxesForOwner(actor.id);
  }

  return NextResponse.json({ inboxes: rows.map(toForgeInboxDto) });
}
