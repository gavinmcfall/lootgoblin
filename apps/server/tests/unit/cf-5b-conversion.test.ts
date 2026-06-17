// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for V2-005f-CF-5b T_b1 — convertFilamentMmToGrams.
 *
 * Tests the mm→grams conversion module that walks the loadout chain:
 *   printer_loadouts → materials.product_id → filament_products.density + diameterMm
 *
 * PLA fallback constants when the chain is broken:
 *   density  = 1.24 g/cm³
 *   diameter = 1.75 mm
 *
 * Formula: grams = (filamentUsedMm × π × (diameter/2)²) / 1000 × density
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { convertFilamentMmToGrams } from '../../src/forge/status/divergence/conversion';

const DB_PATH = '/tmp/lootgoblin-cf5b-conversion.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'CF-5b Conversion Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedPrinter(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.printers).values({
    id,
    ownerId,
    kind: 'fdm_klipper',
    name: 'CF-5b Test Printer',
    connectionConfig: { host: '192.168.1.50', port: 7125, scheme: 'http', requiresAuth: false, startPrint: true },
    active: true,
  });
  return id;
}

async function seedFilamentProduct(opts: {
  density: number | null;
  diameterMm: number | null;
  brand?: string;
  subtype?: string;
}): Promise<string> {
  const id = uid();
  await db().insert(schema.filamentProducts).values({
    id,
    brand: opts.brand ?? 'Test Brand',
    subtype: opts.subtype ?? 'PLA',
    colors: ['#FF0000'],
    colorPattern: 'solid',
    density: opts.density,
    diameterMm: opts.diameterMm,
    source: 'user',
  });
  return id;
}

async function seedMaterial(ownerId: string, productId: string | null): Promise<string> {
  const id = uid();
  await db().insert(schema.materials).values({
    id,
    ownerId,
    kind: 'filament_spool',
    brand: 'Test Brand',
    subtype: 'PLA',
    colors: ['#FF0000'],
    colorPattern: 'solid',
    productId,
    initialAmount: 1000,
    remainingAmount: 1000,
    unit: 'g',
    active: true,
  });
  return id;
}

async function seedLoadout(printerId: string, materialId: string, slotIndex = 0): Promise<void> {
  await db().insert(schema.printerLoadouts).values({
    id: uid(),
    printerId,
    slotIndex,
    materialId,
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

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
// Helpers for formula verification
// ---------------------------------------------------------------------------

function calcGrams(filamentMm: number, densityGPerCm3: number, diameterMm: number): number {
  const crossSectionMm2 = Math.PI * (diameterMm / 2) ** 2;
  const volumeMm3 = filamentMm * crossSectionMm2;
  const volumeCm3 = volumeMm3 / 1000;
  return volumeCm3 * densityGPerCm3;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('convertFilamentMmToGrams', () => {
  it('1. uses catalog density when product_id is set (PLA 1.24 g/cm³, 1.75mm) for 1000mm input', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const productId = await seedFilamentProduct({ density: 1.24, diameterMm: 1.75, subtype: 'PLA' });
    const materialId = await seedMaterial(ownerId, productId);
    await seedLoadout(printerId, materialId, 0);

    const result = await convertFilamentMmToGrams({
      printerId,
      filamentUsedMm: 1000,
      slotIndex: 0,
      dbUrl: DB_URL,
    });

    const expected = calcGrams(1000, 1.24, 1.75);
    expect(result.grams).toBeCloseTo(expected, 2);  // ~2.98g
    expect(result.densitySource).toBe('catalog');
  });

  it('2. uses catalog density for PETG (1.27 g/cm³, 1.75mm)', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const productId = await seedFilamentProduct({ density: 1.27, diameterMm: 1.75, subtype: 'PETG' });
    const materialId = await seedMaterial(ownerId, productId);
    await seedLoadout(printerId, materialId, 0);

    const result = await convertFilamentMmToGrams({
      printerId,
      filamentUsedMm: 1000,
      slotIndex: 0,
      dbUrl: DB_URL,
    });

    const expected = calcGrams(1000, 1.27, 1.75);
    expect(result.grams).toBeCloseTo(expected, 2);
    expect(result.densitySource).toBe('catalog');
  });

  it('3. uses catalog density for 2.85mm Ultimaker filament (PLA 1.24, 2.85mm)', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const productId = await seedFilamentProduct({ density: 1.24, diameterMm: 2.85, brand: 'Ultimaker', subtype: 'PLA' });
    const materialId = await seedMaterial(ownerId, productId);
    await seedLoadout(printerId, materialId, 0);

    const result = await convertFilamentMmToGrams({
      printerId,
      filamentUsedMm: 1000,
      slotIndex: 0,
      dbUrl: DB_URL,
    });

    // 1000mm × π × 1.425² × 1.24 / 1000 ≈ 7.9g
    const expected = calcGrams(1000, 1.24, 2.85);
    expect(result.grams).toBeCloseTo(expected, 2);
    expect(result.densitySource).toBe('catalog');
  });

  it('4. falls back to PLA defaults when material has no product_id', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    // No product_id
    const materialId = await seedMaterial(ownerId, null);
    await seedLoadout(printerId, materialId, 0);

    const result = await convertFilamentMmToGrams({
      printerId,
      filamentUsedMm: 1000,
      slotIndex: 0,
      dbUrl: DB_URL,
    });

    // Falls back to PLA 1.24 g/cm³, 1.75mm
    const expected = calcGrams(1000, 1.24, 1.75);
    expect(result.grams).toBeCloseTo(expected, 2);  // ~2.98g
    expect(result.densitySource).toBe('fallback');
  });

  it('5. falls back to PLA defaults when no material loaded in slot', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    // No loadout inserted for this printer

    const result = await convertFilamentMmToGrams({
      printerId,
      filamentUsedMm: 1000,
      slotIndex: 0,
      dbUrl: DB_URL,
    });

    const expected = calcGrams(1000, 1.24, 1.75);
    expect(result.grams).toBeCloseTo(expected, 2);
    expect(result.densitySource).toBe('fallback');
  });

  it('6. returns 0 grams when filamentUsedMm is 0', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);

    const result = await convertFilamentMmToGrams({
      printerId,
      filamentUsedMm: 0,
      slotIndex: 0,
      dbUrl: DB_URL,
    });

    expect(result.grams).toBe(0);
  });

  it('7. falls back to PLA defaults when filament_products has null density/diameter (path d)', async () => {
    // SpoolmanDB seed gap case: a catalog row exists but density/diameter are NULL.
    // The schema permits both fields nullable (real() without notNull()), so this
    // is a real production case the conversion module must handle.
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const productId = await seedFilamentProduct({
      density: null,
      diameterMm: null,
      brand: 'Sparse Brand',
      subtype: 'PLA',
    });
    const materialId = await seedMaterial(ownerId, productId);
    await seedLoadout(printerId, materialId, 0);

    const result = await convertFilamentMmToGrams({
      printerId,
      filamentUsedMm: 1000,
      slotIndex: 0,
      dbUrl: DB_URL,
    });

    // Both null → must fall back to PLA defaults (1.24 g/cm³, 1.75mm) → ~2.98g
    const expected = calcGrams(1000, 1.24, 1.75);
    expect(result.grams).toBeCloseTo(expected, 2);
    expect(result.densitySource).toBe('fallback');
  });
});
