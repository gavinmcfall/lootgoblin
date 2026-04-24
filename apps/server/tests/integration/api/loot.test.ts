/**
 * Integration tests — loot API — V2-002-T12
 *
 * GET /api/v1/loot                 — list with ?collectionId filter + pagination
 * POST /api/v1/loot                — create
 * GET /api/v1/loot/:id             — detail with files inline
 * PATCH /api/v1/loot/:id           — update metadata
 * DELETE /api/v1/loot/:id          — cascades lootFiles; ACL denial
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

const mockGetSession = vi.fn();
vi.mock('../../../src/auth/helpers', () => ({
  getSessionOrNull: (...args: unknown[]) => mockGetSession(...args),
  isValidApiKey: vi.fn().mockResolvedValue(false),
  isValidApiKeyWithScope: vi.fn().mockResolvedValue({ valid: false, reason: 'missing' }),
}));

const DB_PATH = '/tmp/lootgoblin-api-t12-loot.db';
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

function makeReq(method: string, url = 'http://local/api/v1/loot', body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id, name: 'Loot Test User', email: `${id}@loot.test`, emailVerified: false, createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string): Promise<string> {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-loot-'));
  const id = uid();
  await db().insert(schema.stashRoots).values({
    id, ownerId, name: 'Loot Root', path: rootPath, createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(ownerId: string, stashRootId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id, ownerId, name: `LootCol-${uid().slice(0, 8)}`, pathTemplate: '{title}', stashRootId,
    createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(collectionId: string, title = 'Test Loot'): Promise<string> {
  const id = uid();
  await db().insert(schema.loot).values({
    id, collectionId, title, description: null, tags: [], creator: null,
    license: null, sourceItemId: null, contentSummary: null, fileMissing: false,
    createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedLootFile(lootId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.lootFiles).values({
    id, lootId, path: `file-${id.slice(0, 8)}.3mf`, format: '3mf', size: 1024,
    hash: '0'.repeat(64), origin: 'ingest', provenance: null, createdAt: new Date(),
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

describe('GET /api/v1/loot', () => {
  it('returns 401 when unauthenticated', async () => {
    mockGetSession.mockResolvedValue(null);
    const { GET } = await import('../../../src/app/api/v1/loot/route');
    const res = await GET(makeReq('GET'));
    expect(res.status).toBe(401);
  });

  it('returns list with pagination fields', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    await seedLoot(colId, 'Paginated Loot');
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/loot/route');
    const res = await GET(makeReq('GET', 'http://local/api/v1/loot?limit=10&offset=0'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.items)).toBe(true);
    expect(typeof json.total).toBe('number');
    expect(json.limit).toBe(10);
  });

  it('filters by collectionId', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const colA = await seedCollection(userId, rootId);
    const colB = await seedCollection(userId, rootId);
    const lootA = await seedLoot(colA, 'LootA');
    await seedLoot(colB, 'LootB');
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/loot/route');
    const res = await GET(makeReq('GET', `http://local/api/v1/loot?collectionId=${colA}`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items.every((item: { collectionId: string }) => item.collectionId === colA)).toBe(true);
    expect(json.items.some((item: { id: string }) => item.id === lootA)).toBe(true);
  });
});

describe('POST /api/v1/loot', () => {
  it('creates loot and returns 201', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { POST } = await import('../../../src/app/api/v1/loot/route');
    const res = await POST(makeReq('POST', 'http://local/api/v1/loot', {
      collectionId: colId,
      title: 'New Loot Item',
      creator: 'Designer McDesign',
      tags: ['mechanical', 'keyboard'],
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBeDefined();
    expect(json.title).toBe('New Loot Item');
    expect(json.tags).toEqual(['mechanical', 'keyboard']);
  });

  it('returns 422 for unknown collectionId', async () => {
    const userId = await seedUser();
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { POST } = await import('../../../src/app/api/v1/loot/route');
    const res = await POST(makeReq('POST', 'http://local/api/v1/loot', {
      collectionId: uid(), title: 'Orphan',
    }));
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/loot/:id', () => {
  it('returns detail with files inline', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(colId, 'Detailed Loot');
    const fileId = await seedLootFile(lootId);
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/loot/[id]/route');
    const res = await GET(makeReq('GET'), { params: Promise.resolve({ id: lootId }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(lootId);
    expect(Array.isArray(json.files)).toBe(true);
    expect(json.files.some((f: { id: string }) => f.id === fileId)).toBe(true);
    expect(typeof json.createdAt).toBe('string');
  });

  it('returns 404 for unknown id', async () => {
    const userId = await seedUser();
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/loot/[id]/route');
    const res = await GET(makeReq('GET'), { params: Promise.resolve({ id: uid() }) });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/v1/loot/:id', () => {
  it('updates metadata fields', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(colId, 'Patchable Loot');
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { PATCH } = await import('../../../src/app/api/v1/loot/[id]/route');
    const res = await PATCH(
      makeReq('PATCH', `http://local/api/v1/loot/${lootId}`, {
        title: 'Updated Title', creator: 'New Creator', tags: ['tag1', 'tag2'], license: 'MIT',
      }),
      { params: Promise.resolve({ id: lootId }) },
    );
    expect(res.status).toBe(200);

    const rows = await db().select({ title: schema.loot.title, creator: schema.loot.creator }).from(schema.loot).where(
      (await import('drizzle-orm')).eq(schema.loot.id, lootId),
    );
    expect(rows[0].title).toBe('Updated Title');
    expect(rows[0].creator).toBe('New Creator');
  });

  it('returns 403 when non-collection-owner tries to patch', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);
    const lootId = await seedLoot(colId, 'ACL Loot');
    mockGetSession.mockResolvedValue(makeSession(otherId));

    const { PATCH } = await import('../../../src/app/api/v1/loot/[id]/route');
    const res = await PATCH(
      makeReq('PATCH', `http://local/api/v1/loot/${lootId}`, { title: 'Stolen' }),
      { params: Promise.resolve({ id: lootId }) },
    );
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/v1/loot/:id', () => {
  it('deletes loot and cascades lootFiles', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(colId, 'Delete Me');
    const fileId = await seedLootFile(lootId);
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { DELETE } = await import('../../../src/app/api/v1/loot/[id]/route');
    const res = await DELETE(makeReq('DELETE'), { params: Promise.resolve({ id: lootId }) });
    expect(res.status).toBe(200);

    // Verify cascade deleted the file.
    const files = await db().select({ id: schema.lootFiles.id }).from(schema.lootFiles).where(
      (await import('drizzle-orm')).eq(schema.lootFiles.id, fileId),
    );
    expect(files.length).toBe(0);
  });

  it('returns 403 when ACL denied (other user)', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);
    const lootId = await seedLoot(colId, 'Protected Loot');
    mockGetSession.mockResolvedValue(makeSession(otherId));

    const { DELETE } = await import('../../../src/app/api/v1/loot/[id]/route');
    const res = await DELETE(makeReq('DELETE'), { params: Promise.resolve({ id: lootId }) });
    expect(res.status).toBe(403);
  });
});
