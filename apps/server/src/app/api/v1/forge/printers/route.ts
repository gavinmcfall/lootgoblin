/**
 * GET  /api/v1/forge/printers — list caller's printers (admin: all)
 * POST /api/v1/forge/printers — create a printer
 *
 * V2-005a-T5 — Forge HTTP API surface.
 *
 * Auth: BetterAuth session OR programmatic API key (matches materials/ingest).
 * ACL: owner-on-mutate, owner-on-read (admin reads ALL — fleet visibility).
 *
 * Idempotency: optional `Idempotency-Key` header (RFC 7240-style). Replay
 * with the same body returns the prior printer (200); replay with a different
 * body returns 409.
 *
 * `reachable_via` semantics:
 *   - Optional in body. If omitted, defaults to `[centralWorkerAgentId]` —
 *     a printer registered without explicit reachable_via is assumed reachable
 *     from the central instance.
 *   - The body wires through to printer_reachable_via rows in the same
 *     transaction as the printer insert.
 */

import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

import { getServerDb, schema } from '@/db/client';
import { logger } from '@/logger';
import { FORGE_PRINTER_KINDS } from '@/db/schema.forge';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  errorResponse,
  findByIdempotencyKey,
  requireAuth,
  toPrinterDto,
  tryClaimIdempotencyKey,
} from '../_shared';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CreateBody = z.object({
  kind: z.enum(FORGE_PRINTER_KINDS),
  name: z.string().min(1).max(200),
  connectionConfig: z.record(z.string(), z.unknown()),
  reachable_via: z.array(z.string().min(1)).optional(),
  active: z.boolean().optional(),
});

type CreateBodyT = z.infer<typeof CreateBody>;

