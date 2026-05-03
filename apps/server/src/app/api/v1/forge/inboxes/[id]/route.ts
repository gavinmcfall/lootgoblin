/**
 * GET    /api/v1/forge/inboxes/:id
 * PATCH  /api/v1/forge/inboxes/:id
 * DELETE /api/v1/forge/inboxes/:id
 *
 * V2-005e-T_e2. Owner-or-admin ACL — cross-owner returns 404 (no id leak).
 * Watcher side effects are wired here:
 *   - PATCH: if `path` changes → stop old + start new watcher (whether the
 *            row was active or not, we stop+restart only if currently active).
 *   - PATCH: if `active` flips → start or stop accordingly.
 *   - DELETE: stop watcher unconditionally.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';
import {
  deleteInbox,
  getInboxForActor,
  updateInbox,
} from '@/forge/inboxes/lifecycle';
import {
  hasActiveWatcher,
  startInboxWatcher,
  stopInboxWatcher,
} from '@/forge/inboxes/ingest';
import {
  ForgeInboxUpdateBody,
  toForgeInboxDto,
} from '@/forge/inboxes/types';

import { errorResponse, requireAuth } from '../../_shared';

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const row = await getInboxForActor({
    id,
    actorId: auth.actor.id,
    actorRole: auth.actor.role,
  });
  if (!row) {
    return errorResponse('not-found', 'inbox-not-found', 404);
  }
  return NextResponse.json({ inbox: toForgeInboxDto(row) });
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('invalid-body', 'JSON parse failed', 400);
  }

  // Reject any attempt to mutate immutable fields up front.
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    for (const immutable of ['id', 'ownerId', 'owner_id', 'createdAt']) {
      if (immutable in r) {
        return errorResponse(
          'invalid-body',
          `field '${immutable}' is immutable`,
          400,
        );
      }
    }
  }

  const parsed = ForgeInboxUpdateBody.safeParse(raw);
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

  const existing = await getInboxForActor({
    id,
    actorId: auth.actor.id,
    actorRole: auth.actor.role,
  });
  if (!existing) {
    return errorResponse('not-found', 'inbox-not-found', 404);
  }

  // Validate defaultPrinterId ownership when set to a non-null value.
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
    if (printer.ownerId !== existing.ownerId && auth.actor.role !== 'admin') {
      return errorResponse('invalid-body', 'unknown defaultPrinterId', 422);
    }
  }

  const updated = await updateInbox(id, body);
  if (!updated) {
    return errorResponse('not-found', 'inbox-not-found', 404);
  }

  // Watcher reconciliation. The desired state is `updated.active === true`
  // and watching `updated.path`. Reach that state with stop/start as needed.
  try {
    const currentlyActive = hasActiveWatcher(id);
    const pathChanged = body.path !== undefined && body.path !== existing.path;
    const activeChanged = body.active !== undefined && body.active !== existing.active;

    if (currentlyActive && (pathChanged || (activeChanged && !updated.active))) {
      await stopInboxWatcher(id);
    }
    if (
      updated.active &&
      (!hasActiveWatcher(id) || pathChanged)
    ) {
      await startInboxWatcher(updated);
    }
  } catch (err) {
    // Log + continue — DB state is already correct, watcher state will be
    // reconciled at next boot if anything is off.
    logger.warn(
      { err, inboxId: id },
      'PATCH /api/v1/forge/inboxes/:id: watcher reconciliation threw',
    );
  }

  return NextResponse.json({ inbox: toForgeInboxDto(updated) });
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const existing = await getInboxForActor({
    id,
    actorId: auth.actor.id,
    actorRole: auth.actor.role,
  });
  if (!existing) {
    return errorResponse('not-found', 'inbox-not-found', 404);
  }

  // Stop the watcher BEFORE deleting the row so a concurrent recovery sweep
  // can't observe an active watcher pointing at a deleted row. If the stop
  // throws, we log + still delete — DB consistency wins; watcher state
  // self-heals at next boot.
  try {
    await stopInboxWatcher(id);
  } catch (err) {
    logger.warn(
      { err, inboxId: id },
      'DELETE /api/v1/forge/inboxes/:id: watcher stop threw',
    );
  }

  const removed = await deleteInbox(id);
  if (!removed) {
    return errorResponse('not-found', 'inbox-not-found', 404);
  }
  return NextResponse.json({ removed: true });
}
