/**
 * Integration tests — Forge slicer worker — V2-005c-T_c10.
 *
 * Drives `runOneSlicerTick` through the slicing → claimable transition for
 * jobs targeting FDM printers, plus the failure paths (no install / resin /
 * no profile / slicer-error / disabled).
 *
 * Stubbed seams:
 *   - `run` (RunCommand) — emits a fake gcode + canned stdout. No real
 *     PrusaSlicer/BambuStudio invocation.
 *   - LOOTGOBLIN_DATA_ROOT pinned at a per-test tmpdir so the
 *     forge_artifacts row's storage_path doesn't pollute /data.
 *
 * SQLite file isolated to /tmp so we don't trip on the global cache from
 * sibling integration suites.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import type { RunCommand } from '../../src/forge/converter/run-command';

const DB_PATH = '/tmp/lootgoblin-forge-slicer-worker.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}
function uid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Stub run-command
// ---------------------------------------------------------------------------

interface SlicerStubOpts {
  /** Body the fake slicer writes for the produced gcode file. */
  outputBody?: string;
  /** Force a non-zero exit (PrusaSlicer "couldn't slice" simulation). */
  fails?: { code: number; stderr: string };
  /** Skip writing the gcode file (slicer "succeeded but no output"). */
  emitNothing?: boolean;
}

function makeSlicerStub(opts: SlicerStubOpts = {}): RunCommand & {
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn: RunCommand = async (cmd, args) => {
    calls.push({ cmd, args });
    if (opts.fails) {
      return { stdout: '', stderr: opts.fails.stderr, code: opts.fails.code };
    }
    // Adapter argv (T_c8): --slice <input> --load <config> --output <dir>.
    const outIdx = args.indexOf('--output');
    if (outIdx < 0 || outIdx === args.length - 1) {
      return { stdout: '', stderr: 'unexpected slicer argv', code: 1 };
    }
    const outDir = args[outIdx + 1]!;
    if (!opts.emitNothing) {
      const gcodePath = path.join(outDir, 'output.gcode');
      await fsp.mkdir(outDir, { recursive: true });
      await fsp.writeFile(gcodePath, opts.outputBody ?? 'M104 S210\nG1 X0 Y0\n');
    }
    // Canned stdout for the metadata parser.
    const stdout = [
      ';estimated printing time = 1h 23m 45s',
      ';filament used [g] = 12.34',
      ';num_layers = 67',
    ].join('\n');
    return { stdout, stderr: '', code: 0 };
  };
  (fn as RunCommand & { calls: typeof calls }).calls = calls;
  return fn as RunCommand & { calls: typeof calls };
}

// ---------------------------------------------------------------------------
// Seeders
// ---------------------------------------------------------------------------

interface BaseFixture {
  ownerId: string;
  stashRootPath: string;
  collectionId: string;
  lootId: string;
  /** Absolute path to the seeded loot file on disk. */
  lootFileId: string;
  lootFileAbsPath: string;
}

