/**
 * Shared helpers for /api/v1/source-auth/:sourceId/* routes — V2-003-T9.
 *
 * Centralises:
 *   - source-id validation against the V2-003 registry
 *   - per-source OAuth provider config (Sketchfab, Google Drive)
 *   - source_credentials read/upsert (encrypted at rest via crypto module)
 *
 * These routes are owned by the v2 source-auth surface; the legacy
 * /api/v1/source-credentials/[source]/route.ts coexists for cookie-jar
 * uploads from the extension.
 */

import { NextResponse } from 'next/server';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';

import { authenticateRequest, INVALID_API_KEY, unauthenticatedResponse } from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';
import { getDb, schema } from '@/db/client';
import { encrypt, decrypt } from '@/crypto';
import { defaultRegistry, type SourceId } from '@/scavengers';
import { logger } from '@/logger';

export type OAuthProviderConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** True when the provider requires PKCE (we use it for Google). */
  requiresPkce: boolean;
};

const PROVIDERS: Partial<Record<SourceId, OAuthProviderConfig>> = {
  sketchfab: {
    authorizeUrl: 'https://sketchfab.com/oauth2/authorize/',
    tokenUrl: 'https://sketchfab.com/oauth2/token/',
    scopes: ['read', 'upload'],
    requiresPkce: false,
  },
  'google-drive': {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    requiresPkce: true,
  },
};

export function providerConfigFor(sourceId: SourceId): OAuthProviderConfig | null {
  return PROVIDERS[sourceId] ?? null;
}

/**
 * Resolve + authorize the caller for a write to the source-auth surface.
 *
 * Returns either a NextResponse to short-circuit with, or `{ actor, sourceId }`
 * for the route handler to continue.
 */
export type AuthOk = { ok: true; actor: { id: string; role: 'admin' | 'user' }; sourceId: SourceId };
export type AuthErr = { ok: false; response: Response };
export type AuthResult = AuthOk | AuthErr;

export async function authorizeWrite(
  req: Request,
  rawSourceId: string,
): Promise<AuthResult> {
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return { ok: false, response: unauthenticatedResponse(actor as null | typeof INVALID_API_KEY) };
  }

  // Validate source against the registry.
  const adapter = defaultRegistry.getById(rawSourceId as SourceId);
  if (!adapter) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'unsupported-source', reason: `unknown sourceId: ${rawSourceId}` },
        { status: 404 },
      ),
    };
  }

  // ACL: source credentials gate library-wide source access. Map to the
  // existing `loot` `update` permission, which is owner-or-admin in V2-001.
  // Source credentials have no per-user owner; treat the actor as owner so
  // any authenticated non-admin user may manage credentials on shared
  // sources. (The resolver's owner-id check passes when ownerId === user.id.)
  const acl = resolveAcl({
    user: actor,
    resource: { kind: 'loot', ownerId: actor.id },
    action: 'update',
  });
  if (!acl.allowed) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 }),
    };
  }

  return { ok: true, actor, sourceId: adapter.id };
}

/** Same as above but for read-only paths (GET status). */
export async function authorizeRead(
  req: Request,
  rawSourceId: string,
): Promise<AuthResult> {
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return { ok: false, response: unauthenticatedResponse(actor as null | typeof INVALID_API_KEY) };
  }
  const adapter = defaultRegistry.getById(rawSourceId as SourceId);
  if (!adapter) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'unsupported-source', reason: `unknown sourceId: ${rawSourceId}` },
        { status: 404 },
      ),
    };
  }
  return { ok: true, actor, sourceId: adapter.id };
}

/**
 * Persist (insert or update) the encrypted credential bag for a sourceId.
 *
 * The existing source_credentials schema is keyed by sourceId (no per-user
 * column), so we upsert the FIRST row matching `sourceId` — or insert a new
 * row if none exists. Returns the row id.
 */
