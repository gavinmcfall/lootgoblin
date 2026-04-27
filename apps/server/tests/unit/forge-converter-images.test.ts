/**
 * Unit tests — forge converter sharp images backend (V2-005b T_b1)
 *
 * Uses the real sharp package on synthesized in-memory image buffers.
 * Each test mints fresh fixture files in a temp dir + cleans up after.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdir, mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

import { convertFile } from '../../src/forge/converter';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'forge-conv-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makeJpegFixture(): Promise<string> {
  const buf = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 50, b: 100 } },
  })
    .jpeg()
    .toBuffer();
  const file = path.join(workDir, 'fixture.jpg');
  await writeFile(file, buf);
  return file;
}

async function makePngFixture(): Promise<string> {
  const buf = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 200, b: 100, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const file = path.join(workDir, 'fixture.png');
  await writeFile(file, buf);
  return file;
}

async function makeWebpFixture(): Promise<string> {
  const buf = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 50, g: 50, b: 200, alpha: 1 } },
  })
    .webp()
    .toBuffer();
  const file = path.join(workDir, 'fixture.webp');
  await writeFile(file, buf);
  return file;
}

describe('convertFile — sharp images', () => {
  it('jpeg → png produces a valid PNG file', async () => {
    const inputPath = await makeJpegFixture();
    const outDir = path.join(workDir, 'out');

    const result = await convertFile({
      inputPath,
      inputFormat: 'jpeg',
      outputFormat: 'png',
      outputDir: outDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputFormat).toBe('png');
    expect(result.outputPaths).toHaveLength(1);
    const meta = await sharp(result.outputPaths[0]).metadata();
    expect(meta.format).toBe('png');
  });

  it('png → jpeg produces a valid JPEG file', async () => {
    const inputPath = await makePngFixture();
    const outDir = path.join(workDir, 'out');

    const result = await convertFile({
      inputPath,
      inputFormat: 'png',
      outputFormat: 'jpeg',
      outputDir: outDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputFormat).toBe('jpeg');
    const meta = await sharp(result.outputPaths[0]).metadata();
    expect(meta.format).toBe('jpeg');
    // Filename uses .jpg extension by convention.
    expect(result.outputPaths[0]).toMatch(/\.jpg$/);
  });

  it('jpeg → webp produces a valid WebP file', async () => {
    const inputPath = await makeJpegFixture();
    const outDir = path.join(workDir, 'out');

    const result = await convertFile({
      inputPath,
      inputFormat: 'jpeg',
      outputFormat: 'webp',
      outputDir: outDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const meta = await sharp(result.outputPaths[0]).metadata();
    expect(meta.format).toBe('webp');
  });

  it('png → webp produces a valid WebP file', async () => {
    const inputPath = await makePngFixture();
    const outDir = path.join(workDir, 'out');

    const result = await convertFile({
      inputPath,
      inputFormat: 'png',
      outputFormat: 'webp',
      outputDir: outDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const meta = await sharp(result.outputPaths[0]).metadata();
    expect(meta.format).toBe('webp');
  });

  it('webp → png produces a valid PNG file', async () => {
    const inputPath = await makeWebpFixture();
    const outDir = path.join(workDir, 'out');

    const result = await convertFile({
      inputPath,
      inputFormat: 'webp',
      outputFormat: 'png',
      outputDir: outDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const meta = await sharp(result.outputPaths[0]).metadata();
    expect(meta.format).toBe('png');
  });

  it('honours a caller-supplied outputDir', async () => {
    const inputPath = await makeJpegFixture();
    const outDir = path.join(workDir, 'custom-out');
    await mkdir(outDir, { recursive: true });

    const result = await convertFile({
      inputPath,
      inputFormat: 'jpeg',
      outputFormat: 'png',
      outputDir: outDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputPaths[0].startsWith(outDir + path.sep)).toBe(true);
    const s = await stat(result.outputPaths[0]);
    expect(s.isFile()).toBe(true);
  });

  it('produces a unique filename when called repeatedly with the same inputs', async () => {
    const inputPath = await makeJpegFixture();
    const outDir = path.join(workDir, 'out');

    const r1 = await convertFile({ inputPath, inputFormat: 'jpeg', outputFormat: 'png', outputDir: outDir });
    const r2 = await convertFile({ inputPath, inputFormat: 'jpeg', outputFormat: 'png', outputDir: outDir });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.outputPaths[0]).not.toBe(r2.outputPaths[0]);
  });

  it('corrupt input → tool-failed', async () => {
    const corrupt = path.join(workDir, 'corrupt.jpg');
    await writeFile(corrupt, 'this is not a jpeg');
    const outDir = path.join(workDir, 'out');

    const result = await convertFile({
      inputPath: corrupt,
      inputFormat: 'jpeg',
      outputFormat: 'png',
      outputDir: outDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('tool-failed');
      expect(result.details).toBeTruthy();
    }
  });

  it('outputDir is created if it does not exist', async () => {
    const inputPath = await makeJpegFixture();
    const outDir = path.join(workDir, 'nested', 'dir', 'that', 'is', 'fresh');

    const result = await convertFile({
      inputPath,
      inputFormat: 'jpeg',
      outputFormat: 'png',
      outputDir: outDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const buf = await readFile(result.outputPaths[0]);
    expect(buf.byteLength).toBeGreaterThan(0);
  });
});
