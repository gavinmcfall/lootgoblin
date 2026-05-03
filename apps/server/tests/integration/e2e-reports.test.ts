/**
 * End-to-end consumption reports through the HTTP API — V2-007a-T15
 *
 * Drives the chain: HTTP route → T13 query helpers → DB. Tests the wiring
 * + half-open window semantics + provenance distribution sums + the
 * outcome split (print-output | waste | recycled).
 *
 * Per-file SQLite path. Real materials + consumption + recycle inserted
 * via HTTP, then ledger event timestamps rewritten so we can deterministically
 * test the half-open `[since, until)` window (gte since, lt until).
 *
 * Coverage:
 *   1. Empty window: GET ?dimension=brand with since=until-of-1d-ago →
 *      empty array (no events).
 *   2. All dimensions: 3 materials of varied brands/colors, 5 consumption
 *      events of mixed kinds + provenance, 1 recycle event. GET each
 *      dimension and assert provenance sums match totalAmount per row.
 *   3. Outcome split: print-output / waste / recycled buckets show the
 *      seeded amounts.
 *   4. Half-open window: events whose ingestedAt equals `since` are
 *      included; events whose ingestedAt equals `until` are excluded.
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

const DB_PATH = '/tmp/lootgoblin-e2e-reports.db';
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
  await dbc.delete(schema.recycleEvents);
  await dbc.delete(schema.mixBatches);
  await dbc.delete(schema.mixRecipes);
  // V2-005f-CF-1 T_g1: printer_loadouts FK-references both materials and
  // printers; drop it before either parent.
  await dbc.delete(schema.printerLoadouts);
  await dbc.delete(schema.materials);
  await dbc.delete(schema.printers);
  mockAuthenticate.mockReset();
});

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: `E2E Reports User ${id.slice(0, 8)}`,
    email: `${id}@e2e-rep.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

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

// ─── HTTP-level helpers ─────────────────────────────────────────────────────

async function seedTestPrinter(ownerId: string, name: string): Promise<string> {
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

async function postFilamentSpool(opts: {
  ownerId: string;
  brand: string;
  colorHex: string;
  initialAmount: number;
  /**
   * V2-005f-CF-1 T_g3: load takes the structured (printerId, slotIndex)
   * pair. Caller is responsible for seeding the printer before passing
   * `loadInto`.
   */
  loadInto?: { printerId: string; slotIndex: number };
}): Promise<string> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const { POST } = await import('../../src/app/api/v1/materials/route');
  const res = await POST(
    makePost('http://local/api/v1/materials', {
      kind: 'filament_spool',
      brand: opts.brand,
      subtype: 'PLA',
      colors: [opts.colorHex],
      colorPattern: 'solid',
      initialAmount: opts.initialAmount,
      unit: 'g',
    }),
  );
  expect(res.status).toBe(201);
  const j = (await res.json()) as { material: { id: string } };
  if (opts.loadInto) {
    mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
    const { POST: load } = await import('../../src/app/api/v1/materials/[id]/load/route');
    const lr = await load(
      makePost(`http://local/api/v1/materials/${j.material.id}/load`, {
        printerId: opts.loadInto.printerId,
        slotIndex: opts.loadInto.slotIndex,
      }),
      { params: Promise.resolve({ id: j.material.id }) },
    );
    expect(lr.status).toBe(200);
  }
  return j.material.id;
}

async function postConsumption(opts: {
  adminId: string;
  materialId: string;
  weight: number;
  provenance: 'measured' | 'entered' | 'estimated';
  attributedKind: 'print' | 'purge' | 'priming' | 'failed-print' | 'waste';
  occurredAt: Date;
}): Promise<{ status: number; ledgerEventId?: string }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.adminId, 'admin'));
  const { POST } = await import('../../src/app/api/v1/materials/consumption/route');
  const res = await POST(
    makePost('http://local/api/v1/materials/consumption', {
      materialId: opts.materialId,
      weightConsumed: opts.weight,
      provenanceClass: opts.provenance,
      attributedTo: { kind: opts.attributedKind },
      occurredAt: opts.occurredAt.toISOString(),
      source: 'manual-entry',
    }),
  );
  if (res.status !== 201) {
    return { status: res.status };
  }
  const j = (await res.json()) as { ledgerEventId: string };
  return { status: res.status, ledgerEventId: j.ledgerEventId };
}

