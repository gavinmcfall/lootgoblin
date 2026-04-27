/**
 * DELETE /api/v1/forge/printers/:id/reachable-via/:agentId — admin-only
 *
 * Removes an entry from printer_reachable_via. 204 on success (or already
 * removed). 404 if the printer doesn't exist.
 */

import { type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';

import { errorResponse } from '../../../../_shared';

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; agentId: string }> },
) {
  const { id: printerId, agentId } = await ctx.params;

  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return unauthenticatedResponse(actor as null | typeof INVALID_API_KEY);
  }
  if (actor.role !== 'admin') {
    return errorResponse('forbidden', 'admin-only', 403);
  }

  const db = getServerDb();

  // Verify printer exists (so we can return a sensible 404 rather than silent
  // no-op delete on an unknown id).
  const printer = await db
    .select({ id: schema.printers.id })
    .from(schema.printers)
    .where(eq(schema.printers.id, printerId))
    .limit(1);
  if (printer.length === 0) {
    return errorResponse('not-found', 'printer-not-found', 404);
  }

  try {
    await db
      .delete(schema.printerReachableVia)
      .where(
        and(
          eq(schema.printerReachableVia.printerId, printerId),
          eq(schema.printerReachableVia.agentId, agentId),
        ),
      );
  } catch (err) {
    logger.error(
      { err, printerId, agentId },
      'DELETE /api/v1/forge/printers/:id/reachable-via/:agentId: delete failed',
    );
    return errorResponse(
      'internal',
      'failed to unbind reachability',
      500,
      err instanceof Error ? err.message : String(err),
    );
  }
  return new Response(null, { status: 204 });
}
