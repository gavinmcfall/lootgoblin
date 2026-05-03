/**
 * Integration tests — V2-005f-CF-1 T_g3.
 *
 * Covers the four new HTTP surfaces over the `printer_loadouts` table:
 *   - POST   /api/v1/materials/:id/load
 *   - POST   /api/v1/materials/:id/unload
 *   - GET    /api/v1/forge/printers/:id/loadout
 *   - GET    /api/v1/materials/:id/loadout-history
 *
 * Real SQLite (per-file path), real domain functions, mocked auth via the
 * standard request-auth shim. Coverage:
 *   - happy paths (load, swap, unload, current loadout, history)
 *   - error mapping (404/409/400/401)
 *   - ACL: cross-owner returns 404 (no id leak); admin override on load
 *
 * Plan target: 12 tests; this file ships 14 (extra cross-owner + GET tests).
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

const DB_PATH = '/tmp/lootgoblin-forge-loadout-routes.db';
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
  const dbc = db();
  await dbc.delete(schema.ledgerEvents);
  await dbc.delete(schema.printerLoadouts);
  await dbc.delete(schema.materials);
  await dbc.delete(schema.printers);
  mockAuthenticate.mockReset();
});

// ---------------------------------------------------------------------------
// Seeders
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: `loadout test user ${id.slice(0, 6)}`,
    email: `${id}@loadout.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedPrinter(ownerId: string, name = 'Test printer'): Promise<string> {
  const id = uid();
  await db().insert(schema.printers).values({
    id,
    ownerId,
    kind: 'fdm_klipper',
    name,
    connectionConfig: {},
    active: true,
    createdAt: new Date(),
  });
  return id;
}

async function seedMaterial(
  ownerId: string,
  overrides: { active?: boolean } = {},
): Promise<string> {
  const id = uid();
  await db().insert(schema.materials).values({
    id,
    ownerId,
    kind: 'filament_spool',
    brand: 'Bambu Lab',
    subtype: 'PLA',
    colors: ['#E63946'],
    colorPattern: 'solid',
    initialAmount: 1000,
    remainingAmount: 1000,
    unit: 'g',
    active: overrides.active ?? true,
    createdAt: new Date(),
  });
  return id;
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

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

function makeBareRequest(
  url: string,
  method: 'POST' | 'GET',
): import('next/server').NextRequest {
  return new Request(url, { method }) as unknown as import('next/server').NextRequest;
}

// ===========================================================================
// POST /api/v1/materials/:id/load
// ===========================================================================

describe('POST /api/v1/materials/:id/load', () => {
  it('1. happy path: empty slot → 200 with loadoutId', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    const matId = await seedMaterial(userId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/materials/${matId}/load`, {
        printerId,
        slotIndex: 0,
      }),
      { params: Promise.resolve({ id: matId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loadoutId: string };
    expect(body.loadoutId).toBeTruthy();
    expect((body as { swappedOutMaterialId?: string }).swappedOutMaterialId).toBeUndefined();
  });

  it('2. slot conflict → 200 with swappedOutMaterialId (atomic swap)', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    const matA = await seedMaterial(userId);
    const matB = await seedMaterial(userId);

    // Load A.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    const r1 = await POST(
      makePost(`http://local/api/v1/materials/${matA}/load`, {
        printerId,
        slotIndex: 1,
      }),
      { params: Promise.resolve({ id: matA }) },
    );
    expect(r1.status).toBe(200);

    // Load B into the same slot — A is swapped out.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const r2 = await POST(
      makePost(`http://local/api/v1/materials/${matB}/load`, {
        printerId,
        slotIndex: 1,
      }),
      { params: Promise.resolve({ id: matB }) },
    );
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as { loadoutId: string; swappedOutMaterialId: string };
    expect(body.swappedOutMaterialId).toBe(matA);
  });

  it('3. material already loaded ELSEWHERE → 409', async () => {
    const userId = await seedUser();
    const printerA = await seedPrinter(userId);
    const printerB = await seedPrinter(userId);
    const matId = await seedMaterial(userId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    const r1 = await POST(
      makePost(`http://local/api/v1/materials/${matId}/load`, {
        printerId: printerA,
        slotIndex: 0,
      }),
      { params: Promise.resolve({ id: matId }) },
    );
    expect(r1.status).toBe(200);

    // Try loading the SAME material into a different printer — rejected.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const r2 = await POST(
      makePost(`http://local/api/v1/materials/${matId}/load`, {
        printerId: printerB,
        slotIndex: 0,
      }),
      { params: Promise.resolve({ id: matId }) },
    );
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as { error: string };
    expect(body.error).toBe('material-already-loaded-elsewhere');
  });

  it('4. retired material → 409 material-retired', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    const matId = await seedMaterial(userId, { active: false });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/materials/${matId}/load`, {
        printerId,
        slotIndex: 0,
      }),
      { params: Promise.resolve({ id: matId }) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('material-retired');
  });

  it('5. negative slotIndex → 400 invalid-body', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    const matId = await seedMaterial(userId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/materials/${matId}/load`, {
        printerId,
        slotIndex: -1,
      }),
      { params: Promise.resolve({ id: matId }) },
    );
    expect(res.status).toBe(400);
  });

  it('6. unknown material → 404', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    const ghost = uid();
    const res = await POST(
      makePost(`http://local/api/v1/materials/${ghost}/load`, {
        printerId,
        slotIndex: 0,
      }),
      { params: Promise.resolve({ id: ghost }) },
    );
    expect(res.status).toBe(404);
  });

  it('7. unknown printer → 404', async () => {
    const userId = await seedUser();
    const matId = await seedMaterial(userId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/materials/${matId}/load`, {
        printerId: uid(),
        slotIndex: 0,
      }),
      { params: Promise.resolve({ id: matId }) },
    );
    expect(res.status).toBe(404);
  });

  it('8. cross-owner material → 404 (no id leak)', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const printerB = await seedPrinter(ownerB);
    const matA = await seedMaterial(ownerA);

    // Owner B authenticates but tries to load A's material.
    mockAuthenticate.mockResolvedValueOnce(actor(ownerB));
    const { POST } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/materials/${matA}/load`, {
        printerId: printerB,
        slotIndex: 0,
      }),
      { params: Promise.resolve({ id: matA }) },
    );
    expect(res.status).toBe(404);
  });

  it('9. cross-owner printer → 404 (no id leak)', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const matA = await seedMaterial(ownerA);
    const printerB = await seedPrinter(ownerB);

    mockAuthenticate.mockResolvedValueOnce(actor(ownerA));
    const { POST } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/materials/${matA}/load`, {
        printerId: printerB,
        slotIndex: 0,
      }),
      { params: Promise.resolve({ id: matA }) },
    );
    expect(res.status).toBe(404);
  });

  it('10. admin can load on behalf of any owner', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const matId = await seedMaterial(ownerId);

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/materials/${matId}/load`, {
        printerId,
        slotIndex: 0,
      }),
      { params: Promise.resolve({ id: matId }) },
    );
    expect(res.status).toBe(200);
  });

  it('11. unauthenticated → 401', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    const matId = await seedMaterial(userId);

    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/materials/${matId}/load`, {
        printerId,
        slotIndex: 0,
      }),
      { params: Promise.resolve({ id: matId }) },
    );
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// POST /api/v1/materials/:id/unload
// ===========================================================================

describe('POST /api/v1/materials/:id/unload', () => {
  it('12. happy path → 200 with previousPrinterId/previousSlotIndex', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    const matId = await seedMaterial(userId);

    // Load it first.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: load } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    await load(
      makePost(`http://local/api/v1/materials/${matId}/load`, {
        printerId,
        slotIndex: 2,
      }),
      { params: Promise.resolve({ id: matId }) },
    );

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: unload } = await import(
      '../../src/app/api/v1/materials/[id]/unload/route'
    );
    const res = await unload(
      makePost(`http://local/api/v1/materials/${matId}/unload`, {}),
      { params: Promise.resolve({ id: matId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      loadoutId: string;
      previousPrinterId: string;
      previousSlotIndex: number;
    };
    expect(body.previousPrinterId).toBe(printerId);
    expect(body.previousSlotIndex).toBe(2);
    expect(body.loadoutId).toBeTruthy();
  });

  it('13. not currently loaded → 409 material-not-loaded', async () => {
    const userId = await seedUser();
    const matId = await seedMaterial(userId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: unload } = await import(
      '../../src/app/api/v1/materials/[id]/unload/route'
    );
    const res = await unload(
      makePost(`http://local/api/v1/materials/${matId}/unload`, {}),
      { params: Promise.resolve({ id: matId }) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('material-not-loaded');
  });

  it('14. accepts empty body (no JSON content)', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    const matId = await seedMaterial(userId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: load } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    await load(
      makePost(`http://local/api/v1/materials/${matId}/load`, {
        printerId,
        slotIndex: 0,
      }),
      { params: Promise.resolve({ id: matId }) },
    );

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: unload } = await import(
      '../../src/app/api/v1/materials/[id]/unload/route'
    );
    const res = await unload(
      makeBareRequest(`http://local/api/v1/materials/${matId}/unload`, 'POST'),
      { params: Promise.resolve({ id: matId }) },
    );
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// GET /api/v1/forge/printers/:id/loadout
// ===========================================================================

describe('GET /api/v1/forge/printers/:id/loadout', () => {
  it('15. returns currently-loaded slots in slot order', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    const matA = await seedMaterial(userId);
    const matB = await seedMaterial(userId);

    // Load both into different slots.
    const { POST: load } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    await load(
      makePost(`http://local/api/v1/materials/${matA}/load`, {
        printerId,
        slotIndex: 1,
      }),
      { params: Promise.resolve({ id: matA }) },
    );
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    await load(
      makePost(`http://local/api/v1/materials/${matB}/load`, {
        printerId,
        slotIndex: 0,
      }),
      { params: Promise.resolve({ id: matB }) },
    );

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/printers/[id]/loadout/route'
    );
    const res = await GET(
      makeBareRequest(`http://local/api/v1/forge/printers/${printerId}/loadout`, 'GET'),
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      slots: Array<{
        slot_index: number;
        material_id: string;
        loaded_at: number;
      }>;
    };
    expect(body.slots).toHaveLength(2);
    expect(body.slots[0]!.slot_index).toBe(0);
    expect(body.slots[0]!.material_id).toBe(matB);
    expect(body.slots[1]!.slot_index).toBe(1);
    expect(body.slots[1]!.material_id).toBe(matA);
    expect(typeof body.slots[0]!.loaded_at).toBe('number');
  });

  it('16. cross-owner printer → 404', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const printerA = await seedPrinter(ownerA);

    mockAuthenticate.mockResolvedValueOnce(actor(ownerB));
    const { GET } = await import(
      '../../src/app/api/v1/forge/printers/[id]/loadout/route'
    );
    const res = await GET(
      makeBareRequest(`http://local/api/v1/forge/printers/${printerA}/loadout`, 'GET'),
      { params: Promise.resolve({ id: printerA }) },
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// GET /api/v1/materials/:id/loadout-history
// ===========================================================================

describe('GET /api/v1/materials/:id/loadout-history', () => {
  it('17. returns history newest-first across load → unload → load', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    const matId = await seedMaterial(userId);

    const { POST: load } = await import(
      '../../src/app/api/v1/materials/[id]/load/route'
    );
    const { POST: unload } = await import(
      '../../src/app/api/v1/materials/[id]/unload/route'
    );

    // 1st load → unload → 2nd load (different slot).
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    await load(
      makePost(`http://local/api/v1/materials/${matId}/load`, {
        printerId,
        slotIndex: 0,
      }),
      { params: Promise.resolve({ id: matId }) },
    );
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    await unload(
      makePost(`http://local/api/v1/materials/${matId}/unload`, {}),
      { params: Promise.resolve({ id: matId }) },
    );
    // Tiny sleep to avoid identical loadedAt timestamps for the deterministic
    // newest-first ordering check.
    await new Promise((r) => setTimeout(r, 10));
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    await load(
      makePost(`http://local/api/v1/materials/${matId}/load`, {
        printerId,
        slotIndex: 2,
      }),
      { params: Promise.resolve({ id: matId }) },
    );

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/materials/[id]/loadout-history/route'
    );
    const res = await GET(
      makeBareRequest(
        `http://local/api/v1/materials/${matId}/loadout-history`,
        'GET',
      ),
      { params: Promise.resolve({ id: matId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      history: Array<{
        printer_id: string;
        slot_index: number;
        loaded_at: number;
        unloaded_at: number | null;
      }>;
    };
    expect(body.history).toHaveLength(2);
    // Newest first → the 2nd load (slot 2, still open) is first.
    expect(body.history[0]!.slot_index).toBe(2);
    expect(body.history[0]!.unloaded_at).toBeNull();
    expect(body.history[1]!.slot_index).toBe(0);
    expect(typeof body.history[1]!.unloaded_at).toBe('number');
  });

  it('18. cross-owner material → 404', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const matA = await seedMaterial(ownerA);

    mockAuthenticate.mockResolvedValueOnce(actor(ownerB));
    const { GET } = await import(
      '../../src/app/api/v1/materials/[id]/loadout-history/route'
    );
    const res = await GET(
      makeBareRequest(
        `http://local/api/v1/materials/${matA}/loadout-history`,
        'GET',
      ),
      { params: Promise.resolve({ id: matA }) },
    );
    expect(res.status).toBe(404);
  });
});
