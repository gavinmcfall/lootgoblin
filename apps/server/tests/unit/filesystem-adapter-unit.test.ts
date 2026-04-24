/**
 * Unit tests for filesystem-adapter — sha256Hex with a known input.
 *
 * These tests use the real filesystem with a small fixed-content temp file.
 * They verify the hash function produces the expected SHA-256 digest.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256Hex } from '../../src/stash/filesystem-adapter';

let tmpDir: string;
let knownFile: string;

// SHA-256 of the ASCII string "hello world\n" (12 bytes)
// $ echo "hello world" | sha256sum
// a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447
const KNOWN_CONTENT = 'hello world\n';
const KNOWN_SHA256 = 'a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447';

// SHA-256 of exactly "hello world" (no newline, 11 bytes)
// $ echo -n "hello world" | sha256sum
// b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
const KNOWN_CONTENT_NO_NL = 'hello world';
const KNOWN_SHA256_NO_NL =
  'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';

beforeAll(async () => {
  tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'lootgoblin-sha256-unit-'),
  );
  knownFile = path.join(tmpDir, 'known.txt');
  await fs.promises.writeFile(knownFile, KNOWN_CONTENT, 'utf8');
});

afterAll(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('sha256Hex', () => {
  it('returns the correct SHA-256 hex for a known file with newline', async () => {
    const result = await sha256Hex(knownFile);
    expect(result).toBe(KNOWN_SHA256);
  });

  it('returns the correct SHA-256 hex for a file without trailing newline', async () => {
    const noNlFile = path.join(tmpDir, 'no-newline.txt');
    await fs.promises.writeFile(noNlFile, KNOWN_CONTENT_NO_NL, 'utf8');
    const result = await sha256Hex(noNlFile);
    expect(result).toBe(KNOWN_SHA256_NO_NL);
  });

  it('returns different hashes for files with different content', async () => {
    const fileA = path.join(tmpDir, 'a.txt');
    const fileB = path.join(tmpDir, 'b.txt');
    await fs.promises.writeFile(fileA, 'content-A', 'utf8');
    await fs.promises.writeFile(fileB, 'content-B', 'utf8');
    const hashA = await sha256Hex(fileA);
    const hashB = await sha256Hex(fileB);
    expect(hashA).not.toBe(hashB);
  });

  it('returns the same hash for two files with identical content', async () => {
    const fileC = path.join(tmpDir, 'c.txt');
    const fileD = path.join(tmpDir, 'd.txt');
    const same = 'identical content';
    await fs.promises.writeFile(fileC, same, 'utf8');
    await fs.promises.writeFile(fileD, same, 'utf8');
    const hashC = await sha256Hex(fileC);
    const hashD = await sha256Hex(fileD);
    expect(hashC).toBe(hashD);
    expect(hashC).toHaveLength(64); // 256 bits → 64 hex chars
  });

  it('produces a 64-character lowercase hex string', async () => {
    const result = await sha256Hex(knownFile);
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the canonical empty SHA-256 digest for a 0-byte file', async () => {
    // Exercises the pipeline+generator path when no data chunks flow.
    // Canonical SHA-256 of the empty byte string.
    const emptyFile = path.join(tmpDir, 'empty.bin');
    await fs.promises.writeFile(emptyFile, Buffer.alloc(0));
    const stat = await fs.promises.stat(emptyFile);
    expect(stat.size).toBe(0);

    const result = await sha256Hex(emptyFile);
    expect(result).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
