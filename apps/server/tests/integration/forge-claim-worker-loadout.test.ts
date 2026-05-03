/**
 * V2-005f-CF-1 T_g4: claim worker fills materials_used[].material_id from the
 * printer's current open loadout via getCurrentLoadout(), with a warning log
 * for slicer-estimate slots that have no loaded material.
 *
 * Coverage:
 *   1. Single-slot printer-target — loadout populates material_id from slot 0.
 *   2. No load — slot 0 ships material_id='' and a warning is emitted.
 *   3. Mixed — 2 of 3 slots loaded → 2 filled, 1 empty + 1 warning.
 *   4. Slicer-target dispatch — extractAndPersistSlicerEstimate is skipped
 *      entirely (gated by `targetKind === 'printer'`), so getCurrentLoadout
 *      is never queried and no warning fires.
 *
 * Test setup mirrors the existing forge-claim-worker.test.ts harness — real
 * DB, real claim worker, on-disk gcode artifact whose `; filament used [g]`
 * comment drives extractSlicerEstimate.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { bootstrapCentralWorker } from '../../src/forge/agent-bootstrap';
import { createDispatchJob } from '../../src/forge/dispatch-jobs';
import { getDefaultRegistry } from '../../src/forge/dispatch/registry';
import type {
  DispatchHandler,
  DispatchOutcome,
} from '../../src/forge/dispatch/handler';
import { createMaterial, loadInPrinter } from '../../src/materials/lifecycle';
import { logger } from '../../src/logger';
import type { MaterialsUsed } from '../../src/db/schema.forge';

const DB_PATH = '/tmp/lootgoblin-forge-claim-worker-loadout.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}
function uid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Slicer artifact templates
// ---------------------------------------------------------------------------

/**
 * Build a PrusaSlicer-style gcode payload with N filament slots. Per-slot
 * grams are emitted as a comma-separated list so the parser splits into N
 * SlicerEstimateSlot rows with slot_index = 0..N-1.
 *
 * Slot 0 always has a non-zero gram count so the single-slot tests have
 * something to verify.
 */
