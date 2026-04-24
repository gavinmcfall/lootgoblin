/**
 * filesystem-adapter.ts — Low-level filesystem-move primitive for the Stash pillar.
 *
 * Implements ADR-009 "copy-then-cleanup with hardlink":
 *   - Attempts hardlink first (same-filesystem, zero bytes written).
 *   - Falls back to byte-copy + SHA-256 verify on EXDEV (cross-filesystem).
 *   - Calls onAfterDestinationVerified() BEFORE unlinking source so the caller
 *     can commit DB state inside the same logical operation.
 *   - Rolls back (removes destination) if the DB commit hook throws.
 *   - Never calls fs.rename() or any API that implicitly replaces destination.
 *   - Pure fs/hash — zero Drizzle/DB imports.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CleanupPolicy = 'immediate' | 'deferred';

export type MoveRequest = {
  source: string;
  destination: string;
  cleanupPolicy: CleanupPolicy;
  /**
   * Called AFTER destination is established and verified, BEFORE source is
   * unlinked. Caller uses this to commit DB state. If it throws, destination
   * is removed and source is left untouched.
   *
   * IMPORTANT: The adapter assumes this callback's promise resolves only after
   * the DB transaction has been durably committed. If your DB uses deferred
   * WAL flush or the callback returns before disk sync, the subsequent source
   * unlink may precede DB durability — yielding a window where the source
   * file is gone but the DB row referencing the new destination is not yet
   * persisted.
   */
  onAfterDestinationVerified: () => Promise<void>;
  /**
   * @internal Test seam — when true the adapter behaves as if fs.link threw
   * EXDEV regardless of whether the link actually succeeds. Used by
   * integration tests to exercise the copy path without a real cross-device
   * mount.
   */
  _forceExdev?: boolean;
};

export type MoveResult =
  | {
      status: 'linked';
      destination: string;
      source: string;
      sameFilesystem: true;
      bytesWritten: 0;
    }
  | {
      status: 'copied';
      destination: string;
      source: string;
      sameFilesystem: false;
      bytesWritten: number;
      sourceHash: string;
      destinationHash: string;
    }
  | {
      status: 'pending-cleanup';
      destination: string;
      source: string;
      cleanupMethod: 'linked' | 'copied';
    }
  | {
      status: 'failed';
      reason: FailureReason;
      details: string;
      error?: unknown;
      /**
       * Present when the adapter attempted a best-effort cleanup (e.g. removing
       * a corrupted destination after `hash-mismatch` or `db-commit-failed`)
       * and that cleanup itself failed. Callers should log this and surface
       * the orphaned destination to operators. Absence of this field means
       * either no rollback was needed, or rollback succeeded.
       */
      rollbackError?: unknown;
    };

export type FailureReason =
  | 'source-not-found'
  | 'destination-exists'
  | 'mkdir-failed'
  | 'link-failed-non-exdev'
  | 'copy-failed'
  | 'hash-mismatch'
  | 'db-commit-failed'
  | 'source-cleanup-failed';

// ---------------------------------------------------------------------------
// Exported utilities
// ---------------------------------------------------------------------------

/**
 * Returns true if paths `a` and `b` reside on the same filesystem device
 * (same stat().dev). Used internally by linkOrCopy; also exported for callers
 * that want to decide ahead of time whether a move will be free (hardlink) or
 * expensive (byte-copy).
 *
 * Note: `b` need not exist — when `b` doesn't exist the parent directory is
 * stat'd instead. If the parent also doesn't exist, throws ENOENT.
 */
export async function sameFilesystem(a: string, b: string): Promise<boolean> {
  const statA = await fs.promises.stat(a);
  let statB: fs.Stats;
  try {
    statB = await fs.promises.stat(b);
  } catch {
    // b doesn't exist; stat the parent directory instead
    statB = await fs.promises.stat(dirname(b));
  }
  return statA.dev === statB.dev;
}

/**
 * Streams a file through SHA-256 and returns the hex digest.
 * Streaming keeps memory usage constant for large files.
 */
export async function sha256Hex(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  await pipeline(stream, async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
    }
  });
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Core primitive
// ---------------------------------------------------------------------------

/**
 * Move a file from source to destination using hardlink (same-fs) or
 * byte-copy (cross-fs). Calls the DB commit hook after destination is
 * verified but before source is removed.
 */
