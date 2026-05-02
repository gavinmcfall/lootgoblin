/**
 * Integration tests for the Materials schema — V2-007a-T1
 *
 * Real SQLite DB at /tmp/lootgoblin-t1-materials.db
 *
 * Coverage:
 *   1. Migration applies cleanly to a fresh DB.
 *   2. Insert a Material row for each MATERIAL_KINDS value.
 *   3. Multi-hex colors round-trip.
 *   4. FK enforcement: mix_batch with bogus recipe_id fails.
 *   5. FK enforcement: mix_batch with bogus material_id fails.
 *   6. Cascade delete: deleting the user removes their materials, mix_recipes,
 *      and recycle_events.
 *   7. Cascade delete: deleting a kind='mix_batch' Material deletes its
 *      mix_batches row.
 *   8. Expected indexes exist (PRAGMA / sqlite_master).
 *   9. Stub catalog tables exist + accept inserts of just an id.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { MATERIAL_KINDS } from '../../src/materials/types';
import type { MaterialKind } from '../../src/materials/types';

const DB_PATH = '/tmp/lootgoblin-t1-materials.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

function now(): Date {
  return new Date();
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

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Materials Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

interface SeedMaterialOpts {
  ownerId: string;
  kind: MaterialKind;
  brand?: string | null;
  subtype?: string | null;
  colors?: string[] | null;
  colorPattern?: string | null;
  initialAmount?: number;
  remainingAmount?: number;
  unit?: 'g' | 'ml';
}

async function seedMaterial(opts: SeedMaterialOpts): Promise<string> {
  const id = uid();
  await db().insert(schema.materials).values({
    id,
    ownerId: opts.ownerId,
    kind: opts.kind,
    brand: opts.brand ?? null,
    subtype: opts.subtype ?? null,
    colors: opts.colors ?? null,
    colorPattern: opts.colorPattern ?? null,
    initialAmount: opts.initialAmount ?? 1000,
    remainingAmount: opts.remainingAmount ?? 1000,
    unit: opts.unit ?? 'g',
    active: true,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V2-007a-T1 materials schema migration', () => {
  it('1. migrations applied — all new tables exist', () => {
    const sqlite = (
      db() as unknown as {
        $client: { prepare: (s: string) => { all: () => Array<{ name: string }> } };
      }
    ).$client;
    const expected = [
      'filament_products',
      'materials',
      'mix_batches',
      'mix_recipes',
      'recycle_events',
      'resin_products',
    ];
    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${expected
          .map((n) => `'${n}'`)
          .join(',')})`,
      )
      .all();
    expect(tables.map((t) => t.name).sort()).toEqual(expected);
  });

  it('2. accepts inserts for every MaterialKind value', async () => {
    const ownerId = await seedUser();
    const ids: string[] = [];
    for (const kind of MATERIAL_KINDS) {
      ids.push(
        await seedMaterial({
          ownerId,
          kind,
          brand: 'Test Brand',
          subtype: 'PLA',
          colors: ['#FF0000'],
          colorPattern: 'solid',
        }),
      );
    }

    const rows = await db()
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.ownerId, ownerId));

    expect(rows.length).toBe(MATERIAL_KINDS.length);
    expect(rows.map((r) => r.kind).sort()).toEqual([...MATERIAL_KINDS].sort());
  });

  it('3. multi-hex colors round-trip via JSON column', async () => {
    const ownerId = await seedUser();
    const colors = ['#FF0000', '#00FF00', '#0000FF'];
    const id = await seedMaterial({
      ownerId,
      kind: 'filament_spool',
      brand: 'Bambu Lab',
      subtype: 'PLA',
      colors,
      colorPattern: 'multi-section',
    });

    const row = (
      await db().select().from(schema.materials).where(eq(schema.materials.id, id))
    )[0];

    expect(row?.colors).toEqual(colors);
    expect(row?.colorPattern).toBe('multi-section');
    expect(row?.active).toBe(true);
  });

  it('4. FK enforcement: mix_batch with non-existent recipe_id fails', async () => {
    const ownerId = await seedUser();
    const materialId = await seedMaterial({
      ownerId,
      kind: 'mix_batch',
    });

    let threw = false;
    try {
      await db().insert(schema.mixBatches).values({
        id: uid(),
        recipeId: 'no-such-recipe',
        materialId,
        totalVolume: 100,
        perComponentDraws: [
          { sourceMaterialId: uid(), drawAmount: 100, provenanceClass: 'entered' },
        ],
      });
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/FOREIGN KEY|foreign key/i);
    }
    expect(threw).toBe(true);
  });

  it('5. FK enforcement: mix_batch with non-existent material_id fails', async () => {
    const ownerId = await seedUser();

    const recipeId = uid();
    await db().insert(schema.mixRecipes).values({
      id: recipeId,
      ownerId,
      name: 'Royal Purple 50/50',
      components: [
        { materialProductRef: 'polymaker-resin-purple', ratioOrGrams: 50 },
        { materialProductRef: 'polymaker-resin-blue', ratioOrGrams: 50 },
      ],
    });

    let threw = false;
    try {
      await db().insert(schema.mixBatches).values({
        id: uid(),
        recipeId,
        materialId: 'no-such-material',
        totalVolume: 100,
        perComponentDraws: [],
      });
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/FOREIGN KEY|foreign key/i);
    }
    expect(threw).toBe(true);
  });

  it('6. cascade: deleting a user removes their materials + mix_recipes + recycle_events', async () => {
    const ownerId = await seedUser();

    // Material
    const materialId = await seedMaterial({ ownerId, kind: 'filament_spool' });

    // mix_recipe
    const recipeId = uid();
    await db().insert(schema.mixRecipes).values({
      id: recipeId,
      ownerId,
      name: 'Cascade Recipe',
      components: [{ materialProductRef: 'foo', ratioOrGrams: 100 }],
    });

    // recycled_spool (output for the recycle_event)
    const outputSpoolId = await seedMaterial({ ownerId, kind: 'recycled_spool' });

    // recycle_event
    const recycleId = uid();
    await db().insert(schema.recycleEvents).values({
      id: recycleId,
      ownerId,
      inputs: [
        { sourceMaterialId: null, weight: 240, provenanceClass: 'entered', note: 'scrap' },
      ],
      outputSpoolId,
    });

    // Sanity: rows exist
    expect(
      (await db().select().from(schema.materials).where(eq(schema.materials.ownerId, ownerId)))
        .length,
    ).toBe(2);

    // Delete the user
    await db().delete(schema.user).where(eq(schema.user.id, ownerId));

    // All owner-scoped tables empty for this owner
    expect(
      (await db().select().from(schema.materials).where(eq(schema.materials.ownerId, ownerId)))
        .length,
    ).toBe(0);
    expect(
      (
        await db().select().from(schema.mixRecipes).where(eq(schema.mixRecipes.ownerId, ownerId))
      ).length,
    ).toBe(0);
    expect(
      (
        await db()
          .select()
          .from(schema.recycleEvents)
          .where(eq(schema.recycleEvents.ownerId, ownerId))
      ).length,
    ).toBe(0);

    // Reference materialId/recipeId/outputSpoolId so the linter sees them used.
    expect(materialId).toBeTruthy();
    expect(recycleId).toBeTruthy();
    expect(recipeId).toBeTruthy();
  });

  it('7. cascade: deleting a kind=mix_batch Material deletes its mix_batches row', async () => {
    const ownerId = await seedUser();

    // recipe
    const recipeId = uid();
    await db().insert(schema.mixRecipes).values({
      id: recipeId,
      ownerId,
      name: 'Cascade-via-material recipe',
      components: [{ materialProductRef: 'foo', ratioOrGrams: 100 }],
    });

    // mix_batch material
    const materialId = await seedMaterial({
      ownerId,
      kind: 'mix_batch',
      unit: 'ml',
      initialAmount: 100,
      remainingAmount: 100,
    });

    // mix_batches row joining recipe + material
    const batchId = uid();
    await db().insert(schema.mixBatches).values({
      id: batchId,
      recipeId,
      materialId,
      totalVolume: 100,
      perComponentDraws: [
        { sourceMaterialId: uid(), drawAmount: 100, provenanceClass: 'entered' },
      ],
    });

    // Sanity: batch row exists
    expect(
      (await db().select().from(schema.mixBatches).where(eq(schema.mixBatches.id, batchId))).length,
    ).toBe(1);

    // Delete the Material row → expect mix_batches CASCADE delete
    await db().delete(schema.materials).where(eq(schema.materials.id, materialId));

    expect(
      (await db().select().from(schema.mixBatches).where(eq(schema.mixBatches.id, batchId))).length,
    ).toBe(0);
  });

  it('8. expected indexes are present', () => {
    const sqlite = (
      db() as unknown as {
        $client: {
          prepare: (s: string) => { all: (...args: unknown[]) => Array<{ name: string }> };
        };
      }
    ).$client;

    const idxFor = (table: string): string[] =>
      sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${table}'`)
        .all()
        .map((r) => r.name);

    // V2-005f-CF-1 T_g1 dropped the legacy `materials_loaded_idx` along with
    // the `loaded_in_printer_ref` column; load tracking moved to the
    // `printer_loadouts` table.
    expect(idxFor('materials')).toEqual(
      expect.arrayContaining([
        'materials_owner_active_idx',
        'materials_owner_kind_idx',
        'materials_product_idx',
        'materials_owner_brand_idx',
        'materials_owner_subtype_idx',
      ]),
    );
    expect(idxFor('mix_recipes')).toEqual(expect.arrayContaining(['mix_recipes_owner_idx']));
    expect(idxFor('mix_batches')).toEqual(
      expect.arrayContaining(['mix_batches_recipe_idx', 'mix_batches_material_idx']),
    );
    expect(idxFor('recycle_events')).toEqual(
      expect.arrayContaining(['recycle_events_owner_idx', 'recycle_events_output_idx']),
    );
  });

  it('9. catalog stub tables exist and accept inserts of just an id', async () => {
    await db().insert(schema.filamentProducts).values({ id: 'bambu-pla-basic-black' });
    await db().insert(schema.resinProducts).values({ id: 'elegoo-standard-grey' });

    const filaments = await db().select().from(schema.filamentProducts);
    const resins = await db().select().from(schema.resinProducts);

    expect(filaments.map((r) => r.id)).toContain('bambu-pla-basic-black');
    expect(resins.map((r) => r.id)).toContain('elegoo-standard-grey');
  });
});
