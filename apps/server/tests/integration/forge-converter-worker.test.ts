/**
 * Integration tests — Forge converter worker — V2-005b-T_b4.
 *
 * Drives `runOneConverterTick` and `startForgeConverterWorker` through the
 * pending → converting → claimable transition. Uses a stubbed `runCommand`
 * so tests run identically on every host (no real Blender / 7z dependency).
 *
 * Coverage:
 *   1. Mesh conversion happy path (glb → stl for orcaslicer).
 *   2. Mesh conversion to 3mf (stl → 3mf for fdm_bambu_lan).
 *   3. Archive extraction happy path (zip with STL inside → orcaslicer).
 *   4. Archive with only system metadata → markFailed unsupported-format.
 *   5. Loot with no files → markFailed unsupported-format.
 *   6. Converter returns ok=false → markFailed conversion-failed.
 *   7. Race: two parallel ticks on the same job → exactly one runs.
 *   8. Worker loop: start runs a tick, abort terminates the loop.
 *
 * Setup notes (mirrors forge-claim-worker.test.ts patterns):
 *   - Dedicated SQLite file at /tmp/lootgoblin-forge-converter-worker.db.
 *   - Each test seeds owner + stash root + collection + loot via inline
 *     helpers. afterEach wipes dispatch_jobs + loot tree.
 *   - bootstrapCentralWorker is called only when needed for parity with the
 *     surrounding fixture; the converter worker itself does NOT depend on
 *     the agent row (unlike the claim worker), but the cascade-cleanup is
 *     simpler when a fresh agent row exists.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterEach,
} from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { createDispatchJob } from '../../src/forge/dispatch-jobs';
import type { RunCommand } from '../../src/forge/converter';

const DB_PATH = '/tmp/lootgoblin-forge-converter-worker.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}
function uid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Stub builders
// ---------------------------------------------------------------------------

interface MeshStubOpts {
  /** Body of the produced output file. */
  outputBody?: string;
  /** Force the blender invocation to fail with this code/stderr. */
  blenderFails?: { code: number; stderr: string };
}

/**
 * Stub runCommand that handles the `which blender` probe + the actual
 * `blender --background ...` invocation. The Blender argv pattern (T_b3):
 *   blender --background --python-exit-code 1 --python <script> -- \
 *     <input> <output> <input-format> <output-format>
 */
