/**
 * Unit tests for Mix flow — V2-007a-T5.
 *
 * Real-DB-on-tmpfile pattern (mirrors materials-lifecycle.test.ts). Covers:
 *   - createMixRecipe: happy paths + validation (count, malformed, sum-not-validated).
 *   - applyMixBatch: validation rejects (recipe-not-found, draw-* mismatches,
 *     source-* failures, malformed inputs).
 *   - applyMixBatch happy paths: 2-component, 3-component, color override.
 *   - Provenance escalation: weakest-link rule across measured/entered/estimated.
 *   - Atomic rollback: injected ledger / mix_batches insert failures must roll
 *     back the whole batch (no source decrement, no mix_batch material).
 *   - Mass-conservation invariant property test (the headliner): randomized
 *     loop that snapshots remainingAmount before+after and asserts the deltas
 *     equal the new mix_batch's initialAmount within tolerance.
 */

import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { createMaterial } from '../../src/materials/lifecycle';
import { createMixRecipe, applyMixBatch } from '../../src/materials/mix';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-materials-mix-unit.db';
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
    name: 'Mix Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
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
      subtype: 'Standard Resin',
      colors: ['#112233'],
      colorPattern: 'solid',
      initialAmount,
      unit: 'ml',
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`seedResinBottle failed: ${r.reason}`);
  return r.material;
}

