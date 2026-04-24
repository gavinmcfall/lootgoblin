/**
 * walker.ts — Recursive filesystem walk for the Adoption orchestrator.
 *
 * Returns a flat list of file entries with paths relative to the stash root.
 * Uses Node 20's fs.promises.readdir({ recursive: true }) in string-path mode.
 * Skips directories (only regular files). Skips hidden files (leading dot) by default.
 *
 * Symlink policy: symlinks — both to files AND to directories — are skipped
 * entirely. Node's readdir with { recursive: true } DOES follow directory
 * symlinks, and fs.stat (follows symlinks) would pass `isFile()` on a
 * symlink-to-file, leading to (a) duplicate enumeration of the same inode via
 * two paths, and (b) infinite recursion on symlink cycles. We use fs.lstat
 * (does NOT follow symlinks) and drop any entry where isSymbolicLink() is
 * true. No cycle handling is attempted; real paths only.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { logger } from '../../logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WalkedFile = {
  absolutePath: string;
  /** Forward-slash, relative to stash root. */
  relativePath: string;
  size: number;
  mtime: Date;
};

export type WalkOptions = {
  /** If true, hidden files (leading dot) are included. Default: false. */
  includeHidden?: boolean;
};

// ---------------------------------------------------------------------------
// walkStashRoot
// ---------------------------------------------------------------------------

/**
 * Recursively walks rootPath and returns all regular files.
 *
 * Hidden files (names starting with ".") are skipped unless includeHidden is true.
 * Symlinks (both file and directory) are skipped — no cycle handling is attempted;
 * enumerate real paths only. See file-level docstring for rationale.
 */
export async function walkStashRoot(
  rootPath: string,
  options: WalkOptions = {},
): Promise<WalkedFile[]> {
  const { includeHidden = false } = options;

  // Normalise root so we can compute relative paths cleanly.
  const root = path.resolve(rootPath);

  // Use the string-based recursive readdir to avoid Dirent<Buffer> type issues
  // with older @types/node versions. We lstat each entry individually for
  // metadata + symlink detection.
  //
  // NOTE: Node's readdir({ recursive: true }) follows directory symlinks. We
  // can't prevent that at enumeration time — the defense is to lstat every
  // returned path and drop symlink entries. A symlink-to-directory that was
  // traversed by readdir will have its contents surfaced via the real path
  // too, so dropping the symlinked path avoids duplicate enumeration as long
  // as the real path is also inside `root`. If the real path is OUTSIDE
  // `root`, only the symlinked-path entries exist — still surface-able here
  // but we skip them anyway because they're under a symlink segment. This is
  // conservative (may miss out-of-root content via intentional symlinks) but
  // safe (no cycles, no duplicates).
  let allRelPaths: string[];
  try {
    // Cast to string[] — the actual runtime returns strings when no encoding option given
    allRelPaths = (await fsp.readdir(root, { recursive: true })) as string[];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // Root doesn't exist or isn't a directory — return empty.
      return [];
    }
    throw err;
  }

  const results: WalkedFile[] = [];

  for (const relRaw of allRelPaths) {
    // Normalise to forward-slash relative path.
    const relativePath = relRaw.split(path.sep).join('/');
    const absolutePath = path.join(root, relRaw);

    // Skip hidden files/dirs (any path segment starting with ".")
    if (!includeHidden && relativePath.split('/').some((seg) => seg.startsWith('.'))) {
      continue;
    }

    // lstat (NOT stat) — must not follow symlinks so we can detect and skip them.
    let lstats: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      lstats = await fsp.lstat(absolutePath);
    } catch {
      // File disappeared between readdir and lstat — skip it.
      continue;
    }

    // Drop symlinks (to files AND directories) — no cycle handling.
    if (lstats.isSymbolicLink()) {
      logger.debug({ path: relativePath }, 'walker: skipping symlink');
      continue;
    }

    // Skip directories, sockets, FIFOs — only regular files.
    if (!lstats.isFile()) continue;

    // Also drop any entry whose ancestor is a symlink. readdir({recursive})
    // may have already followed a directory symlink; files reachable ONLY
    // via that symlinked path have a non-symlink leaf but symlinked parent.
    // Walk up and check each ancestor. This is O(depth) per file — fine for
    // v2 scale.
    let skipDueToSymlinkAncestor = false;
    const segs = relativePath.split('/');
    for (let i = 1; i < segs.length; i++) {
      const ancestorRel = segs.slice(0, i).join('/');
      const ancestorAbs = path.join(root, ancestorRel);
      try {
        const ancestorLstat = await fsp.lstat(ancestorAbs);
        if (ancestorLstat.isSymbolicLink()) {
          skipDueToSymlinkAncestor = true;
          break;
        }
      } catch {
        // Ancestor gone — treat as disappeared, skip the leaf too.
        skipDueToSymlinkAncestor = true;
        break;
      }
    }
    if (skipDueToSymlinkAncestor) {
      logger.debug({ path: relativePath }, 'walker: skipping entry under symlinked ancestor');
      continue;
    }

    results.push({
      absolutePath,
      relativePath,
      size: lstats.size,
      mtime: lstats.mtime,
    });
  }

  return results;
}
