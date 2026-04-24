/**
 * Integration tests — collections API — V2-002-T12
 *
 * GET /api/v1/collections         — list with pagination
 * POST /api/v1/collections        — create
 * GET /api/v1/collections/:id     — detail
 * PATCH /api/v1/collections/:id   — rename + pathTemplate change
 * DELETE /api/v1/collections/:id  — empty ok; non-empty without cascade → 409;
 *                                   cascade=true → ok; ACL denial
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { runMigrations, getDb, schema, resetDbCache } from '../../../src/db/client';

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
vi.mock('../../../src/auth/request-auth', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
}));

// Helper — the old "session shape" used in existing tests.  Translate to the
// new AuthenticatedActor shape returned by authenticateRequest.
function asActor(session: { user: { id: string; role: 'admin' | 'user' } } | null) {
  if (!session) return null;
  return { id: session.user.id, role: session.user.role, source: 'session' as const };
}
const mockGetSession = {
  mockResolvedValue: (v: unknown) => {
    mockAuthenticate.mockResolvedValue(asActor(v as { user: { id: string; role: 'admin' | 'user' } } | null));
  },
};

const DB_PATH = '/tmp/lootgoblin-api-t12-collections.db';
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

function makeReq(method: string, url = 'http://local/api/v1/collections', body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id, name: 'Col Test User', email: `${id}@col.test`, emailVerified: false, createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string): Promise<{ rootId: string; rootPath: string }> {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-col-'));
  const rootId = uid();
  await db().insert(schema.stashRoots).values({
    id: rootId, ownerId, name: 'Test Root', path: rootPath, createdAt: new Date(), updatedAt: new Date(),
  });
  return { rootId, rootPath };
}

async function seedCollection(ownerId: string, stashRootId: string, name?: string): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id, ownerId, name: name ?? `Col-${uid().slice(0, 8)}`,
    pathTemplate: '{creator}/{title}', stashRootId,
    createdAt: new Date(), updatedAt: new Date(),
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

describe('GET /api/v1/collections', () => {
  it('returns 401 with error:unauthenticated when no session and no API key', async () => {
    mockGetSession.mockResolvedValue(null);
    const { GET } = await import('../../../src/app/api/v1/collections/route');
    const res = await GET(makeReq('GET'));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'unauthenticated' });
  });

  it('authenticates via x-api-key header when session is absent', async () => {
    // Simulate an API-key-authenticated actor (authenticateRequest already
    // unifies session + api-key internally; we just assert the shared helper
    // treats an api-key actor the same as a session actor).
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    await seedCollection(userId, rootId);
    mockAuthenticate.mockResolvedValueOnce({ id: `api-key:${uid()}`, role: 'user', source: 'api-key' });

    const req = new Request('http://local/api/v1/collections', {
      method: 'GET',
      headers: { 'x-api-key': 'lg_api_fake-test-key' },
    });
    const { GET } = await import('../../../src/app/api/v1/collections/route');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.items)).toBe(true);
  });

  it('returns list with total + pagination fields', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    await seedCollection(userId, rootId);
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/collections/route');
    const res = await GET(makeReq('GET', 'http://local/api/v1/collections?limit=10&offset=0'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.items)).toBe(true);
    expect(typeof json.total).toBe('number');
    expect(json.limit).toBe(10);
    expect(json.offset).toBe(0);
  });
});

describe('POST /api/v1/collections', () => {
  it('creates a collection and returns 201', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { POST } = await import('../../../src/app/api/v1/collections/route');
    const res = await POST(makeReq('POST', 'http://local/api/v1/collections', {
      name: `MyCol-${uid().slice(0, 8)}`,
      pathTemplate: '{creator}/{title}',
      stashRootId: rootId,
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBeDefined();
    expect(json.ownerId).toBe(userId);
    expect(typeof json.createdAt).toBe('string');
  });

  it('returns 422 for unknown stashRootId', async () => {
    const userId = await seedUser();
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { POST } = await import('../../../src/app/api/v1/collections/route');
    const res = await POST(makeReq('POST', 'http://local/api/v1/collections', {
      name: 'X',
      pathTemplate: '{title}',
      stashRootId: uid(), // non-existent
    }));
    expect(res.status).toBe(422);
  });

  it('returns 400 for invalid body (empty name)', async () => {
    const userId = await seedUser();
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { POST } = await import('../../../src/app/api/v1/collections/route');
    const res = await POST(makeReq('POST', 'http://local/api/v1/collections', {
      name: '', pathTemplate: '{title}', stashRootId: uid(),
    }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/collections/:id', () => {
  it('returns 404 for unknown id', async () => {
    const userId = await seedUser();
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/collections/[id]/route');
    const res = await GET(makeReq('GET'), { params: Promise.resolve({ id: uid() }) });
    expect(res.status).toBe(404);
  });

  it('returns 200 with collection detail', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId, `DetailCol-${uid().slice(0, 8)}`);
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/collections/[id]/route');
    const res = await GET(makeReq('GET'), { params: Promise.resolve({ id: colId }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(colId);
    expect(typeof json.createdAt).toBe('string');
    expect(typeof json.updatedAt).toBe('string');
  });
});

describe('PATCH /api/v1/collections/:id', () => {
  it('renames a collection', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId, `PatchCol-${uid().slice(0, 8)}`);
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { PATCH } = await import('../../../src/app/api/v1/collections/[id]/route');
    const newName = `Renamed-${uid().slice(0, 8)}`;
    const res = await PATCH(
      makeReq('PATCH', `http://local/api/v1/collections/${colId}`, { name: newName }),
      { params: Promise.resolve({ id: colId }) },
    );
    expect(res.status).toBe(200);

    const rows = await db().select({ name: schema.collections.name }).from(schema.collections).where(
      (await import('drizzle-orm')).eq(schema.collections.id, colId),
    );
    expect(rows[0].name).toBe(newName);
  });

  it('changes pathTemplate (DB only, no file moves)', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId, `TplCol-${uid().slice(0, 8)}`);
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { PATCH } = await import('../../../src/app/api/v1/collections/[id]/route');
    const res = await PATCH(
      makeReq('PATCH', `http://local/api/v1/collections/${colId}`, { pathTemplate: '{creator|slug}/{title|slug}' }),
      { params: Promise.resolve({ id: colId }) },
    );
    expect(res.status).toBe(200);

    const rows = await db().select({ pathTemplate: schema.collections.pathTemplate }).from(schema.collections).where(
      (await import('drizzle-orm')).eq(schema.collections.id, colId),
    );
    expect(rows[0].pathTemplate).toBe('{creator|slug}/{title|slug}');
  });

  it('returns 403 when other user tries to patch', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const { rootId } = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);
    mockGetSession.mockResolvedValue(makeSession(otherId));

    const { PATCH } = await import('../../../src/app/api/v1/collections/[id]/route');
    const res = await PATCH(
      makeReq('PATCH', `http://local/api/v1/collections/${colId}`, { name: 'Hijack' }),
      { params: Promise.resolve({ id: colId }) },
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'forbidden', reason: expect.any(String) });
  });
});

describe('DELETE /api/v1/collections/:id', () => {
  it('deletes an empty collection', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { DELETE } = await import('../../../src/app/api/v1/collections/[id]/route');
    const res = await DELETE(makeReq('DELETE'), { params: Promise.resolve({ id: colId }) });
    expect(res.status).toBe(200);
  });

  it('returns 409 when collection has loot (no cascade)', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    // Insert loot into collection.
    await db().insert(schema.loot).values({
      id: uid(), collectionId: colId, title: 'Some Loot', description: null,
      tags: [], creator: null, license: null, sourceItemId: null,
      contentSummary: null, fileMissing: false, createdAt: new Date(), updatedAt: new Date(),
    });
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { DELETE } = await import('../../../src/app/api/v1/collections/[id]/route');
    const res = await DELETE(makeReq('DELETE'), { params: Promise.resolve({ id: colId }) });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('collection-not-empty');
  });

  it('cascade=true deletes non-empty collection', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    await db().insert(schema.loot).values({
      id: uid(), collectionId: colId, title: 'Cascade Loot', description: null,
      tags: [], creator: null, license: null, sourceItemId: null,
      contentSummary: null, fileMissing: false, createdAt: new Date(), updatedAt: new Date(),
    });
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { DELETE } = await import('../../../src/app/api/v1/collections/[id]/route');
    const res = await DELETE(
      makeReq('DELETE', `http://local/api/v1/collections/${colId}?cascade=true`),
      { params: Promise.resolve({ id: colId }) },
    );
    expect(res.status).toBe(200);
  });

  it('returns 403 when other user tries to delete', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const { rootId } = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);
    mockGetSession.mockResolvedValue(makeSession(otherId));

    const { DELETE } = await import('../../../src/app/api/v1/collections/[id]/route');
    const res = await DELETE(makeReq('DELETE'), { params: Promise.resolve({ id: colId }) });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'forbidden', reason: expect.any(String) });
  });
});
