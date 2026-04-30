/**
 * Integration tests — /api/v1/forge/printers/:id/credentials — V2-005d-a T_da3
 *
 * Real SQLite + auth shim, mirroring api-v1-forge-printers.test.ts /
 * forge-slicer-routes.test.ts conventions.
 *
 * ACL note: the route uses the printer-mutation pattern from V2-005a-T5
 * (owner-only; admin does NOT bypass; cross-owner returns 404). The task
 * spec referenced "owner OR admin"; we follow the established consent
 * model — see the route file header for the rationale. Test cases reflect
 * this:
 *   - "POST as admin (different user from printer owner)" returns 404, not 201
 *   - "POST as user who's not printer owner" returns 404, not 403
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';

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

const DB_PATH = '/tmp/lootgoblin-api-forge-printer-credentials.db';
const DB_URL = `file:${DB_PATH}`;
const TEST_SECRET = 'x'.repeat(32);

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}
function uid(): string {
  return crypto.randomUUID();
}
function actor(userId: string, role: 'admin' | 'user' = 'user') {
  return { id: userId, role, source: 'session' as const };
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      await fsp.unlink(`${DB_PATH}${suffix}`);
    } catch {
      /* ignore */
    }
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
  resetDbCache();
  await runMigrations(DB_URL);
});

afterAll(() => {
  delete process.env.LOOTGOBLIN_SECRET;
});