async function seedRecipe(
  ownerId: string,
  componentCount = 2,
): Promise<string> {
  const components = Array.from({ length: componentCount }, (_, i) => ({
    materialProductRef: `test-resin-${i}`,
    ratioOrGrams: 50,
  }));
  const r = await createMixRecipe(
    { ownerId, name: `recipe-${componentCount}c-${uid().slice(0, 6)}`, components },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`seedRecipe failed: ${r.reason}`);
  return r.recipeId;
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
// createMixRecipe
// ---------------------------------------------------------------------------

describe('createMixRecipe — happy paths', () => {
  it('1. 2-component recipe → row inserted with components array', async () => {
    const ownerId = await seedUser();
    const r = await createMixRecipe(
      {
        ownerId,
        name: 'purple-blue 50/50',
        components: [
          { materialProductRef: 'polymaker-resin-purple', ratioOrGrams: 50 },
          { materialProductRef: 'polymaker-resin-blue', ratioOrGrams: 50 },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const rows = await db()
      .select()
      .from(schema.mixRecipes)
      .where(eq(schema.mixRecipes.id, r.recipeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('purple-blue 50/50');
    expect(rows[0]!.components).toHaveLength(2);
    expect(rows[0]!.components[0]!.materialProductRef).toBe('polymaker-resin-purple');
  });

  it('2. 3-component recipe', async () => {
    const ownerId = await seedUser();
    const r = await createMixRecipe(
      {
        ownerId,
        name: 'tri-mix',
        components: [
          { materialProductRef: 'a', ratioOrGrams: 33 },
          { materialProductRef: 'b', ratioOrGrams: 33 },
          { materialProductRef: 'c', ratioOrGrams: 34 },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = await db()
      .select()
      .from(schema.mixRecipes)
      .where(eq(schema.mixRecipes.id, r.recipeId));
    expect(rows[0]!.components).toHaveLength(3);
  });

  it('7. component sum NOT validated at create (sum=120 still inserts)', async () => {
    const ownerId = await seedUser();
    const r = await createMixRecipe(
      {
        ownerId,
        name: 'sum-120',
        components: [
          { materialProductRef: 'a', ratioOrGrams: 60 },
          { materialProductRef: 'b', ratioOrGrams: 60 },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
  });
});

describe('createMixRecipe — validation rejections', () => {
  it('3. 1 component → reject (component-count-out-of-range)', async () => {
    const ownerId = await seedUser();
    const r = await createMixRecipe(
      {
        ownerId,
        name: 'too-few',
        components: [{ materialProductRef: 'a', ratioOrGrams: 100 }],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('component-count-out-of-range');
  });

  it('4. 11 components → reject', async () => {
    const ownerId = await seedUser();
    const components = Array.from({ length: 11 }, (_, i) => ({
      materialProductRef: `r-${i}`,
      ratioOrGrams: 1,
    }));
    const r = await createMixRecipe(
      { ownerId, name: 'too-many', components },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('component-count-out-of-range');
  });

  it('5. empty components array → reject', async () => {
    const ownerId = await seedUser();
    const r = await createMixRecipe(
      { ownerId, name: 'empty', components: [] },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('component-count-out-of-range');
  });

  it('6a. malformed component (missing materialProductRef) → reject', async () => {
    const ownerId = await seedUser();
    const r = await createMixRecipe(
      {
        ownerId,
        name: 'bad',
        components: [
          // @ts-expect-error intentional malformed input
          { ratioOrGrams: 50 },
          { materialProductRef: 'b', ratioOrGrams: 50 },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('component-malformed');
  });

  it('6b. malformed component (missing ratioOrGrams) → reject', async () => {
    const ownerId = await seedUser();
    const r = await createMixRecipe(
      {
        ownerId,
        name: 'bad2',
        components: [
          // @ts-expect-error intentional malformed input
          { materialProductRef: 'a' },
          { materialProductRef: 'b', ratioOrGrams: 50 },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('component-malformed');
  });

  it('6c. malformed component (negative ratio) → reject', async () => {
    const ownerId = await seedUser();
    const r = await createMixRecipe(
      {
        ownerId,
        name: 'bad3',
        components: [
          { materialProductRef: 'a', ratioOrGrams: -10 },
          { materialProductRef: 'b', ratioOrGrams: 60 },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('component-malformed');
  });
});

// ---------------------------------------------------------------------------
// applyMixBatch — validation rejections
// ---------------------------------------------------------------------------

describe('applyMixBatch — validation rejections', () => {
  it('8. recipe doesn\'t exist → recipe-not-found', async () => {
    const ownerId = await seedUser();
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 100);
    const r = await applyMixBatch(
      {
        recipeId: 'no-such-recipe',
        actorUserId: ownerId,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 50, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 50, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('recipe-not-found');
  });

  it('9. recipe belongs to different owner than actorUserId → recipe-not-found (404 semantics)', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const recipeId = await seedRecipe(ownerA, 2);
    const a = await seedResinBottle(ownerB, 100);
    const b = await seedResinBottle(ownerB, 100);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerB, // different owner
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 50, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 50, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('recipe-not-found');
  });

  it('10. perComponentDraws.length !== recipe.components.length → draw-count-mismatch', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 3); // 3-component recipe
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 100);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 50, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 50, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('draw-count-mismatch');
  });

  it('11. drawAmount=0 in any draw → draw-malformed', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 2);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 100);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 50,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 0, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 50, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('draw-malformed');
  });

  it('12. drawAmount<0 → draw-malformed', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 2);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 100);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: -10, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 50, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('draw-malformed');
  });

  it('13. sum of drawAmounts mismatches totalVolume by > 0.1 → draw-sum-mismatch', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 2);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 100);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 50, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 60, provenanceClass: 'measured' }, // sum=110, off by 10
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('draw-sum-mismatch');
  });

  it('14. sum within ±0.1 → accepted', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 2);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 100);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 100,
        // 50.04 + 49.97 = 100.01, within 0.1
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 50.04, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 49.97, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
  });

  it('15. source material doesn\'t exist → source-not-found', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 2);
    const a = await seedResinBottle(ownerId, 100);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 50, provenanceClass: 'measured' },
          { sourceMaterialId: 'no-such-material', drawAmount: 50, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('source-not-found');
  });

  it('16. source material belongs to different owner → source-not-owned', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const recipeId = await seedRecipe(ownerA, 2);
    const aOwnedByA = await seedResinBottle(ownerA, 100);
    const bOwnedByB = await seedResinBottle(ownerB, 100); // wrong owner

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerA,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: aOwnedByA.id, drawAmount: 50, provenanceClass: 'measured' },
          { sourceMaterialId: bOwnedByB.id, drawAmount: 50, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('source-not-owned');
  });

  it('17. source material is retired (active=false) → source-retired', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 2);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 100);
    // Manually retire B
    await db()
      .update(schema.materials)
      .set({ active: false })
      .where(eq(schema.materials.id, b.id));

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 50, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 50, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('source-retired');
  });

  it('18. source has remainingAmount < drawAmount → source-insufficient', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 2);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 30); // not enough

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 50, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 50, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('source-insufficient');
  });

  it('19. invalid provenanceClass → draw-malformed', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 2);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 100);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 50, provenanceClass: 'measured' },
          // @ts-expect-error intentional invalid provenance
          { sourceMaterialId: b.id, drawAmount: 50, provenanceClass: 'guessed' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('draw-malformed');
  });

  it('20. totalVolume <= 0 → total-volume-invalid', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 2);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 100);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 0,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 0, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 0, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('total-volume-invalid');
  });
});

