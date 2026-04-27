/**
 * Integration tests — forge converter 7z archives backend (V2-005b T_b1)
 *
 * Uses a stubbed `runCommand` so tests run identically on every host. The
 * stub simulates `which 7z` / `where 7z` probes plus `7z x` extraction by
 * writing the desired files into the outputDir before returning.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  convertFile,
  resetToolAvailabilityCache,
  type RunCommand,
} from '../../src/forge/converter';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'forge-conv-7z-'));
  resetToolAvailabilityCache();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Build a stub runCommand. `available` controls which 7z-family binaries
 * the simulated host has on PATH; `extract` describes what files should
 * appear in the outputDir when `7z x` runs.
 */
function makeRun(opts: {
  /** binaries that the `which`/`where` probe finds, in priority order. */
  available?: ReadonlyArray<'7z' | '7za'>;
  /** files (relative paths) to write into outputDir on extract. */
  extractFiles?: ReadonlyArray<{ relPath: string; body?: string }>;
  /** When set, the extract command exits with this code + stderr. */
  extractFails?: { code: number; stderr: string };
}): RunCommand & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const available = new Set(opts.available ?? []);
  const fn: RunCommand = async (cmd, args) => {
    calls.push({ cmd, args });
    // which/where probe
    if (cmd === 'which' || cmd === 'where') {
      const tool = args[0];
      if (available.has(tool as '7z' | '7za')) {
        return { stdout: `/usr/bin/${tool}\n`, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 1 };
    }
    // 7z x or 7za x
    if ((cmd === '7z' || cmd === '7za') && args[0] === 'x') {
      if (opts.extractFails) {
        return { stdout: '', stderr: opts.extractFails.stderr, code: opts.extractFails.code };
      }
      // The -o flag in 7z has no space before the path: -o<dir>
      const oArg = args.find((a) => a.startsWith('-o'));
      if (!oArg) return { stdout: '', stderr: 'no -o flag', code: 1 };
      const outDir = oArg.slice(2);
      for (const f of opts.extractFiles ?? []) {
        const full = path.join(outDir, f.relPath);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, f.body ?? 'fixture');
      }
      return { stdout: 'Everything is Ok\n', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: 'no stub match', code: 1 };
  };
  (fn as RunCommand & { calls: typeof calls }).calls = calls;
  return fn as RunCommand & { calls: typeof calls };
}