function makeMeshStub(opts: MeshStubOpts = {}): RunCommand & {
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn: RunCommand = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'which' || cmd === 'where') {
      const tool = args[0];
      if (tool === 'blender') {
        return { stdout: '/usr/bin/blender\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 1 };
    }
    if (cmd === 'blender') {
      if (opts.blenderFails) {
        return { stdout: '', stderr: opts.blenderFails.stderr, code: opts.blenderFails.code };
      }
      // The script path is at args[3] (after --background --python-exit-code 1
      // --python). Then '--' is at args[4]. Then input/output/inFmt/outFmt
      // are at args[5..8].
      const dashIdx = args.indexOf('--');
      if (dashIdx < 0 || args.length < dashIdx + 5) {
        return { stdout: '', stderr: 'unexpected blender argv', code: 1 };
      }
      const outputPath = args[dashIdx + 2]!;
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.writeFile(outputPath, opts.outputBody ?? 'fixture-mesh');
      return { stdout: '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: 'no stub match', code: 1 };
  };
  (fn as RunCommand & { calls: typeof calls }).calls = calls;
  return fn as RunCommand & { calls: typeof calls };
}

interface ArchiveStubOpts {
  /** Files (relative paths) the simulated 7z extracts. */
  extractFiles: ReadonlyArray<{ relPath: string; body?: string }>;
  /** Force the extract to fail. */
  extractFails?: { code: number; stderr: string };
}

function makeArchiveStub(opts: ArchiveStubOpts): RunCommand & {
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn: RunCommand = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'which' || cmd === 'where') {
      const tool = args[0];
      if (tool === '7z' || tool === '7za') {
        return { stdout: `/usr/bin/${tool}\n`, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 1 };
    }
    if ((cmd === '7z' || cmd === '7za') && args[0] === 'x') {
      if (opts.extractFails) {
        return { stdout: '', stderr: opts.extractFails.stderr, code: opts.extractFails.code };
      }
      const oArg = args.find((a) => a.startsWith('-o'));
      if (!oArg) return { stdout: '', stderr: 'no -o flag', code: 1 };
      const outDir = oArg.slice(2);
      for (const f of opts.extractFiles) {
        const full = path.join(outDir, f.relPath);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, f.body ?? 'fixture');
      }
      return { stdout: 'Everything is Ok\n', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: 'no stub match', code: 1 };
  };
  (fn as RunCommand & { calls: typeof calls }).calls = calls;
  return fn as RunCommand & { calls: typeof calls };
}

// ---------------------------------------------------------------------------
// Seeders
// ---------------------------------------------------------------------------

interface LootFixture {
  ownerId: string;
  stashRootPath: string;
  lootId: string;
  /** Absolute path to the seeded loot file on disk. */
  lootFileAbsPath: string;
}

async function seedLoot(args: {
  format: string;
  fileBody?: string;
  /** Optional override for the file basename (default `model.<format>`). */
  fileName?: string;
}): Promise<LootFixture> {
  const ownerId = uid();
  await db().insert(schema.user).values({
    id: ownerId,
    name: 'Forge Converter Test User',
    email: `${ownerId}@forge-converter.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-fcw-'));
  const rootId = uid();
  await db().insert(schema.stashRoots).values({
    id: rootId,
    ownerId,
    name: 'Converter Test Root',
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
  // Seed the on-disk file (relative to the stashRoot).
  const fileName = args.fileName ?? `model.${args.format}`;
  const relPath = fileName;
  const absPath = path.join(rootPath, relPath);
  await fsp.writeFile(absPath, args.fileBody ?? 'fixture-input');
  await db().insert(schema.lootFiles).values({
    id: uid(),
    lootId,
    path: relPath,
    format: args.format,
    size: (args.fileBody ?? 'fixture-input').length,
    hash: `sha256-fixture-${lootId.slice(0, 8)}`,
    origin: 'manual',
    createdAt: new Date(),
  });
  return { ownerId, stashRootPath: rootPath, lootId, lootFileAbsPath: absPath };
}

async function seedSlicer(ownerId: string, kind: string): Promise<string> {
  const id = uid();
  await db().insert(schema.forgeSlicers).values({
    id,
    ownerId,
    kind,
    invocationMethod: 'url-scheme',
    name: `s-${id.slice(0, 8)}`,
    createdAt: new Date(),
  });
  return id;
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

async function newPendingJob(args: {
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
      initialStatus: 'pending',
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`fixture: ${r.reason}: ${r.details ?? ''}`);
  return r.jobId;
}

async function getDispatchRow(jobId: string) {
  const rows = await db()
    .select()
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.id, jobId));
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// beforeAll / afterEach
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

afterEach(async () => {
  // Order matters for FK cascade.
  await db().delete(schema.dispatchJobs);
  await db().delete(schema.printerReachableVia);
  await db().delete(schema.printers);
  await db().delete(schema.forgeSlicers);
  await db().delete(schema.agents);
  await db().delete(schema.lootFiles);
  await db().delete(schema.loot);
  await db().delete(schema.collections);
  await db().delete(schema.stashRoots);
  await db().delete(schema.user);
});

// ===========================================================================
// runOneConverterTick — happy paths
// ===========================================================================

describe('runOneConverterTick — V2-005b-T_b4 happy paths', () => {
  it('1. mesh conversion: glb → stl for orcaslicer; pending → converting → claimable', async () => {
    const fx = await seedLoot({ format: 'glb' });
    const slicerId = await seedSlicer(fx.ownerId, 'orcaslicer');
    const jobId = await newPendingJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'slicer',
      targetId: slicerId,
    });

    const stub = makeMeshStub({ outputBody: 'converted-stl-bytes' });
    const { runOneConverterTick } = await import(
      '../../src/workers/forge-converter-worker'
    );
    const result = await runOneConverterTick({
      runCommand: stub,
      dbUrl: DB_URL,
    });
    expect(result).toBe('ran');

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('claimable');
    expect(row.convertedFileId).not.toBeNull();
    expect(row.failureReason).toBeNull();

    // The new loot_files row exists, points at the same loot, has the
    // right format and a real sha256 hex hash.
    const files = await db()
      .select()
      .from(schema.lootFiles)
      .where(eq(schema.lootFiles.id, row.convertedFileId!));
    expect(files).toHaveLength(1);
    const newFile = files[0]!;
    expect(newFile.lootId).toBe(fx.lootId);
    expect(newFile.format).toBe('stl');
    expect(newFile.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(newFile.origin).toBe('ingest');
    expect(newFile.provenance).toEqual({
      kind: 'forge-conversion',
      sourceLootFileId: expect.any(String),
    });

    // Blender was invoked exactly once (plus the `which` probe).
    const blenderCalls = stub.calls.filter((c) => c.cmd === 'blender');
    expect(blenderCalls).toHaveLength(1);
  });

  it('2. mesh conversion: stl → 3mf for fdm_bambu_lan; pending → claimable', async () => {
    const fx = await seedLoot({ format: 'stl' });
    const printerId = await seedPrinter(fx.ownerId, 'fdm_bambu_lan');
    const jobId = await newPendingJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: printerId,
    });

    const stub = makeMeshStub({ outputBody: 'converted-3mf' });
    const { runOneConverterTick } = await import(
      '../../src/workers/forge-converter-worker'
    );
    const result = await runOneConverterTick({
      runCommand: stub,
      dbUrl: DB_URL,
    });
    expect(result).toBe('ran');

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('claimable');
    const files = await db()
      .select()
      .from(schema.lootFiles)
      .where(eq(schema.lootFiles.id, row.convertedFileId!));
    expect(files[0]!.format).toBe('3mf');
  });

  it('3. archive extraction: zip with STL inside → orcaslicer; pending → claimable', async () => {
    const fx = await seedLoot({ format: 'zip', fileName: 'pack.zip' });
    const slicerId = await seedSlicer(fx.ownerId, 'orcaslicer');
    const jobId = await newPendingJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'slicer',
      targetId: slicerId,
    });

    const stub = makeArchiveStub({
      extractFiles: [
        { relPath: 'readme.txt', body: 'unrelated' },
        { relPath: 'model.stl', body: 'solid stl' },
        { relPath: 'extra.bogus', body: 'junk' },
      ],
    });
    const { runOneConverterTick } = await import(
      '../../src/workers/forge-converter-worker'
    );
    const result = await runOneConverterTick({
      runCommand: stub,
      dbUrl: DB_URL,
    });
    expect(result).toBe('ran');

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('claimable');
    expect(row.convertedFileId).not.toBeNull();

    const files = await db()
      .select()
      .from(schema.lootFiles)
      .where(eq(schema.lootFiles.id, row.convertedFileId!));
    // The picker iterates the extract output in the order returned by the
    // recursive walk. readme.txt is unsupported on orcaslicer (no entry in
    // CONVERSION_PATHS for txt), so picker skips to model.stl which IS
    // native to orcaslicer.
    expect(files[0]!.format).toBe('stl');
  });
});

// ===========================================================================
// runOneConverterTick — failure paths
// ===========================================================================

describe('runOneConverterTick — V2-005b-T_b4 failure paths', () => {
  it('4. archive with only system metadata → markFailed unsupported-format', async () => {
    const fx = await seedLoot({ format: 'zip', fileName: 'macos.zip' });
    const slicerId = await seedSlicer(fx.ownerId, 'orcaslicer');
    const jobId = await newPendingJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'slicer',
      targetId: slicerId,
    });

    // Only __MACOSX entries — sevenzip-archives.ts filters those out and
    // returns `archive-no-usable-content`. Worker maps that to
    // 'unsupported-format'.
    const stub = makeArchiveStub({
      extractFiles: [
        { relPath: '__MACOSX/._model.stl', body: 'resource fork' },
      ],
    });
    const { runOneConverterTick } = await import(
      '../../src/workers/forge-converter-worker'
    );
    const result = await runOneConverterTick({
      runCommand: stub,
      dbUrl: DB_URL,
    });
    expect(result).toBe('errored');

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('unsupported-format');
    expect(row.failureDetails).toBeTruthy();
  });

  it('5. loot with no files → markFailed unsupported-format', async () => {
    // Inline seed: owner + collection + loot but NO loot_files.
    const ownerId = uid();
    await db().insert(schema.user).values({
      id: ownerId,
      name: 'No-files User',
      email: `${ownerId}@no-files.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-fcw-'));
    const rootId = uid();
    await db().insert(schema.stashRoots).values({
      id: rootId,
      ownerId,
      name: 'r',
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
      title: 'empty loot',
      tags: [],
      fileMissing: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const slicerId = await seedSlicer(ownerId, 'orcaslicer');
    // Insert pending dispatch directly (createDispatchJob wouldn't reject —
    // it doesn't check files).
    const jobId = await newPendingJob({
      ownerId,
      lootId,
      targetKind: 'slicer',
      targetId: slicerId,
    });

    const { runOneConverterTick } = await import(
      '../../src/workers/forge-converter-worker'
    );
    const result = await runOneConverterTick({ dbUrl: DB_URL });
    expect(result).toBe('errored');

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('unsupported-format');
    expect(row.failureDetails).toContain('no files');
  });

  it('6. converter ok=false (blender exits non-zero) → markFailed conversion-failed', async () => {
    const fx = await seedLoot({ format: 'glb' });
    const slicerId = await seedSlicer(fx.ownerId, 'orcaslicer');
    const jobId = await newPendingJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'slicer',
      targetId: slicerId,
    });

    const stub = makeMeshStub({
      blenderFails: { code: 1, stderr: 'blender: import failed' },
    });
    const { runOneConverterTick } = await import(
      '../../src/workers/forge-converter-worker'
    );
    const result = await runOneConverterTick({
      runCommand: stub,
      dbUrl: DB_URL,
    });
    expect(result).toBe('errored');

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('conversion-failed');
    expect(row.failureDetails).toContain('import failed');
  });

  it('7. parallel ticks on one pending job → exactly one ran, the other idle', async () => {
    const fx = await seedLoot({ format: 'glb' });
    const slicerId = await seedSlicer(fx.ownerId, 'orcaslicer');
    const jobId = await newPendingJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'slicer',
      targetId: slicerId,
    });

    // Slow stub widens the race window. The first tick wins markConverting
    // and finishes the conversion; the second sees the row already in
    // 'converting' (or 'claimable') and bails out with 'idle'.
    const slowStub: RunCommand = async (cmd, args) => {
      const inner = makeMeshStub({ outputBody: 'parallel-output' });
      // Insert a small delay before doing the actual work.
      await new Promise((r) => setTimeout(r, 30));
      return inner(cmd, args);
    };

    const { runOneConverterTick } = await import(
      '../../src/workers/forge-converter-worker'
    );
    const [a, b] = await Promise.all([
      runOneConverterTick({ runCommand: slowStub, dbUrl: DB_URL }),
      runOneConverterTick({ runCommand: slowStub, dbUrl: DB_URL }),
    ]);
    const outcomes = [a, b].sort();
    expect(outcomes).toEqual(['idle', 'ran']);

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('claimable');
  });
});