async function postRecycleEvent(opts: {
  ownerId: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const { POST } = await import('../../src/app/api/v1/materials/recycle-events/route');
  const res = await POST(makePost('http://local/api/v1/materials/recycle-events', opts.body));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function getReport(opts: {
  ownerId: string;
  dimension: 'brand' | 'color' | 'printer' | 'outcome' | 'total';
  since?: Date;
  until?: Date;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const params = new URLSearchParams();
  params.set('dimension', opts.dimension);
  if (opts.since) params.set('since', opts.since.toISOString());
  if (opts.until) params.set('until', opts.until.toISOString());
  const { GET } = await import('../../src/app/api/v1/reports/consumption/route');
  const res = await GET(
    makeGet(`http://local/api/v1/reports/consumption?${params.toString()}`),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/**
 * Force-set the ingestedAt timestamp on a freshly-inserted ledger event so
 * the half-open window tests can pin events at exact boundary instants.
 */
async function setLedgerIngestedAt(ledgerEventId: string, ingestedAt: Date): Promise<void> {
  await db()
    .update(schema.ledgerEvents)
    .set({ ingestedAt })
    .where(eq(schema.ledgerEvents.id, ledgerEventId));
}

/**
 * Force-set the createdAt on a freshly-inserted recycle_events row so
 * window queries against recycle data can be controlled deterministically.
 */
async function setRecycleEventCreatedAt(recycleEventId: string, createdAt: Date): Promise<void> {
  await db()
    .update(schema.recycleEvents)
    .set({ createdAt })
    .where(eq(schema.recycleEvents.id, recycleEventId));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

const WINDOW_START = new Date('2026-04-01T00:00:00Z');
const WINDOW_END = new Date('2026-05-01T00:00:00Z');

describe('E2E /api/v1/reports/consumption through HTTP', () => {
  it('empty window: 0 rows', async () => {
    const userId = await seedUser();
    // Window in the past with no events.
    const since = new Date('2020-01-01T00:00:00Z');
    const until = new Date('2020-01-02T00:00:00Z');
    const r = await getReport({ ownerId: userId, dimension: 'brand', since, until });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.rows)).toBe(true);
    expect((r.json.rows as unknown[]).length).toBe(0);
  });

  it('all dimensions populate with provenance sums matching totalAmount', async () => {
    const userId = await seedUser();
    // 3 materials with varied brand/color/printer attribution.
    const printerX1 = await seedTestPrinter(userId, 'printer-X1');
    const printerMK4 = await seedTestPrinter(userId, 'printer-MK4');
    const bambuRed = await postFilamentSpool({
      ownerId: userId,
      brand: 'Bambu Lab',
      colorHex: '#FF0000',
      initialAmount: 1000,
      loadInto: { printerId: printerX1, slotIndex: 0 },
    });
    const polymakerBlue = await postFilamentSpool({
      ownerId: userId,
      brand: 'Polymaker',
      colorHex: '#0000FF',
      initialAmount: 1000,
      loadInto: { printerId: printerMK4, slotIndex: 0 },
    });
    const elegooGreen = await postFilamentSpool({
      ownerId: userId,
      brand: 'Elegoo',
      colorHex: '#00FF00',
      initialAmount: 1000,
      // Not loaded — will be in the null-printer bucket.
    });

    // 5 consumption events.
    const t1 = new Date('2026-04-05T00:00:00Z');
    const t2 = new Date('2026-04-10T00:00:00Z');
    const t3 = new Date('2026-04-15T00:00:00Z');
    const t4 = new Date('2026-04-20T00:00:00Z');
    const t5 = new Date('2026-04-25T00:00:00Z');

    const c1 = await postConsumption({
      adminId: userId,
      materialId: bambuRed,
      weight: 50,
      provenance: 'measured',
      attributedKind: 'print',
      occurredAt: t1,
    });
    expect(c1.status).toBe(201);
    await setLedgerIngestedAt(c1.ledgerEventId!, t1);

    const c2 = await postConsumption({
      adminId: userId,
      materialId: bambuRed,
      weight: 5,
      provenance: 'estimated',
      attributedKind: 'waste',
      occurredAt: t2,
    });
    expect(c2.status).toBe(201);
    await setLedgerIngestedAt(c2.ledgerEventId!, t2);

    const c3 = await postConsumption({
      adminId: userId,
      materialId: polymakerBlue,
      weight: 80,
      provenance: 'measured',
      attributedKind: 'print',
      occurredAt: t3,
    });
    expect(c3.status).toBe(201);
    await setLedgerIngestedAt(c3.ledgerEventId!, t3);

    const c4 = await postConsumption({
      adminId: userId,
      materialId: polymakerBlue,
      weight: 10,
      provenance: 'entered',
      attributedKind: 'purge',
      occurredAt: t4,
    });
    expect(c4.status).toBe(201);
    await setLedgerIngestedAt(c4.ledgerEventId!, t4);

    const c5 = await postConsumption({
      adminId: userId,
      materialId: elegooGreen,
      weight: 30,
      provenance: 'estimated',
      attributedKind: 'failed-print',
      occurredAt: t5,
    });
    expect(c5.status).toBe(201);
    await setLedgerIngestedAt(c5.ledgerEventId!, t5);

    // 1 recycle event. inputs[].weight=40 from elegoo (already had 30g consumed).
    const re = await postRecycleEvent({
      ownerId: userId,
      body: {
        inputs: [{ sourceMaterialId: elegooGreen, weight: 40, provenanceClass: 'measured' }],
        outputWeight: 40,
      },
    });
    expect(re.status).toBe(201);
    const recycleEventDto = re.json.recycleEvent as { id: string };
    await setRecycleEventCreatedAt(recycleEventDto.id, new Date('2026-04-20T12:00:00Z'));

    // ─── Brand dimension ───
    const brandR = await getReport({
      ownerId: userId,
      dimension: 'brand',
      since: WINDOW_START,
      until: WINDOW_END,
    });
    expect(brandR.status).toBe(200);
    type BrandRow = {
      key: { brand: string | null };
      totalAmount: number;
      provenance: Record<string, number>;
    };
    const brandRows = brandR.json.rows as BrandRow[];
    // Provenance sum equals totalAmount per row.
    for (const row of brandRows) {
      const provSum = Object.values(row.provenance).reduce((a, b) => a + b, 0);
      expect(provSum).toBe(row.totalAmount);
    }
    // Bambu = 50 + 5 = 55.
    expect(brandRows.find((r) => r.key.brand === 'Bambu Lab')?.totalAmount).toBe(55);
    expect(brandRows.find((r) => r.key.brand === 'Polymaker')?.totalAmount).toBe(90);
    expect(brandRows.find((r) => r.key.brand === 'Elegoo')?.totalAmount).toBe(30);

    // ─── Color dimension ───
    const colorR = await getReport({
      ownerId: userId,
      dimension: 'color',
      since: WINDOW_START,
      until: WINDOW_END,
    });
    expect(colorR.status).toBe(200);
    const colorRows = colorR.json.rows as Array<{
      key: { primaryColor: string | null };
      totalAmount: number;
      provenance: Record<string, number>;
    }>;
    for (const row of colorRows) {
      const provSum = Object.values(row.provenance).reduce((a, b) => a + b, 0);
      expect(provSum).toBe(row.totalAmount);
    }

    // ─── Printer dimension ───
    const printerR = await getReport({
      ownerId: userId,
      dimension: 'printer',
      since: WINDOW_START,
      until: WINDOW_END,
    });
    expect(printerR.status).toBe(200);
    const printerRows = printerR.json.rows as Array<{
      key: { printerRef: string | null };
      totalAmount: number;
      provenance: Record<string, number>;
    }>;
    for (const row of printerRows) {
      const provSum = Object.values(row.provenance).reduce((a, b) => a + b, 0);
      expect(provSum).toBe(row.totalAmount);
    }

    // ─── Outcome dimension ───
    const outcomeR = await getReport({
      ownerId: userId,
      dimension: 'outcome',
      since: WINDOW_START,
      until: WINDOW_END,
    });
    expect(outcomeR.status).toBe(200);
    const outcomeRows = outcomeR.json.rows as Array<{
      key: { outcome: string };
      totalAmount: number;
      provenance: Record<string, number>;
    }>;
    for (const row of outcomeRows) {
      const provSum = Object.values(row.provenance).reduce((a, b) => a + b, 0);
      expect(provSum).toBe(row.totalAmount);
    }

    // ─── Total dimension ───
    const totalR = await getReport({
      ownerId: userId,
      dimension: 'total',
      since: WINDOW_START,
      until: WINDOW_END,
    });
    expect(totalR.status).toBe(200);
    type TotalRow = {
      key: null;
      totalAmount: number;
      provenance: Record<string, number>;
    };
    const totalRow = totalR.json.row as TotalRow;
    // Total consumption = print-output (50+80) + waste (5) + purge (10, treated as waste) + failed-print (30, treated as waste) = 175
    expect(totalRow.totalAmount).toBe(175);
    const totalProvSum = Object.values(totalRow.provenance).reduce((a, b) => a + b, 0);
    expect(totalProvSum).toBe(totalRow.totalAmount);
  });

  it('outcome split: print-output / waste / recycled buckets reflect seeded amounts', async () => {
    const userId = await seedUser();
    const matId = await postFilamentSpool({
      ownerId: userId,
      brand: 'Bambu Lab',
      colorHex: '#FF0000',
      initialAmount: 1000,
    });
    // 3 print events × 45g.
    for (let i = 0; i < 3; i++) {
      const t = new Date(`2026-04-${10 + i}T00:00:00Z`);
      const c = await postConsumption({
        adminId: userId,
        materialId: matId,
        weight: 45,
        provenance: 'measured',
        attributedKind: 'print',
        occurredAt: t,
      });
      expect(c.status).toBe(201);
      await setLedgerIngestedAt(c.ledgerEventId!, t);
    }
    // 2 waste events × 5g.
    for (let i = 0; i < 2; i++) {
      const t = new Date(`2026-04-${15 + i}T00:00:00Z`);
      const c = await postConsumption({
        adminId: userId,
        materialId: matId,
        weight: 5,
        provenance: 'estimated',
        attributedKind: 'waste',
        occurredAt: t,
      });
      expect(c.status).toBe(201);
      await setLedgerIngestedAt(c.ledgerEventId!, t);
    }

    // 1 recycle event with 50g tracked input.
    const re = await postRecycleEvent({
      ownerId: userId,
      body: {
        inputs: [{ sourceMaterialId: matId, weight: 50, provenanceClass: 'measured' }],
        outputWeight: 48,
      },
    });
    expect(re.status).toBe(201);
    const reId = (re.json.recycleEvent as { id: string }).id;
    await setRecycleEventCreatedAt(reId, new Date('2026-04-20T00:00:00Z'));

    const r = await getReport({
      ownerId: userId,
      dimension: 'outcome',
      since: WINDOW_START,
      until: WINDOW_END,
    });
    expect(r.status).toBe(200);
    const rows = r.json.rows as Array<{ key: { outcome: string }; totalAmount: number }>;
    const printOutput = rows.find((row) => row.key.outcome === 'print-output');
    const waste = rows.find((row) => row.key.outcome === 'waste');
    const recycled = rows.find((row) => row.key.outcome === 'recycled');
    expect(printOutput?.totalAmount).toBe(135); // 3 × 45
    expect(waste?.totalAmount).toBe(10); // 2 × 5
    expect(recycled?.totalAmount).toBe(50); // tracked recycle input weight
  });

  it('half-open window: events at since are INCLUDED; events at until are EXCLUDED', async () => {
    const userId = await seedUser();
    const matId = await postFilamentSpool({
      ownerId: userId,
      brand: 'Bambu Lab',
      colorHex: '#FF0000',
      initialAmount: 1000,
    });

    const since = new Date('2026-04-10T00:00:00Z');
    const until = new Date('2026-04-20T00:00:00Z');
    const beforeBoundary = new Date('2026-04-09T23:59:59Z');
    const atSince = since;
    const middle = new Date('2026-04-15T00:00:00Z');
    const atUntil = until;
    const afterBoundary = new Date('2026-04-21T00:00:00Z');

    const stamps = [beforeBoundary, atSince, middle, atUntil, afterBoundary];
    for (const t of stamps) {
      const c = await postConsumption({
        adminId: userId,
        materialId: matId,
        weight: 10,
        provenance: 'measured',
        attributedKind: 'print',
        occurredAt: t,
      });
      expect(c.status).toBe(201);
      await setLedgerIngestedAt(c.ledgerEventId!, t);
    }

    // Window covers atSince (inclusive) → atUntil (exclusive) → 2 events:
    //   atSince (10), middle (10) — atUntil is excluded → total = 20.
    const r = await getReport({
      ownerId: userId,
      dimension: 'total',
      since,
      until,
    });
    expect(r.status).toBe(200);
    const totalRow = r.json.row as { totalAmount: number };
    expect(totalRow.totalAmount).toBe(20);
  });
});
