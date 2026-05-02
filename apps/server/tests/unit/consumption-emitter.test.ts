/**
 * Unit tests — consumption-emitter — V2-005f-T_dcf11.
 *
 * Coverage:
 *   1. emitConsumptionForCompletion — no measuredConsumption → zero result
 *   2. emitConsumptionForCompletion — measured grams direct from event
 *   3. emitConsumptionForCompletion — Bambu remain_percent fallback math
 *   4. emitConsumptionForCompletion — empty material_id slot is skipped
 *   5. emitConsumptionForCompletion — idempotent (second call → skipped)
 *   6. emitConsumptionForCompletion — handler returns ok:false → failed counter
 *   7. emitConsumptionForCompletion — materials_used null → zero result
 *   8. emitConsumptionForCompletion — dispatch_job missing → zero result
 *   9. emitConsumptionForDispatch — happy path emits one event per slot
 *  10. emitConsumptionForDispatch — idempotent (second call → all skipped)
 *  11. emitConsumptionForDispatch — empty material_ids → all skipped
 *  12. emitConsumptionForDispatch — non-positive estimated_grams skipped
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb } from '../../src/db/client';
import * as schema from '../../src/db/schema';
import { createMaterial } from '../../src/materials/lifecycle';
import {
  emitConsumptionForCompletion,
  emitConsumptionForDispatch,
} from '../../src/forge/status/consumption-emitter';
import type { StatusEvent } from '../../src/forge/status/types';
import type {
  MaterialsUsed,
  MaterialsUsedEntry,
} from '../../src/db/schema.forge';
import type {
  ConsumptionResult,
  MaterialConsumedEvent,
} from '../../src/materials/consumption';

const DB_PATH = '/tmp/lootgoblin-consumption-emitter.db';
const DB_URL = `file:${DB_PATH}`;

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  process.env.LOOTGOBLIN_SECRET ??= 'a'.repeat(32);
  await runMigrations(DB_URL);
}, 30_000);

beforeEach(() => {
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
});

afterEach(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = getDb(DB_URL) as any;
  await db.delete(schema.ledgerEvents);
  await db.delete(schema.dispatchJobs);
  await db.delete(schema.materials);
  await db.delete(schema.lootFiles);
  await db.delete(schema.loot);
  await db.delete(schema.collections);
  await db.delete(schema.stashRoots);
  await db.delete(schema.user);
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
}

async function seedUser(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = getDb(DB_URL) as any;
  const id = uid('u');
  await db.insert(schema.user).values({
    id,
    name: 'consumption-emitter test user',
    email: `${id}@emitter.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedMaterial(
  ownerId: string,
  initialAmount = 1000,
): Promise<string> {
  const r = await createMaterial(
    {
      ownerId,
      kind: 'filament_spool',
      brand: 'TestBrand',
      subtype: 'PLA',
      colors: ['#112233'],
      colorPattern: 'solid',
      initialAmount,
      unit: 'g',
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`seedMaterial failed: ${r.reason}`);
  return r.material.id;
}

async function seedDispatchJob(args: {
  ownerId: string;
  materialsUsed?: MaterialsUsed | null;
}): Promise<{ jobId: string; lootId: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = getDb(DB_URL) as any;
  const rootId = uid('r');
  const collectionId = uid('c');
  const lootId = uid('l');
  const jobId = uid('j');

  await db.insert(schema.stashRoots).values({
    id: rootId,
    ownerId: args.ownerId,
    name: 'root',
    path: `/tmp/lg-em-${randomUUID().slice(0, 8)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.collections).values({
    id: collectionId,
    ownerId: args.ownerId,
    name: 'c',
    pathTemplate: '{title|slug}',
    stashRootId: rootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: 'cube',
    tags: [],
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.dispatchJobs).values({
    id: jobId,
    ownerId: args.ownerId,
    lootId,
    targetKind: 'printer',
    targetId: uid('p-fake'),
    status: 'dispatched',
    materialsUsed: args.materialsUsed ?? null,
    createdAt: new Date(),
  });
  return { jobId, lootId };
}

function makeCompletedEvent(
  measuredConsumption?: StatusEvent['measuredConsumption'],
): StatusEvent {
  return {
    kind: 'completed',
    remoteJobRef: '',
    progressPct: 100,
    measuredConsumption,
    rawPayload: { gcodeState: 'FINISH' },
    occurredAt: new Date('2026-05-01T00:30:00Z'),
  };
}

function entry(
  slot: number,
  materialId: string,
  estimated: number,
): MaterialsUsedEntry {
  return {
    slot_index: slot,
    material_id: materialId,
    estimated_grams: estimated,
    measured_grams: null,
  };
}

// ---------------------------------------------------------------------------
// Phase B — emitConsumptionForCompletion
// ---------------------------------------------------------------------------

describe('emitConsumptionForCompletion — V2-005f-T_dcf11 Phase B', () => {
  it('1. event has no measuredConsumption → zero result', async () => {
    const ownerId = await seedUser();
    const matId = await seedMaterial(ownerId);
    const { jobId } = await seedDispatchJob({
      ownerId,
      materialsUsed: [entry(0, matId, 100)],
    });

    const r = await emitConsumptionForCompletion(
      { dispatchJobId: jobId, event: makeCompletedEvent(undefined) },
      { dbUrl: DB_URL },
    );
    expect(r).toEqual({ emitted: 0, skipped: 0, failed: 0 });
  });

  it('2. measured grams reported directly → emitted=1, decrement applied', async () => {
    const ownerId = await seedUser();
    const matId = await seedMaterial(ownerId, 500);
    const { jobId } = await seedDispatchJob({
      ownerId,
      materialsUsed: [entry(0, matId, 100)],
    });

    const r = await emitConsumptionForCompletion(
      {
        dispatchJobId: jobId,
        event: makeCompletedEvent([{ slot_index: 0, grams: 95 }]),
      },
      { dbUrl: DB_URL },
    );
    expect(r).toEqual({ emitted: 1, skipped: 0, failed: 0 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(DB_URL) as any;
    const matRows = await db
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, matId));
    expect(matRows[0].remainingAmount).toBe(405);

    const ledger = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].kind).toBe('material.consumed');
    expect(ledger[0].provenanceClass).toBe('measured');
    const payload = JSON.parse(ledger[0].payload);
    expect(payload.weightConsumed).toBe(95);
    expect(payload.attributedTo.jobId).toBe(jobId);
    expect(payload.attributedTo.note).toBe('slot:0');
  });

  it('3. Bambu remain_percent fallback — estimated 100g + remain_percent=20 → 80g', async () => {
    const ownerId = await seedUser();
    const matId = await seedMaterial(ownerId, 500);
    const { jobId } = await seedDispatchJob({
      ownerId,
      materialsUsed: [entry(0, matId, 100)],
    });

    const r = await emitConsumptionForCompletion(
      {
        dispatchJobId: jobId,
        event: makeCompletedEvent([
          { slot_index: 0, grams: 0, remain_percent: 20 },
        ]),
      },
      { dbUrl: DB_URL },
    );
    expect(r).toEqual({ emitted: 1, skipped: 0, failed: 0 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(DB_URL) as any;
    const ledger = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    expect(ledger).toHaveLength(1);
    const payload = JSON.parse(ledger[0].payload);
    expect(payload.weightConsumed).toBe(80);
  });

  it('4. slot with empty material_id → skipped at debug, no emit', async () => {
    const ownerId = await seedUser();
    const { jobId } = await seedDispatchJob({
      ownerId,
      materialsUsed: [
        { slot_index: 0, material_id: '', estimated_grams: 100, measured_grams: null },
      ],
    });

    const r = await emitConsumptionForCompletion(
      {
        dispatchJobId: jobId,
        event: makeCompletedEvent([{ slot_index: 0, grams: 95 }]),
      },
      { dbUrl: DB_URL },
    );
    expect(r).toEqual({ emitted: 0, skipped: 0, failed: 0 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(DB_URL) as any;
    const ledger = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    expect(ledger).toHaveLength(0);
  });

  it('5. idempotent — second call sees existing ledger row → all skipped', async () => {
    const ownerId = await seedUser();
    const matId = await seedMaterial(ownerId, 500);
    const { jobId } = await seedDispatchJob({
      ownerId,
      materialsUsed: [entry(0, matId, 100)],
    });

    const event = makeCompletedEvent([{ slot_index: 0, grams: 95 }]);

    const first = await emitConsumptionForCompletion(
      { dispatchJobId: jobId, event },
      { dbUrl: DB_URL },
    );
    expect(first).toEqual({ emitted: 1, skipped: 0, failed: 0 });

    const second = await emitConsumptionForCompletion(
      { dispatchJobId: jobId, event },
      { dbUrl: DB_URL },
    );
    expect(second).toEqual({ emitted: 0, skipped: 1, failed: 0 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(DB_URL) as any;
    const ledger = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    expect(ledger).toHaveLength(1);
  });

  it('6. handler returns ok:false → failed=1', async () => {
    const ownerId = await seedUser();
    const matId = await seedMaterial(ownerId, 500);
    const { jobId } = await seedDispatchJob({
      ownerId,
      materialsUsed: [entry(0, matId, 100)],
    });

    const stubHandler = async (
      _e: MaterialConsumedEvent,
    ): Promise<ConsumptionResult> => ({
      ok: false,
      reason: 'persist-failed',
      details: 'simulated',
    });

    const r = await emitConsumptionForCompletion(
      {
        dispatchJobId: jobId,
        event: makeCompletedEvent([{ slot_index: 0, grams: 95 }]),
      },
      { dbUrl: DB_URL, handler: stubHandler },
    );
    expect(r).toEqual({ emitted: 0, skipped: 0, failed: 1 });
  });

  it('7. materials_used null → zero result', async () => {
    const ownerId = await seedUser();
    const { jobId } = await seedDispatchJob({ ownerId, materialsUsed: null });

    const r = await emitConsumptionForCompletion(
      {
        dispatchJobId: jobId,
        event: makeCompletedEvent([{ slot_index: 0, grams: 95 }]),
      },
      { dbUrl: DB_URL },
    );
    expect(r).toEqual({ emitted: 0, skipped: 0, failed: 0 });
  });

  it('8. dispatch_job missing → zero result', async () => {
    const r = await emitConsumptionForCompletion(
      {
        dispatchJobId: 'no-such-job',
        event: makeCompletedEvent([{ slot_index: 0, grams: 95 }]),
      },
      { dbUrl: DB_URL },
    );
    expect(r).toEqual({ emitted: 0, skipped: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// Phase A — emitConsumptionForDispatch
// ---------------------------------------------------------------------------

describe('emitConsumptionForDispatch — V2-005f-T_dcf11 Phase A', () => {
  it('9. happy path — 3 slots with valid material_ids → 3 emitted, 3 ledger rows', async () => {
    const ownerId = await seedUser();
    const m0 = await seedMaterial(ownerId, 500);
    const m1 = await seedMaterial(ownerId, 500);
    const m2 = await seedMaterial(ownerId, 500);
    const { jobId, lootId } = await seedDispatchJob({ ownerId });

    const materialsUsed: MaterialsUsed = [
      entry(0, m0, 50),
      entry(1, m1, 25),
      entry(2, m2, 12),
    ];

    const r = await emitConsumptionForDispatch(
      { dispatchJobId: jobId, lootId, materialsUsed },
      { dbUrl: DB_URL },
    );
    expect(r).toEqual({ emitted: 3, skipped: 0, failed: 0 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(DB_URL) as any;
    const ledger = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    expect(ledger).toHaveLength(3);
    for (const row of ledger) {
      expect(row.kind).toBe('material.consumed');
      expect(row.provenanceClass).toBe('estimated');
    }
  });

  it('10. idempotent — second call → 3 skipped, no extra ledger rows', async () => {
    const ownerId = await seedUser();
    const m0 = await seedMaterial(ownerId, 500);
    const m1 = await seedMaterial(ownerId, 500);
    const m2 = await seedMaterial(ownerId, 500);
    const { jobId, lootId } = await seedDispatchJob({ ownerId });

    const materialsUsed: MaterialsUsed = [
      entry(0, m0, 50),
      entry(1, m1, 25),
      entry(2, m2, 12),
    ];

    const first = await emitConsumptionForDispatch(
      { dispatchJobId: jobId, lootId, materialsUsed },
      { dbUrl: DB_URL },
    );
    expect(first).toEqual({ emitted: 3, skipped: 0, failed: 0 });

    const second = await emitConsumptionForDispatch(
      { dispatchJobId: jobId, lootId, materialsUsed },
      { dbUrl: DB_URL },
    );
    expect(second).toEqual({ emitted: 0, skipped: 3, failed: 0 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(DB_URL) as any;
    const ledger = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    expect(ledger).toHaveLength(3);
  });

  it('11. all material_ids empty → 0 emitted, 0 skipped (silent skip)', async () => {
    const ownerId = await seedUser();
    const { jobId, lootId } = await seedDispatchJob({ ownerId });

    const materialsUsed: MaterialsUsed = [
      { slot_index: 0, material_id: '', estimated_grams: 50, measured_grams: null },
      { slot_index: 1, material_id: '', estimated_grams: 25, measured_grams: null },
      { slot_index: 2, material_id: '', estimated_grams: 12, measured_grams: null },
    ];

    const r = await emitConsumptionForDispatch(
      { dispatchJobId: jobId, lootId, materialsUsed },
      { dbUrl: DB_URL },
    );
    expect(r).toEqual({ emitted: 0, skipped: 0, failed: 0 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb(DB_URL) as any;
    const ledger = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));
    expect(ledger).toHaveLength(0);
  });

  it('12. estimated_grams <= 0 → silent skip', async () => {
    const ownerId = await seedUser();
    const matId = await seedMaterial(ownerId);
    const { jobId, lootId } = await seedDispatchJob({ ownerId });

    const materialsUsed: MaterialsUsed = [
      entry(0, matId, 0),
      entry(1, matId, -5),
    ];

    const r = await emitConsumptionForDispatch(
      { dispatchJobId: jobId, lootId, materialsUsed },
      { dbUrl: DB_URL },
    );
    expect(r).toEqual({ emitted: 0, skipped: 0, failed: 0 });
  });
});