describe('convertFile — 7z archives', () => {
  it('zip → archive-extract happy path', async () => {
    const stub = makeRun({
      available: ['7z'],
      extractFiles: [
        { relPath: 'model.stl', body: 'solid stl' },
        { relPath: 'readme.txt', body: 'readme' },
      ],
    });
    const outDir = path.join(workDir, 'out');

    const result = await convertFile(
      {
        inputPath: '/tmp/fake.zip',
        inputFormat: 'zip',
        outputFormat: 'archive-extract',
        outputDir: outDir,
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputFormat).toBe('archive-extract');
    expect(result.outputPaths).toHaveLength(2);
    expect(result.outputPaths.some((p) => p.endsWith('model.stl'))).toBe(true);
    expect(result.outputPaths.some((p) => p.endsWith('readme.txt'))).toBe(true);
  });

  it('rar → archive-extract happy path', async () => {
    const stub = makeRun({
      available: ['7z'],
      extractFiles: [{ relPath: 'inside.obj' }],
    });
    const outDir = path.join(workDir, 'out');

    const result = await convertFile(
      {
        inputPath: '/tmp/fake.rar',
        inputFormat: 'rar',
        outputFormat: 'archive-extract',
        outputDir: outDir,
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputPaths).toHaveLength(1);
    expect(result.outputPaths[0].endsWith('inside.obj')).toBe(true);
  });

  it('7z → archive-extract happy path', async () => {
    const stub = makeRun({
      available: ['7z'],
      extractFiles: [{ relPath: 'a/b/c.stl' }],
    });
    const outDir = path.join(workDir, 'out');

    const result = await convertFile(
      {
        inputPath: '/tmp/fake.7z',
        inputFormat: '7z',
        outputFormat: 'archive-extract',
        outputDir: outDir,
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputPaths).toHaveLength(1);
    expect(result.outputPaths[0]).toMatch(/[\\/]a[\\/]b[\\/]c\.stl$/);
  });

  it('missing tool: neither 7z nor 7za present → missing-tool', async () => {
    const stub = makeRun({ available: [] });

    const result = await convertFile(
      {
        inputPath: '/tmp/fake.zip',
        inputFormat: 'zip',
        outputFormat: 'archive-extract',
        outputDir: path.join(workDir, 'out'),
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing-tool');
      expect(result.toolName).toBe('7z');
      expect(result.installHint).toContain('p7zip-full');
    }
  });

  it('prefers 7z when both 7z and 7za are available', async () => {
    const stub = makeRun({
      available: ['7z', '7za'],
      extractFiles: [{ relPath: 'x.stl' }],
    });

    const result = await convertFile(
      {
        inputPath: '/tmp/fake.zip',
        inputFormat: 'zip',
        outputFormat: 'archive-extract',
        outputDir: path.join(workDir, 'out'),
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(true);
    // Confirm it called `7z x ...` — never `7za x ...`.
    const extractCalls = stub.calls.filter((c) => (c.cmd === '7z' || c.cmd === '7za') && c.args[0] === 'x');
    expect(extractCalls).toHaveLength(1);
    expect(extractCalls[0].cmd).toBe('7z');
  });

  it('falls back to 7za when only 7za is available', async () => {
    const stub = makeRun({
      available: ['7za'],
      extractFiles: [{ relPath: 'x.stl' }],
    });

    const result = await convertFile(
      {
        inputPath: '/tmp/fake.zip',
        inputFormat: 'zip',
        outputFormat: 'archive-extract',
        outputDir: path.join(workDir, 'out'),
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(true);
    const extractCalls = stub.calls.filter((c) => (c.cmd === '7z' || c.cmd === '7za') && c.args[0] === 'x');
    expect(extractCalls).toHaveLength(1);
    expect(extractCalls[0].cmd).toBe('7za');
  });

  it('archive containing only system metadata → archive-no-usable-content', async () => {
    const stub = makeRun({
      available: ['7z'],
      extractFiles: [
        { relPath: '__MACOSX/._garbage' },
        { relPath: 'sub/.DS_Store' },
        { relPath: 'Thumbs.db' },
      ],
    });

    const result = await convertFile(
      {
        inputPath: '/tmp/fake.zip',
        inputFormat: 'zip',
        outputFormat: 'archive-extract',
        outputDir: path.join(workDir, 'out'),
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('archive-no-usable-content');
      expect(result.details).toContain('3 files');
    }
  });

  it('filters system metadata while keeping real files', async () => {
    const stub = makeRun({
      available: ['7z'],
      extractFiles: [
        { relPath: '__MACOSX/._noise' },
        { relPath: '.DS_Store' },
        { relPath: 'real.stl' },
      ],
    });

    const result = await convertFile(
      {
        inputPath: '/tmp/fake.zip',
        inputFormat: 'zip',
        outputFormat: 'archive-extract',
        outputDir: path.join(workDir, 'out'),
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputPaths).toHaveLength(1);
    expect(result.outputPaths[0].endsWith('real.stl')).toBe(true);
  });

  it('extract tool exits non-zero → tool-failed with stderr in details', async () => {
    const stub = makeRun({
      available: ['7z'],
      extractFails: { code: 2, stderr: 'Cannot open file as archive' },
    });

    const result = await convertFile(
      {
        inputPath: '/tmp/fake.zip',
        inputFormat: 'zip',
        outputFormat: 'archive-extract',
        outputDir: path.join(workDir, 'out'),
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('tool-failed');
      expect(result.details).toContain('Cannot open file as archive');
    }
  });

  it('does not auto-recurse: nested archive paths are returned as-is', async () => {
    const stub = makeRun({
      available: ['7z'],
      extractFiles: [
        { relPath: 'outer/model.stl' },
        { relPath: 'outer/inner.zip' },
      ],
    });

    const result = await convertFile(
      {
        inputPath: '/tmp/fake.zip',
        inputFormat: 'zip',
        outputFormat: 'archive-extract',
        outputDir: path.join(workDir, 'out'),
      },
      { runCommand: stub },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both the inner archive and the stl are surfaced; recursion is a
    // T_b3-worker concern, not a T_b1-framework concern.
    expect(result.outputPaths).toHaveLength(2);
    expect(result.outputPaths.some((p) => p.endsWith('model.stl'))).toBe(true);
    expect(result.outputPaths.some((p) => p.endsWith('inner.zip'))).toBe(true);
  });
});
