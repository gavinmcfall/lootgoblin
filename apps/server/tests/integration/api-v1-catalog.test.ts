/**
 * Integration tests — /api/v1/catalog/* — V2-007b T_B2.
 *
 * Real SQLite. Auth mocked via the request-auth shim used elsewhere.
 *
 * Coverage (high-value paths only):
 *   - 401 without auth
 *   - 200 list (system + own)
 *   - 201 create user entry
 *   - 201 admin-create system entry
 *   - 403 non-admin trying to create system
 *   - 400 invalid body
 *   - 404 cross-owner read
 *   - 409 idempotent id-conflict
 *   - 200 PATCH happy path
 *   - 204 DELETE happy path
 *   - 200 search returns results
 *   - 401 / 403 / 404 across resin endpoints (smoke)
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
  const actual =
    await importOriginal<typeof import('../../src/auth/request-auth')>();
  return {
    ...actual,
    authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  };
});

const DB_PATH = '/tmp/lootgoblin-api-catalog.db';
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

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Catalog Test User',
    email: `${id}@catalog.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

// ─── Request builders ───────────────────────────────────────────────────────

function makePost(
  url: string,
  body: unknown,
): import('next/server').NextRequest {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

function makeGet(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'GET' }) as unknown as import('next/server').NextRequest;
}

function makePatch(
  url: string,
  body: unknown,
): import('next/server').NextRequest {
  return new Request(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

function makeDelete(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'DELETE' }) as unknown as import('next/server').NextRequest;
}

const validUserBody = (overrides: Record<string, unknown> = {}) => ({
  brand: 'IntegrationBrand',
  subtype: 'PLA',
  colors: ['#A1B2C3'],
  colorPattern: 'solid',
  source: 'user',
  ...overrides,
});

const validSystemBody = (overrides: Record<string, unknown> = {}) => ({
  brand: 'SystemBrand',
  subtype: 'PLA',
  colors: ['#11AA22'],
  colorPattern: 'solid',
  source: 'system:spoolmandb',
  ownerId: null,
  ...overrides,
});

// ═══════════════════════════════════════════════════════════════════════════
// FILAMENTS
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/catalog/filaments', () => {
  it('rejects unauthenticated callers (401)', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import(
      '../../src/app/api/v1/catalog/filaments/route'
    );
    const res = await POST(
      makePost('http://local/api/v1/catalog/filaments', validUserBody()),
    );
    expect(res.status).toBe(401);
  });

  it('rejects an invalid body (400)', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/catalog/filaments/route'
    );
    const res = await POST(
      makePost('http://local/api/v1/catalog/filaments', { foo: 'bar' }),
    );
    expect(res.status).toBe(400);
  });

  it('user creates custom entry → 201', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/catalog/filaments/route'
    );
    const res = await POST(
      makePost('http://local/api/v1/catalog/filaments', validUserBody()),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      product: { ownerId: string; source: string };
    };
    expect(json.product.ownerId).toBe(userId);
    expect(json.product.source).toBe('user');
  });

  it('admin creates system entry → 201', async () => {
    const adminId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(
      '../../src/app/api/v1/catalog/filaments/route'
    );
    const res = await POST(
      makePost('http://local/api/v1/catalog/filaments', validSystemBody()),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      product: { ownerId: string | null; source: string };
    };
    expect(json.product.ownerId).toBeNull();
    expect(json.product.source).toBe('system:spoolmandb');
  });

  it('non-admin trying to create system → 403', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/catalog/filaments/route'
    );
    const res = await POST(
      makePost('http://local/api/v1/catalog/filaments', validSystemBody()),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('admin-required');
  });

  it('idempotent re-create: same id + different body → 409', async () => {
    const adminId = await seedUser();
    const stableId = `int:bambu-${uid()}`;
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(
      '../../src/app/api/v1/catalog/filaments/route'
    );
    const res1 = await POST(
      makePost(
        'http://local/api/v1/catalog/filaments',
        validSystemBody({ id: stableId }),
      ),
    );
    expect(res1.status).toBe(201);

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const res2 = await POST(
      makePost(
        'http://local/api/v1/catalog/filaments',
        validSystemBody({ id: stableId, colors: ['#FFFFFF'] }),
      ),
    );
    expect(res2.status).toBe(409);
    const body = (await res2.json()) as { error: string };
    expect(body.error).toBe('id-conflict');
  });
});

describe('GET /api/v1/catalog/filaments', () => {
  it('rejects unauthenticated callers (401)', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import(
      '../../src/app/api/v1/catalog/filaments/route'
    );
    const res = await GET(makeGet('http://local/api/v1/catalog/filaments'));
    expect(res.status).toBe(401);
  });

  it('returns mixed system + own (no cross-owner customs)', async () => {
    const adminId = await seedUser();
    const userA = await seedUser();
    const userB = await seedUser();

    // admin-create a system row
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(
      '../../src/app/api/v1/catalog/filaments/route'
    );
    const sysRes = await POST(
      makePost(
        'http://local/api/v1/catalog/filaments',
        validSystemBody({ brand: 'GET-Sys' }),
      ),
    );
    expect(sysRes.status).toBe(201);
    const sysId = ((await sysRes.json()) as { product: { id: string } })
      .product.id;

    // user-A creates a custom
    mockAuthenticate.mockResolvedValueOnce(actor(userA));
    const ownRes = await POST(
      makePost(
        'http://local/api/v1/catalog/filaments',
        validUserBody({ brand: 'GET-OwnA' }),
      ),
    );
    expect(ownRes.status).toBe(201);
    const ownId = ((await ownRes.json()) as { product: { id: string } })
      .product.id;

    // user-B creates a custom (should NOT be visible to user-A)
    mockAuthenticate.mockResolvedValueOnce(actor(userB));
    const crossRes = await POST(
      makePost(
        'http://local/api/v1/catalog/filaments',
        validUserBody({ brand: 'GET-OwnB' }),
      ),
    );
    expect(crossRes.status).toBe(201);
    const crossId = ((await crossRes.json()) as { product: { id: string } })
      .product.id;

    mockAuthenticate.mockResolvedValueOnce(actor(userA));
    const { GET } = await import(
      '../../src/app/api/v1/catalog/filaments/route'
    );
    const res = await GET(
      makeGet('http://local/api/v1/catalog/filaments?limit=200'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: Array<{ id: string }> };
    const ids = new Set(body.products.map((p) => p.id));
    expect(ids.has(sysId)).toBe(true);
    expect(ids.has(ownId)).toBe(true);
    expect(ids.has(crossId)).toBe(false);
  });
});

describe('GET /api/v1/catalog/filaments/:id', () => {
  it('cross-owner read → 404', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userA));
    const { POST } = await import(
      '../../src/app/api/v1/catalog/filaments/route'
    );
    const created = await POST(
      makePost(
        'http://local/api/v1/catalog/filaments',
        validUserBody({ brand: 'XO-A' }),
      ),
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { product: { id: string } })
      .product.id;

    mockAuthenticate.mockResolvedValueOnce(actor(userB));
    const { GET } = await import(
      '../../src/app/api/v1/catalog/filaments/[id]/route'
    );
    const res = await GET(
      makeGet(`http://local/api/v1/catalog/filaments/${id}`),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/v1/catalog/filaments/:id', () => {
  it('owner can patch → 200', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/catalog/filaments/route'
    );
    const created = await POST(
      makePost(
        'http://local/api/v1/catalog/filaments',
        validUserBody({ brand: 'Patchable' }),
      ),
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { product: { id: string } })
      .product.id;

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import(
      '../../src/app/api/v1/catalog/filaments/[id]/route'
    );
    const res = await PATCH(
      makePatch(`http://local/api/v1/catalog/filaments/${id}`, {
        brand: 'Patched',
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { product: { brand: string } };
    expect(body.product.brand).toBe('Patched');
  });
});

describe('DELETE /api/v1/catalog/filaments/:id', () => {
  it('owner can delete → 204', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/catalog/filaments/route'
    );
    const created = await POST(
      makePost(
        'http://local/api/v1/catalog/filaments',
        validUserBody({ brand: 'Deletable' }),
      ),
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { product: { id: string } })
      .product.id;

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { DELETE } = await import(
      '../../src/app/api/v1/catalog/filaments/[id]/route'
    );
    const res = await DELETE(
      makeDelete(`http://local/api/v1/catalog/filaments/${id}`),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(204);
  });
});

describe('GET /api/v1/catalog/filaments/search', () => {
  it('returns matching results (200)', async () => {
    const adminId = await seedUser();
    const userId = await seedUser();
    const tag = `IntSearch-${uid().slice(0, 8)}`;

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(
      '../../src/app/api/v1/catalog/filaments/route'
    );
    const created = await POST(
      makePost(
        'http://local/api/v1/catalog/filaments',
        validSystemBody({ brand: tag }),
      ),
    );
    expect(created.status).toBe(201);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/catalog/filaments/search/route'
    );
    const res = await GET(
      makeGet(
        `http://local/api/v1/catalog/filaments/search?q=${encodeURIComponent(tag)}`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: Array<{ brand: string }> };
    expect(body.products.some((p) => p.brand === tag)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RESINS — smoke
// ═══════════════════════════════════════════════════════════════════════════

describe('/api/v1/catalog/resins smoke', () => {
  it('user creates own resin → 201; cross-owner GET → 404; DELETE own → 204', async () => {
    const userA = await seedUser();
    const userB = await seedUser();

    mockAuthenticate.mockResolvedValueOnce(actor(userA));
    const { POST } = await import(
      '../../src/app/api/v1/catalog/resins/route'
    );
    const create = await POST(
      makePost('http://local/api/v1/catalog/resins', {
        brand: 'ResinIntegration',
        subtype: 'standard',
        source: 'user',
        colors: ['#445566'],
      }),
    );
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { product: { id: string } })
      .product.id;

    // cross-owner GET → 404
    mockAuthenticate.mockResolvedValueOnce(actor(userB));
    const { GET: getOne } = await import(
      '../../src/app/api/v1/catalog/resins/[id]/route'
    );
    const x = await getOne(
      makeGet(`http://local/api/v1/catalog/resins/${id}`),
      { params: Promise.resolve({ id }) },
    );
    expect(x.status).toBe(404);

    // owner DELETE → 204
    mockAuthenticate.mockResolvedValueOnce(actor(userA));
    const { DELETE } = await import(
      '../../src/app/api/v1/catalog/resins/[id]/route'
    );
    const d = await DELETE(
      makeDelete(`http://local/api/v1/catalog/resins/${id}`),
      { params: Promise.resolve({ id }) },
    );
    expect(d.status).toBe(204);
  });

  it('non-admin cannot create system resin → 403', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/catalog/resins/route'
    );
    const res = await POST(
      makePost('http://local/api/v1/catalog/resins', {
        brand: 'NoBypass',
        subtype: 'standard',
        source: 'system:polymaker-preset',
        ownerId: null,
      }),
    );
    expect(res.status).toBe(403);
  });

  it('GET list 401 unauthenticated', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/catalog/resins/route');
    const res = await GET(makeGet('http://local/api/v1/catalog/resins'));
    expect(res.status).toBe(401);
  });
});