async function seedLoot(args: {
  format?: string;
  fileBody?: string;
}): Promise<BaseFixture> {
  const ownerId = uid();
  await db().insert(schema.user).values({
    id: ownerId,
    name: 'Slicer Worker Test User',
    email: `${ownerId}@forge-slicer.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-fsw-'));
  const rootId = uid();
  await db().insert(schema.stashRoots).values({
    id: rootId,
    ownerId,
    name: 'Slicer Test Root',
    path: rootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `c-${collectionId.slice(0, 8)}`,
    pathTemplate: '{title|slug}',
    stashRootId: rootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootId = uid();
  await db().insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: `model-${lootId.slice(0, 6)}`,
    tags: [],
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const fileName = `model.${args.format ?? 'stl'}`;
  const absPath = path.join(rootPath, fileName);
  await fsp.writeFile(absPath, args.fileBody ?? 'solid stl');
  const lootFileId = uid();
  await db().insert(schema.lootFiles).values({
    id: lootFileId,
    lootId,
    path: fileName,
    format: args.format ?? 'stl',
    size: (args.fileBody ?? 'solid stl').length,
    hash: `sha256-fixture-${lootId.slice(0, 8)}`,
    origin: 'manual',
    createdAt: new Date(),
  });
  return {
    ownerId,
    stashRootPath: rootPath,
    collectionId,
    lootId,
    lootFileId,
    lootFileAbsPath: absPath,
  };
}

async function seedPrinter(ownerId: string, kind: string): Promise<string> {
  const id = uid();
  await db().insert(schema.printers).values({
    id,
    ownerId,
    kind,
    name: `p-${id.slice(0, 8)}`,
    connectionConfig: { url: 'http://1.2.3.4:7125', apiKey: 'k' },
    active: true,
    createdAt: new Date(),
  });
  return id;
}

async function seedSlicerProfile(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.slicerProfiles).values({
    id,
    ownerId,
    name: 'Test profile',
    slicerKind: 'prusaslicer',
    printerKind: 'fdm_klipper',
    materialKind: 'pla',
    settingsPayload: { layer_height: 0.2, infill_density: 15 },
    opaqueUnsupported: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedReadyInstall(slicerKind: 'prusaslicer' | 'bambustudio') {
  // Create a real binary path — adapter calls fsp.access on it.
  const binaryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-fsw-bin-'));
  const binaryPath = path.join(binaryDir, slicerKind);
  await fsp.writeFile(binaryPath, '#!/usr/bin/env bash\n');
  await fsp.chmod(binaryPath, 0o755);
  await db().insert(schema.forgeSlicerInstalls).values({
    id: uid(),
    slicerKind,
    installedVersion: '2.9.1',
    binaryPath,
    installRoot: binaryDir,
    installStatus: 'ready',
    updateAvailable: false,
  });
  return { binaryPath };
}

async function seedSlicingJob(args: {
  ownerId: string;
  lootId: string;
  targetKind: 'printer' | 'slicer';
  targetId: string;
  convertedFileId?: string | null;
}): Promise<string> {
  const id = uid();
  await db().insert(schema.dispatchJobs).values({
    id,
    ownerId: args.ownerId,
    lootId: args.lootId,
    targetKind: args.targetKind,
    targetId: args.targetId,
    status: 'slicing',
    convertedFileId: args.convertedFileId ?? null,
    createdAt: new Date(),
  });
  return id;
}

async function getDispatchRow(jobId: string) {
  const rows = await db()
    .select()
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.id, jobId));
  return rows[0]!;
}

async function getArtifactsForJob(jobId: string) {
  return db()
    .select()
    .from(schema.forgeArtifacts)
    .where(eq(schema.forgeArtifacts.dispatchJobId, jobId));
}

// ---------------------------------------------------------------------------
// beforeAll / afterEach
// ---------------------------------------------------------------------------

let dataRoot: string;

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
}, 30_000);

beforeEach(async () => {
  // Per-test data-root keeps forge_artifacts files out of the developer's
  // /data dir.
  dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-fsw-data-'));
  process.env.LOOTGOBLIN_DATA_ROOT = dataRoot;
  delete process.env.FORGE_DISABLE_SLICING;
});

afterEach(async () => {
  delete process.env.FORGE_DISABLE_SLICING;
  delete process.env.LOOTGOBLIN_DATA_ROOT;
  // Order matters for FK cascade.
  await db().delete(schema.forgeArtifacts);
  await db().delete(schema.forgeSlicerProfileMaterializations);
  await db().delete(schema.forgeSlicerInstalls);
  await db().delete(schema.dispatchJobs);
  await db().delete(schema.printerReachableVia);
  await db().delete(schema.printers);
  await db().delete(schema.forgeSlicers);
  await db().delete(schema.agents);
  await db().delete(schema.slicerProfiles);
  await db().delete(schema.lootFiles);
  await db().delete(schema.loot);
  await db().delete(schema.collections);
  await db().delete(schema.stashRoots);
  await db().delete(schema.user);
  try {
    await fsp.rm(dataRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ===========================================================================
// runOneSlicerTick
// ===========================================================================

describe('runOneSlicerTick — V2-005c-T_c10', () => {
  it('1. FORGE_DISABLE_SLICING=1 short-circuits — job stays in slicing', async () => {
    process.env.FORGE_DISABLE_SLICING = '1';
    const fx = await seedLoot({});
    const printerId = await seedPrinter(fx.ownerId, 'fdm_klipper');
    const jobId = await seedSlicingJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: printerId,
    });

    const { runOneSlicerTick } = await import(
      '../../src/workers/forge-slicer-worker'
    );
    const counts = await runOneSlicerTick({ dbUrl: DB_URL });
    expect(counts).toEqual({ jobsProcessed: 0, jobsFailed: 0, jobsSkipped: 0 });

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('slicing');
    expect(row.failureReason).toBeNull();
  });

  it('2. happy path: STL → fdm_klipper → claimable + forge_artifacts row', async () => {
    const fx = await seedLoot({});
    await seedReadyInstall('prusaslicer');
    await seedSlicerProfile(fx.ownerId);
    const printerId = await seedPrinter(fx.ownerId, 'fdm_klipper');
    const jobId = await seedSlicingJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: printerId,
    });

    const stub = makeSlicerStub({ outputBody: 'M104 S210\nG28\n' });
    const { runOneSlicerTick } = await import(
      '../../src/workers/forge-slicer-worker'
    );
    const counts = await runOneSlicerTick({ run: stub, dbUrl: DB_URL });
    expect(counts).toEqual({ jobsProcessed: 1, jobsFailed: 0, jobsSkipped: 0 });

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('claimable');
    expect(row.failureReason).toBeNull();

    const artifacts = await getArtifactsForJob(jobId);
    expect(artifacts).toHaveLength(1);
    const art = artifacts[0]!;
    expect(art.kind).toBe('gcode');
    expect(art.mimeType).toBe('text/x.gcode');
    expect(art.sizeBytes).toBeGreaterThan(0);
    expect(art.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(art.storagePath.startsWith(path.join(dataRoot, 'forge-artifacts', jobId))).toBe(true);
    expect(fs.existsSync(art.storagePath)).toBe(true);
  });

  it('3. slicer-error → failed with slicing-failed reason', async () => {
    const fx = await seedLoot({});
    await seedReadyInstall('prusaslicer');
    await seedSlicerProfile(fx.ownerId);
    const printerId = await seedPrinter(fx.ownerId, 'fdm_klipper');
    const jobId = await seedSlicingJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: printerId,
    });

    const stub = makeSlicerStub({
      fails: { code: 1, stderr: 'non-manifold geometry detected' },
    });
    const { runOneSlicerTick } = await import(
      '../../src/workers/forge-slicer-worker'
    );
    const counts = await runOneSlicerTick({ run: stub, dbUrl: DB_URL });
    expect(counts.jobsFailed).toBe(1);

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('slicing-failed');
    expect(row.failureDetails).toContain('non-manifold');
  });

  it('4. resin printer (resin_sdcp) → failed with unsupported-format', async () => {
    const fx = await seedLoot({});
    await seedReadyInstall('prusaslicer');
    await seedSlicerProfile(fx.ownerId);
    const printerId = await seedPrinter(fx.ownerId, 'resin_sdcp');
    const jobId = await seedSlicingJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: printerId,
    });

    const { runOneSlicerTick } = await import(
      '../../src/workers/forge-slicer-worker'
    );
    const counts = await runOneSlicerTick({ dbUrl: DB_URL });
    expect(counts.jobsFailed).toBe(1);

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('unsupported-format');
    expect(row.failureDetails).toContain('resin');
  });

  it('5. no slicer profile configured → failed with unsupported-format', async () => {
    const fx = await seedLoot({});
    await seedReadyInstall('prusaslicer');
    // NB: no seedSlicerProfile call.
    const printerId = await seedPrinter(fx.ownerId, 'fdm_klipper');
    const jobId = await seedSlicingJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: printerId,
    });

    const { runOneSlicerTick } = await import(
      '../../src/workers/forge-slicer-worker'
    );
    const counts = await runOneSlicerTick({ dbUrl: DB_URL });
    expect(counts.jobsFailed).toBe(1);

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('unsupported-format');
    expect(row.failureDetails).toContain('no slicer profile');
  });

  it('6. forge_artifacts metadata_json carries parsed estimated time + filament', async () => {
    const fx = await seedLoot({});
    await seedReadyInstall('prusaslicer');
    const profileId = await seedSlicerProfile(fx.ownerId);
    const printerId = await seedPrinter(fx.ownerId, 'fdm_klipper');
    const jobId = await seedSlicingJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: printerId,
    });

    const stub = makeSlicerStub();
    const { runOneSlicerTick } = await import(
      '../../src/workers/forge-slicer-worker'
    );
    await runOneSlicerTick({ run: stub, dbUrl: DB_URL });

    const artifacts = await getArtifactsForJob(jobId);
    expect(artifacts).toHaveLength(1);
    const meta = JSON.parse(artifacts[0]!.metadataJson!);
    // From the canned stdout in the stub: 1h 23m 45s + 12.34g + 67 layers.
    expect(meta.estimatedPrintTimeSeconds).toBe(60 * 60 + 23 * 60 + 45);
    expect(meta.filamentUsedGrams).toBe(12.34);
    expect(meta.layers).toBe(67);
    expect(meta.slicerKind).toBe('prusaslicer');
    expect(meta.slicerProfileId).toBe(profileId);
    expect(meta.printerKind).toBe('fdm_klipper');
  });

  it('7. no install row → failed with unsupported-format (adapter not-installed)', async () => {
    const fx = await seedLoot({});
    await seedSlicerProfile(fx.ownerId);
    const printerId = await seedPrinter(fx.ownerId, 'fdm_klipper');
    const jobId = await seedSlicingJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: printerId,
    });

    const { runOneSlicerTick } = await import(
      '../../src/workers/forge-slicer-worker'
    );
    const counts = await runOneSlicerTick({ dbUrl: DB_URL });
    expect(counts.jobsFailed).toBe(1);

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('unsupported-format');
    expect(row.failureDetails).toContain('not-installed');
  });
});
