/**
 * Unit tests for V2-005c T_c8 — Prusa-fork shared SlicerAdapter.
 *
 * Uses a temp sqlite DB (matches the forge-slicer-registry test pattern)
 * to seed install rows, plus a stub RunCommand for the CLI invocation.
 * Real fs is used for the binary-exists / output-file checks because the
 * adapter calls fsp.access + readdir on real paths — mocking node:fs
 * across vitest workers is fragile.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { getDb, resetDbCache, runMigrations } from '@/db/client';
import { forgeSlicerInstalls } from '@/db/schema.forge';
import { createSlicerAdapter } from '@/forge/slicer/adapter';
import type { RunCommand } from '@/forge/converter/run-command';

const DB_PATH = '/tmp/lootgoblin-forge-slicer-adapter.db';
const DB_URL = `file:${DB_PATH}`;

let workRoot: string;

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
});

beforeEach(() => {
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  delete process.env.FORGE_DISABLE_SLICING;
  const db = getDb(DB_URL) as any;
  db.run(sql`DELETE FROM forge_slicer_installs`);
  workRoot = mkdtempSync(path.join(tmpdir(), 'forge-slicer-adapter-'));
});

afterAll(() => {
  resetDbCache();
  try {
    rmSync(DB_PATH, { force: true });
  } catch {
    // ignore
  }
});

interface SeedOpts {
  slicerKind?: 'prusaslicer' | 'orcaslicer' | 'bambustudio';
  installStatus?: 'downloading' | 'extracting' | 'verifying' | 'ready' | 'failed';
  binaryPath?: string | null;
}

function seedInstall(opts: SeedOpts = {}) {
  const db = getDb(DB_URL) as any;
  db.insert(forgeSlicerInstalls)
    .values({
      id: randomUUID(),
      slicerKind: opts.slicerKind ?? 'prusaslicer',
      installedVersion: '2.7.4',
      binaryPath: opts.binaryPath === undefined ? null : opts.binaryPath,
      installRoot: null,
      installStatus: opts.installStatus ?? 'ready',
      lastUpdateCheckAt: null,
      availableVersion: null,
      updateAvailable: false,
      installedAt: null,
      sha256: null,
    })
    .run();
}

function makeStubRun(result: { code: number; stdout?: string; stderr?: string }): RunCommand {
  return async () => ({
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.code,
  });
}

async function makeFakeBinary(): Promise<string> {
  const dir = path.join(workRoot, 'bin');
  await fsp.mkdir(dir, { recursive: true });
  const p = path.join(dir, 'prusa-slicer');
  await fsp.writeFile(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return p;
}

describe('createSlicerAdapter — slice() failure modes', () => {
  it('returns disabled-by-config when FORGE_DISABLE_SLICING=1', async () => {
    process.env.FORGE_DISABLE_SLICING = '1';
    const adapter = createSlicerAdapter({ slicerKind: 'prusaslicer', dbUrl: DB_URL });
    const result = await adapter.slice({
      inputPath: '/tmp/x.stl',
      outputDir: workRoot,
      configPath: '/tmp/x.ini',
      run: makeStubRun({ code: 0 }),
    });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('disabled-by-config');
    }
    delete process.env.FORGE_DISABLE_SLICING;
  });

  it('returns not-installed when no install row exists', async () => {
    const adapter = createSlicerAdapter({ slicerKind: 'prusaslicer', dbUrl: DB_URL });
    const result = await adapter.slice({
      inputPath: '/tmp/x.stl',
      outputDir: workRoot,
      configPath: '/tmp/x.ini',
      run: makeStubRun({ code: 0 }),
    });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('not-installed');
    }
  });

  it('returns not-installed when install row exists but status is not ready', async () => {
    seedInstall({ installStatus: 'downloading', binaryPath: '/tmp/never.bin' });
    const adapter = createSlicerAdapter({ slicerKind: 'prusaslicer', dbUrl: DB_URL });
    const result = await adapter.slice({
      inputPath: '/tmp/x.stl',
      outputDir: workRoot,
      configPath: '/tmp/x.ini',
      run: makeStubRun({ code: 0 }),
    });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('not-installed');
      expect(result.details).toContain('downloading');
    }
  });

  it('returns binary-missing when ready but binary file does not exist on disk', async () => {
    seedInstall({
      installStatus: 'ready',
      binaryPath: path.join(workRoot, 'nope', 'prusa-slicer'),
    });
    const adapter = createSlicerAdapter({ slicerKind: 'prusaslicer', dbUrl: DB_URL });
    const result = await adapter.slice({
      inputPath: '/tmp/x.stl',
      outputDir: workRoot,
      configPath: '/tmp/x.ini',
      run: makeStubRun({ code: 0 }),
    });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('binary-missing');
      expect(result.details).toBeTruthy();
    }
  });

  it('returns slicer-error with stderr details when the slicer exits non-zero', async () => {
    const binary = await makeFakeBinary();
    seedInstall({ installStatus: 'ready', binaryPath: binary });
    const adapter = createSlicerAdapter({ slicerKind: 'prusaslicer', dbUrl: DB_URL });
    const result = await adapter.slice({
      inputPath: '/tmp/x.stl',
      outputDir: workRoot,
      configPath: '/tmp/x.ini',
      run: makeStubRun({
        code: 1,
        stderr: 'Error: non-manifold mesh detected',
      }),
    });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('slicer-error');
      expect(result.details).toContain('non-manifold');
    }
  });

  it('returns no-output when slicer exits 0 but outputDir contains no gcode', async () => {
    const binary = await makeFakeBinary();
    seedInstall({ installStatus: 'ready', binaryPath: binary });
    const outDir = path.join(workRoot, 'out-empty');
    await fsp.mkdir(outDir, { recursive: true });

    const adapter = createSlicerAdapter({ slicerKind: 'prusaslicer', dbUrl: DB_URL });
    const result = await adapter.slice({
      inputPath: '/tmp/x.stl',
      outputDir: outDir,
      configPath: '/tmp/x.ini',
      run: makeStubRun({ code: 0, stdout: 'sliced cleanly\n' }),
    });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('no-output');
      expect(result.details).toContain('sliced cleanly');
    }
  });
});

describe('createSlicerAdapter — slice() success', () => {
  it('returns success with sha256 + size when a gcode file is produced', async () => {
    const binary = await makeFakeBinary();
    seedInstall({ installStatus: 'ready', binaryPath: binary });
    const outDir = path.join(workRoot, 'out-ok');
    await fsp.mkdir(outDir, { recursive: true });
    // Pre-write the "sliced" gcode (real run is stubbed; the adapter
    // doesn't care who wrote the file, only that it ends up in outputDir).
    const gcodeBody = '; G-code\nG1 X0 Y0\n';
    const gcodePath = path.join(outDir, 'cube.gcode');
    await fsp.writeFile(gcodePath, gcodeBody);

    const adapter = createSlicerAdapter({ slicerKind: 'prusaslicer', dbUrl: DB_URL });
    const result = await adapter.slice({
      inputPath: '/tmp/cube.stl',
      outputDir: outDir,
      configPath: '/tmp/cube.ini',
      run: makeStubRun({ code: 0, stdout: 'done\n' }),
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.gcodePath.endsWith('.gcode')).toBe(true);
    expect(result.sizeBytes).toBe(gcodeBody.length);
    const expectedSha = createHash('sha256').update(gcodeBody).digest('hex');
    expect(result.sha256).toBe(expectedSha);
  });

  it('extracts metadata fields (print time + filament grams) from stdout', async () => {
    const binary = await makeFakeBinary();
    seedInstall({ installStatus: 'ready', binaryPath: binary });
    const outDir = path.join(workRoot, 'out-meta');
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.writeFile(path.join(outDir, 'cube.gcode'), '; gcode\n');

    const stdout =
      ';estimated printing time = 1h 23m 45s\n;filament used [g] = 12.34\n;num_layers = 42\n';

    const adapter = createSlicerAdapter({ slicerKind: 'prusaslicer', dbUrl: DB_URL });
    const result = await adapter.slice({
      inputPath: '/tmp/cube.stl',
      outputDir: outDir,
      configPath: '/tmp/cube.ini',
      run: makeStubRun({ code: 0, stdout }),
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    // 1h 23m 45s = 3600 + 1380 + 45 = 5025
    expect(result.metadata.estimatedPrintTimeSeconds).toBe(5025);
    expect(result.metadata.filamentUsedGrams).toBeCloseTo(12.34, 2);
    expect(result.metadata.layers).toBe(42);
  });
});
