/**
 * Integration tests for filesystem-adapter — V2-002-T3
 *
 * All operations run against a real filesystem under /tmp.
 * A unique scratch directory is created in beforeAll and torn down in afterAll.
 *
 * Cross-filesystem (EXDEV) tests use the _forceExdev seam — we can't create a
 * new mount in CI, but the seam forces the adapter through the copy branch.
 *
 * Test cases:
 *   1.  Happy path — hardlink (same-fs, immediate cleanup)
 *   2.  Happy path — copy (_forceExdev, immediate cleanup)
 *   3.  Destination exists → 'destination-exists'
 *   4.  Source missing   → 'source-not-found'
 *   5.  Parent dir creation (deep path)
 *   6.  Link non-EXDEV failure  → 'link-failed-non-exdev'
 *   7.  Hash mismatch (copy path) → 'hash-mismatch'
 *   8.  DB callback throws      → 'db-commit-failed', destination cleaned up
 *   9.  Deferred cleanup        → 'pending-cleanup', both paths exist
 *   10. Source unlink fails     → 'source-cleanup-failed'
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { linkOrCopy, sha256Hex } from '../../src/stash/filesystem-adapter';

// ---------------------------------------------------------------------------
// Setup — create and tear down /tmp scratch directory
// ---------------------------------------------------------------------------

let scratch: string;
let counter = 0;

/** Generate a unique sub-directory inside scratch for each test case. */
function testDir(label: string): string {
  counter += 1;
  return path.join(scratch, `${counter}-${label}`);
}

/** Write a small (~1 KB) fixture file. Returns the file path. */
async function writeFixture(
  dir: string,
  name: string,
  content = 'fixture content for lootgoblin test\n'.repeat(30),
): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.promises.writeFile(filePath, content, 'utf8');
  return filePath;
}

const noop = async () => {};

beforeAll(async () => {
  scratch = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'lootgoblin-fs-adapter-'),
  );
});

