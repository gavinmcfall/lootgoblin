/**
 * Auth helpers for route handlers — V2-001-T4
 *
 * Provides lightweight wrappers for the two session-validation patterns used
 * across API routes:
 *
 *   getSessionOrNull   — returns the BetterAuth session+user or null.
 *   verifyApiKeyOrNull — returns { valid: true } when the x-api-key header
 *                        carries a valid key, or { valid: false } otherwise.
 *
 * Routes import these instead of calling auth.api directly so that T5 can
 * add scope enforcement in a single place without touching every route.
 *
 * NOTE: These helpers must NOT import from '@/auth' using a cached singleton
 * reference that is resolved before instrumentation runs. They do a lazy
 * require so the resolver is always fully populated by call time.
 */

import type { NextRequest } from 'next/server';

/** Lazy-load the auth singleton to avoid import-order issues at boot. */
function getAuth() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('./index') as typeof import('./index')).auth;
}

/**
 * Returns the BetterAuth session + user for the current request, or null if
 * no valid session cookie is present.
 */
export async function getSessionOrNull(req: Request | NextRequest) {
  const authInst = getAuth();
  try {
    return await authInst.api.getSession({ headers: req.headers as Headers });
  } catch {
    return null;
  }
}

/**
 * Returns true when the request carries a valid BetterAuth API key in the
 * `x-api-key` header.  Returns false if the header is absent or the key is
 * invalid / revoked.
 */
export async function isValidApiKey(req: Request | NextRequest): Promise<boolean> {
  const key = (req.headers as Headers).get('x-api-key');
  if (!key) return false;
  const authInst = getAuth();
  try {
    const result = await authInst.api.verifyApiKey({ body: { key } });
    return result.valid === true;
  } catch {
    return false;
  }
}
