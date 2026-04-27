/**
 * Integration tests — V2-005c T_c8 SlicerAdapter against a real binary.
 *
 * Skipped at module-load time when no PrusaSlicer install is present in
 * the registry (or when the binary it points at no longer exists). The
 * skip predicate matches `forge-converter-blender-real.test.ts`: vitest
 * resolves describe.skipIf() before discovery so the skip is visible in
 * the test report rather than ghosting as a no-op.
 *
 * Will become a real assertion in CI once T_c10 adds an install step.
 * Until then, this test no-ops on every host that hasn't `forge tools
 * install`-ed a slicer locally.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resetDbCache, runMigrations } from '@/db/client';
import { createSlicerAdapter } from '@/forge/slicer/adapter';
import { runCommand } from '@/forge/converter/run-command';
import { getInstall } from '@/forge/slicer/registry';

const FIXTURE_STL = path.resolve(__dirname, '../fixtures/converter/cube.stl');

// Resolve at module-load time so describe.skipIf can see the answer
// before discovery. We deliberately use whatever DATABASE_URL is set
// in the host's environment — a CI image with a slicer pre-installed
// will have its registry pointing at the right binary.
const skipReason = await (async (): Promise<string | null> => {
  if (!existsSync(FIXTURE_STL)) return 'fixture cube.stl missing';
  if (!process.env.DATABASE_URL) return 'DATABASE_URL not set';
  try {
    await runMigrations(process.env.DATABASE_URL);
    const install = getInstall({ slicerKind: 'prusaslicer' });
    if (!install) return 'no prusaslicer install row';
    if (install.installStatus !== 'ready') return `install status=${install.installStatus}`;
    if (!install.binaryPath) return 'install row has null binaryPath';
    try {
      await fsp.access(install.binaryPath);
    } catch {
      return `binary not on disk at ${install.binaryPath}`;
    }
    return null;
  } catch (err) {
    return `setup error: ${err instanceof Error ? err.message : String(err)}`;
  }
})();

let workDir: string;

beforeAll(() => {
  if (skipReason) {
    // eslint-disable-next-line no-console
    console.log(`forge-slicer-adapter-real: SKIP — ${skipReason}`);
  }
});

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'forge-slicer-real-'));
  resetDbCache();
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe.skipIf(skipReason !== null)('SlicerAdapter — real PrusaSlicer binary', () => {
  it('slices cube.stl and produces a non-empty .gcode file', async () => {
    // Materialize a near-empty config file. Real slicers default-fill any
    // missing keys, so an empty `--load` target is enough to drive a slice
    // for the smoke test (no need to handcraft a full profile here).
    const configPath = path.join(workDir, 'empty.ini');
    await fsp.writeFile(configPath, '; lootgoblin smoke-test profile\n');

    const adapter = createSlicerAdapter({ slicerKind: 'prusaslicer' });
    const result = await adapter.slice({
      inputPath: FIXTURE_STL,
      outputDir: workDir,
      configPath,
      run: runCommand,
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 12 * 60_000); // 12-min cap: covers slow Bambu Studio startup + slice
});
