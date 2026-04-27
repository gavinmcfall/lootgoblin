/**
 * Unit tests — forge converter Blender backend (V2-005b T_b3)
 *
 * Stubs `runCommand` so these tests run on every host (no Blender binary
 * required). Real Blender invocation is covered separately in
 * `tests/integration/forge-converter-blender-real.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  convertMeshViaBlender,
  SUPPORTED_BLENDER_PAIRS,
} from '../../src/forge/converter/blender-mesh';
import { resetToolAvailabilityCache } from '../../src/forge/converter/tool-availability';
import type { RunCommand } from '../../src/forge/converter/run-command';

let workDir: string;
const PRIOR_DISABLE = process.env.FORGE_DISABLE_MESH_CONVERSION;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'forge-blender-'));
  resetToolAvailabilityCache();
  delete process.env.FORGE_DISABLE_MESH_CONVERSION;
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  resetToolAvailabilityCache();
  if (PRIOR_DISABLE === undefined) {
    delete process.env.FORGE_DISABLE_MESH_CONVERSION;
  } else {
    process.env.FORGE_DISABLE_MESH_CONVERSION = PRIOR_DISABLE;
  }
});

/**
 * Build a stub runCommand. `available` controls whether the simulated
 * `which`/`where blender` probe finds the binary. `blender` controls how
 * the `blender ...` invocation behaves (success / non-zero exit / throw).
 */
function makeRun(opts: {
  blenderOnPath?: boolean;
  blender?: { code: number; stderr?: string; stdout?: string } | { throws: Error };
}): RunCommand & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn: RunCommand = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'which' || cmd === 'where') {
      if (args[0] === 'blender' && opts.blenderOnPath) {
        return { stdout: '/usr/local/bin/blender\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 1 };
    }
    if (cmd === 'blender') {
      if (opts.blender && 'throws' in opts.blender) {
        throw opts.blender.throws;
      }
      const b = opts.blender ?? { code: 0 };
      return {
        stdout: b.stdout ?? '',
        stderr: b.stderr ?? '',
        code: b.code,
      };
    }
    return { stdout: '', stderr: 'no stub match', code: 1 };
  };
  (fn as RunCommand & { calls: typeof calls }).calls = calls;
  return fn as RunCommand & { calls: typeof calls };
}

describe('SUPPORTED_BLENDER_PAIRS', () => {
  it('contains exactly the 5 documented pairs', () => {
    expect(SUPPORTED_BLENDER_PAIRS.size).toBe(5);
    expect(SUPPORTED_BLENDER_PAIRS.has('stl→3mf')).toBe(true);
    expect(SUPPORTED_BLENDER_PAIRS.has('3mf→stl')).toBe(true);
    expect(SUPPORTED_BLENDER_PAIRS.has('obj→stl')).toBe(true);
    expect(SUPPORTED_BLENDER_PAIRS.has('fbx→stl')).toBe(true);
    expect(SUPPORTED_BLENDER_PAIRS.has('glb→stl')).toBe(true);
  });
});

