/**
 * Unit tests for Recycle flow — V2-007a-T6.
 *
 * Real-DB-on-tmpfile pattern (mirrors materials-mix.test.ts). Covers:
 *   - applyRecycleEvent validation (no-inputs, too-many, weight bounds,
 *     output-weight, source-* failures, anomaly + ack model, color override).
 *   - Happy paths: tracked-only, mixed tracked+untracked, color override,
 *     loss accounting, recycle_events row JSON preservation, ledger
 *     related-resources for tracked + synthetic untracked entries.
 *   - Provenance escalation (sister to T5 weakest-link) plus the anomaly+ack
 *     downgrade-one-notch rule.
 *   - Atomic rollback: injected ledger / recycle_events insert failure must
 *     roll back the whole batch (no source decrement, no recycled_spool
 *     material, no recycle_events row).
 *   - Mass-conservation invariant property test (the headliner): randomized
 *     loop with mix of tracked+untracked inputs; sum-of-decrements +
 *     sum-of-untracked-weights === outputWeight ± 0.1.
 */

import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { createMaterial } from '../../src/materials/lifecycle';
import { applyRecycleEvent } from '../../src/materials/recycle';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-materials-recycle-unit.db';
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
    name: 'Recycle Test User',
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
// applyRecycleEvent — validation rejections
// ---------------------------------------------------------------------------

describe('applyRecycleEvent — validation rejections', () => {
  it('1. empty inputs array → no-inputs', async () => {
    const ownerId = await seedUser();
    const r = await applyRecycleEvent(
      { ownerId, actorUserId: ownerId, inputs: [], outputWeight: 100 },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-inputs');
  });

  it('2. inputs.length > 20 → too-many-inputs', async () => {
    const ownerId = await seedUser();
    const inputs = Array.from({ length: 21 }, () => ({
      sourceMaterialId: null,
      weight: 10,
      provenanceClass: 'measured' as const,
    }));
    const r = await applyRecycleEvent(
      { ownerId, actorUserId: ownerId, inputs, outputWeight: 200 },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('too-many-inputs');
  });

  it('3. input weight=0 → input-malformed', async () => {
    const ownerId = await seedUser();
    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: null, weight: 0, provenanceClass: 'measured' }],
        outputWeight: 50,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('input-malformed');
  });

  it('4. input weight<0 → input-malformed', async () => {
    const ownerId = await seedUser();
    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: null, weight: -5, provenanceClass: 'measured' }],
        outputWeight: 50,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('input-malformed');
  });

  it('5. invalid provenanceClass → input-malformed', async () => {
    const ownerId = await seedUser();
    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [
          // @ts-expect-error intentional invalid provenance
          { sourceMaterialId: null, weight: 50, provenanceClass: 'guessed' },
        ],
        outputWeight: 50,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('input-malformed');
  });

  it('6. outputWeight=0 → output-weight-invalid', async () => {
    const ownerId = await seedUser();
    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: null, weight: 50, provenanceClass: 'measured' }],
        outputWeight: 0,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('output-weight-invalid');
  });

  it('7. outputWeight<0 → output-weight-invalid', async () => {
    const ownerId = await seedUser();
    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: null, weight: 50, provenanceClass: 'measured' }],
        outputWeight: -10,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('output-weight-invalid');
  });

  it('8. tracked sourceMaterialId doesn\'t exist → source-not-found', async () => {
    const ownerId = await seedUser();
    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [
          { sourceMaterialId: 'no-such-material', weight: 50, provenanceClass: 'measured' },
        ],
        outputWeight: 50,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('source-not-found');
  });

  it('9. tracked source belongs to different owner → source-not-owned', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const spool = await seedFilamentSpool(ownerB, 500); // owned by B

    const r = await applyRecycleEvent(
      {
        ownerId: ownerA,
        actorUserId: ownerA,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 100,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('source-not-owned');
  });

  it('10. tracked source is retired → source-retired', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    await db()
      .update(schema.materials)
      .set({ active: false })
      .where(eq(schema.materials.id, spool.id));

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 100,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('source-retired');
  });

  it('11. tracked source has remaining < weight → source-insufficient', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 50); // only 50g

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 100,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('source-insufficient');
  });

  it('12. outputWeight > sum * 1.05 with no ack → output-anomaly-no-ack', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 110, // 110 > 100 * 1.05 = 105
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('output-anomaly-no-ack');
  });

  it('13. outputWeight > sum * 1.05 WITH ack → accepted', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 110,
        acknowledgeWeightAnomaly: true,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
  });

  it('14. outputWeight === sum exactly → no ack needed', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 100,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
  });

  it('15. outputWeight at sum * 1.04999 → no ack needed (just below threshold)', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 104.999,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
  });

  it('16. outputWeight at sum * 1.05 exactly → no ack needed (threshold inclusive)', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 105,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
  });

  it('17. outputWeight at sum * 1.0501 → ack needed', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 105.01,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('output-anomaly-no-ack');
  });

  it('18. color override: invalid hex → color-format', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 100,
        outputSpoolColors: ['not-a-hex'],
        outputSpoolColorPattern: 'solid',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('color-format');
  });

  it('19. color override: pattern length mismatch → color-pattern-mismatch', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 100,
        outputSpoolColors: ['#FF0000', '#00FF00'],
        outputSpoolColorPattern: 'solid', // expects 1 color
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('color-pattern-mismatch');
  });
});