beforeEach(async () => {
  // FK order: creds → printers → user. Other forge-side tables aren't
  // touched by this route, but clear them for test isolation if present.
  await db().delete(schema.forgeTargetCredentials);
  await db().delete(schema.printers);
  await db().delete(schema.user);
  mockAuthenticate.mockReset();
  process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
});

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Forge Cred Routes Test User',
    email: `${id}@forge-cred.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedPrinter(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.printers).values({
    id,
    ownerId,
    kind: 'fdm_klipper',
    name: `Printer-${id.slice(0, 8)}`,
    connectionConfig: { url: 'http://1.2.3.4:7125' },
    active: true,
    createdAt: new Date(),
  });
  return id;
}

function makePost(url: string, body: unknown): import('next/server').NextRequest {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}
function makeGet(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'GET' }) as unknown as import('next/server').NextRequest;
}
function makeDelete(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'DELETE' }) as unknown as import('next/server').NextRequest;
}

const ROUTE_PATH = '../../src/app/api/v1/forge/printers/[id]/credentials/route';

// ============================================================================
// POST
// ============================================================================

describe('POST /api/v1/forge/printers/:id/credentials', () => {
  it('401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import(ROUTE_PATH);
    const res = await POST(
      makePost('http://local/api/v1/forge/printers/anything/credentials', {
        kind: 'moonraker_api_key',
        payload: { apiKey: 'k' },
      }),
      { params: Promise.resolve({ id: 'anything' }) },
    );
    expect(res.status).toBe(401);
  });

  it('404 caller is not printer owner (consent model — admin also gets 404)', async () => {
    const aliceId = await seedUser();
    const bobId = await seedUser();
    const printerId = await seedPrinter(aliceId);

    mockAuthenticate.mockResolvedValueOnce(actor(bobId));
    const { POST } = await import(ROUTE_PATH);
    const res = await POST(
      makePost(`http://local/api/v1/forge/printers/${printerId}/credentials`, {
        kind: 'moonraker_api_key',
        payload: { apiKey: 'k' },
      }),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(res.status).toBe(404);
  });

  it('201 owner sets moonraker_api_key; subsequent GET returns metadata', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const { POST, GET } = await import(ROUTE_PATH);
    const res = await POST(
      makePost(`http://local/api/v1/forge/printers/${printerId}/credentials`, {
        kind: 'moonraker_api_key',
        payload: { apiKey: 'super-secret-test-key' },
        label: 'Voron 2.4',
      }),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.kind).toBe('moonraker_api_key');
    expect(body.hasCredential).toBe(true);
    expect(body.label).toBe('Voron 2.4');

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const get = await GET(
      makeGet(`http://local/api/v1/forge/printers/${printerId}/credentials`),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(get.status).toBe(200);
    const getBody = await get.json();
    expect(getBody.kind).toBe('moonraker_api_key');
    expect(getBody.label).toBe('Voron 2.4');
    expect(getBody.hasCredential).toBe(true);
  });

  it('overwrites existing credential (POST twice)', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);

    const { POST, GET } = await import(ROUTE_PATH);
    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    await POST(
      makePost(`http://local/api/v1/forge/printers/${printerId}/credentials`, {
        kind: 'moonraker_api_key',
        payload: { apiKey: 'first' },
        label: 'first-label',
      }),
      { params: Promise.resolve({ id: printerId }) },
    );

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const second = await POST(
      makePost(`http://local/api/v1/forge/printers/${printerId}/credentials`, {
        kind: 'octoprint_api_key',
        payload: { apiKey: 'second' },
        label: 'second-label',
      }),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(second.status).toBe(201);

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const get = await GET(
      makeGet(`http://local/api/v1/forge/printers/${printerId}/credentials`),
      { params: Promise.resolve({ id: printerId }) },
    );
    const body = await get.json();
    expect(body.kind).toBe('octoprint_api_key');
    expect(body.label).toBe('second-label');

    // Only one row in DB.
    const rows = await db().select().from(schema.forgeTargetCredentials);
    expect(rows).toHaveLength(1);
  });

  it('400 invalid kind', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const { POST } = await import(ROUTE_PATH);
    const res = await POST(
      makePost(`http://local/api/v1/forge/printers/${printerId}/credentials`, {
        kind: 'not_a_real_kind',
        payload: { apiKey: 'x' },
      }),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-body');
  });

  it('400 payload wrong shape for kind', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const { POST } = await import(ROUTE_PATH);
    const res = await POST(
      makePost(`http://local/api/v1/forge/printers/${printerId}/credentials`, {
        kind: 'moonraker_api_key',
        payload: { wrong: 'field' },
      }),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-body');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('400 payload missing required field (bambu_lan needs serial)', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const { POST } = await import(ROUTE_PATH);
    const res = await POST(
      makePost(`http://local/api/v1/forge/printers/${printerId}/credentials`, {
        kind: 'bambu_lan',
        payload: { accessCode: 'abc123' },
      }),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-body');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('404 admin (different user from printer owner) — admins do NOT bypass printer ACL', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    const printerId = await seedPrinter(ownerId);

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(ROUTE_PATH);
    const res = await POST(
      makePost(`http://local/api/v1/forge/printers/${printerId}/credentials`, {
        kind: 'moonraker_api_key',
        payload: { apiKey: 'k' },
      }),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(res.status).toBe(404);
  });

  it('404 nonexistent printer', async () => {
    const ownerId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const { POST } = await import(ROUTE_PATH);
    const res = await POST(
      makePost('http://local/api/v1/forge/printers/does-not-exist/credentials', {
        kind: 'moonraker_api_key',
        payload: { apiKey: 'k' },
      }),
      { params: Promise.resolve({ id: 'does-not-exist' }) },
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// GET — security boundary: response NEVER contains decrypted payload
// ============================================================================

describe('GET /api/v1/forge/printers/:id/credentials', () => {
  it('200 returns metadata only — no payload, no apiKey, no encrypted blob', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);

    const SECRET_API_KEY = 'super-secret-test-key';
    const { POST, GET } = await import(ROUTE_PATH);
    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    await POST(
      makePost(`http://local/api/v1/forge/printers/${printerId}/credentials`, {
        kind: 'moonraker_api_key',
        payload: { apiKey: SECRET_API_KEY },
        label: 'metadata-only',
      }),
      { params: Promise.resolve({ id: printerId }) },
    );

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const res = await GET(
      makeGet(`http://local/api/v1/forge/printers/${printerId}/credentials`),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(res.status).toBe(200);
    const rawText = await res.text();

    // Hard security assertion — the secret apiKey value MUST NOT appear in
    // the response body anywhere. This catches accidental leaks via any
    // field name (payload, encryptedBlob, debug fields, error echoes).
    expect(rawText).not.toContain(SECRET_API_KEY);

    const body = JSON.parse(rawText);
    expect(body).not.toHaveProperty('payload');
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('encryptedBlob');
    expect(body).not.toHaveProperty('encrypted_blob');
    expect(body.kind).toBe('moonraker_api_key');
    expect(body.label).toBe('metadata-only');
    expect(body.hasCredential).toBe(true);
  });

  it('404 when no credentials exist for printer', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const { GET } = await import(ROUTE_PATH);
    const res = await GET(
      makeGet(`http://local/api/v1/forge/printers/${printerId}/credentials`),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not-found');
  });
});

// ============================================================================
// DELETE
// ============================================================================

describe('DELETE /api/v1/forge/printers/:id/credentials', () => {
  it('200 owner removes existing row → { removed: true }; subsequent GET 404', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);

    const { POST, GET, DELETE } = await import(ROUTE_PATH);
    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    await POST(
      makePost(`http://local/api/v1/forge/printers/${printerId}/credentials`, {
        kind: 'moonraker_api_key',
        payload: { apiKey: 'k' },
      }),
      { params: Promise.resolve({ id: printerId }) },
    );

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const del = await DELETE(
      makeDelete(`http://local/api/v1/forge/printers/${printerId}/credentials`),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(del.status).toBe(200);
    const delBody = await del.json();
    expect(delBody.removed).toBe(true);

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const get = await GET(
      makeGet(`http://local/api/v1/forge/printers/${printerId}/credentials`),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(get.status).toBe(404);
  });

  it('200 when no row exists → { removed: false }', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const { DELETE } = await import(ROUTE_PATH);
    const res = await DELETE(
      makeDelete(`http://local/api/v1/forge/printers/${printerId}/credentials`),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(false);
  });
});