describe('convertMeshViaBlender — disabled-by-config', () => {
  it('FORGE_DISABLE_MESH_CONVERSION=1 short-circuits without calling Blender', async () => {
    process.env.FORGE_DISABLE_MESH_CONVERSION = '1';
    const stub = makeRun({ blenderOnPath: true });

    const result = await convertMeshViaBlender(
      {
        inputPath: '/tmp/x.stl',
        inputFormat: 'stl',
        outputFormat: '3mf',
        outputDir: workDir,
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('disabled-by-config');
      expect(result.details).toContain('FORGE_DISABLE_MESH_CONVERSION');
    }
    // Critically: no shell-out occurred.
    expect(stub.calls).toHaveLength(0);
  });

  it('any value other than "1" does NOT trigger the kill-switch', async () => {
    process.env.FORGE_DISABLE_MESH_CONVERSION = 'true';
    const stub = makeRun({ blenderOnPath: true, blender: { code: 0 } });

    const result = await convertMeshViaBlender(
      {
        inputPath: '/tmp/x.stl',
        inputFormat: 'stl',
        outputFormat: '3mf',
        outputDir: workDir,
      },
      { runCommand: stub, scriptPath: '/fake/script.py' },
    );

    expect(result.ok).toBe(true);
  });
});

describe('convertMeshViaBlender — missing tool', () => {
  it('returns missing-tool with platform-specific install hint', async () => {
    const stub = makeRun({ blenderOnPath: false });

    const result = await convertMeshViaBlender(
      {
        inputPath: '/tmp/x.stl',
        inputFormat: 'stl',
        outputFormat: '3mf',
        outputDir: workDir,
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing-tool');
      expect(result.toolName).toBe('blender');
      expect(result.installHint).toBeDefined();
      expect(result.installHint).toMatch(/blender|Blender/);
    }
  });
});

describe('convertMeshViaBlender — unsupported pairs', () => {
  it('stl→fbx is not in SUPPORTED_BLENDER_PAIRS → unsupported-pair', async () => {
    const stub = makeRun({ blenderOnPath: true });

    const result = await convertMeshViaBlender(
      {
        inputPath: '/tmp/x.stl',
        inputFormat: 'stl',
        outputFormat: 'fbx',
        outputDir: workDir,
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-pair');
    }
    // No tool probe needed when the pair is rejected up front.
    expect(stub.calls).toHaveLength(0);
  });

  it('ply→stl is mesh-format-routable but not a Blender pair → unsupported-pair', async () => {
    const stub = makeRun({ blenderOnPath: true });

    const result = await convertMeshViaBlender(
      {
        inputPath: '/tmp/x.ply',
        inputFormat: 'ply',
        outputFormat: 'stl',
        outputDir: workDir,
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-pair');
    }
  });
});

describe('convertMeshViaBlender — happy path argv', () => {
  it('invokes blender with the correct CLI shape', async () => {
    const stub = makeRun({ blenderOnPath: true, blender: { code: 0 } });

    const result = await convertMeshViaBlender(
      {
        inputPath: '/tmp/cube.stl',
        inputFormat: 'stl',
        outputFormat: '3mf',
        outputDir: workDir,
      },
      { runCommand: stub, scriptPath: '/fake/script.py' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputFormat).toBe('3mf');
    expect(result.outputPaths).toHaveLength(1);
    expect(result.outputPaths[0]).toMatch(/cube-[0-9a-f]{8}\.3mf$/);
    expect(result.outputPaths[0].startsWith(workDir)).toBe(true);

    const blenderCall = stub.calls.find((c) => c.cmd === 'blender');
    expect(blenderCall).toBeDefined();
    if (!blenderCall) return;
    expect(blenderCall.args).toContain('--background');
    expect(blenderCall.args).toContain('--python-exit-code');
    expect(blenderCall.args).toContain('--python');
    expect(blenderCall.args).toContain('/fake/script.py');
    // The `--` separator must appear so user args reach the script via sys.argv.
    expect(blenderCall.args).toContain('--');
    // User args (after `--`) include input, output, formats.
    const sepIdx = blenderCall.args.indexOf('--');
    const userArgs = blenderCall.args.slice(sepIdx + 1);
    expect(userArgs[0]).toBe('/tmp/cube.stl');
    expect(userArgs[1]).toBe(result.outputPaths[0]);
    expect(userArgs[2]).toBe('stl');
    expect(userArgs[3]).toBe('3mf');
  });

  it('passes timeoutMs to runCommand', async () => {
    let observedTimeout: number | undefined;
    const fn: RunCommand = async (cmd, args, opts) => {
      if (cmd === 'which' || cmd === 'where') {
        return { stdout: '/usr/local/bin/blender\n', stderr: '', code: 0 };
      }
      if (cmd === 'blender') {
        observedTimeout = opts?.timeout;
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 1 };
    };

    await convertMeshViaBlender(
      {
        inputPath: '/tmp/x.stl',
        inputFormat: 'stl',
        outputFormat: '3mf',
        outputDir: workDir,
      },
      { runCommand: fn, scriptPath: '/fake/script.py', timeoutMs: 1234 },
    );

    expect(observedTimeout).toBe(1234);
  });
});

describe('convertMeshViaBlender — failure modes', () => {
  it('blender exits non-zero with stderr → tool-failed (stderr in details)', async () => {
    const stub = makeRun({
      blenderOnPath: true,
      blender: { code: 1, stderr: 'Error: 3MF addon not found' },
    });

    const result = await convertMeshViaBlender(
      {
        inputPath: '/tmp/x.stl',
        inputFormat: 'stl',
        outputFormat: '3mf',
        outputDir: workDir,
      },
      { runCommand: stub, scriptPath: '/fake/script.py' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('tool-failed');
      expect(result.details).toContain('3MF addon not found');
    }
  });

  it('runCommand throws (e.g. timeout) → tool-failed with timeout in details', async () => {
    const stub = makeRun({
      blenderOnPath: true,
      blender: { throws: new Error('Command timed out after 5000ms') },
    });

    const result = await convertMeshViaBlender(
      {
        inputPath: '/tmp/x.stl',
        inputFormat: 'stl',
        outputFormat: '3mf',
        outputDir: workDir,
      },
      { runCommand: stub, scriptPath: '/fake/script.py' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('tool-failed');
      expect(result.details).toContain('timed out');
    }
  });

  it('blender exits non-zero with no stderr → falls back to stdout / exit code', async () => {
    const stub = makeRun({
      blenderOnPath: true,
      blender: { code: 137, stderr: '', stdout: 'Killed' },
    });

    const result = await convertMeshViaBlender(
      {
        inputPath: '/tmp/x.stl',
        inputFormat: 'stl',
        outputFormat: '3mf',
        outputDir: workDir,
      },
      { runCommand: stub, scriptPath: '/fake/script.py' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('tool-failed');
      // Either the stdout text or the exit code in details — both are acceptable surfaces.
      expect(result.details).toMatch(/Killed|137/);
    }
  });
});