// ===========================================================================
// startForgeConverterWorker — loop lifecycle
// ===========================================================================

describe('startForgeConverterWorker — V2-005b-T_b4', () => {
  it('8. start runs at least one tick; abort terminates the loop', async () => {
    const fx = await seedLoot({ format: 'glb' });
    const slicerId = await seedSlicer(fx.ownerId, 'orcaslicer');
    const jobId = await newPendingJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'slicer',
      targetId: slicerId,
    });

    const stub = makeMeshStub({ outputBody: 'loop-output' });
    const { startForgeConverterWorker, stopForgeConverterWorker } = await import(
      '../../src/workers/forge-converter-worker'
    );

    const abort = new AbortController();
    const startPromise = startForgeConverterWorker({
      signal: abort.signal,
      concurrency: 1,
      runCommand: stub,
      dbUrl: DB_URL,
    });

    // Wait long enough for the first tick to drive the job to claimable.
    // POLL_BASE_MS is 2s but the FIRST tick runs immediately (no leading
    // sleep), so 1s is plenty.
    await new Promise((r) => setTimeout(r, 1_000));
    abort.abort();
    stopForgeConverterWorker();

    await Promise.race([
      startPromise,
      new Promise((r) => setTimeout(r, 2_500)),
    ]);

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('claimable');
    expect(row.convertedFileId).not.toBeNull();
  });
});
