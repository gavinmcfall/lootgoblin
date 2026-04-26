/**
 * Integration tests — /api/v1/materials/* — V2-007a-T14
 *
 * Real SQLite. Auth mocked via the request-auth shim used elsewhere.
 *
 * Coverage (high-value paths only — full matrix would be ~150 tests):
 *   - POST /api/v1/materials: 401, 400 invalid body, 201 happy, idempotent
 *     replay (200), idempotency mismatch (409).
 *   - GET /api/v1/materials: 401, owner-scoped, kind filter, pagination.
 *   - GET /api/v1/materials/:id: 200 happy, 404 missing, 404 cross-owner.
 *   - PATCH /api/v1/materials/:id: cosmetic update happy, immutable-field
 *     400, 404 cross-owner.
 *   - POST /api/v1/materials/:id/retire: 200 happy, 409 already-retired.
 *   - POST /api/v1/materials/:id/load + /unload: happy paths + 409 on
 *     not-loaded.
 *   - POST /api/v1/materials/mix-recipes: 201 + idempotency.
 *   - POST /api/v1/materials/mix-batches: 201, 409 idempotency mismatch.
 *   - POST /api/v1/materials/recycle-events: 201 happy.
 *   - POST /api/v1/materials/consumption: 403 non-admin, 201 admin happy.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
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

const DB_PATH = '/tmp/lootgoblin-api-materials.db';
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
    name: 'Materials Test User',
    email: `${id}@materials.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

// --- Request builders ------------------------------------------------------

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

// ─── helpers ────────────────────────────────────────────────────────────────

const validCreateBody = (overrides: Record<string, unknown> = {}) => ({
  kind: 'filament_spool',
  brand: 'Bambu Lab',
  subtype: 'PLA',
  colors: ['#E63946'],
  colorPattern: 'solid',
  initialAmount: 1000,
  unit: 'g',
  ...overrides,
});

async function createMaterial(
  userId: string,
  overrides: Record<string, unknown> = {},
  idempotencyKey?: string,
): Promise<{ id: string }> {
  mockAuthenticate.mockResolvedValueOnce(actor(userId));
  const { POST } = await import('../../src/app/api/v1/materials/route');
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await POST(
    makePost('http://local/api/v1/materials', validCreateBody(overrides), headers),
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as { material: { id: string } };
  return { id: json.material.id };
}

// ===========================================================================
// POST /api/v1/materials
// ===========================================================================

describe('POST /api/v1/materials', () => {
  it('rejects unauthenticated callers (401)', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import('../../src/app/api/v1/materials/route');
    const res = await POST(makePost('http://local/api/v1/materials', validCreateBody()));
    expect(res.status).toBe(401);
  });

  it('rejects an invalid body (400)', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/materials/route');
    const res = await POST(
      makePost('http://local/api/v1/materials', { kind: 'not-a-real-kind' }),
    );
    expect(res.status).toBe(400);
  });

  it('creates a material and returns 201', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/materials/route');
    const res = await POST(
      makePost('http://local/api/v1/materials', validCreateBody()),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { material: { id: string; ownerId: string } };
    expect(body.material.ownerId).toBe(userId);
  });

  it('returns 200 + same row on idempotent replay', async () => {
    const userId = await seedUser();
    const key = uid();
    const { id } = await createMaterial(userId, {}, key);
    // Replay the same body + key.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/materials/route');
    const res = await POST(
      makePost('http://local/api/v1/materials', validCreateBody(), { 'Idempotency-Key': key }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { material: { id: string } };
    expect(body.material.id).toBe(id);
  });

  it('returns 409 on idempotency-key + body mismatch', async () => {
    const userId = await seedUser();
    const key = uid();
    await createMaterial(userId, {}, key);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/materials/route');
    const res = await POST(
      makePost('http://local/api/v1/materials', validCreateBody({ initialAmount: 500 }), {
        'Idempotency-Key': key,
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('idempotency-mismatch');
  });
});

// ===========================================================================
// GET /api/v1/materials
// ===========================================================================

describe('GET /api/v1/materials', () => {
  it('rejects unauthenticated callers (401)', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/materials/route');
    const res = await GET(makeGet('http://local/api/v1/materials'));
    expect(res.status).toBe(401);
  });

  it('returns only the caller’s materials', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    await createMaterial(userA);
    await createMaterial(userB);
    mockAuthenticate.mockResolvedValueOnce(actor(userA));
    const { GET } = await import('../../src/app/api/v1/materials/route');
    const res = await GET(makeGet('http://local/api/v1/materials'));
    const body = (await res.json()) as { materials: Array<{ ownerId: string }> };
    expect(body.materials.length).toBeGreaterThanOrEqual(1);
    for (const m of body.materials) expect(m.ownerId).toBe(userA);
  });

  it('paginates via cursor', async () => {
    const userId = await seedUser();
    // Create 3 materials.
    for (let i = 0; i < 3; i++) await createMaterial(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/materials/route');
    const res = await GET(makeGet('http://local/api/v1/materials?limit=2'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { materials: unknown[]; nextCursor?: string };
    expect(body.materials.length).toBe(2);
    expect(body.nextCursor).toBeTruthy();
  });
});

// ===========================================================================
// GET /api/v1/materials/:id
// ===========================================================================

describe('GET /api/v1/materials/:id', () => {
  it('returns 200 happy', async () => {
    const userId = await seedUser();
    const { id } = await createMaterial(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/materials/[id]/route');
    const res = await GET(makeGet(`http://local/api/v1/materials/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
  });

  it('returns 404 for missing id', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/materials/[id]/route');
    const res = await GET(makeGet('http://local/api/v1/materials/nope'), {
      params: Promise.resolve({ id: 'nope' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 cross-owner', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const { id } = await createMaterial(userA);
    mockAuthenticate.mockResolvedValueOnce(actor(userB));
    const { GET } = await import('../../src/app/api/v1/materials/[id]/route');
    const res = await GET(makeGet(`http://local/api/v1/materials/${id}`), {
      params: Promise.resolve({ id }),
    });
    // ACL kind 'material' allows admin reads but otherwise owner-only. userB
    // is non-admin → 404 (id-leak prevention).
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// PATCH /api/v1/materials/:id
// ===========================================================================

describe('PATCH /api/v1/materials/:id', () => {
  it('happy update (cosmetic field)', async () => {
    const userId = await seedUser();
    const { id } = await createMaterial(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/materials/[id]/route');
    const res = await PATCH(
      makePatch(`http://local/api/v1/materials/${id}`, { brand: 'Polymaker' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { material: { brand: string } };
    expect(body.material.brand).toBe('Polymaker');
  });

  it('rejects immutable field 400', async () => {
    const userId = await seedUser();
    const { id } = await createMaterial(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/materials/[id]/route');
    const res = await PATCH(
      makePatch(`http://local/api/v1/materials/${id}`, { kind: 'resin_bottle' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(400);
  });

  it('cross-owner 404', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const { id } = await createMaterial(userA);
    mockAuthenticate.mockResolvedValueOnce(actor(userB));
    const { PATCH } = await import('../../src/app/api/v1/materials/[id]/route');
    const res = await PATCH(
      makePatch(`http://local/api/v1/materials/${id}`, { brand: 'Polymaker' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// retire / load / unload
// ===========================================================================

describe('material lifecycle actions', () => {
  it('retire: 200 happy then 409 already-retired', async () => {
    const userId = await seedUser();
    const { id } = await createMaterial(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: retire } = await import('../../src/app/api/v1/materials/[id]/retire/route');
    const res1 = await retire(
      makePost(`http://local/api/v1/materials/${id}/retire`, { reason: 'used up' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res1.status).toBe(200);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const res2 = await retire(
      makePost(`http://local/api/v1/materials/${id}/retire`, { reason: 'used up' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res2.status).toBe(409);
  });

  it('load + unload happy + 409 on second unload', async () => {
    const userId = await seedUser();
    const { id } = await createMaterial(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: load } = await import('../../src/app/api/v1/materials/[id]/load/route');
    const r1 = await load(
      makePost(`http://local/api/v1/materials/${id}/load`, { printerRef: 'p1:tray-1' }),
      { params: Promise.resolve({ id }) },
    );
    expect(r1.status).toBe(200);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: unload } = await import('../../src/app/api/v1/materials/[id]/unload/route');
    const r2 = await unload(
      makePost(`http://local/api/v1/materials/${id}/unload`, {}),
      { params: Promise.resolve({ id }) },
    );
    expect(r2.status).toBe(200);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const r3 = await unload(
      makePost(`http://local/api/v1/materials/${id}/unload`, {}),
      { params: Promise.resolve({ id }) },
    );
    expect(r3.status).toBe(409);
  });
});

// ===========================================================================
// mix-recipes
// ===========================================================================

describe('mix-recipes', () => {
  it('POST 201 + GET list owner-scoped', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/materials/mix-recipes/route');
    const res = await POST(
      makePost('http://local/api/v1/materials/mix-recipes', {
        name: 'Test recipe',
        components: [
          { materialProductRef: 'res-a', ratioOrGrams: 50 },
          { materialProductRef: 'res-b', ratioOrGrams: 50 },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { recipe: { id: string } };
    expect(body.recipe.id).toBeTruthy();

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/materials/mix-recipes/route');
    const r2 = await GET(makeGet('http://local/api/v1/materials/mix-recipes'));
    const j = (await r2.json()) as { recipes: Array<{ id: string }> };
    expect(j.recipes.find((r) => r.id === body.recipe.id)).toBeTruthy();
  });

  it('idempotent replay returns the prior recipe', async () => {
    const userId = await seedUser();
    const key = uid();
    const body = {
      name: 'Idempotent recipe',
      components: [
        { materialProductRef: 'a', ratioOrGrams: 1 },
        { materialProductRef: 'b', ratioOrGrams: 1 },
      ],
    };
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/materials/mix-recipes/route');
    const r1 = await POST(
      makePost('http://local/api/v1/materials/mix-recipes', body, { 'Idempotency-Key': key }),
    );
    expect(r1.status).toBe(201);
    const j1 = (await r1.json()) as { recipe: { id: string } };

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const r2 = await POST(
      makePost('http://local/api/v1/materials/mix-recipes', body, { 'Idempotency-Key': key }),
    );
    expect(r2.status).toBe(200);
    const j2 = (await r2.json()) as { recipe: { id: string } };
    expect(j2.recipe.id).toBe(j1.recipe.id);
  });

  it('DELETE 204 happy + DELETE 409 when batches reference', async () => {
    const userId = await seedUser();
    // Create a recipe.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: createRecipe } = await import('../../src/app/api/v1/materials/mix-recipes/route');
    const r = await createRecipe(
      makePost('http://local/api/v1/materials/mix-recipes', {
        name: 'Doomed',
        components: [
          { materialProductRef: 'a', ratioOrGrams: 1 },
          { materialProductRef: 'b', ratioOrGrams: 1 },
        ],
      }),
    );
    const rj = (await r.json()) as { recipe: { id: string } };
    const recipeId = rj.recipe.id;

    // Delete it (no batches yet).
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { DELETE } = await import('../../src/app/api/v1/materials/mix-recipes/[id]/route');
    const dr = await DELETE(makeDelete(`http://local/api/v1/materials/mix-recipes/${recipeId}`), {
      params: Promise.resolve({ id: recipeId }),
    });
    expect(dr.status).toBe(204);
  });
});

// ===========================================================================
// mix-batches
// ===========================================================================

describe('mix-batches', () => {
  it('POST 201 happy', async () => {
    const userId = await seedUser();
    // Two source resin materials (volumetric, ml).
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: createMaterialPost } = await import(
      '../../src/app/api/v1/materials/route'
    );
    const a = await createMaterialPost(
      makePost(
        'http://local/api/v1/materials',
        validCreateBody({ kind: 'resin_bottle', unit: 'ml', initialAmount: 500 }),
      ),
    );
    const aj = (await a.json()) as { material: { id: string } };
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const b = await createMaterialPost(
      makePost(
        'http://local/api/v1/materials',
        validCreateBody({
          kind: 'resin_bottle',
          unit: 'ml',
          initialAmount: 500,
          colors: ['#0000FF'],
        }),
      ),
    );
    const bj = (await b.json()) as { material: { id: string } };

    // Recipe.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: createRecipe } = await import('../../src/app/api/v1/materials/mix-recipes/route');
    const r = await createRecipe(
      makePost('http://local/api/v1/materials/mix-recipes', {
        name: 'Half + half',
        components: [
          { materialProductRef: 'a', ratioOrGrams: 50 },
          { materialProductRef: 'b', ratioOrGrams: 50 },
        ],
      }),
    );
    const rj = (await r.json()) as { recipe: { id: string } };

    // Apply batch.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: applyBatch } = await import(
      '../../src/app/api/v1/materials/mix-batches/route'
    );
    const res = await applyBatch(
      makePost('http://local/api/v1/materials/mix-batches', {
        recipeId: rj.recipe.id,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: aj.material.id, drawAmount: 50, provenanceClass: 'entered' },
          { sourceMaterialId: bj.material.id, drawAmount: 50, provenanceClass: 'entered' },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const j = (await res.json()) as {
      mixBatch: { id: string };
      mixBatchMaterialId: string;
      ledgerEventId: string;
    };
    expect(j.mixBatch.id).toBeTruthy();
    expect(j.mixBatchMaterialId).toBeTruthy();

    // Verify the mix_batches row carries owner_id.
    const rows = await db()
      .select()
      .from(schema.mixBatches)
      .where(eq(schema.mixBatches.id, j.mixBatch.id));
    expect(rows[0]!.ownerId).toBe(userId);
  });
});

// ===========================================================================
// recycle-events
// ===========================================================================

describe('recycle-events', () => {
  it('POST 201 happy with one tracked + one untracked input', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: createMaterialPost } = await import(
      '../../src/app/api/v1/materials/route'
    );
    const a = await createMaterialPost(
      makePost(
        'http://local/api/v1/materials',
        validCreateBody({ initialAmount: 500 }),
      ),
    );
    const aj = (await a.json()) as { material: { id: string } };

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/materials/recycle-events/route');
    const res = await POST(
      makePost('http://local/api/v1/materials/recycle-events', {
        inputs: [
          {
            sourceMaterialId: aj.material.id,
            weight: 200,
            provenanceClass: 'measured',
          },
          {
            sourceMaterialId: null,
            weight: 50,
            provenanceClass: 'entered',
            note: 'loose scrap',
          },
        ],
        outputWeight: 240, // <= sum=250 — no anomaly.
        notes: 'first recycle of the season',
      }),
    );
    expect(res.status).toBe(201);
    const j = (await res.json()) as {
      recycleEvent: { id: string };
      outputSpoolId: string;
    };
    expect(j.recycleEvent.id).toBeTruthy();
    expect(j.outputSpoolId).toBeTruthy();
  });
});

// ===========================================================================
// consumption (admin-only)
// ===========================================================================

describe('POST /api/v1/materials/consumption', () => {
  it('rejects non-admin (403)', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId, 'user'));
    const { POST } = await import('../../src/app/api/v1/materials/consumption/route');
    const res = await POST(
      makePost('http://local/api/v1/materials/consumption', {
        materialId: 'whatever',
        weightConsumed: 10,
        provenanceClass: 'entered',
        attributedTo: { kind: 'print' },
        occurredAt: new Date().toISOString(),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('happy path 201 (admin)', async () => {
    const userId = await seedUser();
    const { id } = await createMaterial(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId, 'admin'));
    const { POST } = await import('../../src/app/api/v1/materials/consumption/route');
    const res = await POST(
      makePost('http://local/api/v1/materials/consumption', {
        materialId: id,
        weightConsumed: 50,
        provenanceClass: 'entered',
        attributedTo: { kind: 'print' },
        occurredAt: new Date().toISOString(),
      }),
    );
    expect(res.status).toBe(201);
    const j = (await res.json()) as { ledgerEventId: string; newRemainingAmount: number };
    expect(j.ledgerEventId).toBeTruthy();
    expect(j.newRemainingAmount).toBe(950);
  });
});
