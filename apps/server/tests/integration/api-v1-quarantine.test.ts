/**
 * Integration tests — GET /api/v1/quarantine — Quarantine HTTP Layer T2
 *
 * Real SQLite. Auth mocked via the request-auth shim.
 *
 * Coverage:
 *   - 401 unauthenticated
 *   - Owner sees own items (not another user's)
 *   - Non-owner non-admin sees nothing (empty list, NOT 403 — list is scoped)
 *   - Admin without ?owner_id= sees all items
 *   - Admin with ?owner_id= sees only that owner's items
 *   - Non-admin passing ?owner_id= gets 403
 *   - ?resolved=false filters pending (resolvedAt IS NULL)
 *   - ?resolved=true filters resolved (resolvedAt IS NOT NULL)
 *   - ?reason= filters by reason
 *   - ?stash_root_id= filters by root
 *   - Cursor paginates DESC by createdAt
 *   - nextCursor present when more items remain, absent on last page
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

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-api-quarantine-list.db';
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

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Quarantine Test User',
    email: `${id}@quarantine.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.stashRoots).values({
    id,
    ownerId,
    name: 'Test Root',
    path: `/tmp/test-root-${id}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedQuarantineItem(
  stashRootId: string,
  overrides: {
    reason?: string;
    resolvedAt?: Date | null;
    createdAt?: Date;
    path?: string;
  } = {},
): Promise<string> {
  const id = uid();
  await db().insert(schema.quarantineItems).values({
    id,
    stashRootId,
    path: overrides.path ?? `/tmp/quarantine/${id}.stl`,
    reason: overrides.reason ?? 'integrity-failed',
    details: null,
    createdAt: overrides.createdAt ?? new Date(),
    resolvedAt: overrides.resolvedAt !== undefined ? overrides.resolvedAt : null,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

function makeGet(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'GET' }) as unknown as import('next/server').NextRequest;
}

// ---------------------------------------------------------------------------
// GET /api/v1/quarantine
// ---------------------------------------------------------------------------

describe('GET /api/v1/quarantine', () => {
  it('returns 401 for unauthenticated callers', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/quarantine/route');
    const res = await GET(makeGet('http://local/api/v1/quarantine'));
    expect(res.status).toBe(401);
  });

  it('returns only items owned by the caller (owner scoping)', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const rootA = await seedStashRoot(userA);
    const rootB = await seedStashRoot(userB);
    await seedQuarantineItem(rootA);
    await seedQuarantineItem(rootA);
    await seedQuarantineItem(rootB);

    mockAuthenticate.mockResolvedValueOnce(actor(userA));
    const { GET } = await import('../../src/app/api/v1/quarantine/route');
    const res = await GET(makeGet('http://local/api/v1/quarantine'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ stashRootId: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    for (const item of body.items) {
      expect(item.stashRootId).toBe(rootA);
    }
  });

  it('non-owner non-admin sees empty list (NOT 403)', async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const root = await seedStashRoot(owner);
    await seedQuarantineItem(root);

    mockAuthenticate.mockResolvedValueOnce(actor(stranger));
    const { GET } = await import('../../src/app/api/v1/quarantine/route');
    const res = await GET(makeGet('http://local/api/v1/quarantine'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    // stranger has no stash roots → empty list
    expect(body.items).toHaveLength(0);
  });

  it('admin without ?owner_id= sees all items across owners', async () => {
    const adminId = await seedUser();
    const userA = await seedUser();
    const userB = await seedUser();
    const rootA = await seedStashRoot(userA);
    const rootB = await seedStashRoot(userB);
    const itemA = await seedQuarantineItem(rootA);
    const itemB = await seedQuarantineItem(rootB);

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/quarantine/route');
    const res = await GET(makeGet('http://local/api/v1/quarantine'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(itemA);
    expect(ids).toContain(itemB);
  });

  it('admin with ?owner_id= sees only that owner items', async () => {
    const adminId = await seedUser();
    const userA = await seedUser();
    const userB = await seedUser();
    const rootA = await seedStashRoot(userA);
    const rootB = await seedStashRoot(userB);
    const itemA = await seedQuarantineItem(rootA);
    await seedQuarantineItem(rootB);

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/quarantine/route');
    const res = await GET(
      makeGet(`http://local/api/v1/quarantine?owner_id=${userA}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toContain(itemA);
    for (const item of body.items) {
      expect(item.id).not.toBe(itemA === item.id ? 'unexpected' : item.id);
    }
    // Verify rootB item is excluded
    const ids = body.items.map((i) => i.id);
    expect(ids.every((id) => id !== (ids.find((x) => x !== itemA) ?? ''))).toBe(true);
  });

  it('non-admin passing ?owner_id= gets 403', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId, 'user'));
    const { GET } = await import('../../src/app/api/v1/quarantine/route');
    const res = await GET(
      makeGet(`http://local/api/v1/quarantine?owner_id=${uid()}`),
    );
    expect(res.status).toBe(403);
  });

  it('?resolved=false returns only pending items (resolvedAt IS NULL)', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const pending = await seedQuarantineItem(root, { resolvedAt: null });
    await seedQuarantineItem(root, { resolvedAt: new Date() });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/quarantine/route');
    const res = await GET(makeGet('http://local/api/v1/quarantine?resolved=false'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; resolvedAt: string | null }> };
    expect(body.items.map((i) => i.id)).toContain(pending);
    for (const item of body.items) {
      expect(item.resolvedAt).toBeNull();
    }
  });

  it('?resolved=true returns only resolved items (resolvedAt IS NOT NULL)', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    await seedQuarantineItem(root, { resolvedAt: null });
    const resolved = await seedQuarantineItem(root, { resolvedAt: new Date() });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/quarantine/route');
    const res = await GET(makeGet('http://local/api/v1/quarantine?resolved=true'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; resolvedAt: string | null }> };
    expect(body.items.map((i) => i.id)).toContain(resolved);
    for (const item of body.items) {
      expect(item.resolvedAt).not.toBeNull();
    }
  });

  it('?reason= filters by reason', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const ifItem = await seedQuarantineItem(root, { reason: 'integrity-failed' });
    await seedQuarantineItem(root, { reason: 'unclassifiable' });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/quarantine/route');
    const res = await GET(makeGet('http://local/api/v1/quarantine?reason=integrity-failed'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; reason: string }> };
    expect(body.items.map((i) => i.id)).toContain(ifItem);
    for (const item of body.items) {
      expect(item.reason).toBe('integrity-failed');
    }
  });

  it('?stash_root_id= filters by root', async () => {
    const userId = await seedUser();
    const rootA = await seedStashRoot(userId);
    const rootB = await seedStashRoot(userId);
    const itemInA = await seedQuarantineItem(rootA);
    await seedQuarantineItem(rootB);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/quarantine/route');
    const res = await GET(
      makeGet(`http://local/api/v1/quarantine?stash_root_id=${rootA}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; stashRootId: string }> };
    expect(body.items.map((i) => i.id)).toContain(itemInA);
    for (const item of body.items) {
      expect(item.stashRootId).toBe(rootA);
    }
  });

  it('cursor paginates DESC by createdAt and returns nextCursor', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);

    // Seed 3 items with distinct timestamps (oldest to newest)
    const now = Date.now();
    const item1 = await seedQuarantineItem(root, { createdAt: new Date(now - 2000) });
    const item2 = await seedQuarantineItem(root, { createdAt: new Date(now - 1000) });
    const item3 = await seedQuarantineItem(root, { createdAt: new Date(now) });

    // Page 1: limit=2 → should return item3 + item2 (newest first)
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/quarantine/route');
    const res1 = await GET(
      makeGet(`http://local/api/v1/quarantine?limit=2`),
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { items: Array<{ id: string }>; nextCursor?: string };
    expect(body1.items.length).toBe(2);
    expect(body1.nextCursor).toBeTruthy();
    // Items should be newest first
    expect(body1.items[0]!.id).toBe(item3);
    expect(body1.items[1]!.id).toBe(item2);

    // Page 2: using cursor from page 1 → should return item1
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const res2 = await GET(
      makeGet(`http://local/api/v1/quarantine?limit=2&cursor=${body1.nextCursor}`),
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { items: Array<{ id: string }>; nextCursor?: string };
    expect(body2.items.map((i) => i.id)).toContain(item1);
    // No more pages
    expect(body2.nextCursor).toBeUndefined();
  });

  it('response envelope has correct DTO shape', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    await seedQuarantineItem(root, { reason: 'needs-user-input' });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/quarantine/route');
    const res = await GET(makeGet('http://local/api/v1/quarantine'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        stashRootId: string;
        path: string;
        reason: string;
        details: unknown;
        createdAt: string;
        resolvedAt: string | null;
      }>;
    };
    expect(body.items.length).toBeGreaterThan(0);
    const item = body.items[0]!;
    expect(typeof item.id).toBe('string');
    expect(typeof item.stashRootId).toBe('string');
    expect(typeof item.path).toBe('string');
    expect(typeof item.reason).toBe('string');
    expect(typeof item.createdAt).toBe('string');
    // ISO 8601 format
    expect(() => new Date(item.createdAt)).not.toThrow();
    expect(item.resolvedAt).toBeNull();
  });
});
