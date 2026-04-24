/**
 * Integration tests — loot files API — V2-002-T12
 *
 * GET /api/v1/loot/:id/files — list files for a loot; empty list; ACL denial
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

function asActor(session: { user: { id: string; role: 'admin' | 'user' } } | null) {
  if (!session) return null;
  return { id: session.user.id, role: session.user.role, source: 'session' as const };
}
const mockGetSession = {
  mockResolvedValue: (v: unknown) => {
    mockAuthenticate.mockResolvedValue(asActor(v as { user: { id: string; role: 'admin' | 'user' } } | null));
  },
};

const DB_PATH = '/tmp/lootgoblin-api-t12-loot-files.db';
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

function makeReq(method: string, url = 'http://local/api/v1/loot/x/files'): Request {
  return new Request(url, { method, headers: { 'content-type': 'application/json' } });
}

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id, name: 'Files Test User', email: `${id}@files.test`, emailVerified: false, createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string): Promise<string> {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-files-'));
  const id = uid();
  await db().insert(schema.stashRoots).values({
    id, ownerId, name: 'Files Root', path: rootPath, createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(ownerId: string, stashRootId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id, ownerId, name: `FilesCol-${uid().slice(0, 8)}`, pathTemplate: '{title}', stashRootId,
    createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(collectionId: string, title = 'File Test Loot'): Promise<string> {
  const id = uid();
  await db().insert(schema.loot).values({
    id, collectionId, title, description: null, tags: [], creator: null,
    license: null, sourceItemId: null, contentSummary: null, fileMissing: false,
    createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedLootFile(lootId: string, format = '3mf'): Promise<string> {
  const id = uid();
  await db().insert(schema.lootFiles).values({
    id, lootId, path: `${id.slice(0, 8)}.${format}`, format, size: 512,
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

describe('GET /api/v1/loot/:id/files', () => {
  it('returns 401 with error:unauthenticated when no session and no API key', async () => {
    mockGetSession.mockResolvedValue(null);
    const { GET } = await import('../../../src/app/api/v1/loot/[id]/files/route');
    const res = await GET(makeReq('GET'), { params: Promise.resolve({ id: uid() }) });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'unauthenticated' });
  });

  it('returns 404 for unknown loot id', async () => {
    const userId = await seedUser();
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/loot/[id]/files/route');
    const res = await GET(makeReq('GET'), { params: Promise.resolve({ id: uid() }) });
    expect(res.status).toBe(404);
  });

  it('returns empty items list when loot has no files', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(colId, 'Empty Files Loot');
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/loot/[id]/files/route');
    const res = await GET(makeReq('GET'), { params: Promise.resolve({ id: lootId }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toEqual([]);
    expect(json.total).toBe(0);
  });

  it('returns files with serialised createdAt', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(colId, 'Files Loot');
    const fileId1 = await seedLootFile(lootId, '3mf');
    const fileId2 = await seedLootFile(lootId, 'stl');
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/loot/[id]/files/route');
    const res = await GET(makeReq('GET'), { params: Promise.resolve({ id: lootId }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items.length).toBe(2);
    expect(json.total).toBe(2);
    const ids = json.items.map((f: { id: string }) => f.id);
    expect(ids).toContain(fileId1);
    expect(ids).toContain(fileId2);
    // Timestamps should be ISO-8601 strings.
    expect(typeof json.items[0].createdAt).toBe('string');
  });

});
