/**
 * Integration tests — thumbnail serve API — V2-002-T12
 *
 * GET /api/v1/loot/:id/thumbnail
 *   — 200 with PNG bytes when status=ok
 *   — 404 with no-thumbnail when status!=ok
 *   — Cache-Control header present on 200
 *   — 401 when unauthenticated
 *   — 404 when file is missing from disk despite status=ok
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
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

const DB_PATH = '/tmp/lootgoblin-api-t12-thumbnail.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB { return getDb(DB_URL) as DB; }
function uid(): string { return crypto.randomUUID(); }

function makeSession(userId: string) {
  return {
    session: { id: uid(), userId, expiresAt: new Date(Date.now() + 86400_000), token: uid() },
    user: { id: userId, email: `${userId}@test.example`, name: 'Test User', emailVerified: true, role: 'user' as const },
  };
}

function makeReq(lootId: string): Request {
  return new Request(`http://local/api/v1/loot/${lootId}/thumbnail`, { method: 'GET' });
}

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id, name: 'Thumb Test User', email: `${id}@thumb.test`, emailVerified: false, createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string, rootPath: string): Promise<string> {
  const id = uid();
  await db().insert(schema.stashRoots).values({
    id, ownerId, name: 'Thumb Root', path: rootPath, createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(ownerId: string, stashRootId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id, ownerId, name: `ThumbCol-${uid().slice(0, 8)}`, pathTemplate: '{title}', stashRootId,
    createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(collectionId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.loot).values({
    id, collectionId, title: `Thumb Loot ${id.slice(0, 8)}`, description: null, tags: [],
    creator: null, license: null, sourceItemId: null, contentSummary: null, fileMissing: false,
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

describe('GET /api/v1/loot/:id/thumbnail', () => {
  it('returns 401 with error:unauthenticated when no session and no API key', async () => {
    mockGetSession.mockResolvedValue(null);
    const { GET } = await import('../../../src/app/api/v1/loot/[id]/thumbnail/route');
    const res = await GET(makeReq(uid()), { params: Promise.resolve({ id: uid() }) });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'unauthenticated' });
  });

  it('returns 404 with no-thumbnail when loot_thumbnails row has status != ok', async () => {
    const userId = await seedUser();
    const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-thumb-'));
    const rootId = await seedStashRoot(userId, rootPath);
    const colId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(colId);

    // Insert thumbnail row with status=pending.
    db().run(
      sql`INSERT INTO loot_thumbnails (loot_id, status, updated_at) VALUES (${lootId}, 'pending', ${Date.now()})`,
    );

    mockGetSession.mockResolvedValue(makeSession(userId));
    const { GET } = await import('../../../src/app/api/v1/loot/[id]/thumbnail/route');
    const res = await GET(makeReq(lootId), { params: Promise.resolve({ id: lootId }) });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('no-thumbnail');
  });

  it('returns 404 with no-thumbnail when no thumbnail row exists', async () => {
    const userId = await seedUser();
    const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-thumb2-'));
    const rootId = await seedStashRoot(userId, rootPath);
    const colId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(colId);
    // No loot_thumbnails row.

    mockGetSession.mockResolvedValue(makeSession(userId));
    const { GET } = await import('../../../src/app/api/v1/loot/[id]/thumbnail/route');
    const res = await GET(makeReq(lootId), { params: Promise.resolve({ id: lootId }) });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('no-thumbnail');
  });

  it('returns 200 PNG with Cache-Control when status=ok and file exists', async () => {
    const userId = await seedUser();
    const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-thumb3-'));
    const rootId = await seedStashRoot(userId, rootPath);
    const colId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(colId);

    // Create a fake PNG file at thumbnails/<lootId>.png.
    const thumbDir = path.join(rootPath, 'thumbnails');
    await fsp.mkdir(thumbDir, { recursive: true });
    const thumbFilename = `${lootId}.png`;
    const thumbRelPath = path.join('thumbnails', thumbFilename);
    const fakeBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG magic bytes
    await fsp.writeFile(path.join(rootPath, thumbRelPath), fakeBytes);

    // Insert thumbnail row with status=ok.
    const now = Date.now();
    db().run(
      sql`INSERT INTO loot_thumbnails (loot_id, status, thumbnail_path, source_kind, generated_at, updated_at)
          VALUES (${lootId}, 'ok', ${thumbRelPath}, '3mf-embedded', ${now}, ${now})`,
    );

    mockGetSession.mockResolvedValue(makeSession(userId));
    const { GET } = await import('../../../src/app/api/v1/loot/[id]/thumbnail/route');
    const res = await GET(makeReq(lootId), { params: Promise.resolve({ id: lootId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const body = await res.arrayBuffer();
    expect(Buffer.from(body).slice(0, 4)).toEqual(fakeBytes);
  });

  it('returns 404 when file is missing from disk despite status=ok', async () => {
    const userId = await seedUser();
    const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-thumb4-'));
    const rootId = await seedStashRoot(userId, rootPath);
    const colId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(colId);

    // Insert thumbnail row with status=ok but non-existent path.
    const thumbRelPath = `thumbnails/${lootId}.png`;
    const now = Date.now();
    db().run(
      sql`INSERT INTO loot_thumbnails (loot_id, status, thumbnail_path, source_kind, generated_at, updated_at)
          VALUES (${lootId}, 'ok', ${thumbRelPath}, 'f3d-cli', ${now}, ${now})`,
    );
    // NOTE: we deliberately do NOT create the file on disk.

    mockGetSession.mockResolvedValue(makeSession(userId));
    const { GET } = await import('../../../src/app/api/v1/loot/[id]/thumbnail/route');
    const res = await GET(makeReq(lootId), { params: Promise.resolve({ id: lootId }) });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('no-thumbnail');
  });
});