// ---------------------------------------------------------------------------
// applyRecycleEvent — happy paths
// ---------------------------------------------------------------------------

describe('applyRecycleEvent — happy paths', () => {
  it('20. single tracked source: 500g spool → 480g recycled output, 20g loss', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 500, provenanceClass: 'measured' }],
        outputWeight: 480, // 20g loss (within 5% slack)
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Source decremented to 0.
    const after = await db().select().from(schema.materials).where(eq(schema.materials.id, spool.id));
    expect(after[0]!.remainingAmount).toBe(0);

    // Recycled spool.
    const out = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, r.outputSpoolId));
    expect(out[0]!.kind).toBe('recycled_spool');
    expect(out[0]!.initialAmount).toBe(480);
    expect(out[0]!.remainingAmount).toBe(480);
    expect(out[0]!.unit).toBe('g');
    expect(out[0]!.active).toBe(true);
    expect(out[0]!.ownerId).toBe(ownerId);

    // Ledger payload records the loss.
    const ev = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, r.ledgerEventId));
    expect(ev[0]!.kind).toBe('material.recycled');
    const payload = JSON.parse(ev[0]!.payload!);
    expect(payload.sumInputs).toBe(500);
    expect(payload.outputWeight).toBe(480);
    expect(payload.weightAnomaly).toBe(false);
  });

  it('21. multiple tracked sources: 100/200/150 → 450g output → all decremented', async () => {
    const ownerId = await seedUser();
    const a = await seedFilamentSpool(ownerId, 200);
    const b = await seedFilamentSpool(ownerId, 300);
    const c = await seedFilamentSpool(ownerId, 250);

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [
          { sourceMaterialId: a.id, weight: 100, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, weight: 200, provenanceClass: 'measured' },
          { sourceMaterialId: c.id, weight: 150, provenanceClass: 'measured' },
        ],
        outputWeight: 450,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const aAfter = await db().select().from(schema.materials).where(eq(schema.materials.id, a.id));
    const bAfter = await db().select().from(schema.materials).where(eq(schema.materials.id, b.id));
    const cAfter = await db().select().from(schema.materials).where(eq(schema.materials.id, c.id));
    expect(aAfter[0]!.remainingAmount).toBe(100);
    expect(bAfter[0]!.remainingAmount).toBe(100);
    expect(cAfter[0]!.remainingAmount).toBe(100);

    const out = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, r.outputSpoolId));
    expect(out[0]!.initialAmount).toBe(450);
  });

  it('22. mix tracked + untracked: 1 tracked 200g + 2 untracked 50g+30g → 280g output', async () => {
    const ownerId = await seedUser();
    const tracked = await seedFilamentSpool(ownerId, 500);

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [
          { sourceMaterialId: tracked.id, weight: 200, provenanceClass: 'measured' },
          { sourceMaterialId: null, weight: 50, provenanceClass: 'entered', note: 'purge scrap' },
          { sourceMaterialId: null, weight: 30, provenanceClass: 'estimated', note: 'offcuts' },
        ],
        outputWeight: 280,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Tracked source decremented; no spurious materials created for the
    // untracked entries.
    const trackedAfter = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, tracked.id));
    expect(trackedAfter[0]!.remainingAmount).toBe(300);

    // Output spool created with weight 280.
    const out = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, r.outputSpoolId));
    expect(out[0]!.initialAmount).toBe(280);
    expect(out[0]!.kind).toBe('recycled_spool');
  });

  it('23a. provenance: all measured + no anomaly → measured', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 100,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, r.ledgerEventId));
    expect(ev[0]!.provenanceClass).toBe('measured');
  });

  it('23b. provenance: measured + entered + no anomaly → entered', async () => {
    const ownerId = await seedUser();
    const a = await seedFilamentSpool(ownerId, 500);
    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [
          { sourceMaterialId: a.id, weight: 100, provenanceClass: 'measured' },
          { sourceMaterialId: null, weight: 50, provenanceClass: 'entered' },
        ],
        outputWeight: 150,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, r.ledgerEventId));
    expect(ev[0]!.provenanceClass).toBe('entered');
  });

  it('23c. provenance: measured inputs + anomaly+ack → entered (downgrade one notch)', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 120, // anomaly (> 105)
        acknowledgeWeightAnomaly: true,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, r.ledgerEventId));
    expect(ev[0]!.provenanceClass).toBe('entered');
  });

  it('23d. provenance: entered inputs + anomaly+ack → estimated', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);
    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'entered' }],
        outputWeight: 120,
        acknowledgeWeightAnomaly: true,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, r.ledgerEventId));
    expect(ev[0]!.provenanceClass).toBe('estimated');
  });

  it('23e. provenance: estimated anywhere → estimated (no further downgrade)', async () => {
    const ownerId = await seedUser();
    const a = await seedFilamentSpool(ownerId, 500);
    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [
          { sourceMaterialId: a.id, weight: 100, provenanceClass: 'measured' },
          { sourceMaterialId: null, weight: 50, provenanceClass: 'estimated' },
        ],
        outputWeight: 200, // anomaly (> 157.5), with ack
        acknowledgeWeightAnomaly: true,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, r.ledgerEventId));
    expect(ev[0]!.provenanceClass).toBe('estimated');
  });

  it('24. output spool brand/colors override propagated correctly', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 200, provenanceClass: 'measured' }],
        outputWeight: 190,
        outputSpoolBrand: 'Recycled Co',
        outputSpoolColors: ['#FF0000', '#0000FF'],
        outputSpoolColorPattern: 'dual-tone',
        outputSpoolColorName: 'red-blue swirl',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const out = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, r.outputSpoolId));
    expect(out[0]!.brand).toBe('Recycled Co');
    expect(out[0]!.colors).toEqual(['#FF0000', '#0000FF']);
    expect(out[0]!.colorPattern).toBe('dual-tone');
    expect(out[0]!.colorName).toBe('red-blue swirl');
  });

  it('25. recycle_events row preserves full inputs JSON (including null sources + notes)', async () => {
    const ownerId = await seedUser();
    const tracked = await seedFilamentSpool(ownerId, 500);

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [
          { sourceMaterialId: tracked.id, weight: 200, provenanceClass: 'measured' },
          { sourceMaterialId: null, weight: 30, provenanceClass: 'entered', note: 'purge tower scrap' },
        ],
        outputWeight: 220,
        notes: 'first batch of recycled PLA',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const re = await db()
      .select()
      .from(schema.recycleEvents)
      .where(eq(schema.recycleEvents.id, r.recycleEventId));
    expect(re).toHaveLength(1);
    expect(re[0]!.ownerId).toBe(ownerId);
    expect(re[0]!.outputSpoolId).toBe(r.outputSpoolId);
    expect(re[0]!.notes).toBe('first batch of recycled PLA');
    const stored = re[0]!.inputs;
    expect(stored).toHaveLength(2);
    expect(stored[0]!.sourceMaterialId).toBe(tracked.id);
    expect(stored[0]!.weight).toBe(200);
    expect(stored[1]!.sourceMaterialId).toBeNull();
    expect(stored[1]!.weight).toBe(30);
    expect(stored[1]!.note).toBe('purge tower scrap');
  });

  it('26. ledger relatedResources: tracked sources + synthetic untracked entries', async () => {
    const ownerId = await seedUser();
    const a = await seedFilamentSpool(ownerId, 500);
    const b = await seedFilamentSpool(ownerId, 500);

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [
          { sourceMaterialId: a.id, weight: 100, provenanceClass: 'measured' },
          { sourceMaterialId: null, weight: 20, provenanceClass: 'entered' },
          { sourceMaterialId: b.id, weight: 80, provenanceClass: 'measured' },
          { sourceMaterialId: null, weight: 10, provenanceClass: 'estimated' },
        ],
        outputWeight: 200,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const ev = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, r.ledgerEventId));
    const related = ev[0]!.relatedResources;
    expect(related).not.toBeNull();
    expect(related).toHaveLength(4);

    const tracked = related!.filter((x) => x.kind === 'material');
    const synthetic = related!.filter((x) => x.kind === 'untracked-scrap');
    expect(tracked.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(synthetic).toHaveLength(2);
    for (const s of synthetic) {
      expect(s.id.startsWith(`${r.recycleEventId}:scrap-`)).toBe(true);
      expect(s.role).toBe('source-input');
    }
    // The two synthetic entries get distinct ids.
    expect(synthetic[0]!.id).not.toBe(synthetic[1]!.id);
    // All entries share the source-input role.
    for (const x of related!) {
      expect(x.role).toBe('source-input');
    }
  });
});

