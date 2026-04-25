/**
 * Integration tests — /api/v1/source-auth/:sourceId/* — V2-003-T9
 *
 * Real SQLite. Auth is mocked via the same `request-auth` shim used by other
 * v2 route tests. Upstream OAuth token endpoints are mocked via msw at the
 * `globalThis.fetch` level for the callback + refresh routes.
 *
 * Cases:
 *   - 401 unauthenticated on every endpoint
 *   - 404 unknown sourceId
 *   - GET status — empty + populated shape, no secrets in response
 *   - POST oauth/start — returns authorizationUrl + state, persists row
 *   - POST oauth/callback — invalid state → 400; valid state → exchanges code,
 *     persists encrypted credentials, deletes state row
 *   - POST api-key — empty → 400; valid → 200 + row created
 *   - POST refresh — calls token endpoint, updates row
 *   - DELETE — removes row(s)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import { eq } from 'drizzle-orm';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

const mockAuthenticate = vi.fn();
vi.mock('../../src/auth/request-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/request-auth')>();
  return {
    ...actual,
    authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  };
});

const DB_PATH = '/tmp/lootgoblin-api-source-auth.db';
const DB_URL = `file:${DB_PATH}`;
const SECRET = 'source-auth-test-secret-32-chars-min';

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB { return getDb(DB_URL) as DB; }
function uid(): string { return crypto.randomUUID(); }

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { await fsp.unlink(`${DB_PATH}${suffix}`); } catch { /* ignore */ }
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.LOOTGOBLIN_SECRET = SECRET;
  resetDbCache();
  await runMigrations(DB_URL);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Source Auth Test User',
    email: `${id}@srcauth.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function actor(userId: string, role: 'admin' | 'user' = 'user') {
  return { id: userId, role, source: 'session' as const };
}

function reqJson(method: string, path: string, body?: unknown): Request {
  return new Request(`http://local${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// GET status / DELETE revoke
// ---------------------------------------------------------------------------

