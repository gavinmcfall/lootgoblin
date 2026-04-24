/**
 * Integration tests — stash-roots API — V2-002-T12
 *
 * GET /api/v1/stash-roots         — list
 * POST /api/v1/stash-roots        — create (path must exist + be writable)
 * GET /api/v1/stash-roots/:id     — detail
 * PATCH /api/v1/stash-roots/:id   — rename
 * DELETE /api/v1/stash-roots/:id  — blocked when Collection references it
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { runMigrations, getDb, schema, resetDbCache } from '../../../src/db/client';

// ── Next.js shim ──────────────────────────────────────────────────────────────
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

// ── Auth mock ─────────────────────────────────────────────────────────────────
const mockAuthenticate = vi.fn();
vi.mock('../../../src/auth/request-auth', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
}));

function asActor(session: { user: { id: string; role: 'admin' | 'user' } } | null) {
  if (!session) return null;
  return { id: session.user.id, role: session.user.role, source: 'session' as const };
}
const mockGetSession = {
  mockResolvedValue: (v: unknown) => {
    mockAuthenticate.mockResolvedValue(asActor(v as { user: { id: string; role: 'admin' | 'user' } } | null));
  },
};

const DB_PATH = '/tmp/lootgoblin-api-t12.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB { return getDb(DB_URL) as DB; }
function uid(): string { return crypto.randomUUID(); }

function makeSession(userId: string, role: 'admin' | 'user' = 'user') {
  return {
    session: { id: uid(), userId, expiresAt: new Date(Date.now() + 86400_000), token: uid() },
    user: { id: userId, email: `${userId}@test.example`, name: 'Test User', emailVerified: true, role },
  };
}

function makeReq(method: string, url = 'http://local/api/v1/stash-roots', body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function seedUser(role: 'admin' | 'user' = 'user'): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id, name: 'SR Test User', email: `${id}@sr.test`, emailVerified: false, createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string, rootPath: string, name = 'Test Root'): Promise<string> {
  const id = uid();
  await db().insert(schema.stashRoots).values({
    id, ownerId, name, path: rootPath, createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { await fsp.unlink(`${DB_PATH}${suffix}`); } catch { /* ignore */ }
  }
  process.env.DATABASE_URL = DB_URL;
  resetDbCache();
  await runMigrations(DB_URL);
});

describe('GET /api/v1/stash-roots', () => {
  it('returns 401 with error:unauthenticated when no session and no API key', async () => {
    mockGetSession.mockResolvedValue(null);
    const { GET } = await import('../../../src/app/api/v1/stash-roots/route');
    const res = await GET(makeReq('GET'));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'unauthenticated' });
  });

  it('returns 200 with items array for authenticated user', async () => {
    const userId = await seedUser();
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-sr-'));
    await seedStashRoot(userId, tmpDir);
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/stash-roots/route');
    const res = await GET(makeReq('GET'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.items)).toBe(true);
    expect(json.items.some((r: { path: string }) => r.path === tmpDir)).toBe(true);
  });
});

describe('POST /api/v1/stash-roots', () => {
  it('returns 201 with new root when path exists + writable', async () => {
    const userId = await seedUser();
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-sr-post-'));
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { POST } = await import('../../../src/app/api/v1/stash-roots/route');
    const res = await POST(makeReq('POST', 'http://local/api/v1/stash-roots', { name: 'My Library', path: tmpDir }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBeDefined();
    expect(json.path).toBe(tmpDir);
    expect(json.ownerId).toBe(userId);
  });

  it('returns 422 when path does not exist', async () => {
    const userId = await seedUser();
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { POST } = await import('../../../src/app/api/v1/stash-roots/route');
    const res = await POST(makeReq('POST', 'http://local/api/v1/stash-roots', { name: 'Bad', path: '/nonexistent/path/abc123' }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe('path-not-accessible');
  });

  it('returns 400 on invalid body', async () => {
    const userId = await seedUser();
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { POST } = await import('../../../src/app/api/v1/stash-roots/route');
    const res = await POST(makeReq('POST', 'http://local/api/v1/stash-roots', { name: '' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid-body');
  });
});

describe('GET /api/v1/stash-roots/:id', () => {
  it('returns 404 for unknown id', async () => {
    const userId = await seedUser();
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/stash-roots/[id]/route');
    const res = await GET(makeReq('GET'), { params: Promise.resolve({ id: uid() }) });
    expect(res.status).toBe(404);
  });

  it('returns 200 with root details', async () => {
    const userId = await seedUser();
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-sr-get-'));
    const rootId = await seedStashRoot(userId, tmpDir, 'Detail Root');
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/stash-roots/[id]/route');
    const res = await GET(makeReq('GET'), { params: Promise.resolve({ id: rootId }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(rootId);
    expect(json.name).toBe('Detail Root');
    expect(typeof json.createdAt).toBe('string');
  });
});

describe('PATCH /api/v1/stash-roots/:id', () => {
  it('renames the root', async () => {
    const userId = await seedUser();
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-sr-patch-'));
    const rootId = await seedStashRoot(userId, tmpDir, 'Old Name');
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { PATCH } = await import('../../../src/app/api/v1/stash-roots/[id]/route');
    const res = await PATCH(
      makeReq('PATCH', `http://local/api/v1/stash-roots/${rootId}`, { name: 'New Name' }),
      { params: Promise.resolve({ id: rootId }) },
    );
    expect(res.status).toBe(200);

    // Verify DB updated.
    const rows = await db().select({ name: schema.stashRoots.name }).from(schema.stashRoots).where(
      (await import('drizzle-orm')).eq(schema.stashRoots.id, rootId),
    );
    expect(rows[0].name).toBe('New Name');
  });

  it('returns 403 when non-owner tries to rename', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-sr-acl-'));
    const rootId = await seedStashRoot(ownerId, tmpDir);
    mockGetSession.mockResolvedValue(makeSession(otherId)); // different user

    const { PATCH } = await import('../../../src/app/api/v1/stash-roots/[id]/route');
    const res = await PATCH(
      makeReq('PATCH', `http://local/api/v1/stash-roots/${rootId}`, { name: 'Hijack' }),
      { params: Promise.resolve({ id: rootId }) },
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'forbidden', reason: expect.any(String) });
  });
});

describe('DELETE /api/v1/stash-roots/:id', () => {
  it('deletes an empty root (no collections)', async () => {
    const userId = await seedUser();
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-sr-del-'));
    const rootId = await seedStashRoot(userId, tmpDir);
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { DELETE } = await import('../../../src/app/api/v1/stash-roots/[id]/route');
    const res = await DELETE(makeReq('DELETE'), { params: Promise.resolve({ id: rootId }) });
    expect(res.status).toBe(200);
  });

  it('returns 409 when a Collection references the root', async () => {
    const userId = await seedUser();
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-sr-restrict-'));
    const rootId = await seedStashRoot(userId, tmpDir);
    // Insert a collection referencing this root.
    const colId = uid();
    await db().insert(schema.collections).values({
      id: colId,
      ownerId: userId,
      name: `Collection-${uid().slice(0, 8)}`,
      pathTemplate: '{creator}/{title}',
      stashRootId: rootId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { DELETE } = await import('../../../src/app/api/v1/stash-roots/[id]/route');
    const res = await DELETE(makeReq('DELETE'), { params: Promise.resolve({ id: rootId }) });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('constraint-violation');
  });
});
