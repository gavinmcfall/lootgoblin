/**
 * Shared request authentication helper — V2-002-T12 review fix.
 *
 * Unifies the two authentication paths used across API routes:
 *
 *   1. BetterAuth session cookie (getSessionOrNull) — browser users.
 *   2. x-api-key header with a 'programmatic' scope key (isValidApiKeyWithScope)
 *      — third-party integrations + future automation clients.
 *
 * Every CRUD route in /api/v1/* goes through this helper so the auth policy
 * is centralised.  Routes that need scope-specific keys (extension_pairing,
 * courier_pairing) continue to call isValidApiKeyWithScope directly with
 * their narrower allowlist.
 *
 * API-key ownership gap (documented V2-001 deficiency):
 *   The `api_keys` Drizzle table does NOT carry an ownerId column. When a
 *   programmatic key authenticates, we cannot attribute the request to a
 *   specific user.  As a pragmatic v2.0 decision, programmatic keys resolve
 *   to a synthetic actor id derived from the keyId with role='user'.
 *   ACL decisions therefore treat the key as an ordinary, non-admin, non-owner
 *   principal — it will pass `read` checks (which allow any authenticated
 *   user) and fail ownership-gated mutations unless the resource's ownerId
 *   happens to match the synthetic id (it won't).
 *
 *   This is intentional for v2.0: programmatic keys are read-first and we
 *   want explicit, auditable per-user attribution before we grant mutation
 *   power.  A future V2-00X task can add owner tracking and lift this.
 */

import { getSessionOrNull } from './helpers';
import { isValidApiKeyWithScope } from './helpers';
import type { NextRequest } from 'next/server';

export interface AuthenticatedActor {
  id: string;
  role: 'admin' | 'user';
  /** Which authentication path produced this actor. Useful for logging. */
  source: 'session' | 'api-key';
}

/**
 * Authenticates the incoming request via session OR API key.
 *
 * Returns the resolved actor on success, or null if neither path yields a
 * valid identity.  Does NOT perform ACL checks — callers must still call
 * `resolveAcl(...)` with the returned actor.
 */
export async function authenticateRequest(
  req: Request | NextRequest,
): Promise<AuthenticatedActor | null> {
  // 1. Try BetterAuth session first — covers browser navigation + XHR.
  const session = await getSessionOrNull(req);
  if (session?.user) {
    return {
      id: session.user.id,
      role: session.user.role ?? 'user',
      source: 'session',
    };
  }

  // 2. Fall back to x-api-key header.  We accept the 'programmatic' scope
  //    for generic CRUD endpoints.  Scope-specific routes (extension,
  //    courier) call isValidApiKeyWithScope directly with their narrower list.
  const apiKeyHeader = (req.headers as Headers).get('x-api-key');
  if (apiKeyHeader) {
    const result = await isValidApiKeyWithScope(req, ['programmatic']);
    if (result.valid) {
      // No ownerId on api_keys table (documented gap).  Use a synthetic id
      // that is stable per-key so logs can correlate but cannot coincidentally
      // match a real user's id (keyIds are uuids, so collision risk is zero).
      return {
        id: `api-key:${result.keyId}`,
        role: 'user',
        source: 'api-key',
      };
    }
  }

  return null;
}
