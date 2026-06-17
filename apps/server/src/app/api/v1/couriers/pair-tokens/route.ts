// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * POST /api/v1/couriers/pair-tokens — V2-006a-T4
 *
 * Admin-only endpoint that mints a one-time Courier pair token.
 *
 * The token is a signed PairTokenPayload (kind='courier', 30-minute TTL)
 * and is returned to the admin UI for out-of-band delivery to the Courier
 * operator. The Courier exchanges it once at /api/v1/couriers/pair.
 *
 * Auth: session or API key via authenticateRequest, gated to admin role.
 * Mirrors the pattern in /api/v1/agents/[id]/heartbeat/route.ts.
 *
 * Returns 200 { token, expires_at } on success.
 * Returns 503 if the instance identity has not been bootstrapped yet
 * (should never happen in production — instrumentation.ts bootstraps it).
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { mintCourierPairToken } from '@/forge/couriers';

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

  const result = await mintCourierPairToken();
  if (!result) {
    return NextResponse.json(
      { error: 'internal', reason: 'identity-not-bootstrapped' },
      { status: 503 },
    );
  }

  return NextResponse.json({ token: result.token, expires_at: result.expires_at });
}
