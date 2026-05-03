/**
 * End-to-end Materials lifecycle through the HTTP API — V2-007a-T15
 *
 * Full chain: HTTP route handler → auth → ACL → domain function → DB → ledger
 * → response. Verifies the wiring + multi-step user journeys land coherently.
 *
 * Per-file SQLite path. Real handlers + real domain functions. No msw — these
 * tests don't hit any external upstream.
 *
 * Coverage:
 *   1. Full lifecycle: POST /materials → POST /:id/load → POST /consumption
 *      (admin) → POST /:id/retire. Asserts state transitions through GET, +
 *      ledger has the four expected events with correct subjectIds.
 *   2. Idempotency-Key: same key + same body → 200; different body → 409.
 *   3. Cross-owner protection on retire (404).
 *   4. Multi-color material round-trip (colors[] + colorPattern preserved).
 *   5. Validation surface: empty colors array → 400.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { eq, and, inArray } from 'drizzle-orm';

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

const DB_PATH = '/tmp/lootgoblin-e2e-materials-lifecycle.db';
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
  // Wipe per-test state to keep tests independent. Order respects FK
  // dependencies (children first). User rows are NOT wiped — each test seeds
  // its own users.
  const dbc = db();
  await dbc.delete(schema.ledgerEvents);
  await dbc.delete(schema.recycleEvents);
  await dbc.delete(schema.mixBatches);
  await dbc.delete(schema.mixRecipes);
  // V2-005f-CF-1 T_g1: printer_loadouts FK-references both materials and
  // printers; clean it before either parent.
  await dbc.delete(schema.printerLoadouts);
  await dbc.delete(schema.materials);
  await dbc.delete(schema.printers);
  mockAuthenticate.mockReset();
});

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: `E2E ML User ${id.slice(0, 8)}`,
    email: `${id}@e2e-ml.test`,
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

// ─── HTTP-level seeders ─────────────────────────────────────────────────────

async function postMaterial(opts: {
  ownerId: string;
  body: Record<string, unknown>;
  idempotencyKey?: string;
  asAdmin?: boolean;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId, opts.asAdmin ? 'admin' : 'user'));
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const { POST } = await import('../../src/app/api/v1/materials/route');
  const res = await POST(makePost('http://local/api/v1/materials', opts.body, headers));
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

async function getMaterial(opts: {
  ownerId: string;
  id: string;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const { GET } = await import('../../src/app/api/v1/materials/[id]/route');
  const res = await GET(makeGet(`http://local/api/v1/materials/${opts.id}`), {
    params: Promise.resolve({ id: opts.id }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

async function loadMaterial(opts: {
  ownerId: string;
  id: string;
  printerId: string;
  slotIndex: number;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const { POST } = await import('../../src/app/api/v1/materials/[id]/load/route');
  const res = await POST(
    makePost(`http://local/api/v1/materials/${opts.id}/load`, {
      printerId: opts.printerId,
      slotIndex: opts.slotIndex,
    }),
    { params: Promise.resolve({ id: opts.id }) },
  );
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

async function seedTestPrinter(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.printers).values({
    id,
    ownerId,
    kind: 'fdm_klipper',
    name: `Test printer ${id.slice(0, 8)}`,
    connectionConfig: {},
    active: true,
    createdAt: new Date(),
  });
  return id;
}

async function postConsumption(opts: {
  adminId: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.adminId, 'admin'));
  const { POST } = await import('../../src/app/api/v1/materials/consumption/route');
  const res = await POST(makePost('http://local/api/v1/materials/consumption', opts.body));
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

async function retireMaterialHttp(opts: {
  ownerId: string;
  id: string;
  reason: string;
  acknowledgeLoaded?: boolean;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const body: Record<string, unknown> = { reason: opts.reason };
  if (opts.acknowledgeLoaded !== undefined) body.acknowledgeLoaded = opts.acknowledgeLoaded;
  const { POST } = await import('../../src/app/api/v1/materials/[id]/retire/route');
  const res = await POST(
    makePost(`http://local/api/v1/materials/${opts.id}/retire`, body),
    { params: Promise.resolve({ id: opts.id }) },
  );
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

const validBody = (overrides: Record<string, unknown> = {}) => ({
  kind: 'filament_spool',
  brand: 'Bambu Lab',
  subtype: 'PLA Basic',
  colors: ['#E63946'],
  colorPattern: 'solid',
  initialAmount: 1000,
  unit: 'g',
  ...overrides,
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('E2E /api/v1/materials lifecycle', () => {
  it('full lifecycle: create → load → consume → retire (4 ledger events, state visible via GET)', async () => {
    const userId = await seedUser();

    // 1. Create material via HTTP.
    const created = await postMaterial({ ownerId: userId, body: validBody() });
    expect(created.status).toBe(201);
    const material = (created.json.material as { id: string });
    const materialId = material.id;

    // GET reflects active=true, no printer ref.
    const after1 = await getMaterial({ ownerId: userId, id: materialId });
    expect(after1.status).toBe(200);
    expect((after1.json.material as { active: boolean }).active).toBe(true);
    expect((after1.json.material as { loadedInPrinterRef: string | null }).loadedInPrinterRef).toBeNull();

    // 2. Load into a printer (real printer row required after T_g2).
    const printerId = await seedTestPrinter(userId);
    const loadRes = await loadMaterial({
      ownerId: userId,
      id: materialId,
      printerId,
      slotIndex: 0,
    });
    expect(loadRes.status).toBe(200);

    // V2-005f-CF-1 T_g4: DTO's `loadedInPrinterRef` is now derived from the
    // open `printer_loadouts` row for this material. After load it points to
    // `printerId`; after unload it returns to null.
    const after2 = await getMaterial({ ownerId: userId, id: materialId });
    expect((after2.json.material as { loadedInPrinterRef: string | null }).loadedInPrinterRef).toBe(
      printerId,
    );

    // 3. Admin records a consumption event (50g print).
    const consumeRes = await postConsumption({
      adminId: userId, // user is admin for this test
      body: {
        materialId,
        weightConsumed: 50,
        provenanceClass: 'measured',
        attributedTo: { kind: 'print', note: 'engineering benchy' },
        occurredAt: new Date().toISOString(),
        source: 'manual-entry',
      },
    });
    expect(consumeRes.status).toBe(201);
    expect(consumeRes.json.newRemainingAmount).toBe(950);
    expect(consumeRes.json.reconciliationNeeded).toBe(false);

    const after3 = await getMaterial({ ownerId: userId, id: materialId });
    expect((after3.json.material as { remainingAmount: number }).remainingAmount).toBe(950);

    // 4. Retire (must acknowledge that it's loaded in a printer).
    const retireRes = await retireMaterialHttp({
      ownerId: userId,
      id: materialId,
      reason: 'tangled',
      acknowledgeLoaded: true,
    });
    expect(retireRes.status).toBe(200);

    const after4 = await getMaterial({ ownerId: userId, id: materialId });
    expect((after4.json.material as { active: boolean }).active).toBe(false);
    expect((after4.json.material as { retirementReason: string | null }).retirementReason).toBe('tangled');

    // Ledger has 4 events for this material id, in order.
    const ledger = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.subjectId, materialId));
    const kinds = ledger
      .sort((a, b) => a.ingestedAt.getTime() - b.ingestedAt.getTime())
      .map((r) => r.kind);
    expect(kinds).toEqual(['material.added', 'material.loaded', 'material.consumed', 'material.retired']);

    // Provenance class on the consumption event.
    const consumed = ledger.find((r) => r.kind === 'material.consumed')!;
    expect(consumed.provenanceClass).toBe('measured');
    expect(consumed.subjectType).toBe('material');
  });

  it('Idempotency-Key: same key + same body → 200 with same id; different body → 409', async () => {
    const userId = await seedUser();
    const key = `idem-${uid()}`;
    const body = validBody({ brand: 'Polymaker', initialAmount: 800 });

    const r1 = await postMaterial({ ownerId: userId, body, idempotencyKey: key });
    expect(r1.status).toBe(201);
    const id1 = (r1.json.material as { id: string }).id;

    // Replay same body + same key.
    const r2 = await postMaterial({ ownerId: userId, body, idempotencyKey: key });
    expect(r2.status).toBe(200);
    expect((r2.json.material as { id: string }).id).toBe(id1);

    // Same key + different body → 409.
    const r3 = await postMaterial({
      ownerId: userId,
      body: { ...body, initialAmount: 750 },
      idempotencyKey: key,
    });
    expect(r3.status).toBe(409);
    expect(r3.json.error).toBe('idempotency-mismatch');

    // Only one DB row for that key.
    const rows = await db()
      .select({ id: schema.materials.id })
      .from(schema.materials)
      .where(
        and(
          eq(schema.materials.ownerId, userId),
          eq(schema.materials.idempotencyKey, key),
        ),
      );
    expect(rows.length).toBe(1);
  });

  it('cross-owner protection: User B cannot retire User A’s material → 404', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const created = await postMaterial({ ownerId: userA, body: validBody() });
    const id = (created.json.material as { id: string }).id;

    const r = await retireMaterialHttp({
      ownerId: userB,
      id,
      reason: 'mine now',
    });
    expect(r.status).toBe(404);

    // Material is still active.
    const after = await db()
      .select({ active: schema.materials.active })
      .from(schema.materials)
      .where(eq(schema.materials.id, id));
    expect(after[0]!.active).toBe(true);
  });

  it('multi-color material: colors[] + colorPattern round-trip via GET', async () => {
    const userId = await seedUser();
    const created = await postMaterial({
      ownerId: userId,
      body: validBody({
        colors: ['#FF0000', '#FFFF00', '#00FF00'],
        colorPattern: 'multi-section',
        colorName: 'Stoplight',
      }),
    });
    expect(created.status).toBe(201);
    const id = (created.json.material as { id: string }).id;

    const got = await getMaterial({ ownerId: userId, id });
    expect(got.status).toBe(200);
    const m = got.json.material as { colors: string[]; colorPattern: string; colorName: string };
    expect(m.colors).toEqual(['#FF0000', '#FFFF00', '#00FF00']);
    expect(m.colorPattern).toBe('multi-section');
    expect(m.colorName).toBe('Stoplight');
  });

  it('validation: solid+empty-colors → 400 invalid-body', async () => {
    const userId = await seedUser();
    const bad = await postMaterial({
      ownerId: userId,
      body: validBody({ colors: [] }),
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('invalid-body');

    // No row inserted.
    const rows = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.ownerId, userId));
    expect(rows.length).toBe(0);

    // No ledger event for this owner/material either.
    const ledger = await db().select().from(schema.ledgerEvents);
    expect(ledger.length).toBe(0);
  });
});

// Suppress unused-import — `inArray` reserved for future cross-test cascade
// checks. Keep here so future expansion doesn't need to re-add the import.
void inArray;
