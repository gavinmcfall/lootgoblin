/**
 * POST /api/v1/agents/:id/heartbeat — V2-005a-T2
 *
 * Bumps `agents.last_seen_at = now()`. Called by:
 *   - The in-process central_worker (from its claim-loop tick — wired in T4)
 *   - Future V2-006 couriers (from their main loop)
 *
 * Auth model:
 *   The agent identifies itself. For v2.0 the only programmatic clients are
 *   the central_worker (admin-session via process identity is the simplest
 *   model) and admin sessions. Future couriers will authenticate via their
 *   `pair_credential_ref` API key — but that requires per-key ownership
 *   tracking the api_keys table doesn't yet have (documented gap in
 *   request-auth.ts header). For now: admin-only, same gate as the rest of
 *   the agent CRUD surface. T6/T7 (courier handshake) can relax this.
 *
 * Idempotent — repeated calls each advance `last_seen_at`.
 *
 * Returns 204 on success, 404 if the agent id is unknown.
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { recordHeartbeat } from '@/forge/agents';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

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

  if (!id) {
    return NextResponse.json(
      { error: 'invalid-path', reason: 'missing agent id' },
      { status: 400 },
    );
  }

  const result = await recordHeartbeat({ id });
  if (!result.ok) {
    if (result.reason === 'not-found') {
      return NextResponse.json(
        { error: 'not-found', reason: 'agent-not-found' },
        { status: 404 },
      );
    }
    return NextResponse.json({ error: 'internal', reason: result.reason }, { status: 500 });
  }
  return new Response(null, { status: 204 });
}