// ---------------------------------------------------------------------------
// applyRecycleEvent — atomic rollback
// ---------------------------------------------------------------------------

/**
 * Build a Proxy around the real DB that throws on insert into a target table.
 * Mirrors the wrapper used in materials-mix.test.ts (T5) test 27.
 */
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
          return (target as { transaction: <U>(f: (t: unknown) => U) => U }).transaction((tx) => {
            const wrappedTx = new Proxy(tx as object, {
              get(t, p, r) {
                if (p === 'insert') return wrapInsert(t);
                return Reflect.get(t, p, r);
              },
            });
            return fn(wrappedTx);
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe('applyRecycleEvent — atomic rollback', () => {
  it('27. injected ledger insert failure → no source decrement, no recycled_spool, no recycle_events', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);

    const before = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, spool.id))
    )[0]!.remainingAmount;
    const matBefore = await db().select().from(schema.materials);
    const reBefore = await db().select().from(schema.recycleEvents);

    const clientModule = await import('../../src/db/client');
    const realDb = clientModule.getServerDb(DB_URL);
    const wrappedDb = buildFailingDbWrapper(schema.ledgerEvents, realDb);
    vi.spyOn(clientModule, 'getServerDb').mockReturnValue(
      wrappedDb as unknown as ReturnType<typeof clientModule.getServerDb>,
    );

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 100,
      },
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

    const matAfter = await db().select().from(schema.materials);
    expect(matAfter).toHaveLength(matBefore.length);
    const reAfter = await db().select().from(schema.recycleEvents);
    expect(reAfter).toHaveLength(reBefore.length);
  });

  it('28. injected recycle_events insert failure → no source decrement, no recycled_spool', async () => {
    const ownerId = await seedUser();
    const spool = await seedFilamentSpool(ownerId, 500);

    const before = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, spool.id))
    )[0]!.remainingAmount;
    const matBefore = await db().select().from(schema.materials);

    const clientModule = await import('../../src/db/client');
    const realDb = clientModule.getServerDb(DB_URL);
    const wrappedDb = buildFailingDbWrapper(schema.recycleEvents, realDb);
    vi.spyOn(clientModule, 'getServerDb').mockReturnValue(
      wrappedDb as unknown as ReturnType<typeof clientModule.getServerDb>,
    );

    const r = await applyRecycleEvent(
      {
        ownerId,
        actorUserId: ownerId,
        inputs: [{ sourceMaterialId: spool.id, weight: 100, provenanceClass: 'measured' }],
        outputWeight: 100,
      },
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

    const matAfter = await db().select().from(schema.materials);
    expect(matAfter).toHaveLength(matBefore.length);
  });
});

