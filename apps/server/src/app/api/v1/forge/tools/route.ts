/**
 * GET /api/v1/forge/tools — V2-005c T_c6
 *
 * Admin-only list of installable slicer kinds + currently-installed rows.
 * The `available` array is the static FORGE_SLICER_KINDS_INSTALLABLE
 * allow-list; `installed` is whatever rows exist in `forge_slicer_installs`.
 *
 * Auth gating mirrors `/api/v1/agents`: BetterAuth session OR programmatic
 * API key, then a hard `actor.role === 'admin'` check. The slicer-install
 * pipeline manages binaries on the server's filesystem, so non-admin users
 * have no business listing them.
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { FORGE_SLICER_KINDS_INSTALLABLE } from '@/db/schema.forge';
import { listInstalls } from '@/forge/slicer/registry';

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

  const installed = listInstalls();
  return NextResponse.json({
    available: FORGE_SLICER_KINDS_INSTALLABLE,
    installed,
  });
}
