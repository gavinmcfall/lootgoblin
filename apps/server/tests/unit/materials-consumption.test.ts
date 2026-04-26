/**
 * Unit tests for Consumption event handler — V2-007a-T8.
 *
 * Real-DB-on-tmpfile pattern (mirrors materials-mix/recycle.test.ts). Covers:
 *   - Validation rejects (invalid event shapes — missing fields, wrong types,
 *     out-of-enum values, occurredAt not a Date, weightConsumed <= 0).
 *   - Happy path: normal print consumption decrements the spool, records the
 *     ledger event with subjectId=materialId, relatedResources from
 *     attributedTo, payload with subtype=undefined, provenance preserved.
 *   - Waste subtype encoding (purge/priming/failed-print/waste → subtype='waste';
 *     print → subtype undefined).
 *   - occurredAt distinct from ingestedAt.
 *   - Negative balance: still applied, reconciliationNeeded=true,
 *     ledger reflects truthfully.
 *   - Retired material: consumption still applied.
 *   - MixBatch consumption: only the mix_batch decrements; sources unchanged.
 *     Mass conservation invariant before/after holds.
 *   - Atomic rollback: injected ledger insert failure → no decrement.
 */

import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { createMaterial } from '../../src/materials/lifecycle';
import { applyMixBatch, createMixRecipe } from '../../src/materials/mix';
import {
  handleMaterialConsumed,
  emitMaterialConsumed,
  type MaterialConsumedEvent,
} from '../../src/materials/consumption';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-materials-consumption-unit.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Consumption Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedFilamentSpool(
  ownerId: string,
  initialAmount: number,
): Promise<typeof schema.materials.$inferSelect> {
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
  if (!r.ok) throw new Error(`seedFilamentSpool failed: ${r.reason}`);
  return r.material;
}