// ---------------------------------------------------------------------------
// applyMixBatch — happy paths
// ---------------------------------------------------------------------------

describe('applyMixBatch — happy paths', () => {
  it('21. 2-component happy path: decrements sources, creates mix_batch material + mix_batches row + ledger event', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 2);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 200);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 50, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 50, provenanceClass: 'entered' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Sources decremented.
    const aRows = await db().select().from(schema.materials).where(eq(schema.materials.id, a.id));
    const bRows = await db().select().from(schema.materials).where(eq(schema.materials.id, b.id));
    expect(aRows[0]!.remainingAmount).toBe(50);
    expect(bRows[0]!.remainingAmount).toBe(150);

    // New mix_batch material.
    const mixMatRows = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, r.mixBatchMaterialId));
    expect(mixMatRows).toHaveLength(1);
    const mixMat = mixMatRows[0]!;
    expect(mixMat.kind).toBe('mix_batch');
    expect(mixMat.initialAmount).toBe(100);
    expect(mixMat.remainingAmount).toBe(100);
    expect(mixMat.unit).toBe('ml');
    expect(mixMat.colors).toBeNull();
    expect(mixMat.colorPattern).toBeNull();
    expect(mixMat.active).toBe(true);
    expect(mixMat.ownerId).toBe(ownerId);

    // mix_batches row.
    const mbRows = await db()
      .select()
      .from(schema.mixBatches)
      .where(eq(schema.mixBatches.id, r.mixBatchId));
    expect(mbRows).toHaveLength(1);
    expect(mbRows[0]!.recipeId).toBe(recipeId);
    expect(mbRows[0]!.materialId).toBe(r.mixBatchMaterialId);
    expect(mbRows[0]!.totalVolume).toBe(100);
    expect(mbRows[0]!.perComponentDraws).toHaveLength(2);
    expect(mbRows[0]!.perComponentDraws[0]!.sourceMaterialId).toBe(a.id);
    expect(mbRows[0]!.perComponentDraws[0]!.drawAmount).toBe(50);

    // Ledger event.
    const ev = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, r.ledgerEventId));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.kind).toBe('material.mix_created');
    expect(ev[0]!.subjectType).toBe('material');
    expect(ev[0]!.subjectId).toBe(r.mixBatchMaterialId);
    expect(ev[0]!.actorUserId).toBe(ownerId);
    // Provenance: any draw 'entered' (no estimated) → batch 'entered'.
    expect(ev[0]!.provenanceClass).toBe('entered');
    const related = ev[0]!.relatedResources;
    expect(related).not.toBeNull();
    const sources = related!.filter((r) => r.role === 'source');
    expect(sources.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    const recipeRefs = related!.filter((r) => r.role === 'recipe');
    expect(recipeRefs).toHaveLength(1);
    expect(recipeRefs[0]!.id).toBe(recipeId);
    expect(recipeRefs[0]!.kind).toBe('mix_recipe');
    const payload = JSON.parse(ev[0]!.payload!);
    expect(payload.totalVolume).toBe(100);
    expect(payload.unit).toBe('ml');
    expect(payload.perComponentDraws).toHaveLength(2);
  });

  it('22. 3-component happy path', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 3);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 100);
    const c = await seedResinBottle(ownerId, 100);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 90,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 30, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 30, provenanceClass: 'measured' },
          { sourceMaterialId: c.id, drawAmount: 30, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    for (const id of [a.id, b.id, c.id]) {
      const rows = await db().select().from(schema.materials).where(eq(schema.materials.id, id));
      expect(rows[0]!.remainingAmount).toBe(70);
    }

    const mixRows = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, r.mixBatchMaterialId));
    expect(mixRows[0]!.initialAmount).toBe(90);
  });

  it('23. provenance: all measured → batch measured', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 2);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 100);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 50, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 50, provenanceClass: 'measured' },
        ],
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

  it('24. provenance: 2 measured + 1 entered → batch entered', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 3);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 100);
    const c = await seedResinBottle(ownerId, 100);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 90,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 30, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 30, provenanceClass: 'measured' },
          { sourceMaterialId: c.id, drawAmount: 30, provenanceClass: 'entered' },
        ],
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

  it('25. provenance: any estimated → batch estimated (weakest-link)', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 3);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 100);
    const c = await seedResinBottle(ownerId, 100);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 90,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 30, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 30, provenanceClass: 'entered' },
          { sourceMaterialId: c.id, drawAmount: 30, provenanceClass: 'estimated' },
        ],
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

  it('26. color override: colors + colorPattern propagated to mix_batch material', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 2);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 100);

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 50, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 50, provenanceClass: 'measured' },
        ],
        colors: ['#FF0000', '#0000FF'],
        colorPattern: 'dual-tone',
        colorName: 'red-blue mix',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const rows = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, r.mixBatchMaterialId));
    expect(rows[0]!.colors).toEqual(['#FF0000', '#0000FF']);
    expect(rows[0]!.colorPattern).toBe('dual-tone');
    expect(rows[0]!.colorName).toBe('red-blue mix');
  });
});

