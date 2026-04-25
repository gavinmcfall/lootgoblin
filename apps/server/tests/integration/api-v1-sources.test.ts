/**
 * Integration tests — GET /api/v1/sources — V2-003-T9
 *
 * Asserts the public catalog of registered Scavenger adapters:
 *   - 401 without auth
 *   - 200 with session — array contains all registered adapters
 *   - per-adapter metadata: id, displayName, supports.{url,sourceItemId,raw},
 *     authMethods
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
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

const DB_PATH = '/tmp/lootgoblin-api-sources.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB { return getDb(DB_URL) as DB; }
function uid(): string { return crypto.randomUUID(); }

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { await fsp.unlink(`${DB_PATH}${suffix}`); } catch { /* ignore */ }
  }
  process.env.DATABASE_URL = DB_URL;
  resetDbCache();
  await runMigrations(DB_URL);
});

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Sources Test User',
    email: `${id}@sources.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function makeReq(): import('next/server').NextRequest {
  return new Request('http://local/api/v1/sources', { method: 'GET' }) as unknown as import('next/server').NextRequest;
}

function makeSessionActor(userId: string) {
  return { id: userId, role: 'user' as const, source: 'session' as const };
}

describe('GET /api/v1/sources', () => {
  it('returns 401 unauthenticated when no session and no API key', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/sources/route');
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'unauthenticated' });
  });

  it('returns 401 with reason:invalid-api-key when API key is rejected', async () => {
    const { INVALID_API_KEY } = await import('../../src/auth/request-auth');
    mockAuthenticate.mockResolvedValueOnce(INVALID_API_KEY);
    const { GET } = await import('../../src/app/api/v1/sources/route');
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'unauthenticated', reason: 'invalid-api-key' });
  });

  it('returns 200 with the full registered catalog for an authenticated user', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(userId));
    const { GET } = await import('../../src/app/api/v1/sources/route');
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.sources)).toBe(true);

    const ids = (json.sources as Array<{ id: string }>).map((s) => s.id);
    // V2-003 default registry: upload, cults3d, makerworld, printables, sketchfab, google-drive
    expect(ids).toEqual(
      expect.arrayContaining(['upload', 'cults3d', 'makerworld', 'printables', 'sketchfab', 'google-drive']),
    );

    // Each entry should have the documented fields.
    for (const s of json.sources as Array<{
      id: string;
      displayName: string;
      supports: { url: boolean; sourceItemId: boolean; raw: boolean };
      authMethods: string[];
    }>) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.displayName).toBe('string');
      expect(s.supports).toHaveProperty('url');
      expect(s.supports).toHaveProperty('sourceItemId');
      expect(s.supports).toHaveProperty('raw');
      expect(Array.isArray(s.authMethods)).toBe(true);
    }
  });

  it('per-adapter authMethods match V2-003 design (T9 contract)', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(userId));
    const { GET } = await import('../../src/app/api/v1/sources/route');
    const res = await GET(makeReq());
    const json = await res.json();
    const sources = json.sources as Array<{ id: string; authMethods: string[]; supports: { url: boolean; sourceItemId: boolean; raw: boolean } }>;
    const byId = (id: string) => sources.find((s) => s.id === id);

    expect(byId('cults3d')?.authMethods).toEqual(['api-key']);
    expect(byId('sketchfab')?.authMethods).toEqual(['oauth', 'api-key']);
    expect(byId('google-drive')?.authMethods).toEqual(['oauth', 'api-key']);
    expect(byId('upload')?.authMethods).toEqual(['none']);
    expect(byId('makerworld')?.authMethods).toEqual(['extension']);
    expect(byId('printables')?.authMethods).toEqual(['extension']);

    // Upload is raw-only.
    expect(byId('upload')?.supports).toEqual({ url: false, sourceItemId: false, raw: true });
    // URL-driven adapters claim url + sourceItemId.
    expect(byId('cults3d')?.supports.url).toBe(true);
    expect(byId('cults3d')?.supports.sourceItemId).toBe(true);
    expect(byId('sketchfab')?.supports.url).toBe(true);
    expect(byId('google-drive')?.supports.url).toBe(true);
  });

  it('accepts a programmatic API key (source:api-key)', async () => {
    mockAuthenticate.mockResolvedValueOnce({
      id: 'api-key:fake-key-id',
      role: 'user' as const,
      source: 'api-key' as const,
    });
    const { GET } = await import('../../src/app/api/v1/sources/route');
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.sources)).toBe(true);
    expect(json.sources.length).toBeGreaterThan(0);
  });
});
