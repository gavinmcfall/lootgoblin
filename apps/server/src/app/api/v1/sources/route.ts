/**
 * GET /api/v1/sources — V2-003-T9
 *
 * Public catalog of registered Scavenger adapters. The UI consumes this to
 * render source cards (display name, auth methods, supports.* flags) and to
 * decide which OAuth flow to start.
 *
 * Auth boundary
 * ─────────────
 * v2 has TWO API-key boundaries:
 *
 *   1. BetterAuth `apikey` table — user-bound, interactive, scope-bearing.
 *      Used by V2-003 for ingest:read/ingest:write, extension_pairing,
 *      courier_pairing, programmatic. Web UI sessions also work (session
 *      cookie maps to a user with role-based ACL).
 *
 *   2. Custom `api_keys` Drizzle table — legacy from v1 (argon2id-hashed,
 *      single-scope rows). Still in use by extension + courier pairing
 *      pre-T9. DEPRECATED for T9+ routes; the source catalog accepts it
 *      via the shared `authenticateRequest` helper but new consumers
 *      should prefer BetterAuth `apikey`.
 *
 * The catalog is read-only and globally cacheable per process — any
 * authenticated caller may read it.
 *
 * Migrated from the v1 stub (5 lines, referenced @/adapters/listAdapters)
 * to the V2-003 ScavengerRegistry. The legacy v1 adapters at
 * apps/server/src/adapters/ are no longer consulted by this route.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, unauthenticatedResponse, INVALID_API_KEY } from '@/auth/request-auth';
import { defaultRegistry } from '@/scavengers';

export async function GET(req: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return unauthenticatedResponse(actor as null | typeof INVALID_API_KEY);
  }

  // ── Build catalog ────────────────────────────────────────────────────────
  const sources = defaultRegistry.list().map((id) => {
    const adapter = defaultRegistry.getById(id);
    // List() returns ids that are guaranteed to resolve, but TypeScript can't
    // narrow that — fall back defensively.
    if (!adapter) {
      return {
        id,
        displayName: id,
        supports: { url: false, sourceItemId: false, raw: false },
        authMethods: [] as string[],
      };
    }
    const meta = adapter.metadata;
    return {
      id,
      displayName: meta?.displayName ?? id,
      supports: meta?.supports ?? { url: false, sourceItemId: false, raw: false },
      authMethods: meta?.authMethods ?? [],
      ...(meta?.rateLimitPolicy ? { rateLimitPolicy: meta.rateLimitPolicy } : {}),
    };
  });

  return NextResponse.json({ sources });
}