describe('GET /api/v1/source-auth/:sourceId', () => {
  it('returns 401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/source-auth/[sourceId]/route');
    const res = await GET(
      reqJson('GET', '/api/v1/source-auth/sketchfab') as never,
      { params: Promise.resolve({ sourceId: 'sketchfab' }) },
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown sourceId', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/source-auth/[sourceId]/route');
    const res = await GET(
      reqJson('GET', '/api/v1/source-auth/unknown') as never,
      { params: Promise.resolve({ sourceId: 'unknown' }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns configured:false when no credential row exists', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/source-auth/[sourceId]/route');
    // Use cults3d so the source has no prior credential from earlier tests.
    const res = await GET(
      reqJson('GET', '/api/v1/source-auth/cults3d') as never,
      { params: Promise.resolve({ sourceId: 'cults3d' }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ sourceId: 'cults3d', configured: false });
  });
});

// ---------------------------------------------------------------------------
// POST api-key
// ---------------------------------------------------------------------------

describe('POST /api/v1/source-auth/:sourceId/api-key', () => {
  it('returns 401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import('../../src/app/api/v1/source-auth/[sourceId]/api-key/route');
    const res = await POST(
      reqJson('POST', '/api/v1/source-auth/cults3d/api-key', { apiKey: 'x' }) as never,
      { params: Promise.resolve({ sourceId: 'cults3d' }) },
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when apiKey is empty', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/source-auth/[sourceId]/api-key/route');
    const res = await POST(
      reqJson('POST', '/api/v1/source-auth/cults3d/api-key', { apiKey: '' }) as never,
      { params: Promise.resolve({ sourceId: 'cults3d' }) },
    );
    expect(res.status).toBe(400);
  });

  it('persists an encrypted credential bag for a valid apiKey', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/source-auth/[sourceId]/api-key/route');

    const res = await POST(
      reqJson('POST', '/api/v1/source-auth/cults3d/api-key', { apiKey: 'real-key-value' }) as never,
      { params: Promise.resolve({ sourceId: 'cults3d' }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, sourceId: 'cults3d' });
    expect(typeof json.credentialId).toBe('string');

    const rows = await db()
      .select({ id: schema.sourceCredentials.id, kind: schema.sourceCredentials.kind })
      .from(schema.sourceCredentials)
      .where(eq(schema.sourceCredentials.sourceId, 'cults3d'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.find((r) => r.id === json.credentialId)?.kind).toBe('api-key');
  });
});

// ---------------------------------------------------------------------------
// OAuth start
// ---------------------------------------------------------------------------

describe('POST /api/v1/source-auth/:sourceId/oauth/start', () => {
  it('returns 422 for sources with no OAuth provider config', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/source-auth/[sourceId]/oauth/start/route');
    const res = await POST(
      reqJson('POST', '/api/v1/source-auth/cults3d/oauth/start', {
        redirectUri: 'http://local/cb',
        clientId: 'cid',
      }) as never,
      { params: Promise.resolve({ sourceId: 'cults3d' }) },
    );
    expect(res.status).toBe(422);
  });

  it('returns authorizationUrl + state and persists oauth_state row (sketchfab)', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/source-auth/[sourceId]/oauth/start/route');
    const res = await POST(
      reqJson('POST', '/api/v1/source-auth/sketchfab/oauth/start', {
        redirectUri: 'http://local/cb',
        clientId: 'sketch-client',
      }) as never,
      { params: Promise.resolve({ sourceId: 'sketchfab' }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.state).toBe('string');
    expect(json.state.length).toBeGreaterThan(0);
    expect(typeof json.authorizationUrl).toBe('string');
    expect(json.authorizationUrl).toContain('sketchfab.com/oauth2/authorize');
    expect(json.authorizationUrl).toContain(`state=${json.state}`);
    // Sketchfab is not PKCE.
    expect(json.authorizationUrl).not.toContain('code_challenge');

    const rows = await db()
      .select({ id: schema.oauthState.id })
      .from(schema.oauthState)
      .where(eq(schema.oauthState.state, json.state));
    expect(rows.length).toBe(1);
  });

  it('emits PKCE params for google-drive', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/source-auth/[sourceId]/oauth/start/route');
    const res = await POST(
      reqJson('POST', '/api/v1/source-auth/google-drive/oauth/start', {
        redirectUri: 'http://local/cb',
        clientId: 'gdrive-client',
      }) as never,
      { params: Promise.resolve({ sourceId: 'google-drive' }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authorizationUrl).toContain('code_challenge=');
    expect(json.authorizationUrl).toContain('code_challenge_method=S256');
    expect(json.authorizationUrl).toContain('access_type=offline');
  });
});

// ---------------------------------------------------------------------------
// OAuth callback
// ---------------------------------------------------------------------------

describe('POST /api/v1/source-auth/:sourceId/oauth/callback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 400 for unknown state', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/source-auth/[sourceId]/oauth/callback/route');
    const res = await POST(
      reqJson('POST', '/api/v1/source-auth/sketchfab/oauth/callback', {
        code: 'auth-code',
        state: 'unknown-state-value',
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: 'http://local/cb',
      }) as never,
      { params: Promise.resolve({ sourceId: 'sketchfab' }) },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'invalid-state' });
  });

  it('exchanges code for tokens and persists encrypted credentials (sketchfab)', async () => {
    const userId = await seedUser();

    // 1. POST oauth/start to get a real state row.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: startPOST } = await import('../../src/app/api/v1/source-auth/[sourceId]/oauth/start/route');
    const startRes = await startPOST(
      reqJson('POST', '/api/v1/source-auth/sketchfab/oauth/start', {
        redirectUri: 'http://local/cb',
        clientId: 'sketch-client',
      }) as never,
      { params: Promise.resolve({ sourceId: 'sketchfab' }) },
    );
    const startJson = await startRes.json();
    const state = startJson.state as string;

    // 2. Mock the token endpoint at globalThis.fetch level.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'read upload',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    // 3. POST oauth/callback with the real state.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/source-auth/[sourceId]/oauth/callback/route');
    const cbRes = await POST(
      reqJson('POST', '/api/v1/source-auth/sketchfab/oauth/callback', {
        code: 'auth-code',
        state,
        clientId: 'sketch-client',
        clientSecret: 'sketch-secret',
        redirectUri: 'http://local/cb',
      }) as never,
      { params: Promise.resolve({ sourceId: 'sketchfab' }) },
    );
    expect(cbRes.status).toBe(200);
    const cbJson = await cbRes.json();
    expect(cbJson).toMatchObject({ ok: true, sourceId: 'sketchfab' });
    expect(typeof cbJson.credentialId).toBe('string');
    expect(typeof cbJson.expiresAt).toBe('number');

    // Token endpoint was called.
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://sketchfab.com/oauth2/token/',
      expect.objectContaining({ method: 'POST' }),
    );

    // Credential row exists with kind='oauth-token' for sketchfab.
    const rows = await db()
      .select({
        id: schema.sourceCredentials.id,
        kind: schema.sourceCredentials.kind,
      })
      .from(schema.sourceCredentials)
      .where(eq(schema.sourceCredentials.sourceId, 'sketchfab'));
    expect(rows.find((r) => r.id === cbJson.credentialId)?.kind).toBe('oauth-token');

    // State row was deleted after exchange.
    const stateRows = await db()
      .select({ id: schema.oauthState.id })
      .from(schema.oauthState)
      .where(eq(schema.oauthState.state, state));
    expect(stateRows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

describe('POST /api/v1/source-auth/:sourceId/refresh', () => {
  it('returns 404 when no credential row exists', async () => {
    // Clear any prior credential rows from earlier tests in the file.
    await db().delete(schema.sourceCredentials).where(eq(schema.sourceCredentials.sourceId, 'google-drive'));
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/source-auth/[sourceId]/refresh/route');
    const res = await POST(
      reqJson('POST', '/api/v1/source-auth/google-drive/refresh') as never,
      { params: Promise.resolve({ sourceId: 'google-drive' }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns 422 when credential is api-key (not oauth)', async () => {
    // Seed an api-key credential for google-drive.
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: setKeyPOST } = await import('../../src/app/api/v1/source-auth/[sourceId]/api-key/route');
    await setKeyPOST(
      reqJson('POST', '/api/v1/source-auth/google-drive/api-key', { apiKey: 'gd-key' }) as never,
      { params: Promise.resolve({ sourceId: 'google-drive' }) },
    );

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/source-auth/[sourceId]/refresh/route');
    const res = await POST(
      reqJson('POST', '/api/v1/source-auth/google-drive/refresh') as never,
      { params: Promise.resolve({ sourceId: 'google-drive' }) },
    );
    expect(res.status).toBe(422);
  });

  it('refreshes oauth credentials by hitting the token endpoint', async () => {
    // Seed an oauth credential for sketchfab via the callback flow.
    const userId = await seedUser();

    // Use shared helper to insert an oauth credential bag directly.
    const { upsertSourceCredential } = await import('../../src/app/api/v1/source-auth/[sourceId]/_shared');
    await upsertSourceCredential({
      sourceId: 'sketchfab',
      kind: 'oauth-token',
      bag: {
        kind: 'oauth',
        accessToken: 'old-access',
        refreshToken: 'r1',
        clientId: 'cid',
        clientSecret: 'csec',
        expiresAt: Date.now() + 60_000,
      },
      expiresAt: new Date(Date.now() + 60_000),
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'rotated-access',
          refresh_token: 'r2',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/source-auth/[sourceId]/refresh/route');
    const res = await POST(
      reqJson('POST', '/api/v1/source-auth/sketchfab/refresh') as never,
      { params: Promise.resolve({ sourceId: 'sketchfab' }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, sourceId: 'sketchfab' });
    expect(typeof json.expiresAt).toBe('number');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://sketchfab.com/oauth2/token/',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns 401 auth-revoked when upstream rejects refresh_token', async () => {
    const userId = await seedUser();

    const { upsertSourceCredential } = await import('../../src/app/api/v1/source-auth/[sourceId]/_shared');
    await upsertSourceCredential({
      sourceId: 'sketchfab',
      kind: 'oauth-token',
      bag: {
        kind: 'oauth',
        accessToken: 'old',
        refreshToken: 'bad-refresh',
        clientId: 'cid',
        clientSecret: 'csec',
        expiresAt: Date.now() + 60_000,
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/source-auth/[sourceId]/refresh/route');
    const res = await POST(
      reqJson('POST', '/api/v1/source-auth/sketchfab/refresh') as never,
      { params: Promise.resolve({ sourceId: 'sketchfab' }) },
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'auth-revoked' });
  });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/source-auth/:sourceId', () => {
  it('removes credential rows for the sourceId', async () => {
    const userId = await seedUser();

    // Seed an api-key credential for printables.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: setKeyPOST } = await import('../../src/app/api/v1/source-auth/[sourceId]/api-key/route');
    await setKeyPOST(
      reqJson('POST', '/api/v1/source-auth/printables/api-key', { apiKey: 'pkey' }) as never,
      { params: Promise.resolve({ sourceId: 'printables' }) },
    );

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { DELETE } = await import('../../src/app/api/v1/source-auth/[sourceId]/route');
    const res = await DELETE(
      reqJson('DELETE', '/api/v1/source-auth/printables') as never,
      { params: Promise.resolve({ sourceId: 'printables' }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(typeof json.removed).toBe('number');

    const rows = await db()
      .select({ id: schema.sourceCredentials.id })
      .from(schema.sourceCredentials)
      .where(eq(schema.sourceCredentials.sourceId, 'printables'));
    expect(rows.length).toBe(0);
  });
});