afterAll(async () => {
  await fs.promises.rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: Happy path — hardlink, immediate cleanup
// ---------------------------------------------------------------------------

describe('linkOrCopy — happy path hardlink (same-fs, immediate)', () => {
  it('returns { status: linked }, source removed, destination exists, hardlink confirmed via inode', async () => {
    const dir = testDir('link-immediate');
    const src = await writeFixture(dir, 'source.stl');
    const dst = path.join(dir, 'dest', 'model.stl');

    const srcStatBefore = await fs.promises.stat(src);

    const result = await linkOrCopy({
      source: src,
      destination: dst,
      cleanupPolicy: 'immediate',
      onAfterDestinationVerified: noop,
    });

    expect(result).toMatchObject({
      status: 'linked',
      destination: dst,
      source: src,
      sameFilesystem: true,
      bytesWritten: 0,
    });

    // Source should be gone (immediate cleanup)
    await expect(fs.promises.access(src)).rejects.toThrow();

    // Destination should exist
    await expect(fs.promises.access(dst)).resolves.toBeUndefined();

    // Before unlink, source and destination shared an inode (hardlink).
    // We can't check the source inode after unlink, but we can confirm
    // the destination inode matches what source had (they were the same file).
    const dstStat = await fs.promises.stat(dst);
    expect(dstStat.ino).toBe(srcStatBefore.ino);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Happy path — copy (forced EXDEV), immediate cleanup
// ---------------------------------------------------------------------------

describe('linkOrCopy — happy path copy (_forceExdev, immediate)', () => {
  it('returns { status: copied }, source removed, destination exists, hashes match', async () => {
    const dir = testDir('copy-immediate');
    const src = await writeFixture(dir, 'source.stl');
    const dst = path.join(dir, 'dest', 'model.stl');

    const result = await linkOrCopy({
      source: src,
      destination: dst,
      cleanupPolicy: 'immediate',
      onAfterDestinationVerified: noop,
      _forceExdev: true,
    });

    expect(result.status).toBe('copied');
    if (result.status !== 'copied') return;

    expect(result.destination).toBe(dst);
    expect(result.source).toBe(src);
    expect(result.sameFilesystem).toBe(false);
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect(result.sourceHash).toHaveLength(64);
    expect(result.destinationHash).toHaveLength(64);
    expect(result.sourceHash).toBe(result.destinationHash);

    // Source should be gone
    await expect(fs.promises.access(src)).rejects.toThrow();

    // Destination should exist
    await expect(fs.promises.access(dst)).resolves.toBeUndefined();

    // Verify hash against independent computation
    const independentHash = await sha256Hex(dst);
    expect(result.destinationHash).toBe(independentHash);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Destination already exists
// ---------------------------------------------------------------------------

describe('linkOrCopy — destination exists', () => {
  it('returns { status: failed, reason: destination-exists } without touching source', async () => {
    const dir = testDir('dest-exists');
    const src = await writeFixture(dir, 'source.stl');
    const dst = await writeFixture(dir, 'dest.stl', 'pre-existing content\n');

    const result = await linkOrCopy({
      source: src,
      destination: dst,
      cleanupPolicy: 'immediate',
      onAfterDestinationVerified: noop,
    });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'destination-exists',
    });

    // Source must be untouched
    await expect(fs.promises.access(src)).resolves.toBeUndefined();

    // Destination must still have its original content
    const dstContent = await fs.promises.readFile(dst, 'utf8');
    expect(dstContent).toBe('pre-existing content\n');
  });
});

// ---------------------------------------------------------------------------
// Test 4: Source missing
// ---------------------------------------------------------------------------

describe('linkOrCopy — source missing', () => {
  it('returns { status: failed, reason: source-not-found } for a nonexistent source', async () => {
    const dir = testDir('src-missing');
    await fs.promises.mkdir(dir, { recursive: true });
    const src = path.join(dir, 'does-not-exist.stl');
    const dst = path.join(dir, 'dest.stl');

    const result = await linkOrCopy({
      source: src,
      destination: dst,
      cleanupPolicy: 'immediate',
      onAfterDestinationVerified: noop,
    });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'source-not-found',
    });
  });

  it('returns { status: failed, reason: source-not-found } when source is a directory', async () => {
    const dir = testDir('src-is-dir');
    await fs.promises.mkdir(dir, { recursive: true });
    const srcDir = path.join(dir, 'asubdir');
    await fs.promises.mkdir(srcDir);
    const dst = path.join(dir, 'dest.stl');

    const result = await linkOrCopy({
      source: srcDir,
      destination: dst,
      cleanupPolicy: 'immediate',
      onAfterDestinationVerified: noop,
    });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'source-not-found',
    });
  });
});

// ---------------------------------------------------------------------------
// Test 5: Parent directory auto-creation (deep path)
// ---------------------------------------------------------------------------

describe('linkOrCopy — parent directory creation', () => {
  it('creates nested parent directories and links successfully', async () => {
    const dir = testDir('deep-parent');
    const src = await writeFixture(dir, 'source.stl');
    // Three levels deep, neither exists
    const dst = path.join(dir, 'a', 'b', 'c', 'model.stl');

    const result = await linkOrCopy({
      source: src,
      destination: dst,
      cleanupPolicy: 'immediate',
      onAfterDestinationVerified: noop,
    });

    expect(result.status).toBe('linked');
    await expect(fs.promises.access(dst)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 6: Link fails with non-EXDEV error
// ---------------------------------------------------------------------------

describe('linkOrCopy — link fails with non-EXDEV', () => {
  it('returns { status: failed, reason: link-failed-non-exdev } when link throws EPERM', async () => {
    const dir = testDir('link-eperm');
    const src = await writeFixture(dir, 'source.stl');
    const dst = path.join(dir, 'dest.stl');

    // Spy on fs.promises.link and make it throw EPERM
    const linkSpy = vi
      .spyOn(fs.promises, 'link')
      .mockRejectedValueOnce(
        Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
      );

    const result = await linkOrCopy({
      source: src,
      destination: dst,
      cleanupPolicy: 'immediate',
      onAfterDestinationVerified: noop,
    });

    linkSpy.mockRestore();

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'link-failed-non-exdev',
    });

    // Source must be untouched
    await expect(fs.promises.access(src)).resolves.toBeUndefined();
    // Destination must NOT have been created
    await expect(fs.promises.access(dst)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test 7: Hash mismatch during copy
// ---------------------------------------------------------------------------

describe('linkOrCopy — hash mismatch', () => {
  it('returns { status: failed, reason: hash-mismatch } and cleans up destination', async () => {
    const dir = testDir('hash-mismatch');
    const src = await writeFixture(dir, 'source.stl');
    const dst = path.join(dir, 'dest.stl');

    // Override copyFile to write different content so the hash won't match
    const copyFileSpy = vi
      .spyOn(fs.promises, 'copyFile')
      .mockImplementationOnce(async (srcPath: fs.PathLike | fs.FileHandle, dstPath: fs.PathLike | fs.FileHandle) => {
        // Write corrupted content to destination
        await fs.promises.writeFile(dstPath as string, 'CORRUPTED CONTENT\n', 'utf8');
      });

    const result = await linkOrCopy({
      source: src,
      destination: dst,
      cleanupPolicy: 'immediate',
      onAfterDestinationVerified: noop,
      _forceExdev: true,
    });

    copyFileSpy.mockRestore();

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'hash-mismatch',
    });

    // Destination must have been cleaned up (rolled back)
    await expect(fs.promises.access(dst)).rejects.toThrow();

    // Source must be untouched
    await expect(fs.promises.access(src)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 8: DB callback throws
// ---------------------------------------------------------------------------

describe('linkOrCopy — DB commit hook throws', () => {
  it('returns { status: failed, reason: db-commit-failed }, removes destination, leaves source', async () => {
    const dir = testDir('db-throw');
    const src = await writeFixture(dir, 'source.stl');
    const dst = path.join(dir, 'dest', 'model.stl');
    const dbError = new Error('simulated DB constraint violation');

    const result = await linkOrCopy({
      source: src,
      destination: dst,
      cleanupPolicy: 'immediate',
      onAfterDestinationVerified: async () => {
        throw dbError;
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'db-commit-failed',
      error: dbError,
    });

    // Destination must have been cleaned up
    await expect(fs.promises.access(dst)).rejects.toThrow();

    // Source must be untouched
    await expect(fs.promises.access(src)).resolves.toBeUndefined();
  });

  it('same with _forceExdev (copy path) — destination removed on db failure', async () => {
    const dir = testDir('db-throw-copy');
    const src = await writeFixture(dir, 'source.stl');
    const dst = path.join(dir, 'dest', 'model.stl');

    const result = await linkOrCopy({
      source: src,
      destination: dst,
      cleanupPolicy: 'immediate',
      onAfterDestinationVerified: async () => {
        throw new Error('DB error on copy path');
      },
      _forceExdev: true,
    });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'db-commit-failed',
    });

    // Destination must have been cleaned up
    await expect(fs.promises.access(dst)).rejects.toThrow();
    // Source must be untouched
    await expect(fs.promises.access(src)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 9: Deferred cleanup
// ---------------------------------------------------------------------------

describe('linkOrCopy — deferred cleanup', () => {
  it('returns { status: pending-cleanup, cleanupMethod: linked }, both source and destination exist', async () => {
    const dir = testDir('deferred-link');
    const src = await writeFixture(dir, 'source.stl');
    const dst = path.join(dir, 'dest', 'model.stl');

    const result = await linkOrCopy({
      source: src,
      destination: dst,
      cleanupPolicy: 'deferred',
      onAfterDestinationVerified: noop,
    });

    expect(result).toMatchObject({
      status: 'pending-cleanup',
      destination: dst,
      source: src,
      cleanupMethod: 'linked',
    });

    // BOTH paths must exist
    await expect(fs.promises.access(src)).resolves.toBeUndefined();
    await expect(fs.promises.access(dst)).resolves.toBeUndefined();
  });

  it('returns { status: pending-cleanup, cleanupMethod: copied } with _forceExdev', async () => {
    const dir = testDir('deferred-copy');
    const src = await writeFixture(dir, 'source.stl');
    const dst = path.join(dir, 'dest', 'model.stl');

    const result = await linkOrCopy({
      source: src,
      destination: dst,
      cleanupPolicy: 'deferred',
      onAfterDestinationVerified: noop,
      _forceExdev: true,
    });

    expect(result).toMatchObject({
      status: 'pending-cleanup',
      destination: dst,
      source: src,
      cleanupMethod: 'copied',
    });

    // BOTH paths must exist
    await expect(fs.promises.access(src)).resolves.toBeUndefined();
    await expect(fs.promises.access(dst)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 10: Immediate cleanup — source unlink fails
// ---------------------------------------------------------------------------

describe('linkOrCopy — source-cleanup-failed', () => {
  it('returns { status: failed, reason: source-cleanup-failed } when unlink fails after successful DB commit', async () => {
    const dir = testDir('unlink-fail');
    const src = await writeFixture(dir, 'source.stl');
    const dst = path.join(dir, 'dest', 'model.stl');

    let dbCommitCalled = false;

    // Spy on fs.promises.unlink to fail once (the source unlink)
    const unlinkSpy = vi
      .spyOn(fs.promises, 'unlink')
      .mockRejectedValueOnce(
        Object.assign(new Error('unlink failed'), { code: 'EPERM' }),
      );

    const result = await linkOrCopy({
      source: src,
      destination: dst,
      cleanupPolicy: 'immediate',
      onAfterDestinationVerified: async () => {
        dbCommitCalled = true;
      },
    });

    unlinkSpy.mockRestore();

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'source-cleanup-failed',
    });

    // DB must have been called (the commit happened before the unlink attempt)
    expect(dbCommitCalled).toBe(true);

    // Destination should exist (was successfully created before the unlink failure)
    await expect(fs.promises.access(dst)).resolves.toBeUndefined();
  });
});