function buildGcode(slotGrams: number[]): string {
  return [
    'G1 X0 Y0',
    'G1 X10 Y10',
    'M104 S0',
    '',
    `; filament used [g] = ${slotGrams.map((g) => g.toFixed(2)).join(', ')}`,
    `; filament used [cm3] = ${slotGrams.map((g) => (g / 1.24).toFixed(2)).join(', ')}`,
    `; filament_type = ${slotGrams.map(() => 'PLA').join(';')}`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Seeders
// ---------------------------------------------------------------------------

const tempArtifacts: string[] = [];

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'T_g4 Test User',
    email: `${id}@t-g4.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string): Promise<string> {
  const id = uid();
  const dir = await fsp.mkdtemp(path.join('/tmp', 'lootgoblin-tg4-'));
  await db().insert(schema.stashRoots).values({
    id,
    ownerId,
    name: 'T_g4 Stash Root',
    path: dir,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(ownerId: string, stashRootId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id,
    ownerId,
    name: `T_g4 Collection ${id.slice(0, 8)}`,
    pathTemplate: '{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(collectionId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.loot).values({
    id,
    collectionId,
    title: `T_g4 Loot ${id.slice(0, 8)}`,
    tags: [],
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
    name: `T_g4 Printer-${id.slice(0, 8)}`,
    connectionConfig: { url: 'http://1.2.3.4:7125', apiKey: 'x' },
    active: true,
    createdAt: new Date(),
  });
  return id;
}

async function seedSlicer(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.forgeSlicers).values({
    id,
    ownerId,
    kind: 'orcaslicer',
    invocationMethod: 'url-scheme',
    name: `T_g4 Slicer-${id.slice(0, 8)}`,
    createdAt: new Date(),
  });
  return id;
}

async function seedReachableVia(printerId: string, agentId: string): Promise<void> {
  await db().insert(schema.printerReachableVia).values({
    printerId,
    agentId,
  });
}

/**
 * Write a real on-disk gcode artifact with the given per-slot grams + insert
 * a forge_artifacts row pointing at it. The path is tracked so afterEach can
 * unlink it.
 */
async function seedArtifactForJob(jobId: string, slotGrams: number[]): Promise<void> {
  const dir = await fsp.mkdtemp(path.join('/tmp', 'lootgoblin-tg4-art-'));
  const artifactPath = path.join(dir, `${jobId}.gcode`);
  await fsp.writeFile(artifactPath, buildGcode(slotGrams), 'utf8');
  tempArtifacts.push(artifactPath);
  await db().insert(schema.forgeArtifacts).values({
    id: uid(),
    dispatchJobId: jobId,
    kind: 'gcode',
    storagePath: artifactPath,
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    mimeType: 'text/x.gcode',
    metadataJson: null,
    createdAt: new Date(),
  });
}

async function seedMaterialOwned(ownerId: string): Promise<string> {
  const r = await createMaterial(
    {
      ownerId,
      kind: 'filament_spool',
      brand: 'TestBrand',
      subtype: 'PLA',
      colors: ['#112233'],
      colorPattern: 'solid',
      initialAmount: 1000,
      unit: 'g',
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`seedMaterial failed: ${r.reason}`);
  return r.material.id;
}

function stubSuccessHandler(): DispatchHandler {
  return {
    kind: 'fdm_klipper',
    async dispatch(): Promise<DispatchOutcome> {
      return { kind: 'success', remoteFilename: 'stub.gcode' };
    },
  };
}

interface BaseFixture {
  centralAgentId: string;
  ownerId: string;
  lootId: string;
  printerId: string;
  slicerId: string;
}

async function buildBaseFixture(): Promise<BaseFixture> {
  const ownerId = await seedUser();
  const stashRootId = await seedStashRoot(ownerId);
  const collectionId = await seedCollection(ownerId, stashRootId);
  const lootId = await seedLoot(collectionId);
  const printerId = await seedPrinter(ownerId);
  const slicerId = await seedSlicer(ownerId);
  const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
  return {
    centralAgentId: bootstrap.agentId,
    ownerId,
    lootId,
    printerId,
    slicerId,
  };
}

async function newClaimableJob(args: {
  ownerId: string;
  lootId: string;
  targetKind: 'printer' | 'slicer';
  targetId: string;
}): Promise<string> {
  const r = await createDispatchJob(
    {
      ownerId: args.ownerId,
      lootId: args.lootId,
      targetKind: args.targetKind,
      targetId: args.targetId,
      initialStatus: 'claimable',
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`fixture: ${r.reason}: ${r.details ?? ''}`);
  return r.jobId;
}

// ---------------------------------------------------------------------------
// Vitest hooks
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

beforeEach(() => {
  getDefaultRegistry().clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Order matters for FK cascade.
  await db().delete(schema.printerLoadouts);
  await db().delete(schema.forgeArtifacts);
  await db().delete(schema.dispatchJobs);
  await db().delete(schema.printerReachableVia);
  await db().delete(schema.printers);
  await db().delete(schema.forgeSlicers);
  await db().delete(schema.agents);
  await db().delete(schema.ledgerEvents);
  await db().delete(schema.materials);
  await db().delete(schema.loot);
  await db().delete(schema.collections);
  await db().delete(schema.stashRoots);
  await db().delete(schema.user);

  for (const p of tempArtifacts.splice(0)) {
    try {
      await fsp.unlink(p);
    } catch {
      // Best-effort cleanup; tmp dir will be GC'd eventually.
    }
  }
});

afterAll(() => {
  getDefaultRegistry().clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('claim worker fills material_id from loadout (V2-005f-CF-1 T_g4)', () => {
  it('1. populates materials_used[].material_id from current loadout', async () => {
    const fx = await buildBaseFixture();
    await seedReachableVia(fx.printerId, fx.centralAgentId);

    const materialId = await seedMaterialOwned(fx.ownerId);
    const loadResult = await loadInPrinter(
      {
        materialId,
        printerId: fx.printerId,
        slotIndex: 0,
        userId: fx.ownerId,
      },
      { dbUrl: DB_URL },
    );
    expect(loadResult.ok).toBe(true);

    const jobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: fx.printerId,
    });
    await seedArtifactForJob(jobId, [38.42]);
    getDefaultRegistry().register(stubSuccessHandler());

    const { runOneClaimTick } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const result = await runOneClaimTick({
      agentId: fx.centralAgentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('ran');

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows).toHaveLength(1);
    const materialsUsed = rows[0]!.materialsUsed as MaterialsUsed | null;
    expect(materialsUsed).not.toBeNull();
    expect(materialsUsed).toHaveLength(1);
    expect(materialsUsed![0]!.slot_index).toBe(0);
    expect(materialsUsed![0]!.material_id).toBe(materialId);
    expect(materialsUsed![0]!.estimated_grams).toBeCloseTo(38.42, 2);
    expect(materialsUsed![0]!.measured_grams).toBeNull();
  });

  it('2. logs warning + leaves material_id empty when slicer-estimate slot has no loaded material', async () => {
    const fx = await buildBaseFixture();
    await seedReachableVia(fx.printerId, fx.centralAgentId);

    // Note: NO loadInPrinter — slot 0 has no loaded material.
    const jobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: fx.printerId,
    });
    await seedArtifactForJob(jobId, [25.0]);
    getDefaultRegistry().register(stubSuccessHandler());

    const warnSpy = vi
      .spyOn(logger, 'warn')
      .mockImplementation(() => undefined as never);

    const { runOneClaimTick } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const result = await runOneClaimTick({
      agentId: fx.centralAgentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('ran');

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    const materialsUsed = rows[0]!.materialsUsed as MaterialsUsed | null;
    expect(materialsUsed).not.toBeNull();
    expect(materialsUsed).toHaveLength(1);
    expect(materialsUsed![0]!.material_id).toBe('');
    expect(materialsUsed![0]!.estimated_grams).toBeCloseTo(25.0, 2);

    // Verify the warning fired with the right context.
    const matchingCalls = warnSpy.mock.calls.filter(
      (c) =>
        typeof c[1] === 'string' &&
        c[1].includes('slicer-estimate references slot with no loaded material'),
    );
    expect(matchingCalls.length).toBeGreaterThanOrEqual(1);
    const meta = matchingCalls[0]![0] as Record<string, unknown>;
    expect(meta.printerId).toBe(fx.printerId);
    expect(meta.slotIndex).toBe(0);
    expect(meta.dispatchJobId).toBe(jobId);
  });

  it('3. mixed match: 2 of 3 slots loaded → 2 with material_id, 1 empty + warning', async () => {
    const fx = await buildBaseFixture();
    await seedReachableVia(fx.printerId, fx.centralAgentId);

    const matSlot0 = await seedMaterialOwned(fx.ownerId);
    const matSlot1 = await seedMaterialOwned(fx.ownerId);
    // Slot 2: deliberately NOT loaded.
    const r0 = await loadInPrinter(
      {
        materialId: matSlot0,
        printerId: fx.printerId,
        slotIndex: 0,
        userId: fx.ownerId,
      },
      { dbUrl: DB_URL },
    );
    expect(r0.ok).toBe(true);
    const r1 = await loadInPrinter(
      {
        materialId: matSlot1,
        printerId: fx.printerId,
        slotIndex: 1,
        userId: fx.ownerId,
      },
      { dbUrl: DB_URL },
    );
    expect(r1.ok).toBe(true);

    const jobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: fx.printerId,
    });
    // gcode references three slots: 0, 1, 2.
    await seedArtifactForJob(jobId, [10.0, 20.0, 5.0]);
    getDefaultRegistry().register(stubSuccessHandler());

    const warnSpy = vi
      .spyOn(logger, 'warn')
      .mockImplementation(() => undefined as never);

    const { runOneClaimTick } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const result = await runOneClaimTick({
      agentId: fx.centralAgentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('ran');

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    const materialsUsed = rows[0]!.materialsUsed as MaterialsUsed | null;
    expect(materialsUsed).not.toBeNull();
    expect(materialsUsed).toHaveLength(3);
    expect(materialsUsed![0]!.material_id).toBe(matSlot0);
    expect(materialsUsed![1]!.material_id).toBe(matSlot1);
    expect(materialsUsed![2]!.material_id).toBe('');

    // Exactly one unmatched-slot warning, for slot 2.
    const matchingCalls = warnSpy.mock.calls.filter(
      (c) =>
        typeof c[1] === 'string' &&
        c[1].includes('slicer-estimate references slot with no loaded material'),
    );
    expect(matchingCalls).toHaveLength(1);
    const meta = matchingCalls[0]![0] as Record<string, unknown>;
    expect(meta.slotIndex).toBe(2);
    expect(meta.dispatchJobId).toBe(jobId);
  });

  it('4. slicer-target dispatch → no loadout query, no warning', async () => {
    const fx = await buildBaseFixture();
    // Slicer-target jobs don't need printer_reachable_via.
    const jobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'slicer',
      targetId: fx.slicerId,
    });
    // Even if we seed an artifact + a loadout-less printer, this should be
    // a no-op — extractAndPersistSlicerEstimate is gated on
    // candidate.targetKind === 'printer'.
    await seedArtifactForJob(jobId, [99.0]);

    const warnSpy = vi
      .spyOn(logger, 'warn')
      .mockImplementation(() => undefined as never);

    const { runOneClaimTick } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const result = await runOneClaimTick({
      agentId: fx.centralAgentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('ran');

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    // Slicer-target dispatch leaves materials_used as the column default
    // (null or empty array — V2-005f-T_dcf1 default). Either way it is NOT
    // populated by the claim worker.
    const materialsUsed = rows[0]!.materialsUsed as MaterialsUsed | null;
    expect(materialsUsed === null || (Array.isArray(materialsUsed) && materialsUsed.length === 0)).toBe(true);

    const matchingCalls = warnSpy.mock.calls.filter(
      (c) =>
        typeof c[1] === 'string' &&
        c[1].includes('slicer-estimate references slot with no loaded material'),
    );
    expect(matchingCalls).toHaveLength(0);
  });
});
