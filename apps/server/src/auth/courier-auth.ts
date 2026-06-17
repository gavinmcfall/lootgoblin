// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Courier authentication resolver — V2-006a-T2
 *
 * Authenticates an inbound HTTP request from a Courier agent.
 *
 * Couriers present a `courier_pairing`-scoped API key in the standard
 * `x-api-key` header.  That key's ID is stored on the Courier's `agents` row
 * as `pair_credential_ref` — there is no separate ownership table needed.
 *
 * Resolution steps:
 *   1. Validate the `x-api-key` header carries a `courier_pairing`-scoped key
 *      via `isValidApiKeyWithScope`.
 *   2. If valid, look up the `agents` row WHERE `pair_credential_ref = keyId`.
 *   3. Return `{ agentId }` if found; `INVALID_API_KEY` if the key is valid but
 *      no agent references it (revoked / decommissioned courier).
 *
 * Return shape mirrors `authenticateRequest` so call sites can use
 * `unauthenticatedResponse` uniformly:
 *
 *   { agentId: string }  — authenticated Courier; caller may proceed.
 *   INVALID_API_KEY      — key presented but rejected (wrong scope, no agent).
 *   null                 — no `x-api-key` header at all.
 *
 * Re-exports `INVALID_API_KEY` and `unauthenticatedResponse` from
 * `request-auth` so courier route handlers only need to import from here.
 */

import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';

import { isValidApiKeyWithScope } from './helpers';
import { getServerDb, schema } from '@/db/client';

export { INVALID_API_KEY, unauthenticatedResponse } from './request-auth';
import { INVALID_API_KEY } from './request-auth';

/**
 * Authenticate the incoming request as a Courier agent.
 *
 * Returns:
 *   { agentId: string }  — valid `courier_pairing` key + matching agent row.
 *   INVALID_API_KEY      — key presented but validation failed (wrong scope,
 *                          invalid/expired key, or no agent references it).
 *   null                 — no `x-api-key` header was present.
 */
export async function authenticateCourier(
  req: Request | NextRequest,
): Promise<{ agentId: string } | null | typeof INVALID_API_KEY> {
  // Short-circuit if no key header — let the caller treat this as unauthenticated.
  const apiKeyHeader = (req.headers as Headers).get('x-api-key');
  if (!apiKeyHeader) {
    return null;
  }

  // Validate key and enforce courier_pairing scope.
  const result = await isValidApiKeyWithScope(req, ['courier_pairing']);
  if (!result.valid) {
    // Header was present but the key is invalid, expired, or wrong-scope.
    return INVALID_API_KEY;
  }

  // Key is valid and scoped. Resolve the Agent row that references this keyId.
  const db = getServerDb();
  const rows = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.pairCredentialRef, result.keyId))
    .limit(1);

  if (rows.length === 0) {
    // Valid courier_pairing key but no agent references it — agent was
    // deleted or the key was reissued without updating the agent row.
    // Treat as a hard rejection rather than a 500.
    return INVALID_API_KEY;
  }

  return { agentId: rows[0]!.id };
}
