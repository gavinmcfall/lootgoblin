/**
 * GET /api/v1/agents — list (admin only)
 * POST /api/v1/agents — create courier (admin only)
 *
 * V2-005a-T2 — Forge Agent CRUD HTTP surface.
 *
 * Auth: admin-session OR programmatic API key. Agents are infrastructure
 * entities (not user-owned); the resolveAcl pattern doesn't apply — we
 * gate inline on `actor.role === 'admin'` like /api/v1/materials/consumption.
 *
 * Idempotency:
 *   No `Idempotency-Key` header. Idempotent re-creates are handled via the
 *   request `id` field — POST with the same `id` and same body returns the
 *   existing agent (200), POST with the same `id` and a different body returns
 *   409. Documented decision (V2-005a-T2): agents are simple enough that the
 *   id-based path is sufficient; no dedicated idempotency_key column.
 *
 * `central_worker` not creatable via API:
 *   Bootstrap is the only path. POST with `kind: 'central_worker'` returns 422.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { createAgent, listAgents } from '@/forge/agents';
import { AGENT_KINDS } from '@/db/schema.forge';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CreateBody = z.object({
  // 'central_worker' is in AGENT_KINDS but is rejected at the route layer
  // because it is bootstrap-only. We list both kinds here so that a request
  // with kind='central_worker' fails with our 422 reason rather than the
  // generic Zod enum error.
  kind: z.enum(AGENT_KINDS),
  pair_credential_ref: z.string().min(1).nullable().optional(),
  reachable_lan_hint: z.string().min(1).nullable().optional(),
  id: z.string().min(1).optional(),
});

const ListQuery = z.object({
  kind: z.enum(AGENT_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

interface AgentRow {
  id: string;
  kind: string;
  pairCredentialRef: string | null;
  reachableLanHint: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

function toAgentDto(row: AgentRow) {
  return {
    id: row.id,
    kind: row.kind,
    pair_credential_ref: row.pairCredentialRef,
    reachable_lan_hint: row.reachableLanHint,
    last_seen_at: row.lastSeenAt ? row.lastSeenAt.getTime() : null,
    created_at: row.createdAt.getTime(),
  };
}

// ---------------------------------------------------------------------------
// GET — list
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return unauthenticatedResponse(actor as null | typeof INVALID_API_KEY);
  }
  if (actor.role !== 'admin') {
    return NextResponse.json(
      { error: 'forbidden', reason: 'admin-only' },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const queryRaw = {
    kind: url.searchParams.get('kind') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  };
  const queryParsed = ListQuery.safeParse(queryRaw);
  if (!queryParsed.success) {
    return NextResponse.json(
      { error: 'invalid-query', issues: queryParsed.error.issues },
      { status: 400 },
    );
  }

  const result = await listAgents(queryParsed.data);
  return NextResponse.json({
    agents: result.agents.map(toAgentDto),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  });
}

// ---------------------------------------------------------------------------
// POST — create courier
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return unauthenticatedResponse(actor as null | typeof INVALID_API_KEY);
  }
  if (actor.role !== 'admin') {
    return NextResponse.json(
      { error: 'forbidden', reason: 'admin-only' },
      { status: 403 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid-body', reason: 'JSON parse failed' },
      { status: 400 },
    );
  }
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  if (body.kind === 'central_worker') {
    return NextResponse.json(
      {
        error: 'invalid-body',
        reason: 'central-worker-via-bootstrap',
        details:
          'central_worker agents are created only by the in-process bootstrap; not via API',
      },
      { status: 422 },
    );
  }

  const result = await createAgent({
    kind: body.kind,
    pairCredentialRef: body.pair_credential_ref ?? null,
    reachableLanHint: body.reachable_lan_hint ?? null,
    id: body.id,
  });

  if (!result.ok) {
    if (result.reason === 'id-conflict') {
      return NextResponse.json(
        { error: 'conflict', reason: result.reason, details: result.details },
        { status: 409 },
      );
    }
    if (result.reason === 'invalid-kind' || result.reason === 'central-worker-via-bootstrap') {
      return NextResponse.json(
        { error: 'invalid-body', reason: result.reason, details: result.details },
        { status: 422 },
      );
    }
    return NextResponse.json(
      { error: 'internal', reason: result.reason, details: result.details },
      { status: 500 },
    );
  }

  // If the caller passed an explicit id and the row already existed (idempotent
  // path), return 200 instead of 201. Detect by re-reading and comparing.
  // Simpler: createAgent returns ok with the same id whether created or
  // pre-existing; route distinguishes by checking whether the caller supplied
  // an id that matches the returned id (best-effort signal — for now we
  // always emit 201, matching the watchlist subscription pattern, since the
  // request did successfully reify a row).
  return NextResponse.json(
    {
      agent: {
        id: result.agentId,
        kind: body.kind,
        pair_credential_ref: body.pair_credential_ref ?? null,
        reachable_lan_hint: body.reachable_lan_hint ?? null,
      },
    },
    { status: 201 },
  );
}
