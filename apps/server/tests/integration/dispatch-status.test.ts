// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration tests — POST /api/v1/dispatch/status — V2-006a-T8
 *
 * Coverage:
 *   1. dispatched phase → job becomes 'dispatched'.
 *   2. failed phase → job becomes 'failed', reason mapped correctly.
 *   3. completed phase with materials_used → job 'completed', measured-provenance
 *      consumption ledger event emitted (assert provenanceClass='measured'),
 *      inventory decremented.
 *   4. completed phase without materials_used → falls back to cached estimate
 *      (job still completes + Phase B is a no-op since measuredConsumption=[]).
 *   5. status-event phase → dispatch_status_events row inserted.
 *   6. Ownership guard: report on a job claimed by ANOTHER agent → 403.
 *   7. Idempotency: two `completed` for the same job → second is 200 { noop:true },
 *      no duplicate consumption event.
 *   8. Missing / invalid API key → 401.
 *
 * DB: /tmp/lootgoblin-v2006a-t8.db (unique per T8).
 *
 * Auth strategy: mint a real courier_pairing key via mintCourierPairToken +
 * exchangeCourierPairToken. For invalid-key tests, mock authenticateCourier.
 *
 * Seed strategy for completed-with-materials:
 *   - Seed a real Material with non-zero currentAmount.
 *   - Pre-populate dispatch_jobs.materials_used with { material_id, estimated_grams }
 *     so that when we POST completed+materials_used, emitConsumptionForCompletion
 *     finds the material row and decrements inventory.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getServerDb, schema } from '../../src/db/client';
import { bootstrapInstanceIdentity } from '../../src/identity/index';
import { mintCourierPairToken, exchangeCourierPairToken } from '../../src/forge/couriers';
import { createDispatchJob } from '../../src/forge/dispatch-jobs';
import { createMaterial } from '../../src/materials/lifecycle';
import type { MaterialsUsed } from '../../src/db/schema.forge';

// ── Next.js shim ─────────────────────────────────────────────────────────────
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

// ── courier-auth mock ─────────────────────────────────────────────────────────
const mockAuthenticateCourier = vi.fn();

vi.mock('../../src/auth/courier-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/courier-auth')>();
  return {
    ...actual,
    authenticateCourier: (...args: unknown[]) => mockAuthenticateCourier(...args),
  };
});

// ── DB setup ─────────────────────────────────────────────────────────────────
const DB_PATH = '/tmp/lootgoblin-v2006a-t8.db';
const DB_URL = `file:${DB_PATH}`;
const TEST_SECRET = 'x'.repeat(32);

