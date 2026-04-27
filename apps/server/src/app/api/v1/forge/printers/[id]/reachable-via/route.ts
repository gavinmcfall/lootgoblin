/**
 * POST /api/v1/forge/printers/:id/reachable-via — admin-only
 *
 * Adds an entry to printer_reachable_via for the given printer. Body:
 *   `{agentId: string}`.
 *
 * Reachable_via mutation is admin-only — it is a cross-cutting infra concern
 * (which agent can reach which printer). See V2-005a-T5 architectural
 * decisions. Returns 201 on insert, 200 on idempotent re-add.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';

import { errorResponse } from '../../../_shared';

const Body = z.object({
  agentId: z.string().min(1),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: printerId } = await ctx.params;
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return unauthenticatedResponse(actor as null | typeof INVALID_API_KEY);
  }
  if (actor.role !== 'admin') {
    return errorResponse('forbidden', 'admin-only', 403);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('invalid-body', 'JSON parse failed', 400);
  }
  const parsed = Body.safeParse(raw);
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
  const { agentId } = parsed.data;

  const db = getServerDb();

  // Verify printer exists (NOT scoped by owner — admin may bind reachability
  // for any printer).
  const printer = await db
    .select({ id: schema.printers.id })
    .from(schema.printers)
    .where(eq(schema.printers.id, printerId))
    .limit(1);
  if (printer.length === 0) {
    return errorResponse('not-found', 'printer-not-found', 404);
  }

  // Verify agent exists.
  const agent = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1);
  if (agent.length === 0) {
    return errorResponse('not-found', 'agent-not-found', 404);
  }

  // Idempotent re-add: if the row exists, return 200; else insert + return 201.
  const existing = await db
    .select({ printerId: schema.printerReachableVia.printerId })
    .from(schema.printerReachableVia)
    .where(
      and(
        eq(schema.printerReachableVia.printerId, printerId),
        eq(schema.printerReachableVia.agentId, agentId),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json(
      { printerId, agentId, alreadyExisted: true },
      { status: 200 },
    );
  }

  try {
    await db.insert(schema.printerReachableVia).values({ printerId, agentId });
  } catch (err) {
    logger.error(
      { err, printerId, agentId },
      'POST /api/v1/forge/printers/:id/reachable-via: insert failed',
    );
    return errorResponse(
      'internal',
      'failed to bind reachability',
      500,
      err instanceof Error ? err.message : String(err),
    );
  }
  return NextResponse.json({ printerId, agentId }, { status: 201 });
}