async function seedResinBottle(
  ownerId: string,
  initialAmount: number,
): Promise<typeof schema.materials.$inferSelect> {
  const r = await createMaterial(
    {
      ownerId,
      kind: 'resin_bottle',
      brand: 'TestBrand',
      subtype: 'Standard',
      colors: ['#445566'],
      colorPattern: 'solid',
      initialAmount,
      unit: 'ml',
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`seedResinBottle failed: ${r.reason}`);
  return r.material;
}

function makeEvent(
  partial: Partial<MaterialConsumedEvent> & { materialId: string },
): MaterialConsumedEvent {
  return {
    type: 'material.consumed',
    materialId: partial.materialId,
    weightConsumed: partial.weightConsumed ?? 50,
    provenanceClass: partial.provenanceClass ?? 'measured',
    attributedTo: partial.attributedTo ?? { kind: 'print' },
    occurredAt: partial.occurredAt ?? new Date(),
    source: partial.source ?? 'forge:dispatch',
  };
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Validation rejections
// ---------------------------------------------------------------------------

describe('handleMaterialConsumed — validation rejections', () => {
  it('1. missing required fields → invalid-event', async () => {
    const r = await handleMaterialConsumed(
      // @ts-expect-error intentionally malformed
      { type: 'material.consumed', materialId: 'x' },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-event');
  });

  it('2. wrong type discriminator → invalid-event', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const evt = makeEvent({ materialId: spool.id });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (evt as any).type = 'material.added';
    const r = await handleMaterialConsumed(evt, { dbUrl: DB_URL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-event');
  });

  it('3. weightConsumed=0 → invalid-event', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const r = await handleMaterialConsumed(
      makeEvent({ materialId: spool.id, weightConsumed: 0 }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-event');
  });

  it('4. weightConsumed<0 → invalid-event', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const r = await handleMaterialConsumed(
      makeEvent({ materialId: spool.id, weightConsumed: -10 }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-event');
  });

  it('5. provenanceClass not in enum → invalid-event', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const r = await handleMaterialConsumed(
      // @ts-expect-error intentionally invalid enum
      makeEvent({ materialId: spool.id, provenanceClass: 'derived' }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-event');
  });

  it('6. attributedTo.kind not in enum → invalid-event', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const r = await handleMaterialConsumed(
      makeEvent({
        materialId: spool.id,
        // @ts-expect-error intentionally invalid kind
        attributedTo: { kind: 'demolition' },
      }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-event');
  });

  it('7. occurredAt not a Date (string) → invalid-event', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const r = await handleMaterialConsumed(
      // @ts-expect-error intentionally wrong type
      { ...makeEvent({ materialId: spool.id }), occurredAt: '2026-01-01' },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-event');
  });

  it('7b. occurredAt absent → invalid-event', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const evt = makeEvent({ materialId: spool.id });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (evt as any).occurredAt;
    const r = await handleMaterialConsumed(evt, { dbUrl: DB_URL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-event');
  });

  it('8. material-not-found → material-not-found', async () => {
    const r = await handleMaterialConsumed(
      makeEvent({ materialId: 'nonexistent-id-xxx' }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('material-not-found');
  });
});

// ---------------------------------------------------------------------------
// Happy path — normal print consumption
// ---------------------------------------------------------------------------

describe('handleMaterialConsumed — normal print consumption', () => {
  it('9. consumes 50g from a 500g spool → 450g + ledger event with subtype undefined + relatedResources [print-job, loot]', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const occurredAt = new Date('2026-04-25T10:00:00Z');
    const r = await handleMaterialConsumed(
      makeEvent({
        materialId: spool.id,
        weightConsumed: 50,
        attributedTo: {
          kind: 'print',
          jobId: 'job-abc',
          lootId: 'loot-xyz',
        },
        occurredAt,
      }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newRemainingAmount).toBe(450);
    expect(r.reconciliationNeeded).toBe(false);

    const after = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, spool.id))
    )[0]!;
    expect(after.remainingAmount).toBe(450);

    const events = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, r.ledgerEventId));
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe('material.consumed');
    expect(ev.subjectType).toBe('material');
    expect(ev.subjectId).toBe(spool.id);
    expect(ev.relatedResources).toEqual([
      { kind: 'print-job', id: 'job-abc', role: 'attributed-to' },
      { kind: 'loot', id: 'loot-xyz', role: 'printed' },
    ]);
    const payload = JSON.parse(ev.payload!);
    expect(payload.weightConsumed).toBe(50);
    expect(payload.unit).toBe('g');
    expect(payload.subtype).toBeUndefined();
    expect(payload.source).toBe('forge:dispatch');
    expect(payload.newRemainingAmount).toBe(450);
    expect(payload.reconciliationNeeded).toBe(false);
  });

  it('10. without jobId → no print-job entry in relatedResources', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const r = await handleMaterialConsumed(
      makeEvent({
        materialId: spool.id,
        weightConsumed: 25,
        attributedTo: { kind: 'print' }, // no jobId, no lootId
      }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = (
      await db()
        .select()
        .from(schema.ledgerEvents)
        .where(eq(schema.ledgerEvents.id, r.ledgerEventId))
    )[0]!;
    expect(ev.relatedResources).toBeNull();
  });

  it('11. with jobId but no lootId → relatedResources has print-job only', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const r = await handleMaterialConsumed(
      makeEvent({
        materialId: spool.id,
        weightConsumed: 25,
        attributedTo: { kind: 'print', jobId: 'job-only' },
      }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = (
      await db()
        .select()
        .from(schema.ledgerEvents)
        .where(eq(schema.ledgerEvents.id, r.ledgerEventId))
    )[0]!;
    expect(ev.relatedResources).toEqual([
      { kind: 'print-job', id: 'job-only', role: 'attributed-to' },
    ]);
  });

  it('12. provenance preserved (measured event → ledger provenanceClass=measured)', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const r = await handleMaterialConsumed(
      makeEvent({
        materialId: spool.id,
        weightConsumed: 10,
        provenanceClass: 'measured',
      }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = (
      await db()
        .select()
        .from(schema.ledgerEvents)
        .where(eq(schema.ledgerEvents.id, r.ledgerEventId))
    )[0]!;
    expect(ev.provenanceClass).toBe('measured');
  });

  it('12b. provenance preserved (estimated)', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const r = await handleMaterialConsumed(
      makeEvent({
        materialId: spool.id,
        weightConsumed: 10,
        provenanceClass: 'estimated',
      }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = (
      await db()
        .select()
        .from(schema.ledgerEvents)
        .where(eq(schema.ledgerEvents.id, r.ledgerEventId))
    )[0]!;
    expect(ev.provenanceClass).toBe('estimated');
  });
});

// ---------------------------------------------------------------------------
// Waste subtypes
// ---------------------------------------------------------------------------

describe('handleMaterialConsumed — waste subtypes', () => {
  it.each([
    ['purge'],
    ['priming'],
    ['failed-print'],
    ['waste'],
  ] as const)(
    '13/14/15/16. attributedTo.kind=%s → payload.subtype="waste"',
    async (kind) => {
      const ownerId = await seedUser();
      const spool = await seedFilamentSpool(ownerId, 500);
      const r = await handleMaterialConsumed(
        makeEvent({
          materialId: spool.id,
          weightConsumed: 5,
          attributedTo: { kind },
        }),
        { dbUrl: DB_URL },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const ev = (
        await db()
          .select()
          .from(schema.ledgerEvents)
          .where(eq(schema.ledgerEvents.id, r.ledgerEventId))
      )[0]!;
      const payload = JSON.parse(ev.payload!);
      expect(payload.subtype).toBe('waste');
    },
  );

  it('17. attributedTo.kind="print" → payload.subtype undefined', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const r = await handleMaterialConsumed(
      makeEvent({
        materialId: spool.id,
        weightConsumed: 5,
        attributedTo: { kind: 'print' },
      }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = (
      await db()
        .select()
        .from(schema.ledgerEvents)
        .where(eq(schema.ledgerEvents.id, r.ledgerEventId))
    )[0]!;
    const payload = JSON.parse(ev.payload!);
    expect(payload.subtype).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// occurredAt distinct from ingestedAt
// ---------------------------------------------------------------------------

describe('handleMaterialConsumed — occurredAt vs ingestedAt', () => {
  it('18. occurredAt 1h ago + now=fixed → ledger has occurredAt 1h ago, ingestedAt=now', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const now = new Date('2026-04-25T12:00:00Z');
    const occurredAt = new Date('2026-04-25T11:00:00Z');
    const r = await handleMaterialConsumed(
      makeEvent({ materialId: spool.id, weightConsumed: 10, occurredAt }),
      { dbUrl: DB_URL, now },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = (
      await db()
        .select()
        .from(schema.ledgerEvents)
        .where(eq(schema.ledgerEvents.id, r.ledgerEventId))
    )[0]!;
    expect(ev.occurredAt?.getTime()).toBe(occurredAt.getTime());
    expect(ev.ingestedAt.getTime()).toBe(now.getTime());
    expect(ev.occurredAt?.getTime()).toBeLessThan(ev.ingestedAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// Negative balance
// ---------------------------------------------------------------------------

describe('handleMaterialConsumed — negative balance', () => {
  it('20/21. spool with 50g + consumes 100g → newRemainingAmount=-50, reconciliationNeeded=true, ok=true', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 50);
    const r = await handleMaterialConsumed(
      makeEvent({ materialId: spool.id, weightConsumed: 100 }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newRemainingAmount).toBe(-50);
    expect(r.reconciliationNeeded).toBe(true);

    const after = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, spool.id))
    )[0]!;
    expect(after.remainingAmount).toBe(-50);

    const ev = (
      await db()
        .select()
        .from(schema.ledgerEvents)
        .where(eq(schema.ledgerEvents.id, r.ledgerEventId))
    )[0]!;
    const payload = JSON.parse(ev.payload!);
    expect(payload.newRemainingAmount).toBe(-50);
    expect(payload.reconciliationNeeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Retired material
// ---------------------------------------------------------------------------

describe('handleMaterialConsumed — retired material', () => {
  it('22. consumption against a retired Material is still applied', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    // Manually retire (skip lifecycle validation; we just need active=false).
    await db()
      .update(schema.materials)
      .set({ active: false, retirementReason: 'test', retiredAt: new Date() })
      .where(eq(schema.materials.id, spool.id));

    const r = await handleMaterialConsumed(
      makeEvent({ materialId: spool.id, weightConsumed: 75 }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newRemainingAmount).toBe(425);

    const after = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, spool.id))
    )[0]!;
    expect(after.remainingAmount).toBe(425);
    expect(after.active).toBe(false); // unchanged
  });
});

// ---------------------------------------------------------------------------
// MixBatch consumption — the plan's special case
// ---------------------------------------------------------------------------

describe('handleMaterialConsumed — mix-batch consumption', () => {
  it('23/24/25. consumption targeting a mix_batch decrements ONLY the mix_batch (sources unchanged); mass conservation holds', async () => {
    const ownerId = await seedUser();

    // Setup: source bottles A (300ml) + B (200ml).
    const A = await seedResinBottle(ownerId, 300);
    const B = await seedResinBottle(ownerId, 200);

    // T5 mix recipe + apply (200ml batch, 100 from each).
    const recipe = await createMixRecipe(
      {
        ownerId,
        name: 'a-b 50/50',
        components: [
          { materialProductRef: 'ref-a', ratioOrGrams: 50 },
          { materialProductRef: 'ref-b', ratioOrGrams: 50 },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(recipe.ok).toBe(true);
    if (!recipe.ok) return;

    const mix = await applyMixBatch(
      {
        recipeId: recipe.recipeId,
        actorUserId: ownerId,
        totalVolume: 200,
        perComponentDraws: [
          { sourceMaterialId: A.id, drawAmount: 100, provenanceClass: 'measured' },
          { sourceMaterialId: B.id, drawAmount: 100, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(mix.ok).toBe(true);
    if (!mix.ok) return;

    // After mix-apply: A=200, B=100, mix_batch=200.
    const aAfterMix = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, A.id))
    )[0]!.remainingAmount;
    const bAfterMix = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, B.id))
    )[0]!.remainingAmount;
    const mbAfterMix = (
      await db()
        .select()
        .from(schema.materials)
        .where(eq(schema.materials.id, mix.mixBatchMaterialId))
    )[0]!.remainingAmount;
    expect(aAfterMix).toBe(200);
    expect(bAfterMix).toBe(100);
    expect(mbAfterMix).toBe(200);

    // 24. Consume 50ml from the mix_batch (with jobId, no lootId).
    const r = await handleMaterialConsumed(
      makeEvent({
        materialId: mix.mixBatchMaterialId,
        weightConsumed: 50,
        attributedTo: { kind: 'print', jobId: 'job-123' },
      }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 24a. mix_batch -> 150
    const mbAfter = (
      await db()
        .select()
        .from(schema.materials)
        .where(eq(schema.materials.id, mix.mixBatchMaterialId))
    )[0]!.remainingAmount;
    expect(mbAfter).toBe(150);

    // 24b/24c. sources unchanged
    const aAfter = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, A.id))
    )[0]!.remainingAmount;
    const bAfter = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, B.id))
    )[0]!.remainingAmount;
    expect(aAfter).toBe(200);
    expect(bAfter).toBe(100);

    // 24d. Ledger event subjectId=mix_batch.id; relatedResources only print-job (no source bottles).
    const ev = (
      await db()
        .select()
        .from(schema.ledgerEvents)
        .where(eq(schema.ledgerEvents.id, r.ledgerEventId))
    )[0]!;
    expect(ev.subjectId).toBe(mix.mixBatchMaterialId);
    expect(ev.relatedResources).toEqual([
      { kind: 'print-job', id: 'job-123', role: 'attributed-to' },
    ]);

    // 25. Mass conservation: initial A+B = 500. After all ops:
    //     A + B + mix_batch + consumed === 500.
    const consumed = 50;
    const total = aAfter + bAfter + mbAfter + consumed;
    expect(total).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Atomic rollback
// ---------------------------------------------------------------------------

function buildFailingDbWrapper(targetTable: unknown, realDb: unknown) {
  const throwInsertOnTarget = (b: object): unknown =>
    new Proxy(b, {
      get(target, p, r) {
        if (p === 'values') {
          return () => ({
            run: () => {
              throw new Error('forced insert failure');
            },
          });
        }
        return Reflect.get(target, p, r);
      },
    });

  const wrapInsert = (target: unknown) => {
    return (table: unknown) => {
      const builder = (target as { insert: (t: unknown) => unknown }).insert(table);
      if (table === targetTable) return throwInsertOnTarget(builder as object);
      return builder;
    };
  };

  return new Proxy(realDb as object, {
    get(target, prop, receiver) {
      if (prop === 'insert') return wrapInsert(target);
      if (prop === 'transaction') {
        return <T>(fn: (tx: unknown) => T): T => {
          return (target as { transaction: <U>(f: (t: unknown) => U) => U }).transaction(
            (tx) => {
              const wrappedTx = new Proxy(tx as object, {
                get(t, p, r) {
                  if (p === 'insert') return wrapInsert(t);
                  return Reflect.get(t, p, r);
                },
              });
              return fn(wrappedTx);
            },
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe('handleMaterialConsumed — atomic rollback', () => {
  it('26/27. injected ledger insert failure → no decrement, persist-failed', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const before = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, spool.id))
    )[0]!.remainingAmount;

    const clientModule = await import('../../src/db/client');
    const realDb = clientModule.getServerDb(DB_URL);
    const wrappedDb = buildFailingDbWrapper(schema.ledgerEvents, realDb);
    vi.spyOn(clientModule, 'getServerDb').mockReturnValue(
      wrappedDb as unknown as ReturnType<typeof clientModule.getServerDb>,
    );

    const r = await handleMaterialConsumed(
      makeEvent({ materialId: spool.id, weightConsumed: 100 }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('persist-failed');

    vi.restoreAllMocks();

    const after = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, spool.id))
    )[0]!.remainingAmount;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// emitMaterialConsumed re-export sanity
// ---------------------------------------------------------------------------

describe('emitMaterialConsumed', () => {
  it('forwards to handleMaterialConsumed', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 100);
    const r = await emitMaterialConsumed(
      makeEvent({ materialId: spool.id, weightConsumed: 30 }),
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newRemainingAmount).toBe(70);
  });
});
