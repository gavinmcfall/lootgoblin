/**
 * Unit tests — forge converter framework (V2-005b T_b1)
 *
 * Behaviour of the dispatch layer in `apps/server/src/forge/converter/index.ts`
 * with stubbed `runCommand` and tool-availability cache. No real shell-out,
 * no real archives — those are covered by the images + archives suites.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  convertFile,
  normalizeFormat,
  resetToolAvailabilityCache,
  isToolAvailable,
  type RunCommand,
} from '../../src/forge/converter';

// Helper — build a stub runCommand with controlled responses keyed by argv[0].
type StubMatcher = {
  match: (cmd: string, args: string[]) => boolean;
  result: { stdout?: string; stderr?: string; code: number };
};

function makeStubRunCommand(matchers: StubMatcher[], onCall?: (cmd: string, args: string[]) => void): RunCommand & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn: RunCommand = async (cmd, args) => {
    calls.push({ cmd, args });
    if (onCall) onCall(cmd, args);
    for (const m of matchers) {
      if (m.match(cmd, args)) {
        return {
          stdout: m.result.stdout ?? '',
          stderr: m.result.stderr ?? '',
          code: m.result.code,
        };
      }
    }
    return { stdout: '', stderr: 'no stub match', code: 1 };
  };
  // attach for inspection
  (fn as RunCommand & { calls: typeof calls }).calls = calls;
  return fn as RunCommand & { calls: typeof calls };
}

beforeEach(() => {
  resetToolAvailabilityCache();
});

describe('normalizeFormat', () => {
  it('lowercases', () => {
    expect(normalizeFormat('JPEG')).toBe('jpeg');
    expect(normalizeFormat('STL')).toBe('stl');
  });

  it('strips leading dot', () => {
    expect(normalizeFormat('.png')).toBe('png');
    expect(normalizeFormat('.JPEG')).toBe('jpeg');
  });

  it('passes through already-normalized forms', () => {
    expect(normalizeFormat('webp')).toBe('webp');
  });
});

describe('convertFile — dispatch rejections', () => {
  it('same input/output format returns unsupported-pair', async () => {
    const result = await convertFile({
      inputPath: '/tmp/x.jpg',
      inputFormat: 'jpeg',
      outputFormat: 'jpeg',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-pair');
    }
  });

  it('unknown input format with unknown output → unsupported-pair', async () => {
    const result = await convertFile({
      inputPath: '/tmp/x.bogus',
      inputFormat: 'bogus',
      outputFormat: 'alsobogus',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-pair');
    }
  });

  it('mesh pair outside SUPPORTED_BLENDER_PAIRS → unsupported-pair (T_b3 backend)', async () => {
    // stl→gcode is not in SUPPORTED_BLENDER_PAIRS (gcode is a slicer
    // output, not a Blender export). The mesh dispatcher routes to the
    // Blender backend, which short-circuits with unsupported-pair before
    // trying to invoke the binary.
    const result = await convertFile({
      inputPath: '/tmp/x.stl',
      inputFormat: 'stl',
      outputFormat: 'gcode',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-pair');
    }
  });

  it('archive input with non-archive-extract output → unsupported-pair', async () => {
    const result = await convertFile({
      inputPath: '/tmp/x.zip',
      inputFormat: 'zip',
      outputFormat: 'png',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-pair');
      expect(result.details).toContain('archive-extract');
    }
  });
});

describe('convertFile — format normalization', () => {
  it('treats .JPEG and JPEG as jpeg (same-format no-op rejected)', async () => {
    const result = await convertFile({
      inputPath: '/tmp/x.jpeg',
      inputFormat: '.JPEG',
      outputFormat: 'JPEG',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-pair');
      // Confirm normalization: details should reference the lowercased form.
      expect(result.details).toContain("'jpeg'");
    }
  });

  it("'jpg' alias normalizes to 'jpeg' (collides with output 'jpeg' → no-op)", async () => {
    const result = await convertFile({
      inputPath: '/tmp/x.jpg',
      inputFormat: 'jpg',
      outputFormat: 'jpeg',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-pair');
    }
  });
});

describe('isToolAvailable — caching', () => {
  it('caches a missing-tool result and does not re-probe', async () => {
    const stub = makeStubRunCommand([
      { match: (cmd, args) => args[0] === '7z', result: { code: 1, stdout: '' } },
    ]);

    const first = await isToolAvailable('7z', stub);
    const second = await isToolAvailable('7z', stub);

    expect(first).toBe(false);
    expect(second).toBe(false);
    // Only one probe should have run.
    expect(stub.calls.length).toBe(1);
  });

  it('caches an available-tool result', async () => {
    const stub = makeStubRunCommand([
      { match: (cmd, args) => args[0] === 'somecli', result: { code: 0, stdout: '/usr/bin/somecli\n' } },
    ]);

    const first = await isToolAvailable('somecli', stub);
    const second = await isToolAvailable('somecli', stub);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(stub.calls.length).toBe(1);
  });

  it('resetToolAvailabilityCache forces re-probe', async () => {
    const stub = makeStubRunCommand([
      { match: (cmd, args) => args[0] === 'cycle-tool', result: { code: 1, stdout: '' } },
    ]);

    await isToolAvailable('cycle-tool', stub);
    expect(stub.calls.length).toBe(1);

    resetToolAvailabilityCache();
    await isToolAvailable('cycle-tool', stub);
    expect(stub.calls.length).toBe(2);
  });
});

describe('convertFile — runCommand stub injection', () => {
  it('archive extraction routes through the supplied runCommand stub (which probe + extract)', async () => {
    // Stub: which 7z = found; 7z x = success but we won't have files on disk
    // afterwards (the stub doesn't actually extract). The framework will
    // walk an empty outputDir and report archive-no-usable-content. That
    // proves dispatch went through the stub, not the production runner.
    const stub = makeStubRunCommand([
      // which / where probe for 7z
      { match: (cmd, args) => args[0] === '7z' && (cmd === 'which' || cmd === 'where'), result: { code: 0, stdout: '/usr/bin/7z\n' } },
      // extract command
      { match: (cmd) => cmd === '7z', result: { code: 0, stdout: '' } },
    ]);

    const result = await convertFile(
      {
        inputPath: '/tmp/nonexistent.zip',
        inputFormat: 'zip',
        outputFormat: 'archive-extract',
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('archive-no-usable-content');
    }
    // Both the which probe and the extract call should have hit the stub.
    expect(stub.calls.some((c) => c.cmd === 'which' || c.cmd === 'where')).toBe(true);
    expect(stub.calls.some((c) => c.cmd === '7z' && c.args[0] === 'x')).toBe(true);
  });
});
