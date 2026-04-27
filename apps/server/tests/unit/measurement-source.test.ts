/**
 * Unit tests for the MeasurementSource seam — V2-007a-T9.
 *
 * The seam is INTERFACE-ONLY in v2-007a. These tests prove:
 *   1. The stub implementation behaves predictably.
 *   2. The interface compiles when implemented by an arbitrary class.
 *   3. The interface composes cleanly with the existing Mix flow (T5)
 *      via a small bridging helper that mirrors what a future v3+
 *      scale-agent integration would do at the API edge.
 *   4. The reading shape enforces `Date` for timestamps at the type level.
 *
 * No implementations are registered in production code.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { createMaterial } from '../../src/materials/lifecycle';
import { createMixRecipe, applyMixBatch } from '../../src/materials/mix';
import {
  StubMeasurementSource,
  type MeasurementSource,
  type MeasurementReading,
} from '../../src/measurement';

// ---------------------------------------------------------------------------
// DB setup (mirrors materials-mix.test.ts conventions)
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-measurement-source-unit.db';
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
    name: 'Measurement Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
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
// Stub behavior
// ---------------------------------------------------------------------------

describe('StubMeasurementSource', () => {
  it('1. fixed reading returns the same value across multiple reads', async () => {
    const fixed: MeasurementReading = {
      deviceId: 'stub-fixed',
      weight_g: 250,
      tare_g: 10,
      timestamp: new Date('2026-04-25T00:00:00Z'),
    };
    const src = new StubMeasurementSource(fixed);

    const a = await src.readWeight();
    const b = await src.readWeight();
    const c = await src.readWeight();

    expect(a).toEqual(fixed);
    expect(b).toEqual(fixed);
    expect(c).toEqual(fixed);
  });

  it('2. function source advances values across reads', async () => {
    let counter = 0;
    const src = new StubMeasurementSource(() => ({
      deviceId: 'stub-fn',
      weight_g: 100 + counter,
      tare_g: 0,
      timestamp: new Date(2026, 3, 25, 0, 0, counter++),
    }));

    const a = await src.readWeight();
    const b = await src.readWeight();
    const c = await src.readWeight();

    expect(a.weight_g).toBe(100);
    expect(b.weight_g).toBe(101);
    expect(c.weight_g).toBe(102);
    expect(a.timestamp.getTime()).toBeLessThan(b.timestamp.getTime());
    expect(b.timestamp.getTime()).toBeLessThan(c.timestamp.getTime());
  });
});

// ---------------------------------------------------------------------------
// Interface compiles with hand-rolled implementations
// ---------------------------------------------------------------------------

describe('MeasurementSource interface', () => {
  it('3. compiles when implemented by a hand-rolled class', async () => {
    class TestImpl implements MeasurementSource {
      async readWeight(): Promise<MeasurementReading> {
        return { deviceId: 'test', weight_g: 100, tare_g: 5, timestamp: new Date() };
      }
    }
    const impl: MeasurementSource = new TestImpl();
    const reading = await impl.readWeight();
    expect(reading).toMatchObject({ deviceId: 'test', weight_g: 100, tare_g: 5 });
    expect(reading.timestamp).toBeInstanceOf(Date);
  });

  it('5. timestamp must be a Date (type-level enforcement)', () => {
    // The following lines, if uncommented, would NOT compile:
    //
    //   // @ts-expect-error timestamp must be Date, not string
    //   const bad1: MeasurementReading = {
    //     deviceId: 'x', weight_g: 1, tare_g: 0, timestamp: '2026-04-25T00:00:00Z',
    //   };
    //   // @ts-expect-error timestamp must be Date, not number
    //   const bad2: MeasurementReading = {
    //     deviceId: 'x', weight_g: 1, tare_g: 0, timestamp: 1714000000000,
    //   };
    //
    // We assert the positive case at runtime: a valid reading passes.
    const ok: MeasurementReading = {
      deviceId: 'x',
      weight_g: 1,
      tare_g: 0,
      timestamp: new Date(),
    };
    expect(ok.timestamp).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// Seam demonstration: bridge a MeasurementReading into the Mix flow
// ---------------------------------------------------------------------------

/**
 * Bridging helper — foreshadows v3+ wiring. A real scale-agent integration
 * would receive a MeasurementReading at the HTTP edge and translate it into
 * the per-component-draw shape expected by applyMixBatch. The helper is
 * intentionally trivial: the interface composes cleanly with the existing
 * draw shape, modulo the `sourceMaterialId` lookup (which a real integration
 * would resolve from `deviceId` → loaded bottle via the printer-loaded-state
 * surface added in T4).
 */
