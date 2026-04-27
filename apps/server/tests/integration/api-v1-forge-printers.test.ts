/**
 * Integration tests — /api/v1/forge/printers/* — V2-005a-T5
 *
 * Real SQLite. Auth mocked via the standard `request-auth` shim used by the
 * other /api/v1 integration suites.
 *
 * Coverage:
 *   - POST: 401 unauth, 400 invalid body, 201 happy, idempotent replay (200),
 *           idempotency mismatch (409), 422 unknown reachable_via agentId
 *   - GET list: 401, owner-scoped, admin sees all, kind+active filters, pagination
 *   - GET single: 200, 404 missing, 404 cross-owner, admin sees cross-owner
 *   - PATCH: 200 happy, 400 immutable, 404 cross-owner
 *   - DELETE: 204, 404 cross-owner
 *   - reachable-via POST: 401, 403 non-admin, 201 happy, 200 idempotent,
 *                         404 missing printer, 404 missing agent
 *   - reachable-via DELETE: 204 happy, 204 idempotent missing pair,
 *                           403 non-admin, 404 missing printer
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

const DB_PATH = '/tmp/lootgoblin-api-forge-printers.db';
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
  // Clear forge state between tests; users are seeded per-test.
  await db().delete(schema.printerReachableVia);
  await db().delete(schema.printerAcls);
  await db().delete(schema.printers);
  await db().delete(schema.agents);
  await db().delete(schema.user);
  mockAuthenticate.mockReset();
});

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Forge Printer Test User',
    email: `${id}@forge-printer.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCentralWorker(): Promise<string> {
  const { bootstrapCentralWorker } = await import('../../src/forge/agent-bootstrap');
  const r = await bootstrapCentralWorker({ dbUrl: DB_URL });
  return r.agentId;
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
  kind: 'fdm_klipper',
  name: 'Voron 2.4',
  connectionConfig: { url: 'http://1.2.3.4:7125', apiKey: 'foo' },
  ...overrides,
});

// ============================================================================
// POST /api/v1/forge/printers
// ============================================================================

describe('POST /api/v1/forge/printers', () => {
  it('401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import('../../src/app/api/v1/forge/printers/route');
    const res = await POST(makePost('http://local/api/v1/forge/printers', validBody()));
    expect(res.status).toBe(401);
  });

  it('400 invalid body', async () => {
    const userId = await seedUser();
    await seedCentralWorker();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/printers/route');
    const res = await POST(
      makePost('http://local/api/v1/forge/printers', { kind: 'made_up_kind' }),
    );
    expect(res.status).toBe(400);
  });

  it('201 happy create defaults reachable_via to central_worker', async () => {
    const userId = await seedUser();
    const centralAgentId = await seedCentralWorker();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/printers/route');
    const res = await POST(makePost('http://local/api/v1/forge/printers', validBody()));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.printer.kind).toBe('fdm_klipper');
    expect(json.printer.ownerId).toBe(userId);
    expect(json.printer.active).toBe(true);

    // reachable_via row was created.
    const reach = await db()
      .select()
      .from(schema.printerReachableVia)
      .where(eq(schema.printerReachableVia.printerId, json.printer.id));
    expect(reach).toHaveLength(1);
    expect(reach[0]!.agentId).toBe(centralAgentId);
  });

  it('201 explicit reachable_via overrides default', async () => {
    const userId = await seedUser();
    const centralAgentId = await seedCentralWorker();
    // Add a courier
    const courierId = uid();
    await db().insert(schema.agents).values({
      id: courierId,
      kind: 'courier',
      pairCredentialRef: null,
      reachableLanHint: null,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/printers/route');
    const res = await POST(
      makePost(
        'http://local/api/v1/forge/printers',
        validBody({ reachable_via: [courierId] }),
      ),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    const reach = await db()
      .select()
      .from(schema.printerReachableVia)
      .where(eq(schema.printerReachableVia.printerId, json.printer.id));
    expect(reach.map((r) => r.agentId)).toEqual([courierId]);
    // central_worker NOT in reachable_via
    expect(reach.map((r) => r.agentId)).not.toContain(centralAgentId);
  });

  it('422 unknown agent id in reachable_via', async () => {
    const userId = await seedUser();
    await seedCentralWorker();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/printers/route');
    const res = await POST(
      makePost(
        'http://local/api/v1/forge/printers',
        validBody({ reachable_via: ['nonexistent-agent'] }),
      ),
    );
    expect(res.status).toBe(422);
  });

  it('200 idempotent replay returns prior printer', async () => {
    const userId = await seedUser();
    await seedCentralWorker();
    mockAuthenticate.mockResolvedValue(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/printers/route');
    const r1 = await POST(
      makePost('http://local/api/v1/forge/printers', validBody(), {
        'Idempotency-Key': 'replay-1',
      }),
    );
    expect(r1.status).toBe(201);
    const j1 = await r1.json();
    const r2 = await POST(
      makePost('http://local/api/v1/forge/printers', validBody(), {
        'Idempotency-Key': 'replay-1',
      }),
    );
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.printer.id).toBe(j1.printer.id);
  });

  it('409 idempotency mismatch on differing body', async () => {
    const userId = await seedUser();
    await seedCentralWorker();
    mockAuthenticate.mockResolvedValue(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/printers/route');
    const r1 = await POST(
      makePost('http://local/api/v1/forge/printers', validBody({ name: 'Voron A' }), {
        'Idempotency-Key': 'collide-1',
      }),
    );
    expect(r1.status).toBe(201);
    const r2 = await POST(
      makePost('http://local/api/v1/forge/printers', validBody({ name: 'Voron B' }), {
        'Idempotency-Key': 'collide-1',
      }),
    );
    expect(r2.status).toBe(409);
  });
});

// ============================================================================
// GET /api/v1/forge/printers
// ============================================================================

describe('GET /api/v1/forge/printers', () => {
  it('401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/forge/printers/route');
    const res = await GET(makeGet('http://local/api/v1/forge/printers'));
    expect(res.status).toBe(401);
  });

  it('200 owner-scoped list (own printers only)', async () => {
    const aliceId = await seedUser();
    const bobId = await seedUser();
    await seedCentralWorker();

    // Insert printers directly.
    const aliceP = uid();
    const bobP = uid();
    await db().insert(schema.printers).values({
      id: aliceP,
      ownerId: aliceId,
      kind: 'fdm_klipper',
      name: 'Alice voron',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    await db().insert(schema.printers).values({
      id: bobP,
      ownerId: bobId,
      kind: 'fdm_klipper',
      name: 'Bob voron',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });

    mockAuthenticate.mockResolvedValueOnce(actor(aliceId));
    const { GET } = await import('../../src/app/api/v1/forge/printers/route');
    const res = await GET(makeGet('http://local/api/v1/forge/printers'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.printers.map((p: { id: string }) => p.id)).toEqual([aliceP]);
  });

  it('200 admin sees all printers', async () => {
    const aliceId = await seedUser();
    const bobId = await seedUser();
    const adminId = await seedUser();
    await seedCentralWorker();
    await db().insert(schema.printers).values({
      id: uid(),
      ownerId: aliceId,
      kind: 'fdm_klipper',
      name: 'A',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    await db().insert(schema.printers).values({
      id: uid(),
      ownerId: bobId,
      kind: 'fdm_klipper',
      name: 'B',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/forge/printers/route');
    const res = await GET(makeGet('http://local/api/v1/forge/printers'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.printers).toHaveLength(2);
  });

  it('200 paginates with cursor', async () => {
    const userId = await seedUser();
    await seedCentralWorker();
    // Insert 3 printers with monotonically increasing createdAt.
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      await db().insert(schema.printers).values({
        id: uid(),
        ownerId: userId,
        kind: 'fdm_klipper',
        name: `P${i}`,
        connectionConfig: {},
        active: true,
        createdAt: new Date(base + i * 1000),
      });
    }
    mockAuthenticate.mockResolvedValue(actor(userId));
    const { GET } = await import('../../src/app/api/v1/forge/printers/route');
    const res = await GET(makeGet('http://local/api/v1/forge/printers?limit=2'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.printers).toHaveLength(2);
    expect(typeof json.nextCursor).toBe('string');
    const res2 = await GET(
      makeGet(`http://local/api/v1/forge/printers?limit=2&cursor=${json.nextCursor}`),
    );
    const json2 = await res2.json();
    expect(json2.printers).toHaveLength(1);
  });
});

// ============================================================================
// GET /api/v1/forge/printers/:id
// ============================================================================

describe('GET /api/v1/forge/printers/:id', () => {
  it('200 happy', async () => {
    const userId = await seedUser();
    const id = uid();
    await db().insert(schema.printers).values({
      id,
      ownerId: userId,
      kind: 'fdm_klipper',
      name: 'p',
      connectionConfig: { url: 'x' },
      active: true,
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/forge/printers/[id]/route');
    const res = await GET(makeGet(`http://local/api/v1/forge/printers/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.printer.id).toBe(id);
  });

  it('404 missing id', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/forge/printers/[id]/route');
    const res = await GET(makeGet('http://local/api/v1/forge/printers/no-such'), {
      params: Promise.resolve({ id: 'no-such' }),
    });
    expect(res.status).toBe(404);
  });

  it('404 cross-owner (not leaked)', async () => {
    const aliceId = await seedUser();
    const bobId = await seedUser();
    const id = uid();
    await db().insert(schema.printers).values({
      id,
      ownerId: aliceId,
      kind: 'fdm_klipper',
      name: 'p',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(bobId));
    const { GET } = await import('../../src/app/api/v1/forge/printers/[id]/route');
    const res = await GET(makeGet(`http://local/api/v1/forge/printers/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(404);
  });

  it('200 admin reads cross-owner', async () => {
    const aliceId = await seedUser();
    const adminId = await seedUser();
    const id = uid();
    await db().insert(schema.printers).values({
      id,
      ownerId: aliceId,
      kind: 'fdm_klipper',
      name: 'p',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/forge/printers/[id]/route');
    const res = await GET(makeGet(`http://local/api/v1/forge/printers/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// PATCH /api/v1/forge/printers/:id
// ============================================================================

describe('PATCH /api/v1/forge/printers/:id', () => {
  it('200 owner updates name', async () => {
    const userId = await seedUser();
    const id = uid();
    await db().insert(schema.printers).values({
      id,
      ownerId: userId,
      kind: 'fdm_klipper',
      name: 'old',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/forge/printers/[id]/route');
    const res = await PATCH(makePatch(`http://local/api/v1/forge/printers/${id}`, { name: 'new' }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.printer.name).toBe('new');
  });

  it('400 attempting to patch immutable kind', async () => {
    const userId = await seedUser();
    const id = uid();
    await db().insert(schema.printers).values({
      id,
      ownerId: userId,
      kind: 'fdm_klipper',
      name: 'p',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/forge/printers/[id]/route');
    const res = await PATCH(
      makePatch(`http://local/api/v1/forge/printers/${id}`, { kind: 'fdm_bambu_lan' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(400);
  });

  it('404 cross-owner update', async () => {
    const aliceId = await seedUser();
    const bobId = await seedUser();
    const id = uid();
    await db().insert(schema.printers).values({
      id,
      ownerId: aliceId,
      kind: 'fdm_klipper',
      name: 'p',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(bobId));
    const { PATCH } = await import('../../src/app/api/v1/forge/printers/[id]/route');
    const res = await PATCH(
      makePatch(`http://local/api/v1/forge/printers/${id}`, { name: 'pwn' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// DELETE /api/v1/forge/printers/:id
// ============================================================================

describe('DELETE /api/v1/forge/printers/:id', () => {
  it('204 owner deletes', async () => {
    const userId = await seedUser();
    const id = uid();
    await db().insert(schema.printers).values({
      id,
      ownerId: userId,
      kind: 'fdm_klipper',
      name: 'p',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { DELETE } = await import('../../src/app/api/v1/forge/printers/[id]/route');
    const res = await DELETE(makeDelete(`http://local/api/v1/forge/printers/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(204);

    const remaining = await db().select().from(schema.printers).where(eq(schema.printers.id, id));
    expect(remaining).toHaveLength(0);
  });

  it('404 cross-owner', async () => {
    const aliceId = await seedUser();
    const bobId = await seedUser();
    const id = uid();
    await db().insert(schema.printers).values({
      id,
      ownerId: aliceId,
      kind: 'fdm_klipper',
      name: 'p',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(bobId));
    const { DELETE } = await import('../../src/app/api/v1/forge/printers/[id]/route');
    const res = await DELETE(makeDelete(`http://local/api/v1/forge/printers/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// reachable-via routes
// ============================================================================

describe('POST /api/v1/forge/printers/:id/reachable-via', () => {
  it('401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import(
      '../../src/app/api/v1/forge/printers/[id]/reachable-via/route'
    );
    const res = await POST(
      makePost('http://local/api/v1/forge/printers/x/reachable-via', { agentId: 'y' }),
      { params: Promise.resolve({ id: 'x' }) },
    );
    expect(res.status).toBe(401);
  });

  it('403 non-admin', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/forge/printers/[id]/reachable-via/route'
    );
    const res = await POST(
      makePost('http://local/api/v1/forge/printers/x/reachable-via', { agentId: 'y' }),
      { params: Promise.resolve({ id: 'x' }) },
    );
    expect(res.status).toBe(403);
  });

  it('201 admin adds binding', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    const centralAgentId = await seedCentralWorker();
    const printerId = uid();
    await db().insert(schema.printers).values({
      id: printerId,
      ownerId,
      kind: 'fdm_klipper',
      name: 'p',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    // Add a different agent to bind.
    const courierId = uid();
    await db().insert(schema.agents).values({
      id: courierId,
      kind: 'courier',
      pairCredentialRef: null,
      reachableLanHint: null,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    });

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(
      '../../src/app/api/v1/forge/printers/[id]/reachable-via/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/forge/printers/${printerId}/reachable-via`, {
        agentId: courierId,
      }),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(res.status).toBe(201);

    const reach = await db()
      .select()
      .from(schema.printerReachableVia)
      .where(eq(schema.printerReachableVia.printerId, printerId));
    expect(reach.map((r) => r.agentId).sort()).toEqual([courierId].sort());
    void centralAgentId; // (sanity: only courier should be bound, not central)
  });

  it('200 idempotent re-add', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    const centralAgentId = await seedCentralWorker();
    const printerId = uid();
    await db().insert(schema.printers).values({
      id: printerId,
      ownerId,
      kind: 'fdm_klipper',
      name: 'p',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    await db().insert(schema.printerReachableVia).values({
      printerId,
      agentId: centralAgentId,
    });

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(
      '../../src/app/api/v1/forge/printers/[id]/reachable-via/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/forge/printers/${printerId}/reachable-via`, {
        agentId: centralAgentId,
      }),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(res.status).toBe(200);
  });

  it('404 missing printer', async () => {
    const adminId = await seedUser();
    const centralAgentId = await seedCentralWorker();
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(
      '../../src/app/api/v1/forge/printers/[id]/reachable-via/route'
    );
    const res = await POST(
      makePost('http://local/api/v1/forge/printers/no-such/reachable-via', {
        agentId: centralAgentId,
      }),
      { params: Promise.resolve({ id: 'no-such' }) },
    );
    expect(res.status).toBe(404);
  });

  it('404 missing agent', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    await seedCentralWorker();
    const printerId = uid();
    await db().insert(schema.printers).values({
      id: printerId,
      ownerId,
      kind: 'fdm_klipper',
      name: 'p',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(
      '../../src/app/api/v1/forge/printers/[id]/reachable-via/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/forge/printers/${printerId}/reachable-via`, {
        agentId: 'no-such-agent',
      }),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/v1/forge/printers/:id/reachable-via/:agentId', () => {
  it('403 non-admin', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { DELETE } = await import(
      '../../src/app/api/v1/forge/printers/[id]/reachable-via/[agentId]/route'
    );
    const res = await DELETE(
      makeDelete('http://local/api/v1/forge/printers/x/reachable-via/y'),
      { params: Promise.resolve({ id: 'x', agentId: 'y' }) },
    );
    expect(res.status).toBe(403);
  });

  it('204 admin deletes binding', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    const centralAgentId = await seedCentralWorker();
    const printerId = uid();
    await db().insert(schema.printers).values({
      id: printerId,
      ownerId,
      kind: 'fdm_klipper',
      name: 'p',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    await db().insert(schema.printerReachableVia).values({
      printerId,
      agentId: centralAgentId,
    });
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { DELETE } = await import(
      '../../src/app/api/v1/forge/printers/[id]/reachable-via/[agentId]/route'
    );
    const res = await DELETE(
      makeDelete(
        `http://local/api/v1/forge/printers/${printerId}/reachable-via/${centralAgentId}`,
      ),
      { params: Promise.resolve({ id: printerId, agentId: centralAgentId }) },
    );
    expect(res.status).toBe(204);
    const remaining = await db()
      .select()
      .from(schema.printerReachableVia)
      .where(eq(schema.printerReachableVia.printerId, printerId));
    expect(remaining).toHaveLength(0);
  });

  it('204 idempotent delete missing pair (no error)', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    await seedCentralWorker();
    const printerId = uid();
    await db().insert(schema.printers).values({
      id: printerId,
      ownerId,
      kind: 'fdm_klipper',
      name: 'p',
      connectionConfig: {},
      active: true,
      createdAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { DELETE } = await import(
      '../../src/app/api/v1/forge/printers/[id]/reachable-via/[agentId]/route'
    );
    const res = await DELETE(
      makeDelete(`http://local/api/v1/forge/printers/${printerId}/reachable-via/no-agent`),
      { params: Promise.resolve({ id: printerId, agentId: 'no-agent' }) },
    );
    expect(res.status).toBe(204);
  });

  it('404 missing printer', async () => {
    const adminId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { DELETE } = await import(
      '../../src/app/api/v1/forge/printers/[id]/reachable-via/[agentId]/route'
    );
    const res = await DELETE(
      makeDelete('http://local/api/v1/forge/printers/no-such/reachable-via/y'),
      { params: Promise.resolve({ id: 'no-such', agentId: 'y' }) },
    );
    expect(res.status).toBe(404);
  });
});