export async function upsertSourceCredential(args: {
  sourceId: SourceId;
  kind: 'oauth-token' | 'api-key';
  bag: Record<string, unknown>;
  expiresAt?: Date | null;
}): Promise<{ id: string; created: boolean }> {
  const secret = process.env.LOOTGOBLIN_SECRET;
  if (!secret) {
    throw new Error('LOOTGOBLIN_SECRET not set — cannot persist source credential');
  }
  const encryptedBlob = Buffer.from(encrypt(JSON.stringify(args.bag), secret));

  const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

  const existing = await db
    .select({ id: schema.sourceCredentials.id })
    .from(schema.sourceCredentials)
    .where(eq(schema.sourceCredentials.sourceId, args.sourceId))
    .limit(1);

  if (existing[0]) {
    await db
      .update(schema.sourceCredentials)
      .set({
        kind: args.kind,
        encryptedBlob,
        expiresAt: args.expiresAt ?? null,
        status: 'active',
        lastUsedAt: new Date(),
      })
      .where(eq(schema.sourceCredentials.id, existing[0].id));
    return { id: existing[0].id, created: false };
  }

  const id = randomUUID();
  await db.insert(schema.sourceCredentials).values({
    id,
    sourceId: args.sourceId,
    label: `${args.sourceId}-${id.slice(0, 6)}`,
    kind: args.kind,
    encryptedBlob,
    expiresAt: args.expiresAt ?? null,
    status: 'active',
  });
  return { id, created: true };
}

/**
 * Read the most-recent credential row for a sourceId + return a redacted
 * status shape suitable for the GET status endpoint. NEVER returns the
 * decrypted bag.
 */
export async function readCredentialStatus(sourceId: SourceId): Promise<
  | {
      configured: false;
    }
  | {
      configured: true;
      kind: string;
      status: string;
      expiresAt?: number;
      lastUsedAt?: number;
    }
> {
  const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
  const rows = await db
    .select({
      kind: schema.sourceCredentials.kind,
      status: schema.sourceCredentials.status,
      expiresAt: schema.sourceCredentials.expiresAt,
      lastUsedAt: schema.sourceCredentials.lastUsedAt,
    })
    .from(schema.sourceCredentials)
    .where(eq(schema.sourceCredentials.sourceId, sourceId))
    .limit(1);
  const row = rows[0];
  if (!row) return { configured: false };
  return {
    configured: true,
    kind: row.kind,
    status: row.status,
    ...(row.expiresAt ? { expiresAt: row.expiresAt.getTime() } : {}),
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt.getTime() } : {}),
  };
}

/** Remove every source_credentials row for `sourceId`. Returns rows-deleted. */
export async function deleteCredentials(sourceId: SourceId): Promise<number> {
  const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
  const before = await db
    .select({ id: schema.sourceCredentials.id })
    .from(schema.sourceCredentials)
    .where(eq(schema.sourceCredentials.sourceId, sourceId));
  if (before.length === 0) return 0;
  await db
    .delete(schema.sourceCredentials)
    .where(eq(schema.sourceCredentials.sourceId, sourceId));
  return before.length;
}

/**
 * Issue a new oauth_state row + return the random state value (and code
 * verifier where needed). Caller embeds `state` in the authorize redirect.
 *
 * Side-effect: opportunistic sweep of expired rows on ~1% of calls.
 * See schema.oauth.ts for the lifecycle commentary.
 */
export async function createOAuthState(args: {
  userId: string;
  sourceId: SourceId;
  pkce: boolean;
  redirectUri: string;
}): Promise<{ state: string; codeVerifier: string | null }> {
  // 32-byte hex.
  const state = randomBytesHex(32);
  const codeVerifier = args.pkce ? randomBytesHex(32) : null;
  const id = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000);

  const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
  await db.insert(schema.oauthState).values({
    id,
    userId: args.userId,
    sourceId: args.sourceId,
    state,
    codeVerifier,
    redirectUri: args.redirectUri,
    createdAt: now,
    expiresAt,
  });

  // Lazy purge: ~1% of /oauth/start calls reap any expired rows.
  if (Math.random() < 0.01) {
    try {
      await db
        .delete(schema.oauthState)
        .where(lt(schema.oauthState.expiresAt, now));
    } catch (err) {
      logger.warn({ err }, 'oauth-state: opportunistic purge failed (non-fatal)');
    }
  }

  return { state, codeVerifier };
}

