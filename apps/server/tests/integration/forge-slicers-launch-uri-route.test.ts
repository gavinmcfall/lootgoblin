/**
 * Integration tests — GET /api/v1/forge/slicers/launch-uri — V2-005e-T_e4
 *
 * Real SQLite + auth shim, mirroring api-v1-forge-slicers.test.ts.
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

const DB_PATH = '/tmp/lootgoblin-api-forge-slicers-launch-uri.db';
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
}, 30_000);

beforeEach(async () => {
  const dbc = db();
  await dbc.delete(schema.lootFiles);
  await dbc.delete(schema.loot);
  await dbc.delete(schema.collections);
  await dbc.delete(schema.stashRoots);
  await dbc.delete(schema.user);
  mockAuthenticate.mockReset();
  delete process.env.LOOTGOBLIN_PUBLIC_URL;
});

async function seedUser(role: 'admin' | 'user' = 'user'): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: `lu-${id.slice(0, 6)}`,
    email: `${id}@lu.test`,
    emailVerified: false,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLootFile(ownerId: string): Promise<{
  collectionId: string;
  lootId: string;
  lootFileId: string;
}> {
  const stashRootId = uid();
  await db().insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId,
    name: 'root',
    path: '/tmp/lu-root',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `c-${uid().slice(0, 4)}`,
    pathTemplate: '{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootId = uid();
  await db().insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: 'fixture-loot',
    description: null,
    tags: [],
    creator: null,
    license: null,
    sourceItemId: null,
    contentSummary: null,
    fileMissing: false,
    parentLootId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootFileId = uid();
  await db().insert(schema.lootFiles).values({
    id: lootFileId,
    lootId,
    path: 'fixture/file.3mf',
    format: '3mf',
    size: 1234,
    hash: 'a'.repeat(64),
    origin: 'manual',
    provenance: null,
    createdAt: new Date(),
  });
  return { collectionId, lootId, lootFileId };
}

function makeGet(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'GET' }) as unknown as import('next/server').NextRequest;
}

const ROUTE = 'http://local/api/v1/forge/slicers/launch-uri';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/forge/slicers/launch-uri (T_e4)', () => {
  it('401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import(
      '../../src/app/api/v1/forge/slicers/launch-uri/route'
    );
    const res = await GET(
      makeGet(`${ROUTE}?slicerKind=bambu_studio&lootFileId=anything`),
    );
    expect(res.status).toBe(401);
  });

  it('400 missing required query params', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/slicers/launch-uri/route'
    );
    const res = await GET(makeGet(`${ROUTE}?slicerKind=bambu_studio`));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid-query');
  });

  it('400 unknown slicerKind', async () => {
    const userId = await seedUser();
    const { lootFileId } = await seedLootFile(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/slicers/launch-uri/route'
    );
    const res = await GET(
      makeGet(`${ROUTE}?slicerKind=not-a-slicer&lootFileId=${lootFileId}`),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('unknown-slicer-kind');
  });

  it('404 unknown lootFileId', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/slicers/launch-uri/route'
    );
    const res = await GET(
      makeGet(`${ROUTE}?slicerKind=bambu_studio&lootFileId=does-not-exist`),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('not-found');
  });

  it('404 cross-owner lootFileId (security via obscurity)', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const { lootFileId } = await seedLootFile(ownerA);
    mockAuthenticate.mockResolvedValueOnce(actor(ownerB));
    const { GET } = await import(
      '../../src/app/api/v1/forge/slicers/launch-uri/route'
    );
    const res = await GET(
      makeGet(`${ROUTE}?slicerKind=bambu_studio&lootFileId=${lootFileId}`),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('not-found');
  });

  it('happy path: bambu_studio returns rendered URI', async () => {
    const userId = await seedUser();
    const { lootFileId } = await seedLootFile(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/slicers/launch-uri/route'
    );
    const res = await GET(
      makeGet(`${ROUTE}?slicerKind=bambu_studio&lootFileId=${lootFileId}`),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.fallback).toBeNull();
    expect(json.uri).toBe(
      `bambu-connect://import-file?url=http://local/api/v1/loot/files/${lootFileId}`,
    );
  });

  it('slicer with no scheme returns fallback=download + uri=""', async () => {
    const userId = await seedUser();
    const { lootFileId } = await seedLootFile(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/slicers/launch-uri/route'
    );
    const res = await GET(
      makeGet(`${ROUTE}?slicerKind=prusaslicer&lootFileId=${lootFileId}`),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.uri).toBe('');
    expect(json.fallback).toBe('download');
  });

  it('admin sees other-owner files', async () => {
    const ownerA = await seedUser();
    const adminId = await seedUser('admin');
    const { lootFileId } = await seedLootFile(ownerA);
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import(
      '../../src/app/api/v1/forge/slicers/launch-uri/route'
    );
    const res = await GET(
      makeGet(`${ROUTE}?slicerKind=orcaslicer&lootFileId=${lootFileId}`),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.uri).toBe(
      `orcaslicer://open?url=http://local/api/v1/loot/files/${lootFileId}`,
    );
    expect(json.fallback).toBeNull();
  });

  it('LOOTGOBLIN_PUBLIC_URL overrides the request origin in the rendered URL', async () => {
    process.env.LOOTGOBLIN_PUBLIC_URL = 'https://loot.example.com/';
    const userId = await seedUser();
    const { lootFileId } = await seedLootFile(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/slicers/launch-uri/route'
    );
    const res = await GET(
      makeGet(`${ROUTE}?slicerKind=bambu_studio&lootFileId=${lootFileId}`),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.uri).toBe(
      `bambu-connect://import-file?url=https://loot.example.com/api/v1/loot/files/${lootFileId}`,
    );
  });
});
