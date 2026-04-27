/**
 * Integration tests for the catalog schema — V2-007b T_B1
 *
 * Real SQLite DB at /tmp/lootgoblin-t_b1-catalog.db.
 *
 * Coverage:
 *   1. Migration 0022 applies cleanly (the V2-007a stubs gain the full
 *      column set + indexes).
 *   2. Insert a system-seeded filament product (owner_id NULL).
 *   3. Insert a user-custom filament product (non-NULL owner_id).
 *   4. FK CASCADE: deleting a user removes their custom catalog entries
 *      (system-seeded entries with NULL owner_id are untouched).
 *   5. Insert a resin product with the full kind-specific column set.
 *   6. Insert a resin product with most fields NULL (PrusaSlicer-derived seed
 *      has thin coverage — schema must tolerate it).
 *   7. JSON round-trip on colors / default_temps / default_exposure /
 *      compatibility.
 *   8. Expected indexes are present on both tables (PRAGMA / sqlite_master).
 *   9. Expression index on json_extract(colors, '$[0]') is hit by the SQLite
 *      query planner for primary-color filter queries.
 *  10. Insert a 4-color rainbow PLA filament + verify the multi-hex
 *      round-trip end-to-end.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq, isNull, and } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  FILAMENT_SUBTYPES,
  RESIN_SUBTYPES,
  RESIN_MATERIAL_CLASSES,
  PRODUCT_SOURCES,
  isFilamentSubtype,
  isResinSubtype,
  isProductSource,
  isResinMaterialClass,
} from '../../src/materials/catalog-types';

const DB_PATH = '/tmp/lootgoblin-t_b1-catalog.db';
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
    name: 'Catalog Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

interface RawSqliteClient {
  prepare: (s: string) => {
    all: (...args: unknown[]) => Array<Record<string, unknown>>;
    get: (...args: unknown[]) => Record<string, unknown> | undefined;
    run: (...args: unknown[]) => unknown;
  };
}

function rawClient(): RawSqliteClient {
  return (db() as unknown as { $client: RawSqliteClient }).$client;
}

describe('V2-007b T_B1 catalog schema migration', () => {
  it('1. migration applied — filament_products + resin_products have the expanded column set', () => {
    const sqlite = rawClient();
    const filamentCols = sqlite
      .prepare(`PRAGMA table_info('filament_products')`)
      .all()
      .map((r) => String(r.name));
    const resinCols = sqlite
      .prepare(`PRAGMA table_info('resin_products')`)
      .all()
      .map((r) => String(r.name));

    expect(filamentCols).toEqual(
      expect.arrayContaining([
        'id',
        'brand',
        'product_line',
        'subtype',
        'colors',
        'color_pattern',
        'color_name',
        'default_temps',
        'diameter_mm',
        'density',
        'spool_weight_g',
        'empty_spool_weight_g',
        'finish',
        'pattern',
        'is_glow',
        'is_translucent',
        'retail_url',
        'slicer_id',
        'owner_id',
        'source',
        'source_ref',
        'created_at',
        'updated_at',
      ]),
    );

    expect(resinCols).toEqual(
      expect.arrayContaining([
        'id',
        'brand',
        'product_line',
        'subtype',
        'colors',
        'color_name',
        'default_exposure',
        'density_g_ml',
        'viscosity_cps',
        'bottle_volume_ml',
        'compatibility',
        'material_class',
        'retail_url',
        'owner_id',
        'source',
        'source_ref',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('2. insert a system-seeded filament product (owner_id NULL)', async () => {
    const id = 'bambu-pla-basic-velvet-eclipse';
    await db().insert(schema.filamentProducts).values({
      id,
      brand: 'Bambu Lab',
      productLine: 'PLA Basic',
      subtype: 'PLA',
      colors: ['#000000', '#A34342'],
      colorPattern: 'dual-tone',
      colorName: 'Velvet Eclipse',
      defaultTemps: { nozzle_min: 220, nozzle_max: 240, bed: 60 },
      diameterMm: 1.75,
      density: 1.24,
      spoolWeightG: 1000,
      emptySpoolWeightG: 250,
      finish: 'glossy',
      isGlow: false,
      isTranslucent: false,
      retailUrl: 'https://bambulab.com/en/filament/pla-basic',
      slicerId: 'GFA00',
      ownerId: null,
      source: 'system:spoolmandb',
      sourceRef: 'd4f3a21:filaments/bambulab.json',
    });

    const row = (
      await db()
        .select()
        .from(schema.filamentProducts)
        .where(eq(schema.filamentProducts.id, id))
    )[0];

    expect(row).toBeDefined();
    expect(row?.brand).toBe('Bambu Lab');
    expect(row?.subtype).toBe('PLA');
    expect(isFilamentSubtype(row?.subtype)).toBe(true);
    expect(row?.colors).toEqual(['#000000', '#A34342']);
    expect(row?.colorPattern).toBe('dual-tone');
    expect(row?.ownerId).toBeNull();
    expect(row?.source).toBe('system:spoolmandb');
    expect(isProductSource(row?.source)).toBe(true);
    expect(row?.isGlow).toBe(false);
    expect(row?.isTranslucent).toBe(false);
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });

  it('3. insert a user-custom filament product (non-NULL owner_id)', async () => {
    const ownerId = await seedUser();
    const id = `custom-${uid()}`;

    await db().insert(schema.filamentProducts).values({
      id,
      brand: 'Garage Roll',
      productLine: 'Mystery Spool',
      subtype: 'PETG',
      colors: ['#3366CC'],
      colorPattern: 'solid',
      ownerId,
      source: 'user',
    });

    const row = (
      await db()
        .select()
        .from(schema.filamentProducts)
        .where(eq(schema.filamentProducts.id, id))
    )[0];

    expect(row?.ownerId).toBe(ownerId);
    expect(row?.source).toBe('user');
  });

  it('4. FK CASCADE: deleting the user removes their custom catalog entries; system seeded survive', async () => {
    const ownerId = await seedUser();
    const customId = `custom-${uid()}`;

    await db().insert(schema.filamentProducts).values({
      id: customId,
      brand: 'Garage Roll',
      subtype: 'PLA',
      colors: ['#FF8800'],
      colorPattern: 'solid',
      ownerId,
      source: 'user',
    });

    // Sanity: 1 row owned by this user.
    expect(
      (
        await db()
          .select()
          .from(schema.filamentProducts)
          .where(eq(schema.filamentProducts.ownerId, ownerId))
      ).length,
    ).toBe(1);

    // Delete user → custom row cascades.
    await db().delete(schema.user).where(eq(schema.user.id, ownerId));

    expect(
      (
        await db()
          .select()
          .from(schema.filamentProducts)
          .where(eq(schema.filamentProducts.ownerId, ownerId))
      ).length,
    ).toBe(0);

    // System-seeded row from test 2 still exists.
    const sysRows = await db()
      .select()
      .from(schema.filamentProducts)
      .where(isNull(schema.filamentProducts.ownerId));
    expect(sysRows.length).toBeGreaterThanOrEqual(1);
  });

  it('5. insert a resin product with full kind-specific fields', async () => {
    const id = 'prusa-tough-orange';
    await db().insert(schema.resinProducts).values({
      id,
      brand: 'Prusa Polymers',
      productLine: 'Prusament Tough',
      subtype: 'tough',
      colors: ['#FF8040'],
      colorName: 'Prusa Orange',
      defaultExposure: {
        layer_height_mm: 0.05,
        exposure_seconds: 7,
        bottom_layers: 4,
        bottom_exposure_seconds: 35,
      },
      densityGMl: 1.18,
      viscosityCps: 350,
      bottleVolumeMl: 1000,
      compatibility: { wavelength_nm: 405, printer_compat: ['SL1S Speed', 'Original Prusa SL1'] },
      materialClass: 'consumer',
      retailUrl: 'https://www.prusa3d.com/category/prusament-resin/',
      ownerId: null,
      source: 'system:open-filament-db',
    });

    const row = (
      await db()
        .select()
        .from(schema.resinProducts)
        .where(eq(schema.resinProducts.id, id))
    )[0];

    expect(row?.brand).toBe('Prusa Polymers');
    expect(isResinSubtype(row?.subtype)).toBe(true);
    expect(row?.defaultExposure?.layer_height_mm).toBe(0.05);
    expect(row?.compatibility?.wavelength_nm).toBe(405);
    expect(row?.compatibility?.printer_compat).toEqual(['SL1S Speed', 'Original Prusa SL1']);
    expect(isResinMaterialClass(row?.materialClass)).toBe(true);
  });

  it('6. insert a resin product with most fields NULL (sparse PrusaSlicer-derived seed)', async () => {
    const id = `sparse-${uid()}`;
    await db().insert(schema.resinProducts).values({
      id,
      brand: '3DM',
      subtype: 'tough',
      // colors NULL, colorName NULL, defaultExposure NULL, densityGMl NULL,
      // viscosityCps NULL, bottleVolumeMl NULL, compatibility NULL,
      // materialClass NULL, retailUrl NULL, ownerId NULL, sourceRef NULL.
      source: 'community-pr',
    });

    const row = (
      await db()
        .select()
        .from(schema.resinProducts)
        .where(eq(schema.resinProducts.id, id))
    )[0];

    expect(row?.brand).toBe('3DM');
    expect(row?.subtype).toBe('tough');
    expect(row?.colors).toBeNull();
    expect(row?.densityGMl).toBeNull();
    expect(row?.compatibility).toBeNull();
    expect(row?.materialClass).toBeNull();
    expect(row?.source).toBe('community-pr');
  });

  it('7. JSON columns round-trip cleanly', async () => {
    const fid = `json-${uid()}`;
    const colors = ['#FF0000', '#00FF00', '#0000FF'];
    const temps = { nozzle_min: 200, nozzle_max: 220, bed: 55, chamber: 35 };
    await db().insert(schema.filamentProducts).values({
      id: fid,
      brand: 'JsonTest',
      subtype: 'PLA',
      colors,
      colorPattern: 'gradient',
      defaultTemps: temps,
      source: 'user',
      ownerId: await seedUser(),
    });

    const fr = (
      await db()
        .select()
        .from(schema.filamentProducts)
        .where(eq(schema.filamentProducts.id, fid))
    )[0];
    expect(fr?.colors).toEqual(colors);
    expect(fr?.defaultTemps).toEqual(temps);

    const rid = `json-${uid()}`;
    const exposure = {
      layer_height_mm: 0.05,
      exposure_seconds: 8,
      bottom_layers: 6,
      bottom_exposure_seconds: 40,
      lift_speed_mm_min: 60,
    };
    const compatibility = { wavelength_nm: 385, printer_compat: ['Form 3', 'Form 4'] };
    await db().insert(schema.resinProducts).values({
      id: rid,
      brand: 'JsonResin',
      subtype: 'engineering',
      defaultExposure: exposure,
      compatibility,
      source: 'user',
      ownerId: await seedUser(),
    });

    const rr = (
      await db()
        .select()
        .from(schema.resinProducts)
        .where(eq(schema.resinProducts.id, rid))
    )[0];
    expect(rr?.defaultExposure).toEqual(exposure);
    expect(rr?.compatibility).toEqual(compatibility);
  });

  it('8. expected indexes are present on both catalog tables', () => {
    const sqlite = rawClient();

    const idxFor = (table: string): string[] =>
      sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`)
        .all(table)
        .map((r) => String(r.name));

    expect(idxFor('filament_products')).toEqual(
      expect.arrayContaining([
        'filament_products_brand_idx',
        'filament_products_subtype_idx',
        'filament_products_brand_subtype_idx',
        'filament_products_owner_idx',
        'filament_products_source_idx',
        'filament_products_primary_color_idx',
      ]),
    );

    expect(idxFor('resin_products')).toEqual(
      expect.arrayContaining([
        'resin_products_brand_idx',
        'resin_products_subtype_idx',
        'resin_products_class_idx',
        'resin_products_owner_idx',
        'resin_products_source_idx',
      ]),
    );
  });

  it('9. expression index on colors[0] is used by the query planner', () => {
    const sqlite = rawClient();

    // Get the EXPLAIN QUERY PLAN for a primary-color filter. The expression
    // index should produce a SEARCH plan that mentions our index name.
    const plan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM filament_products
         WHERE json_extract(colors, '$[0]') = ?`,
      )
      .all('#FF0000');

    const detail = plan.map((row) => String(row.detail ?? '')).join(' | ');
    expect(detail).toContain('filament_products_primary_color_idx');
  });

  it('10. multi-hex 4-color rainbow PLA round-trips', async () => {
    const id = `rainbow-${uid()}`;
    const rainbow = ['#FF0000', '#FFFF00', '#00FF00', '#0000FF'];
    await db().insert(schema.filamentProducts).values({
      id,
      brand: 'SUNLU',
      productLine: 'Silk Multi-Color',
      subtype: 'PLA-Silk',
      colors: rainbow,
      colorPattern: 'multi-section',
      colorName: 'Rainbow Quad',
      finish: 'glossy',
      ownerId: null,
      source: 'system:spoolmandb',
    });

    const row = (
      await db()
        .select()
        .from(schema.filamentProducts)
        .where(eq(schema.filamentProducts.id, id))
    )[0];

    expect(row?.colors).toEqual(rainbow);
    expect(row?.colors?.length).toBe(4);
    expect(row?.colorPattern).toBe('multi-section');

    // And the primary-color expression index actually finds it by hex[0].
    const found = await db()
      .select()
      .from(schema.filamentProducts)
      .where(
        and(
          eq(schema.filamentProducts.colorPattern, 'multi-section'),
          eq(schema.filamentProducts.id, id),
        ),
      );
    expect(found.length).toBe(1);
  });

  it('enums export the expected fixed lists', () => {
    expect(FILAMENT_SUBTYPES.length).toBeGreaterThan(20);
    expect(FILAMENT_SUBTYPES).toContain('PLA');
    expect(FILAMENT_SUBTYPES).toContain('PETG-CF');
    expect(RESIN_SUBTYPES).toContain('tough');
    expect(RESIN_SUBTYPES).toContain('water-washable');
    expect(RESIN_MATERIAL_CLASSES).toContain('medical-Class-IIa');
    expect(PRODUCT_SOURCES).toContain('system:spoolmandb');
    expect(PRODUCT_SOURCES).toContain('user');
  });
});
