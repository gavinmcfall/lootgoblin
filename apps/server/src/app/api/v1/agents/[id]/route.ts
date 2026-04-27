/**
 * GET /api/v1/agents/:id
 * PATCH /api/v1/agents/:id
 * DELETE /api/v1/agents/:id
 *
 * V2-005a-T2 — admin-only Agent endpoints. See ../route.ts for the auth model.
 *
 * PATCH mutable fields: `pair_credential_ref`, `reachable_lan_hint`. `kind` is
 * structural identity and is not patchable; create a new agent if you need
 * a different kind.
 *
 * DELETE refuses if the agent is referenced by `printer_reachable_via` rows
 * (409 agent-has-reachable-printers) or if it would leave the system without
 * a `central_worker` (409 cannot-delete-bootstrap-agent). See
 * `src/forge/agents.ts` for the rationale.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { deleteAgent, getAgent, updateAgent } from '@/forge/agents';

const UpdateBody = z.object({
  pair_credential_ref: z.string().min(1).nullable().optional(),
  reachable_lan_hint: z.string().min(1).nullable().optional(),
});

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

async function gateAdmin(req: NextRequest) {
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return { ok: false as const, response: unauthenticatedResponse(actor as null | typeof INVALID_API_KEY) };
  }
  if (actor.role !== 'admin') {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: 'forbidden', reason: 'admin-only' },
        { status: 403 },
      ),
    };
  }
  return { ok: true as const, actor };
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const gate = await gateAdmin(req);
  if (!gate.ok) return gate.response;

  if (!id) {
    return NextResponse.json(
      { error: 'invalid-path', reason: 'missing agent id' },
      { status: 400 },
    );
  }

  const row = await getAgent({ id });
  if (!row) {
    return NextResponse.json(
      { error: 'not-found', reason: 'agent-not-found' },
      { status: 404 },
    );
  }
  return NextResponse.json({ agent: toAgentDto(row) });
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const gate = await gateAdmin(req);
  if (!gate.ok) return gate.response;

  if (!id) {
    return NextResponse.json(
      { error: 'invalid-path', reason: 'missing agent id' },
      { status: 400 },
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
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if ('kind' in r) {
      return NextResponse.json(
        {
          error: 'invalid-body',
          reason: 'kind is structural and cannot be patched — create a new agent instead',
        },
        { status: 400 },
      );
    }
  }
  const parsed = UpdateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await updateAgent({
    id,
    ...(parsed.data.pair_credential_ref !== undefined
      ? { pairCredentialRef: parsed.data.pair_credential_ref }
      : {}),
    ...(parsed.data.reachable_lan_hint !== undefined
      ? { reachableLanHint: parsed.data.reachable_lan_hint }
      : {}),
  });
  if (!result.ok) {
    if (result.reason === 'not-found') {
      return NextResponse.json(
        { error: 'not-found', reason: 'agent-not-found' },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: 'internal', reason: result.reason, details: result.details },
      { status: 500 },
    );
  }

  const refreshed = await getAgent({ id });
  if (!refreshed) {
    return NextResponse.json({ error: 'internal', reason: 'post-update-missing' }, { status: 500 });
  }
  return NextResponse.json({ agent: toAgentDto(refreshed) });
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const gate = await gateAdmin(req);
  if (!gate.ok) return gate.response;

  if (!id) {
    return NextResponse.json(
      { error: 'invalid-path', reason: 'missing agent id' },
      { status: 400 },
    );
  }

  const result = await deleteAgent({ id });
  if (!result.ok) {
    if (result.reason === 'not-found') {
      return NextResponse.json(
        { error: 'not-found', reason: 'agent-not-found' },
        { status: 404 },
      );
    }
    if (
      result.reason === 'agent-has-reachable-printers' ||
      result.reason === 'cannot-delete-bootstrap-agent'
    ) {
      return NextResponse.json(
        { error: 'conflict', reason: result.reason, details: result.details },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: 'internal', reason: result.reason, details: result.details },
      { status: 500 },
    );
  }
  return new Response(null, { status: 204 });
}