// ---------------------------------------------------------------------------
// Mass-conservation invariant property test
// ---------------------------------------------------------------------------

/**
 * Seeded LCG random generator (deterministic across runs). Mirrors T5.
 */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 1;
  return () => {
    s = (s * 48271) % 2147483647;
    return (s & 0x7fffffff) / 2147483647;
  };
}

describe('applyRecycleEvent — mass conservation invariant', () => {
  it('29. property: sum-of-tracked-deltas + sum-of-untracked-weights === outputWeight (no-anomaly path)', async () => {
    const ownerId = await seedUser();
    const rand = seededRandom(0xfeed1e);

    for (let iter = 0; iter < 20; iter++) {
      const trackedCount = 1 + Math.floor(rand() * 5); // 1..5
      const untrackedCount = Math.floor(rand() * 4); // 0..3

      const inputs: Array<{
        sourceMaterialId: string | null;
        weight: number;
        provenanceClass: 'measured' | 'entered' | 'estimated';
      }> = [];

      for (let c = 0; c < trackedCount; c++) {
        const weight = 1 + Math.floor(rand() * 100);
        const sourceRemaining = weight + 1 + Math.floor(rand() * 200);
        const src = await seedFilamentSpool(ownerId, sourceRemaining);
        const provIdx = Math.floor(rand() * 3);
        const provenanceClass = (
          ['measured', 'entered', 'estimated'] as const
        )[provIdx]!;
        inputs.push({ sourceMaterialId: src.id, weight, provenanceClass });
      }
      for (let c = 0; c < untrackedCount; c++) {
        const weight = 1 + Math.floor(rand() * 50);
        const provIdx = Math.floor(rand() * 3);
        const provenanceClass = (
          ['measured', 'entered', 'estimated'] as const
        )[provIdx]!;
        inputs.push({ sourceMaterialId: null, weight, provenanceClass });
      }

      // No-anomaly path: outputWeight === sum (well within the threshold).
      const outputWeight = inputs.reduce((acc, i) => acc + i.weight, 0);

      // Snapshot tracked sources BEFORE.
      const beforeMap = new Map<string, number>();
      for (const i of inputs) {
        if (i.sourceMaterialId === null) continue;
        const rows = await db()
          .select()
          .from(schema.materials)
          .where(eq(schema.materials.id, i.sourceMaterialId));
        beforeMap.set(i.sourceMaterialId, rows[0]!.remainingAmount);
      }

      const r = await applyRecycleEvent(
        { ownerId, actorUserId: ownerId, inputs, outputWeight },
        { dbUrl: DB_URL },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // Compute deltas on tracked + sum untracked, assert mass conservation.
      let sumTrackedDeltas = 0;
      let sumUntracked = 0;
      for (const i of inputs) {
        if (i.sourceMaterialId === null) {
          sumUntracked += i.weight;
        } else {
          const rows = await db()
            .select()
            .from(schema.materials)
            .where(eq(schema.materials.id, i.sourceMaterialId));
          const after = rows[0]!.remainingAmount;
          sumTrackedDeltas += beforeMap.get(i.sourceMaterialId)! - after;
        }
      }

      const out = await db()
        .select()
        .from(schema.materials)
        .where(eq(schema.materials.id, r.outputSpoolId));
      const initial = out[0]!.initialAmount;

      expect(Math.abs(sumTrackedDeltas + sumUntracked - initial)).toBeLessThanOrEqual(0.1);
      expect(out[0]!.remainingAmount).toBe(initial);
    }
  }, 60_000);
});
