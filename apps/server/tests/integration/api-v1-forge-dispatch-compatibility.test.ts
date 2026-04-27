/**
 * Integration tests — GET /api/v1/forge/dispatch/compatibility — V2-005a-T6
 *
 * Real SQLite + auth shim. Exercises:
 *   - 401 unauth
 *   - 400 invalid query params
 *   - 200 native (STL + orcaslicer)
 *   - 200 conversion-required (STL + fdm_klipper → gcode)
 *   - 200 unsupported (jpeg + slicer)
 *   - 404 nonexistent loot
 *   - 404 cross-owner loot
 *   - 422 loot has no files
 *   - mixedFormat flag when multiple files have different formats
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
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

const DB_PATH = '/tmp/lootgoblin-api-forge-compat.db';
const DB_URL = `file:${DB_PATH}`;

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
  resetDbCache();
  await runMigrations(DB_URL);
});

beforeEach(async () => {
  await db().delete(schema.lootFiles);
  await db().delete(schema.loot);
  await db().delete(schema.collections);
  await db().delete(schema.stashRoots);
  await db().delete(schema.user);
  mockAuthenticate.mockReset();
});

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Forge Compat Test User',
    email: `${id}@forge-compat.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(ownerId: string): Promise<string> {
  const rootId = uid();
  await db().insert(schema.stashRoots).values({
    id: rootId,
    ownerId,
    name: 'root',
    path: '/tmp/x',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `c-${collectionId.slice(0, 6)}`,
    pathTemplate: '{title|slug}',
    stashRootId: rootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootId = uid();
  await db().insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: 'a model',
    tags: [],
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return lootId;
}

async function seedLootFile(
  lootId: string,
  format: string,
  path?: string,
  createdAt?: Date,
): Promise<string> {
  const id = uid();
  await db().insert(schema.lootFiles).values({
    id,
    lootId,
    path: path ?? `model.${format}`,
    format,
    size: 1024,
    hash: `sha256-${id}`,
    origin: 'manual',
    createdAt: createdAt ?? new Date(),
  });
  return id;
}

function makeGet(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'GET' }) as unknown as import('next/server').NextRequest;
}

const URL_BASE = 'http://local/api/v1/forge/dispatch/compatibility';

describe('GET /api/v1/forge/dispatch/compatibility', () => {
  it('401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/compatibility/route'
    );
    const res = await GET(makeGet(`${URL_BASE}?lootId=x&targetKind=orcaslicer`));
    expect(res.status).toBe(401);
  });

  it('400 missing lootId', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/compatibility/route'
    );
    const res = await GET(makeGet(`${URL_BASE}?targetKind=orcaslicer`));
    expect(res.status).toBe(400);
  });

  it('400 missing targetKind', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/compatibility/route'
    );
    const res = await GET(makeGet(`${URL_BASE}?lootId=foo`));
    expect(res.status).toBe(400);
  });

  it('400 invalid targetKind', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/compatibility/route'
    );
    const res = await GET(
      makeGet(`${URL_BASE}?lootId=foo&targetKind=not-a-real-kind`),
    );
    expect(res.status).toBe(400);
  });

  it('200 native — STL loot + orcaslicer', async () => {
    const userId = await seedUser();
    const lootId = await seedLoot(userId);
    await seedLootFile(lootId, 'stl');
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/compatibility/route'
    );
    const res = await GET(
      makeGet(`${URL_BASE}?lootId=${lootId}&targetKind=orcaslicer`),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lootId).toBe(lootId);
    expect(json.targetKind).toBe('orcaslicer');
    expect(json.format).toBe('stl');
    expect(json.band).toBe('native');
    expect(json.mixedFormat).toBe(false);
  });

  it('200 conversion-required — STL loot + fdm_klipper → gcode', async () => {
    const userId = await seedUser();
    const lootId = await seedLoot(userId);
    await seedLootFile(lootId, 'stl');
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/compatibility/route'
    );
    const res = await GET(
      makeGet(`${URL_BASE}?lootId=${lootId}&targetKind=fdm_klipper`),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.band).toBe('conversion-required');
    expect(json.conversionTo).toBe('gcode');
  });

  it('200 unsupported — jpeg loot + any', async () => {
    const userId = await seedUser();
    const lootId = await seedLoot(userId);
    await seedLootFile(lootId, 'jpeg', 'cover.jpeg');
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/compatibility/route'
    );
    const res = await GET(
      makeGet(`${URL_BASE}?lootId=${lootId}&targetKind=orcaslicer`),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.band).toBe('unsupported');
    expect(json.reason).toMatch(/image/i);
  });

  it('404 nonexistent loot', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/compatibility/route'
    );
    const res = await GET(
      makeGet(`${URL_BASE}?lootId=no-such-loot&targetKind=orcaslicer`),
    );
    expect(res.status).toBe(404);
  });

  it('404 cross-owner loot', async () => {
    const aliceId = await seedUser();
    const bobId = await seedUser();
    const aliceLoot = await seedLoot(aliceId);
    await seedLootFile(aliceLoot, 'stl');
    mockAuthenticate.mockResolvedValueOnce(actor(bobId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/compatibility/route'
    );
    const res = await GET(
      makeGet(`${URL_BASE}?lootId=${aliceLoot}&targetKind=orcaslicer`),
    );
    expect(res.status).toBe(404);
  });

  it('422 loot has no files', async () => {
    const userId = await seedUser();
    const lootId = await seedLoot(userId);
    // Deliberately do NOT seed any loot files.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/compatibility/route'
    );
    const res = await GET(
      makeGet(`${URL_BASE}?lootId=${lootId}&targetKind=orcaslicer`),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe('no-files');
  });

  it('200 mixedFormat=true when files have different formats', async () => {
    const userId = await seedUser();
    const lootId = await seedLoot(userId);
    // First file (by createdAt) is STL → primary format.
    await seedLootFile(lootId, 'stl', 'a.stl', new Date('2025-01-01T00:00:00Z'));
    await seedLootFile(lootId, 'gcode', 'b.gcode', new Date('2025-01-02T00:00:00Z'));
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/compatibility/route'
    );
    const res = await GET(
      makeGet(`${URL_BASE}?lootId=${lootId}&targetKind=orcaslicer`),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.format).toBe('stl');
    expect(json.mixedFormat).toBe(true);
    expect(json.band).toBe('native');
  });
});
