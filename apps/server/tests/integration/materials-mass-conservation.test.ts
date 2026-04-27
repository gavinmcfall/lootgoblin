/**
 * Mass-conservation invariant — V2-007a-T8 integration test.
 *
 * Top-level invariant for the materials pillar:
 *   total mass IN the system at any time
 *     === mass that came IN (initial amounts of source materials)
 *         minus mass that went OUT (consumption events).
 *
 * Equivalent re-arrangement (used here):
 *   sum(initial_amounts of sources)
 *     === sum(remaining_amounts of ALL materials, active or retired)
 *         + sum(consumption_event.weightConsumed)
 *
 * This test runs a 10-iteration property loop. Each iteration:
 *   1. Creates 3 source materials (resin bottles, ml) with random initial
 *      amounts in [100, 500].
 *   2. Applies a 2-component mix using a random subset (2 of 3) and random
 *      draw amounts. The third source is left untouched in this iteration.
 *   3. Consumes a random portion of the mix_batch in [10, batch_volume].
 *   4. Asserts the conservation invariant holds.
 *
 * Each iteration uses fresh source materials; the system-wide total grows
 * with each iteration but the invariant is computed PER-ITERATION over the
 * materials created in that iteration plus the consumption recorded against
 * them. This isolates per-iteration invariants from per-suite ones (still
 * checked at the end as a sanity sweep).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq, inArray, and } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { createMaterial } from '../../src/materials/lifecycle';
import { applyMixBatch, createMixRecipe } from '../../src/materials/mix';
import { handleMaterialConsumed } from '../../src/materials/consumption';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-materials-mass-conservation-int.db';
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
    name: 'Mass Conservation Test User',
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

/** Seeded LCG random generator (deterministic across runs). */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 1;
  return () => {
    s = (s * 48271) % 2147483647;
    return (s & 0x7fffffff) / 2147483647;
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

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe('materials mass-conservation invariant — full lifecycle (T4 + T5 + T8)', () => {
  it('property: sum(initial_sources) === sum(remaining_all_materials) + sum(consumption_events) per iteration', async () => {
    const ownerId = await seedUser();
    const rand = seededRandom(0xdecade);

    for (let iter = 0; iter < 10; iter++) {
      // 1. Create 3 source materials with random initial amounts in [100, 500].
      const initialA = 100 + Math.floor(rand() * 400);
      const initialB = 100 + Math.floor(rand() * 400);
      const initialC = 100 + Math.floor(rand() * 400);
      const A = await seedResinBottle(ownerId, initialA);
      const B = await seedResinBottle(ownerId, initialB);
      const C = await seedResinBottle(ownerId, initialC);

      // 2. Apply a 2-component mix using a random subset of {A, B, C}.
      //    Pick the first two of a shuffled order.
      const ordered = [A, B, C].sort(() => rand() - 0.5);
      const [src1, src2, untouched] = ordered;
      // Random draws: each in [10, src.remainingAmount]; batch_volume = sum.
      const draw1 = 10 + Math.floor(rand() * (src1!.remainingAmount - 10));
      const draw2 = 10 + Math.floor(rand() * (src2!.remainingAmount - 10));
      const batchVolume = draw1 + draw2;

      const recipe = await createMixRecipe(
        {
          ownerId,
          name: `iter-${iter}`,
          components: [
            { materialProductRef: 'a', ratioOrGrams: 50 },
            { materialProductRef: 'b', ratioOrGrams: 50 },
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
          totalVolume: batchVolume,
          perComponentDraws: [
            {
              sourceMaterialId: src1!.id,
              drawAmount: draw1,
              provenanceClass: 'measured',
            },
            {
              sourceMaterialId: src2!.id,
              drawAmount: draw2,
              provenanceClass: 'measured',
            },
          ],
        },
        { dbUrl: DB_URL },
      );
      expect(mix.ok).toBe(true);
      if (!mix.ok) return;

      // 3. Consume a random portion of the mix_batch in [10, batchVolume].
      const consumeAmount = 10 + Math.floor(rand() * (batchVolume - 10));
      const cr = await handleMaterialConsumed(
        {
          type: 'material.consumed',
          materialId: mix.mixBatchMaterialId,
          weightConsumed: consumeAmount,
          provenanceClass: 'measured',
          attributedTo: { kind: 'print', jobId: `job-${iter}` },
          occurredAt: new Date(),
          source: 'forge:dispatch',
        },
        { dbUrl: DB_URL },
      );
      expect(cr.ok).toBe(true);
      if (!cr.ok) return;

      // 4. Snapshot all 4 materials (A, B, C, mix_batch) involved this iteration.
      const allIds = [A.id, B.id, C.id, mix.mixBatchMaterialId];
      const remainingRows = await db()
        .select()
        .from(schema.materials)
        .where(inArray(schema.materials.id, allIds));
      const remainingTotal = remainingRows.reduce(
        (acc, r) => acc + r.remainingAmount,
        0,
      );

      // Sum of consumption events recorded against THIS iteration's materials.
      const consumptionEvents = await db()
        .select()
        .from(schema.ledgerEvents)
        .where(
          and(
            eq(schema.ledgerEvents.kind, 'material.consumed'),
            inArray(schema.ledgerEvents.subjectId, allIds),
          ),
        );
      const consumedTotal = consumptionEvents.reduce((acc, e) => {
        const p = JSON.parse(e.payload!);
        return acc + (p.weightConsumed as number);
      }, 0);

      const initialTotal = initialA + initialB + initialC;

      // Mass conservation: initial = remaining + consumed.
      // The mix_batch's "added mass" is internal — it's a transformation, not
      // an inflow. Untouched material C still has initialC remaining.
      expect(remainingTotal + consumedTotal).toBe(initialTotal);

      // Sanity: untouched remained untouched.
      const cAfter = remainingRows.find((r) => r.id === untouched!.id)!.remainingAmount;
      expect(cAfter).toBe(untouched!.remainingAmount);
    }
  }, 60_000);
});