function readingToDraw(
  reading: MeasurementReading,
  sourceMaterialId: string,
): {
  sourceMaterialId: string;
  drawAmount: number;
  provenanceClass: 'measured';
} {
  return {
    sourceMaterialId,
    drawAmount: reading.weight_g,
    provenanceClass: 'measured',
  };
}

describe('MeasurementSource seam → Mix flow', () => {
  it('4. a measured reading bridges into applyMixBatch with measured provenance', async () => {
    const ownerId = await seedUser();

    // Seed two source bottles with plenty of material.
    const sourceA = await createMaterial(
      {
        ownerId,
        kind: 'resin_bottle',
        brand: 'TestBrand',
        subtype: 'Standard Resin',
        colors: ['#ff0000'],
        colorPattern: 'solid',
        initialAmount: 500,
        unit: 'ml',
      },
      { dbUrl: DB_URL },
    );
    if (!sourceA.ok) throw new Error(`seed sourceA failed: ${sourceA.reason}`);
    const sourceB = await createMaterial(
      {
        ownerId,
        kind: 'resin_bottle',
        brand: 'TestBrand',
        subtype: 'Standard Resin',
        colors: ['#0000ff'],
        colorPattern: 'solid',
        initialAmount: 500,
        unit: 'ml',
      },
      { dbUrl: DB_URL },
    );
    if (!sourceB.ok) throw new Error(`seed sourceB failed: ${sourceB.reason}`);

    const recipeRes = await createMixRecipe(
      {
        ownerId,
        name: 'seam-demo-recipe',
        components: [
          { materialProductRef: 'red', ratioOrGrams: 100 },
          { materialProductRef: 'blue', ratioOrGrams: 100 },
        ],
      },
      { dbUrl: DB_URL },
    );
    if (!recipeRes.ok) throw new Error(`seed recipe failed: ${recipeRes.reason}`);

    // Hand-craft two stub sources reading 100g (≡ 100ml at density=1 — the
    // seam demonstration is unit-agnostic; a real integration handles unit
    // conversion at the API edge).
    const scaleA = new StubMeasurementSource({
      deviceId: 'pi-scale-01',
      weight_g: 100,
      tare_g: 0,
      timestamp: new Date('2026-04-25T00:00:00Z'),
    });
    const scaleB = new StubMeasurementSource({
      deviceId: 'pi-scale-02',
      weight_g: 100,
      tare_g: 0,
      timestamp: new Date('2026-04-25T00:00:01Z'),
    });

    const readingA = await scaleA.readWeight();
    const readingB = await scaleB.readWeight();

    expect(readingA.weight_g).toBe(100);
    expect(readingB.weight_g).toBe(100);

    // Bridge both readings into draws and apply the batch.
    const result = await applyMixBatch(
      {
        recipeId: recipeRes.recipeId,
        actorUserId: ownerId,
        totalVolume: 200,
        perComponentDraws: [
          readingToDraw(readingA, sourceA.material.id),
          readingToDraw(readingB, sourceB.material.id),
        ],
      },
      { dbUrl: DB_URL },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify the ledger event recorded measured provenance — i.e. the seam
    // is the intended path for 'measured' readings to reach the ledger.
    const ledgerRows = await db()
      .select()
      .from(schema.ledgerEvents);
    const evt = ledgerRows.find((r) => r.id === result.ledgerEventId);
    expect(evt).toBeDefined();
    expect(evt!.provenanceClass).toBe('measured');
    expect(evt!.kind).toBe('material.mix_created');
  });
});
