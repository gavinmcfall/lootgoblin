/**
 * Integration tests — search API — V2-002-T12
 *
 * GET /api/v1/search?q= — FTS5 search; returns hydrated Loot rows.
 *
 * Note: the search route uses the module-level IndexerEngine singleton.
 * We inject our own engine via the module memo pattern by resetting it
 * before each describe block. Because the route file caches _engine at
 * module level, we reset it by reimporting after clearing the module cache —
 * OR we simply use a shared DB and seed + call indexLoot() ourselves, which
 * is cleaner and exercises the real FTS path.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { runMigrations, getDb, schema, resetDbCache } from '../../../src/db/client';
import { createIndexerEngine } from '../../../src/stash/indexer';

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

const DB_PATH = '/tmp/lootgoblin-api-t12-search.db';
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

function makeReq(q: string): Request {
  return new Request(`http://local/api/v1/search?q=${encodeURIComponent(q)}`, {
    method: 'GET',
    headers: { 'content-type': 'application/json' },
  });
}

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id, name: 'Search Test User', email: `${id}@search.test`, emailVerified: false, createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string): Promise<{ rootId: string; rootPath: string }> {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-search-'));
  const rootId = uid();
  await db().insert(schema.stashRoots).values({
    id: rootId, ownerId, name: 'Search Root', path: rootPath, createdAt: new Date(), updatedAt: new Date(),
  });
  return { rootId, rootPath };
}

async function seedCollection(ownerId: string, stashRootId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id, ownerId, name: `SearchCol-${uid().slice(0, 8)}`, pathTemplate: '{title}', stashRootId,
    createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(collectionId: string, title: string, opts?: { creator?: string; description?: string; tags?: string[] }): Promise<string> {
  const id = uid();
  await db().insert(schema.loot).values({
    id, collectionId, title, description: opts?.description ?? null, tags: opts?.tags ?? [],
    creator: opts?.creator ?? null, license: null, sourceItemId: null,
    contentSummary: null, fileMissing: false, createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

// Index loot into FTS5 using a real engine (f3d runner stubbed to avoid subprocess).
async function indexLoot(lootId: string): Promise<void> {
  const engine = createIndexerEngine({
    dbUrl: DB_URL,
    f3dRunner: async () => ({ status: 'failed' as const, error: 'f3d-not-found' }),
  });
  await engine.indexLoot(lootId);
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { await fsp.unlink(`${DB_PATH}${suffix}`); } catch { /* ignore */ }
  }
  process.env.DATABASE_URL = DB_URL;
  resetDbCache();
  await runMigrations(DB_URL);
});

describe('GET /api/v1/search', () => {
  it('returns 401 with error:unauthenticated when no session and no API key', async () => {
    mockGetSession.mockResolvedValue(null);
    const { GET } = await import('../../../src/app/api/v1/search/route');
    const res = await GET(makeReq('keyboard'));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'unauthenticated' });
  });

  it('returns empty results for blank query', async () => {
    const userId = await seedUser();
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/search/route');
    const res = await GET(new Request('http://local/api/v1/search?q=', { method: 'GET' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toEqual([]);
    expect(json.total).toBe(0);
  });

  it('returns empty results for unknown term', async () => {
    const userId = await seedUser();
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/search/route');
    const res = await GET(makeReq('xyzzy_does_not_exist_12345'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toEqual([]);
  });

  it('returns hydrated loot rows for matching term', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    const lootId = await seedLoot(colId, 'Topre Switch Model', { creator: 'KeyboardDesigner', tags: ['topre', 'switch'] });
    await indexLoot(lootId);
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/search/route');
    const res = await GET(makeReq('topre'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items.some((r: { id: string }) => r.id === lootId)).toBe(true);
    // Response items are full Loot rows with ISO timestamps.
    expect(typeof json.items[0].createdAt).toBe('string');
  });

  it('pagination: limit + offset parameters respected', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    // Seed 3 items with a shared term.
    const term = `paginateterm${uid().replace(/-/g, '').slice(0, 8)}`;
    for (let i = 0; i < 3; i++) {
      const id = await seedLoot(colId, `${term} Model ${i}`, { description: term });
      await indexLoot(id);
    }
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/search/route');
    const res = await GET(new Request(`http://local/api/v1/search?q=${term}&limit=2&offset=0`, { method: 'GET' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items.length).toBeLessThanOrEqual(2);
    expect(json.limit).toBe(2);
    expect(json.offset).toBe(0);
  });

  it('malformed FTS5 query is handled gracefully (returns empty)', async () => {
    const userId = await seedUser();
    mockGetSession.mockResolvedValue(makeSession(userId));

    const { GET } = await import('../../../src/app/api/v1/search/route');
    // Malformed FTS5: trailing AND with no RHS
    const res = await GET(makeReq('hello AND'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toEqual([]);
  });
});
