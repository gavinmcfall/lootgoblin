/**
 * Auth helpers for route handlers — V2-001-T4 / T5
 *
 * Provides lightweight wrappers for the two session-validation patterns used
 * across API routes:
 *
 *   getSessionOrNull          — returns the BetterAuth session+user or null.
 *   isValidApiKey             — returns true if the x-api-key header carries a
 *                               valid, unrevoked, non-expired key (any scope).
 *   isValidApiKeyWithScope    — returns { valid, scope, userId, reason } after
 *                               verifying the key AND enforcing scope membership.
 *
 * Implementation note (V2-001-T5):
 *   Application-managed keys are stored in the custom `api_keys` Drizzle table
 *   with argon2id hashes.  This is separate from BetterAuth's own `apikey` table.
 *   Verification is therefore done via Drizzle + argon2, not via
 *   auth.api.verifyApiKey, which only covers BetterAuth-native keys.
 *
 * Routes import these instead of calling auth.api directly so that T5 scope
 * enforcement is centralised here and not scattered across every route handler.
 *
 * NOTE: These helpers must NOT import from '@/auth' using a cached singleton
 * reference that is resolved before instrumentation runs. They do a lazy
 * require so the resolver is always fully populated by call time.
 *
 * Courier routes (V2-006): dispatch claim / status report / heartbeat will call
 *   isValidApiKeyWithScope(req, ['courier_pairing'])
 * Programmatic routes (future): any third-party integration endpoint will call
 *   isValidApiKeyWithScope(req, ['programmatic'])
 */

import argon2 from 'argon2';
import { isNull } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import type { ApiKeyScope } from './scopes';
import { getDb, schema } from '@/db/client';

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
 * Internal: look up the api_keys row for this key and verify the argon2 hash.
 * Returns the row if valid and non-revoked, null otherwise.
 */
async function findValidKeyRow(key: string): Promise<{
  id: string;
  name: string;
  scope: string;
  expiresAt: Date | null;
} | null> {
  try {
    const db = getDb() as any;
    const rows: Array<{
      id: string;
      name: string;
      keyHash: string;
      scope: string;
      expiresAt: Date | null;
    }> = await db
      .select({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        keyHash: schema.apiKeys.keyHash,
        scope: schema.apiKeys.scope,
        expiresAt: schema.apiKeys.expiresAt,
      })
      .from(schema.apiKeys)
      .where(isNull(schema.apiKeys.revokedAt));

    for (const row of rows) {
      const match = await argon2.verify(row.keyHash, key);
      if (match) {
        return { id: row.id, name: row.name, scope: row.scope, expiresAt: row.expiresAt };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns true when the request carries a valid BetterAuth API key in the
 * `x-api-key` header.  Returns false if the header is absent, the key is
 * invalid / revoked, or the key has expired.
 */
export async function isValidApiKey(req: Request | NextRequest): Promise<boolean> {
  const key = (req.headers as Headers).get('x-api-key');
  if (!key) return false;
  const row = await findValidKeyRow(key);
  if (!row) return false;
  if (row.expiresAt && row.expiresAt < new Date()) return false;
  return true;
}

/**
 * Verifies the API key in the x-api-key header and enforces scope membership.
 *
 * Returns:
 *   { valid: true,  scope, keyId }          — key is valid + scope is allowed.
 *   { valid: false, reason: 'missing' }     — no x-api-key header.
 *   { valid: false, reason: 'invalid' }     — key not found / argon2 mismatch.
 *   { valid: false, reason: 'expired' }     — key exists but past expiresAt.
 *   { valid: false, reason: 'wrong-scope',
 *     expected: [...], actual: '...' }      — valid key but wrong scope.
 */
export async function isValidApiKeyWithScope(
  req: Request | NextRequest,
  allowedScopes: ApiKeyScope[],
): Promise<
  | { valid: true; scope: ApiKeyScope; keyId: string }
  | { valid: false; reason: 'missing' }
  | { valid: false; reason: 'invalid' }
  | { valid: false; reason: 'expired' }
  | { valid: false; reason: 'wrong-scope'; expected: ApiKeyScope[]; actual: string }
> {
  const key = (req.headers as Headers).get('x-api-key');
  if (!key) return { valid: false, reason: 'missing' };

  const row = await findValidKeyRow(key);
  if (!row) return { valid: false, reason: 'invalid' };

  if (row.expiresAt && row.expiresAt < new Date()) {
    return { valid: false, reason: 'expired' };
  }

  const actualScope = row.scope;
  if (!allowedScopes.includes(actualScope as ApiKeyScope)) {
    return {
      valid: false,
      reason: 'wrong-scope',
      expected: allowedScopes,
      actual: actualScope,
    };
  }

  return { valid: true, scope: actualScope as ApiKeyScope, keyId: row.id };
}