// ---------------------------------------------------------------------------
// applyMixBatch — atomic rollback
// ---------------------------------------------------------------------------

/**
 * Build a Proxy around the real DB that throws on insert into a target table.
 * Mirrors the wrapper used in materials-lifecycle.test.ts test 15.
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

describe('applyMixBatch — atomic rollback', () => {
  it('27. injected ledger insert failure → no source decrement, no mix_batch material, no mix_batches row', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 2);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 200);

    // Snapshot before.
    const beforeA = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, a.id))
    )[0]!.remainingAmount;
    const beforeB = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, b.id))
    )[0]!.remainingAmount;
    const matBefore = await db().select().from(schema.materials);
    const mbBefore = await db().select().from(schema.mixBatches);

    const clientModule = await import('../../src/db/client');
    const realDb = clientModule.getServerDb(DB_URL);
    const wrappedDb = buildFailingDbWrapper(schema.ledgerEvents, realDb);
    vi.spyOn(clientModule, 'getServerDb').mockReturnValue(
      wrappedDb as unknown as ReturnType<typeof clientModule.getServerDb>,
    );

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 50, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 50, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('persist-failed');

    vi.restoreAllMocks();

    // Sources NOT decremented.
    const afterA = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, a.id))
    )[0]!.remainingAmount;
    const afterB = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, b.id))
    )[0]!.remainingAmount;
    expect(afterA).toBe(beforeA);
    expect(afterB).toBe(beforeB);

    // No new materials, no new mix_batches.
    const matAfter = await db().select().from(schema.materials);
    expect(matAfter).toHaveLength(matBefore.length);
    const mbAfter = await db().select().from(schema.mixBatches);
    expect(mbAfter).toHaveLength(mbBefore.length);
  });

  it('28. injected mix_batches insert failure → sources NOT decremented, mix_batch material NOT created', async () => {
    const ownerId = await seedUser();
    const recipeId = await seedRecipe(ownerId, 2);
    const a = await seedResinBottle(ownerId, 100);
    const b = await seedResinBottle(ownerId, 200);

    const beforeA = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, a.id))
    )[0]!.remainingAmount;
    const beforeB = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, b.id))
    )[0]!.remainingAmount;
    const matBefore = await db().select().from(schema.materials);

    const clientModule = await import('../../src/db/client');
    const realDb = clientModule.getServerDb(DB_URL);
    const wrappedDb = buildFailingDbWrapper(schema.mixBatches, realDb);
    vi.spyOn(clientModule, 'getServerDb').mockReturnValue(
      wrappedDb as unknown as ReturnType<typeof clientModule.getServerDb>,
    );

    const r = await applyMixBatch(
      {
        recipeId,
        actorUserId: ownerId,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: a.id, drawAmount: 50, provenanceClass: 'measured' },
          { sourceMaterialId: b.id, drawAmount: 50, provenanceClass: 'measured' },
        ],
      },
      { dbUrl: DB_URL },
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('persist-failed');

    vi.restoreAllMocks();

    const afterA = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, a.id))
    )[0]!.remainingAmount;
    const afterB = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, b.id))
    )[0]!.remainingAmount;
    expect(afterA).toBe(beforeA);
    expect(afterB).toBe(beforeB);

    const matAfter = await db().select().from(schema.materials);
    expect(matAfter).toHaveLength(matBefore.length);
  });
});

// ---------------------------------------------------------------------------
// Mass-conservation invariant property test
// ---------------------------------------------------------------------------

/**
 * Seeded LCG random generator (deterministic across runs).
 * Returns a function in [0, 1).
 */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 1;
  return () => {
    // Park-Miller minstd
    s = (s * 48271) % 2147483647;
    return (s & 0x7fffffff) / 2147483647;
  };
}

