/**
 * Integration tests — forge converter Blender backend (V2-005b T_b3)
 *
 * Real Blender CLI invocation. Skipped when `blender` is not on PATH —
 * vitest's `describe.skipIf` is evaluated at module-load time so the
 * skip decision shows up cleanly in the test report.
 *
 * The host's `blender` binary actually runs the bundled Python helper
 * here, so this test catches:
 *   - bpy operator name drift (the version-detection fallback in
 *     `mesh-import-export.py`)
 *   - 3MF addon enable failures
 *   - argv-after-`--` plumbing
 *
 * Tests the simplest pair (stl → 3mf) to keep wall-clock cost low.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { convertMeshViaBlender } from '../../src/forge/converter/blender-mesh';
import {
  isToolAvailable,
  resetToolAvailabilityCache,
} from '../../src/forge/converter/tool-availability';

// Resolve at module-load time so describe.skipIf() can see the answer
// before the test discovery pass runs. Vitest supports top-level await.
const hasBlender = await isToolAvailable('blender');

const FIXTURE_STL = path.resolve(__dirname, '../fixtures/converter/cube.stl');

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'forge-blender-real-'));
  resetToolAvailabilityCache();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  resetToolAvailabilityCache();
});

describe.skipIf(!hasBlender)('convertMeshViaBlender — real Blender binary', () => {
  it('converts cube.stl to 3MF with non-zero output size', async () => {
    const result = await convertMeshViaBlender({
      inputPath: FIXTURE_STL,
      inputFormat: 'stl',
      outputFormat: '3mf',
      outputDir: workDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputFormat).toBe('3mf');
    expect(result.outputPaths).toHaveLength(1);
    const stats = await stat(result.outputPaths[0]);
    expect(stats.size).toBeGreaterThan(0);
  }, 90_000); // generous: Blender startup + conversion + addon enable
});