let testApiKey = '';
let testAgentId = '';
let sharedUserId = '';

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
  await runMigrations(DB_URL);

  await bootstrapInstanceIdentity('test-instance-t8');

  sharedUserId = randomUUID();
  await getServerDb(DB_URL).insert(schema.user).values({
    id: sharedUserId,
    name: 'T8 Shared User',
    email: `${sharedUserId}@dispatch-status.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const mintResult = await mintCourierPairToken();
  if (!mintResult) throw new Error('mintCourierPairToken returned null');

  const exchangeResult = await exchangeCourierPairToken(mintResult.token, { dbUrl: DB_URL });
  if (!exchangeResult.ok) throw new Error(`exchangeCourierPairToken failed: ${JSON.stringify(exchangeResult)}`);

  testApiKey = exchangeResult.api_key;
  testAgentId = exchangeResult.agent_id;
}, 30_000);

// ── Per-test cleanup ──────────────────────────────────────────────────────────

beforeEach(async () => {
  const d = getServerDb(DB_URL);
  d.delete(schema.dispatchStatusEvents).run();
  d.delete(schema.ledgerEvents).run();
  d.delete(schema.dispatchJobs).run();
  d.delete(schema.printerLoadouts).run();
  d.delete(schema.printers).run();
  d.delete(schema.materials).run();
  d.delete(schema.collections).run();
  d.delete(schema.stashRoots).run();

  // Keep testAgentId; delete extra courier agents inserted by individual tests.
  const extraAgents = await d
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.kind, 'courier'));
  for (const row of extraAgents) {
    if (row.id !== testAgentId) {
      d.delete(schema.agents).where(eq(schema.agents.id, row.id)).run();
    }
  }

  // Reset mock to passthrough.
  mockAuthenticateCourier.mockImplementation(async () => ({ agentId: testAgentId }));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function db() {
  return getServerDb(DB_URL);
}

function makeReq(body: unknown, apiKey?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return new Request('http://local/api/v1/dispatch/status', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function seedStashRoot(): Promise<string> {
  const id = randomUUID();
  await db().insert(schema.stashRoots).values({
    id,
    ownerId: sharedUserId,
    name: 'T8 Test Root',
    path: '/tmp/t8-stash',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(stashRootId: string): Promise<string> {
  const id = randomUUID();
  await db().insert(schema.collections).values({
    id,
    ownerId: sharedUserId,
    name: `T8 Collection ${id.slice(0, 8)}`,
    pathTemplate: '{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(collectionId: string): Promise<string> {
  const id = randomUUID();
  await db().insert(schema.loot).values({
    id,
    collectionId,
    title: `T8 Loot ${id.slice(0, 8)}`,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedPrinter(): Promise<string> {
  const id = randomUUID();
  await db().insert(schema.printers).values({
    id,
    ownerId: sharedUserId,
    kind: 'fdm_klipper',
    name: `T8 Printer ${id.slice(0, 8)}`,
    connectionConfig: { url: 'http://10.0.0.99:7125' },
    active: true,
    createdAt: new Date(),
  });
  return id;
}

async function seedLootFixture(): Promise<{ lootId: string }> {
  const stashRootId = await seedStashRoot();
  const collectionId = await seedCollection(stashRootId);
  const lootId = await seedLoot(collectionId);
  return { lootId };
}

/**
 * Seed a dispatch job in a specific status with a specific agent as
 * claim_marker. The initialStatus from createDispatchJob is 'claimable';
 * we force the desired status + claim_marker directly via UPDATE.
 */
async function seedJobInStatus(
  lootId: string,
  targetId: string,
  targetKind: 'printer',
  status: string,
  claimMarkerId: string,
  materialsUsed?: MaterialsUsed,
): Promise<string> {
  const r = await createDispatchJob(
    {
      ownerId: sharedUserId,
      lootId,
      targetKind,
      targetId,
      initialStatus: 'claimable',
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`seedJobInStatus: ${r.reason}`);
  const jobId = r.jobId;

  // Force status + claim_marker.
  db()
    .update(schema.dispatchJobs)
    .set({
      status,
      claimMarker: claimMarkerId,
      claimedAt: new Date(),
      startedAt: status === 'dispatched' ? new Date() : null,
      materialsUsed: materialsUsed ?? null,
    })
    .where(eq(schema.dispatchJobs.id, jobId))
    .run();

  return jobId;
}

// Import route lazily (after mocks are registered).
const getRoute = () =>
  import('../../src/app/api/v1/dispatch/status/route').then((m) => m.POST);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/dispatch/status', () => {
  it('1. dispatched phase → job transitions from claimed to dispatched', async () => {
    const { lootId } = await seedLootFixture();
    const printerId = await seedPrinter();
    const jobId = await seedJobInStatus(lootId, printerId, 'printer', 'claimed', testAgentId);

    const POST = await getRoute();
    const res = await POST(makeReq({ phase: 'dispatched', job_id: jobId, remote_filename: 'model.gcode' }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
    expect(body.noop).toBeUndefined();

    const rows = await db()
      .select({ status: schema.dispatchJobs.status })
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId))
      .limit(1);
    expect(rows[0]?.status).toBe('dispatched');
  });

  it('2. failed phase → job becomes failed, reason mapped correctly', async () => {
    const { lootId } = await seedLootFixture();
    const printerId = await seedPrinter();
    const jobId = await seedJobInStatus(lootId, printerId, 'printer', 'claimed', testAgentId);

    const POST = await getRoute();
    const res = await POST(makeReq({
      phase: 'failed',
      job_id: jobId,
      reason: 'unreachable',
      details: 'connection timeout',
    }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });

    const rows = await db()
      .select({
        status: schema.dispatchJobs.status,
        failureReason: schema.dispatchJobs.failureReason,
        failureDetails: schema.dispatchJobs.failureDetails,
      })
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId))
      .limit(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.failureReason).toBe('unreachable');
    expect(rows[0]?.failureDetails).toBe('connection timeout');
  });

  it('2b. failed reason mapping: rejected → target-rejected', async () => {
    const { lootId } = await seedLootFixture();
    const printerId = await seedPrinter();
    const jobId = await seedJobInStatus(lootId, printerId, 'printer', 'claimed', testAgentId);

    const POST = await getRoute();
    const res = await POST(makeReq({ phase: 'failed', job_id: jobId, reason: 'rejected' }) as any);
    expect(res.status).toBe(200);

    const rows = await db()
      .select({ failureReason: schema.dispatchJobs.failureReason })
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId))
      .limit(1);
    expect(rows[0]?.failureReason).toBe('target-rejected');
  });

  it('3. completed with materials_used → measured consumption ledger event emitted', async () => {
    const { lootId } = await seedLootFixture();
    const printerId = await seedPrinter();

    // Seed a real Material row (100 g initial stock).
    const mat = await createMaterial({
      ownerId: sharedUserId,
      kind: 'filament_spool',
      brand: 'T8 Brand',
      subtype: 'PLA',
      colors: ['#888888'],
      colorPattern: 'solid',
      initialAmount: 100,
      unit: 'g',
    }, { dbUrl: DB_URL });
    if (!mat.ok) throw new Error(`createMaterial failed: ${mat.reason}`);
    const materialId = mat.material.id;

    // Seed dispatch_jobs.materials_used with the real material_id so that
    // emitConsumptionForCompletion can correlate the slot.
    const materialsUsed: MaterialsUsed = [
      { slot_index: 0, material_id: materialId, estimated_grams: 10, measured_grams: null },
    ];

    const jobId = await seedJobInStatus(
      lootId, printerId, 'printer', 'dispatched', testAgentId, materialsUsed,
    );

    const POST = await getRoute();
    const res = await POST(makeReq({
      phase: 'completed',
      job_id: jobId,
      materials_used: [{ slot_index: 0, material_id: materialId, measured_grams: 12.5 }],
    }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
    expect(body.noop).toBeUndefined();

    // Job status should be 'completed'.
    const jobRows = await db()
      .select({ status: schema.dispatchJobs.status })
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId))
      .limit(1);
    expect(jobRows[0]?.status).toBe('completed');

    // A 'measured' provenance ledger event should have been emitted.
    const ledgerRows = await db()
      .select({
        provenanceClass: schema.ledgerEvents.provenanceClass,
        payload: schema.ledgerEvents.payload,
      })
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));

    const measuredRow = ledgerRows.find(
      (r) => r.provenanceClass === 'measured',
    );
    expect(measuredRow).toBeDefined();

    // Verify inventory was decremented.
    const matRows = await db()
      .select({ remainingAmount: schema.materials.remainingAmount })
      .from(schema.materials)
      .where(eq(schema.materials.id, materialId))
      .limit(1);
    expect(matRows[0]?.remainingAmount).toBeLessThan(100);
  });

  it('4. completed without materials_used → job completes (Phase B is no-op)', async () => {
    const { lootId } = await seedLootFixture();
    const printerId = await seedPrinter();

    // No materials_used seeded on the job — Phase B has nothing to correlate.
    const jobId = await seedJobInStatus(lootId, printerId, 'printer', 'dispatched', testAgentId);

    const POST = await getRoute();
    const res = await POST(makeReq({ phase: 'completed', job_id: jobId }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
    expect(body.noop).toBeUndefined();

    const rows = await db()
      .select({ status: schema.dispatchJobs.status })
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId))
      .limit(1);
    expect(rows[0]?.status).toBe('completed');

    // No consumption ledger events (no materials were wired).
    const ledgerRows = await db()
      .select({ id: schema.ledgerEvents.id })
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    expect(ledgerRows.length).toBe(0);
  });

  it('5. status-event phase → dispatch_status_events row inserted', async () => {
    const { lootId } = await seedLootFixture();
    const printerId = await seedPrinter();
    const jobId = await seedJobInStatus(lootId, printerId, 'printer', 'dispatched', testAgentId);

    const POST = await getRoute();
    const res = await POST(makeReq({
      phase: 'status-event',
      job_id: jobId,
      event: {
        kind: 'progress',
        remote_job_ref: 'model.gcode',
        progress_pct: 50,
        raw_payload: { progress: 50 },
        occurred_at: new Date().toISOString(),
      },
    }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });

    // A dispatch_status_events row should exist.
    const evRows = await db()
      .select({ eventKind: schema.dispatchStatusEvents.eventKind })
      .from(schema.dispatchStatusEvents)
      .where(eq(schema.dispatchStatusEvents.dispatchJobId, jobId));
    expect(evRows.length).toBeGreaterThan(0);
    expect(evRows[0]?.eventKind).toBe('progress');
  });

  it('6. ownership guard: report on a job claimed by ANOTHER agent → 403', async () => {
    const { lootId } = await seedLootFixture();
    const printerId = await seedPrinter();

    // Seed a second agent.
    const otherAgentId = randomUUID();
    await db().insert(schema.agents).values({
      id: otherAgentId,
      kind: 'courier',
      pairCredentialRef: null,
      lastSeenAt: null,
      reachableLanHint: null,
      createdAt: new Date(),
    });

    // Job is claimed by the OTHER agent.
    const jobId = await seedJobInStatus(lootId, printerId, 'printer', 'claimed', otherAgentId);

    const POST = await getRoute();
    const res = await POST(makeReq({ phase: 'dispatched', job_id: jobId }) as any);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'forbidden', reason: 'not-claimed-by-agent' });
  });

  it('7. idempotency: second completed → 200 { noop:true }, no duplicate consumption', async () => {
    const { lootId } = await seedLootFixture();
    const printerId = await seedPrinter();

    // Seed a material so Phase B has something to emit.
    const mat = await createMaterial({
      ownerId: sharedUserId,
      kind: 'filament_spool',
      brand: 'T8 Brand',
      subtype: 'PLA',
      colors: ['#000000'],
      colorPattern: 'solid',
      initialAmount: 200,
      unit: 'g',
    }, { dbUrl: DB_URL });
    if (!mat.ok) throw new Error(`createMaterial failed: ${mat.reason}`);
    const materialId = mat.material.id;

    const materialsUsed: MaterialsUsed = [
      { slot_index: 0, material_id: materialId, estimated_grams: 15, measured_grams: null },
    ];
    const jobId = await seedJobInStatus(
      lootId, printerId, 'printer', 'dispatched', testAgentId, materialsUsed,
    );

    const POST = await getRoute();
    const completedBody = {
      phase: 'completed',
      job_id: jobId,
      materials_used: [{ slot_index: 0, material_id: materialId, measured_grams: 15 }],
    };

    // First call → transitions + emits consumption.
    const res1 = await POST(makeReq(completedBody) as any);
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1).toMatchObject({ ok: true });
    expect(body1.noop).toBeUndefined();

    // Count ledger rows after first call.
    const ledgerAfterFirst = await db()
      .select({ id: schema.ledgerEvents.id })
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    const countAfterFirst = ledgerAfterFirst.length;

    // Second call → noop.
    const res2 = await POST(makeReq(completedBody) as any);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2).toMatchObject({ ok: true, noop: true });

    // No additional consumption rows.
    const ledgerAfterSecond = await db()
      .select({ id: schema.ledgerEvents.id })
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    expect(ledgerAfterSecond.length).toBe(countAfterFirst);
  });

  it('8. missing API key → 401', async () => {
    mockAuthenticateCourier.mockImplementation(async () => null);

    const POST = await getRoute();
    const res = await POST(makeReq({ phase: 'dispatched', job_id: randomUUID() }) as any);
    expect(res.status).toBe(401);
  });

  it('8b. invalid API key → 401', async () => {
    const { INVALID_API_KEY } = await import('../../src/auth/courier-auth');
    mockAuthenticateCourier.mockImplementation(async () => INVALID_API_KEY);

    const POST = await getRoute();
    const res = await POST(makeReq({ phase: 'dispatched', job_id: randomUUID() }) as any);
    expect(res.status).toBe(401);
  });
});