/**
 * Atomically consume an oauth_state row.
 *
 * Issues `DELETE FROM oauth_state WHERE state=? RETURNING ...` — only the
 * first concurrent caller sees the row, defending against authorization-code
 * replay races where two callbacks share a state value.
 *
 * The returned state is then compared to the supplied `args.state` with
 * `crypto.timingSafeEqual` (via {@link timingSafeEqualStrings}). After the
 * scope/expiry checks return, the row is gone and cannot be reused.
 */
export async function consumeOAuthState(args: {
  userId: string;
  sourceId: SourceId;
  state: string;
}): Promise<{ id: string; codeVerifier: string | null; redirectUri: string | null } | null> {
  type Row = {
    id: string;
    userId: string;
    sourceId: string;
    state: string;
    codeVerifier: string | null;
    redirectUri: string | null;
    expiresAt: number; // raw ms — better-sqlite3 returns the underlying integer for RETURNING
  };

  // Drizzle does not surface SQLite's RETURNING for DELETE on the
  // better-sqlite3 driver yet; drop to the raw client. The driver is exposed
  // on `(db as any).$client` per Drizzle's better-sqlite3 layer.
  const db = getDb() as unknown as {
    $client: {
      prepare: (sql: string) => {
        get: (...params: unknown[]) => Row | undefined;
        all: (...params: unknown[]) => Row[];
        run: (...params: unknown[]) => { changes: number };
      };
    };
  };

  const stmt = db.$client.prepare(
    `DELETE FROM oauth_state WHERE state = ?
     RETURNING id, user_id AS userId, source_id AS sourceId, state,
               code_verifier AS codeVerifier, redirect_uri AS redirectUri,
               expires_at AS expiresAt`,
  );
  const row = stmt.get(args.state) as Row | undefined;
  if (!row) return null;

  // Timing-safe state comparison — defends against length/equality timing
  // leaks now that the row is in hand.
  if (!timingSafeEqualStrings(row.state, args.state)) {
    return null;
  }
  if (row.userId !== args.userId) return null;
  if (row.sourceId !== args.sourceId) return null;
  // expiresAt comes back as ms-since-epoch in the raw driver row.
  if (typeof row.expiresAt === 'number' && row.expiresAt < Date.now()) return null;

  return {
    id: row.id,
    codeVerifier: row.codeVerifier,
    redirectUri: row.redirectUri,
  };
}

/**
 * Read the latest decrypted credential bag for a sourceId — used by the
 * /refresh route to call the upstream token endpoint with the stored
 * refresh_token. Returns null if no row exists; throws if decrypt fails.
 */
export async function readDecryptedBag(sourceId: SourceId): Promise<{
  id: string;
  kind: string;
  bag: Record<string, unknown>;
} | null> {
  const secret = process.env.LOOTGOBLIN_SECRET;
  if (!secret) throw new Error('LOOTGOBLIN_SECRET not set');

  const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
  const rows = await db
    .select({
      id: schema.sourceCredentials.id,
      kind: schema.sourceCredentials.kind,
      encryptedBlob: schema.sourceCredentials.encryptedBlob,
    })
    .from(schema.sourceCredentials)
    .where(eq(schema.sourceCredentials.sourceId, sourceId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const buf = Buffer.from(row.encryptedBlob as Uint8Array);
  const json = decrypt(buf.toString('utf8'), secret);
  let bag: unknown;
  try {
    bag = JSON.parse(json);
  } catch (err) {
    logger.warn({ err, sourceId }, 'source-auth: failed to JSON.parse decrypted credential bag');
    throw err;
  }
  if (!bag || typeof bag !== 'object') {
    throw new Error('decrypted credential bag is not an object');
  }
  return { id: row.id, kind: row.kind, bag: bag as Record<string, unknown> };
}

/** Local helper — node:crypto.randomBytes(N).toString('hex'). */
function randomBytesHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Constant-time string comparison. `crypto.timingSafeEqual` requires equal
 * buffer lengths — return false on mismatch BEFORE the comparison so we
 * don't leak length, but the early exit is independent of byte content.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Compute a PKCE S256 code_challenge from a verifier.
 * SHA-256 → base64url (no padding).
 */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
