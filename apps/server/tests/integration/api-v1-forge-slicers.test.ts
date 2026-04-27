/**
 * Integration tests — /api/v1/forge/slicers/* — V2-005a-T5
 *
 * Same pattern as api-v1-forge-printers.test.ts (real SQLite + auth shim).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

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

const DB_PATH = '/tmp/lootgoblin-api-forge-slicers.db';
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
  await db().delete(schema.slicerAcls);
  await db().delete(schema.forgeSlicers);
  await db().delete(schema.user);
  mockAuthenticate.mockReset();
});

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Forge Slicer Test User',
    email: `${id}@forge-slicer.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function makePost(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): import('next/server').NextRequest {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}
function makeGet(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'GET' }) as unknown as import('next/server').NextRequest;
}
function makePatch(url: string, body: unknown): import('next/server').NextRequest {
  return new Request(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}
function makeDelete(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'DELETE' }) as unknown as import('next/server').NextRequest;
}

const validBody = (overrides: Record<string, unknown> = {}) => ({
  kind: 'orcaslicer',
  name: 'Orca on MacBook',
  invocationMethod: 'url-scheme',
  ...overrides,
});

// ===========================================================================
// POST
// ===========================================================================

describe('POST /api/v1/forge/slicers', () => {
  it('401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import('../../src/app/api/v1/forge/slicers/route');
    const res = await POST(makePost('http://local/api/v1/forge/slicers', validBody()));
    expect(res.status).toBe(401);
  });

  it('400 invalid body', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/slicers/route');
    const res = await POST(
      makePost('http://local/api/v1/forge/slicers', { kind: 'wat' }),
    );
    expect(res.status).toBe(400);
  });

  it('201 happy create', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/slicers/route');
    const res = await POST(
      makePost('http://local/api/v1/forge/slicers', validBody({ deviceId: 'mac-1' })),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.slicer.kind).toBe('orcaslicer');
    expect(json.slicer.deviceId).toBe('mac-1');
    expect(json.slicer.ownerId).toBe(userId);
  });

  it('200 idempotent replay', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValue(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/slicers/route');
    const r1 = await POST(
      makePost('http://local/api/v1/forge/slicers', validBody(), {
        'Idempotency-Key': 'k1',
      }),
    );
    const j1 = await r1.json();
    expect(r1.status).toBe(201);
    const r2 = await POST(
      makePost('http://local/api/v1/forge/slicers', validBody(), {
        'Idempotency-Key': 'k1',
      }),
    );
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.slicer.id).toBe(j1.slicer.id);
  });

  it('409 idempotency mismatch', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValue(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/slicers/route');
    await POST(
      makePost('http://local/api/v1/forge/slicers', validBody({ name: 'A' }), {
        'Idempotency-Key': 'k2',
      }),
    );
    const r2 = await POST(
      makePost('http://local/api/v1/forge/slicers', validBody({ name: 'B' }), {
        'Idempotency-Key': 'k2',
      }),
    );
    expect(r2.status).toBe(409);
  });
});

// ===========================================================================
// GET list
// ===========================================================================

describe('GET /api/v1/forge/slicers', () => {
  it('401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/forge/slicers/route');
    const res = await GET(makeGet('http://local/api/v1/forge/slicers'));
    expect(res.status).toBe(401);
  });

  it('200 owner-scoped list', async () => {
    const aliceId = await seedUser();
    const bobId = await seedUser();
    const aId = uid();
    const bId = uid();
    await db().insert(schema.forgeSlicers).values({
      id: aId,
      ownerId: aliceId,
      kind: 'orcaslicer',
      name: 'A',
      invocationMethod: 'url-scheme',
      createdAt: new Date(),
    });
    await db().insert(schema.forgeSlicers).values({
      id: bId,
      ownerId: bobId,
      kind: 'orcaslicer',
      name: 'B',
      invocationMethod: 'url-scheme',
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(aliceId));
    const { GET } = await import('../../src/app/api/v1/forge/slicers/route');
    const res = await GET(makeGet('http://local/api/v1/forge/slicers'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.slicers.map((s: { id: string }) => s.id)).toEqual([aId]);
  });

  it('200 admin sees all', async () => {
    const aliceId = await seedUser();
    const bobId = await seedUser();
    const adminId = await seedUser();
    await db().insert(schema.forgeSlicers).values({
      id: uid(),
      ownerId: aliceId,
      kind: 'orcaslicer',
      name: 'A',
      invocationMethod: 'url-scheme',
      createdAt: new Date(),
    });
    await db().insert(schema.forgeSlicers).values({
      id: uid(),
      ownerId: bobId,
      kind: 'bambu_studio',
      name: 'B',
      invocationMethod: 'url-scheme',
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/forge/slicers/route');
    const res = await GET(makeGet('http://local/api/v1/forge/slicers'));
    const json = await res.json();
    expect(json.slicers).toHaveLength(2);
  });

  it('200 paginates', async () => {
    const userId = await seedUser();
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      await db().insert(schema.forgeSlicers).values({
        id: uid(),
        ownerId: userId,
        kind: 'orcaslicer',
        name: `n${i}`,
        invocationMethod: 'url-scheme',
        createdAt: new Date(base + i * 1000),
      });
    }
    mockAuthenticate.mockResolvedValue(actor(userId));
    const { GET } = await import('../../src/app/api/v1/forge/slicers/route');
    const res = await GET(makeGet('http://local/api/v1/forge/slicers?limit=2'));
    const json = await res.json();
    expect(json.slicers).toHaveLength(2);
    expect(typeof json.nextCursor).toBe('string');
  });
});

// ===========================================================================
// GET / PATCH / DELETE single
// ===========================================================================

describe('GET /api/v1/forge/slicers/:id', () => {
  it('200 happy', async () => {
    const userId = await seedUser();
    const id = uid();
    await db().insert(schema.forgeSlicers).values({
      id,
      ownerId: userId,
      kind: 'orcaslicer',
      name: 'n',
      invocationMethod: 'url-scheme',
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/forge/slicers/[id]/route');
    const res = await GET(makeGet(`http://local/api/v1/forge/slicers/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
  });

  it('404 cross-owner', async () => {
    const aliceId = await seedUser();
    const bobId = await seedUser();
    const id = uid();
    await db().insert(schema.forgeSlicers).values({
      id,
      ownerId: aliceId,
      kind: 'orcaslicer',
      name: 'n',
      invocationMethod: 'url-scheme',
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(bobId));
    const { GET } = await import('../../src/app/api/v1/forge/slicers/[id]/route');
    const res = await GET(makeGet(`http://local/api/v1/forge/slicers/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(404);
  });

  it('404 missing', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/forge/slicers/[id]/route');
    const res = await GET(makeGet('http://local/api/v1/forge/slicers/no-such'), {
      params: Promise.resolve({ id: 'no-such' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/v1/forge/slicers/:id', () => {
  it('200 owner updates name', async () => {
    const userId = await seedUser();
    const id = uid();
    await db().insert(schema.forgeSlicers).values({
      id,
      ownerId: userId,
      kind: 'orcaslicer',
      name: 'old',
      invocationMethod: 'url-scheme',
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/forge/slicers/[id]/route');
    const res = await PATCH(makePatch(`http://local/api/v1/forge/slicers/${id}`, { name: 'new' }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.slicer.name).toBe('new');
  });

  it('400 attempting to patch immutable kind', async () => {
    const userId = await seedUser();
    const id = uid();
    await db().insert(schema.forgeSlicers).values({
      id,
      ownerId: userId,
      kind: 'orcaslicer',
      name: 'n',
      invocationMethod: 'url-scheme',
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/forge/slicers/[id]/route');
    const res = await PATCH(
      makePatch(`http://local/api/v1/forge/slicers/${id}`, { kind: 'cura' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/v1/forge/slicers/:id', () => {
  it('204 owner deletes', async () => {
    const userId = await seedUser();
    const id = uid();
    await db().insert(schema.forgeSlicers).values({
      id,
      ownerId: userId,
      kind: 'orcaslicer',
      name: 'n',
      invocationMethod: 'url-scheme',
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { DELETE } = await import('../../src/app/api/v1/forge/slicers/[id]/route');
    const res = await DELETE(makeDelete(`http://local/api/v1/forge/slicers/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(204);
    const remaining = await db()
      .select()
      .from(schema.forgeSlicers)
      .where(eq(schema.forgeSlicers.id, id));
    expect(remaining).toHaveLength(0);
  });

  it('404 cross-owner', async () => {
    const aliceId = await seedUser();
    const bobId = await seedUser();
    const id = uid();
    await db().insert(schema.forgeSlicers).values({
      id,
      ownerId: aliceId,
      kind: 'orcaslicer',
      name: 'n',
      invocationMethod: 'url-scheme',
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(bobId));
    const { DELETE } = await import('../../src/app/api/v1/forge/slicers/[id]/route');
    const res = await DELETE(makeDelete(`http://local/api/v1/forge/slicers/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(404);
  });
});