describe('applyMixBatch — mass conservation invariant', () => {
  it('29. property: sum-of-source-deltas === mix_batch.initialAmount across 20 randomized iterations', async () => {
    const ownerId = await seedUser();
    const rand = seededRandom(0xc0ffee);

    for (let iter = 0; iter < 20; iter++) {
      const componentCount = 2 + Math.floor(rand() * 4); // 2..5
      const recipeId = await seedRecipe(ownerId, componentCount);

      // Each draw 1..100 ml; source has at least drawAmount headroom + slack.
      const draws: Array<{
        sourceMaterialId: string;
        drawAmount: number;
        provenanceClass: 'measured' | 'entered' | 'estimated';
      }> = [];

      for (let c = 0; c < componentCount; c++) {
        const drawAmount = 1 + Math.floor(rand() * 100);
        const sourceRemaining = drawAmount + 1 + Math.floor(rand() * 200);
        const src = await seedResinBottle(ownerId, sourceRemaining);
        const provIdx = Math.floor(rand() * 3);
        const provenanceClass = (
          ['measured', 'entered', 'estimated'] as const
        )[provIdx]!;
        draws.push({ sourceMaterialId: src.id, drawAmount, provenanceClass });
      }

      const totalVolume = draws.reduce((acc, d) => acc + d.drawAmount, 0);

      // Snapshot all involved source remainings BEFORE.
      const beforeMap = new Map<string, number>();
      for (const d of draws) {
        const rows = await db()
          .select()
          .from(schema.materials)
          .where(eq(schema.materials.id, d.sourceMaterialId));
        beforeMap.set(d.sourceMaterialId, rows[0]!.remainingAmount);
      }

      const r = await applyMixBatch(
        {
          recipeId,
          actorUserId: ownerId,
          totalVolume,
          perComponentDraws: draws,
        },
        { dbUrl: DB_URL },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // Snapshot after, compute deltas-on-sources, assert sum equals new mix.
      let sumDeltas = 0;
      for (const d of draws) {
        const rows = await db()
          .select()
          .from(schema.materials)
          .where(eq(schema.materials.id, d.sourceMaterialId));
        const after = rows[0]!.remainingAmount;
        const delta = beforeMap.get(d.sourceMaterialId)! - after;
        sumDeltas += delta;
      }

      const mixRows = await db()
        .select()
        .from(schema.materials)
        .where(eq(schema.materials.id, r.mixBatchMaterialId));
      const mixInitial = mixRows[0]!.initialAmount;

      // Mass conservation: sum of source deltas equals new mix's initial amount.
      expect(Math.abs(sumDeltas - mixInitial)).toBeLessThanOrEqual(0.1);
      // And the new mix's remainingAmount equals initialAmount on creation.
      expect(mixRows[0]!.remainingAmount).toBe(mixInitial);
    }
  }, 60_000);
});