export async function linkOrCopy(req: MoveRequest): Promise<MoveResult> {
  const { source, destination, cleanupPolicy, onAfterDestinationVerified } =
    req;

  // ── Step 1: Verify source exists and is a regular file ──────────────────
  let sourceStat: fs.Stats;
  try {
    // stat follows symlinks — a symlink-to-file is treated as a regular file.
    sourceStat = await fs.promises.stat(source);
  } catch (err) {
    return {
      status: 'failed',
      reason: 'source-not-found',
      details: `Source does not exist: ${source}`,
      error: err,
    };
  }
  if (!sourceStat.isFile()) {
    return {
      status: 'failed',
      reason: 'source-not-found',
      details: `Source is not a regular file: ${source}`,
    };
  }

  // ── Step 2: Verify destination does NOT exist ────────────────────────────
  try {
    await fs.promises.access(destination);
    // If access succeeds, destination exists — fail
    return {
      status: 'failed',
      reason: 'destination-exists',
      details: `Destination already exists: ${destination}`,
    };
  } catch {
    // ENOENT is expected — destination does not exist, continue
  }

  // ── Step 3: mkdir -p on parent directory ─────────────────────────────────
  try {
    await fs.promises.mkdir(dirname(destination), { recursive: true });
  } catch (err) {
    return {
      status: 'failed',
      reason: 'mkdir-failed',
      details: `Failed to create parent directory for: ${destination}`,
      error: err,
    };
  }

  // ── Step 4: Try hardlink ──────────────────────────────────────────────────
  type Branch = 'linked' | 'copied';
  let branch: Branch;
  let copyBytesWritten = 0;
  let srcHash = '';
  let dstHash = '';

  const shouldForceCopy = req._forceExdev === true;

  if (!shouldForceCopy) {
    try {
      await fs.promises.link(source, destination);
      branch = 'linked';
    } catch (linkErr) {
      const code = (linkErr as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') {
        branch = 'copied';
      } else if (code === 'EEXIST') {
        // Race: another process created the destination between the step 2
        // access() check and the step 4 link() call. Report as
        // destination-exists so callers can handle it uniformly with the
        // pre-check path (rename/quarantine/skip).
        return {
          status: 'failed',
          reason: 'destination-exists',
          details: `Destination already exists (race after access check): ${destination}`,
          error: linkErr,
        };
      } else {
        return {
          status: 'failed',
          reason: 'link-failed-non-exdev',
          details: `fs.link failed with ${code ?? 'unknown error'}: ${source} → ${destination}`,
          error: linkErr,
        };
      }
    }
  } else {
    branch = 'copied';
  }

  // ── Step 5: Byte-copy path (EXDEV or forced) ──────────────────────────────
  if (branch === 'copied') {
    // Compute source hash before copy
    try {
      srcHash = await sha256Hex(source);
    } catch (err) {
      return {
        status: 'failed',
        reason: 'copy-failed',
        details: `Failed to hash source before copy: ${source}`,
        error: err,
      };
    }

    // Copy source → destination
    try {
      await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // COPYFILE_EXCL enforces no-overwrite at the OS level. Fires under
        // the same race as step 2/4: another process created the destination
        // between the access() check and the copyFile() call. Report
        // uniformly as destination-exists.
        return {
          status: 'failed',
          reason: 'destination-exists',
          details: `Destination already exists (race during copy): ${destination}`,
          error: err,
        };
      }
      return {
        status: 'failed',
        reason: 'copy-failed',
        details: `fs.copyFile failed: ${source} → ${destination}`,
        error: err,
      };
    }

    // Compute destination hash and verify
    try {
      dstHash = await sha256Hex(destination);
    } catch (err) {
      const rollbackErr = await bestEffortUnlink(destination);
      return {
        status: 'failed',
        reason: 'copy-failed',
        details: `Failed to hash destination after copy: ${destination}`,
        error: err,
        ...(rollbackErr ? { rollbackError: rollbackErr } : {}),
      };
    }

    if (dstHash !== srcHash) {
      const rollbackErr = await bestEffortUnlink(destination);
      return {
        status: 'failed',
        reason: 'hash-mismatch',
        details: `SHA-256 mismatch after copy: source=${srcHash} destination=${dstHash}`,
        ...(rollbackErr ? { rollbackError: rollbackErr } : {}),
      };
    }

    // Record bytes written — reuse sourceStat.size from step 1 to avoid a
    // second stat syscall and TOCTOU window. The hash verification above
    // already proves the destination bytes equal the source bytes.
    copyBytesWritten = sourceStat.size;
  }

  // ── Step 6: Call DB commit hook ───────────────────────────────────────────
  try {
    await onAfterDestinationVerified();
  } catch (err) {
    const rollbackErr = await bestEffortUnlink(destination);
    return {
      status: 'failed',
      reason: 'db-commit-failed',
      details: `onAfterDestinationVerified threw: ${source} → ${destination}`,
      error: err,
      ...(rollbackErr ? { rollbackError: rollbackErr } : {}),
    };
  }

  // ── Step 7: Cleanup policy ────────────────────────────────────────────────
  if (cleanupPolicy === 'deferred') {
    return {
      status: 'pending-cleanup',
      destination,
      source,
      cleanupMethod: branch,
    };
  }

  // immediate — unlink source
  try {
    await fs.promises.unlink(source);
  } catch (err) {
    return {
      status: 'failed',
      reason: 'source-cleanup-failed',
      details: `Failed to unlink source after successful move+DB commit: ${source}`,
      error: err,
    };
  }

  // Return success
  if (branch === 'linked') {
    return {
      status: 'linked',
      destination,
      source,
      sameFilesystem: true,
      bytesWritten: 0,
    };
  } else {
    return {
      status: 'copied',
      destination,
      source,
      sameFilesystem: false,
      bytesWritten: copyBytesWritten,
      sourceHash: srcHash,
      destinationHash: dstHash,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Unlink without throwing — used for best-effort rollback. Returns the caught
 * Error on failure (so callers can attach it to the outgoing failure result
 * as `rollbackError`), or null on success.
 */
async function bestEffortUnlink(filePath: string): Promise<Error | null> {
  try {
    await fs.promises.unlink(filePath);
    return null;
  } catch (err) {
    return err as Error;
  }
}