const ListQuery = z.object({
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  kind: z.enum(FORGE_PRINTER_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().optional(),
});

function normalizeBody(body: CreateBodyT, ownerId: string): string {
  return JSON.stringify({
    ownerId,
    kind: body.kind,
    name: body.name,
    connectionConfig: body.connectionConfig,
    active: body.active ?? true,
  });
}

function normalizeStored(row: typeof schema.printers.$inferSelect): string {
  return JSON.stringify({
    ownerId: row.ownerId,
    kind: row.kind,
    name: row.name,
    connectionConfig: row.connectionConfig,
    active: row.active === true,
  });
}

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
  const parsed = CreateBody.safeParse(raw);
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

  const db = getServerDb();
  const idempotencyKey = req.headers.get('Idempotency-Key');
  const normalized = normalizeBody(body, actor.id);

  if (idempotencyKey) {
    const prior = await findByIdempotencyKey<typeof schema.printers.$inferSelect>(
      schema.printers,
      schema.printers.ownerId,
      schema.printers.idempotencyKey,
      actor.id,
      idempotencyKey,
    );
    if (prior) {
      if (normalizeStored(prior) === normalized) {
        return NextResponse.json({ printer: toPrinterDto(prior) }, { status: 200 });
      }
      return NextResponse.json(
        {
          error: 'idempotency-mismatch',
          message: 'Idempotency-Key reused with a different request body',
          printerId: prior.id,
        },
        { status: 409 },
      );
    }
  }

  // Resolve reachable_via: explicit list OR default to [centralWorkerAgentId].
  let reachableAgentIds: string[];
  if (body.reachable_via && body.reachable_via.length > 0) {
    // Validate every agent id exists.
    const found = await db
      .select({ id: schema.agents.id })
      .from(schema.agents);
    const known = new Set(found.map((r) => r.id));
    for (const agentId of body.reachable_via) {
      if (!known.has(agentId)) {
        return errorResponse(
          'invalid-body',
          `unknown agent id in reachable_via: ${agentId}`,
          422,
        );
      }
    }
    reachableAgentIds = Array.from(new Set(body.reachable_via));
  } else {
    const central = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.kind, 'central_worker'))
      .limit(1);
    if (central.length === 0) {
      return errorResponse(
        'internal',
        'no central_worker agent found; bootstrap is supposed to ensure one',
        500,
      );
    }
    reachableAgentIds = [central[0]!.id];
  }

  const id = randomUUID();
  const now = new Date();
  try {
    await db.insert(schema.printers).values({
      id,
      ownerId: actor.id,
      kind: body.kind,
      name: body.name,
      connectionConfig: body.connectionConfig,
      active: body.active ?? true,
      createdAt: now,
    });
    for (const agentId of reachableAgentIds) {
      await db.insert(schema.printerReachableVia).values({ printerId: id, agentId });
    }
  } catch (err) {
    logger.error({ err, ownerId: actor.id }, 'POST /api/v1/forge/printers: insert failed');
    return errorResponse(
      'internal',
      'failed to create printer',
      500,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (idempotencyKey) {
    const claim = await tryClaimIdempotencyKey(
      schema.printers,
      schema.printers.id,
      id,
      idempotencyKey,
    );
    if (!claim.ok) {
      try {
        await db.delete(schema.printerReachableVia).where(eq(schema.printerReachableVia.printerId, id));
        await db.delete(schema.printers).where(eq(schema.printers.id, id));
      } catch (cleanupErr) {
        logger.warn(
          { err: cleanupErr, printerId: id },
          'POST /api/v1/forge/printers: cleanup of idempotency loser failed',
        );
      }
      const winner = await findByIdempotencyKey<typeof schema.printers.$inferSelect>(
        schema.printers,
        schema.printers.ownerId,
        schema.printers.idempotencyKey,
        actor.id,
        idempotencyKey,
      );
      if (winner) {
        return NextResponse.json({ printer: toPrinterDto(winner) }, { status: 200 });
      }
      logger.error(
        { err: claim.err, printerId: id },
        'POST /api/v1/forge/printers: idempotency claim failed and no winner found',
      );
      return errorResponse('internal', 'failed to persist idempotency key', 500);
    }
  }

  const refreshed = await db
    .select()
    .from(schema.printers)
    .where(eq(schema.printers.id, id))
    .limit(1);
  return NextResponse.json(
    { printer: toPrinterDto(refreshed[0]!) },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// GET — list
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const url = new URL(req.url);
  const queryParsed = ListQuery.safeParse({
    active: url.searchParams.get('active') ?? undefined,
    kind: url.searchParams.get('kind') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  });
  if (!queryParsed.success) {
    return NextResponse.json(
      {
        error: 'invalid-query',
        message: 'invalid query parameters',
        issues: queryParsed.error.issues,
      },
      { status: 400 },
    );
  }
  const q = queryParsed.data;

  const db = getServerDb();
  const conditions = [];
  if (actor.role !== 'admin') {
    conditions.push(eq(schema.printers.ownerId, actor.id));
  }
  if (q.kind) conditions.push(eq(schema.printers.kind, q.kind));
  if (q.active !== undefined) conditions.push(eq(schema.printers.active, q.active));
  if (q.cursor) {
    const cursorMs = Number(q.cursor);
    if (!Number.isFinite(cursorMs)) {
      return errorResponse('invalid-query', 'cursor must be a numeric ms timestamp', 400);
    }
    conditions.push(lt(schema.printers.createdAt, new Date(cursorMs)));
  }

  const whereClause =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
      ? conditions[0]
      : and(...conditions);

  const rows = await (whereClause
    ? db
        .select()
        .from(schema.printers)
        .where(whereClause)
        .orderBy(desc(schema.printers.createdAt), asc(schema.printers.id))
        .limit(q.limit + 1)
    : db
        .select()
        .from(schema.printers)
        .orderBy(desc(schema.printers.createdAt), asc(schema.printers.id))
        .limit(q.limit + 1));

  const hasMore = rows.length > q.limit;
  const sliced = hasMore ? rows.slice(0, q.limit) : rows;
  const nextCursor =
    hasMore && sliced.length > 0
      ? String(sliced[sliced.length - 1]!.createdAt.getTime())
      : undefined;

  return NextResponse.json({
    printers: sliced.map(toPrinterDto),
    ...(nextCursor ? { nextCursor } : {}),
  });
}
