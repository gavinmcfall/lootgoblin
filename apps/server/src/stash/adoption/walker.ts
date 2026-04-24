/**
 * walker.ts — Recursive filesystem walk for the Adoption orchestrator.
 *
 * Returns a flat list of file entries with paths relative to the stash root.
 * Uses Node 20's fs.promises.readdir({ recursive: true, withFileTypes: true }).
 * Skips directories (only regular files). Skips hidden files (leading dot) by default.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

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
 * Symlinks are not followed — only regular files are returned.
 */
export async function walkStashRoot(
  rootPath: string,
  options: WalkOptions = {},
): Promise<WalkedFile[]> {
  const { includeHidden = false } = options;

  // Normalise root so we can compute relative paths cleanly.
  const root = path.resolve(rootPath);

  // Use the string-based recursive readdir to avoid Dirent<Buffer> type issues
  // with older @types/node versions. We stat each file individually for metadata.
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

    // Stat to determine file type + metadata.
    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(absolutePath);
    } catch {
      // File disappeared between readdir and stat — skip it.
      continue;
    }

    // Only regular files (skip directories, symlinks, etc.)
    if (!stat.isFile()) continue;

    results.push({
      absolutePath,
      relativePath,
      size: stat.size,
      mtime: stat.mtime,
    });
  }

  return results;
}
