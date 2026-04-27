/**
 * sevenzip-archives.ts — V2-005b T_b1
 *
 * Shell-out to `7z` (or `7za` fallback) to extract zip / rar / 7z archives.
 *
 * Architectural decisions (locked in plan dispatch):
 *  - Prefer `7z` over `7za`. Both are p7zip aliases on Linux; some distros
 *    only ship one. Probe both, use the first available.
 *  - Extraction target is `outputDir` (caller-supplied). Caller owns
 *    cleanup; we never delete extracted contents.
 *  - After extraction, walk outputDir recursively and filter "system
 *    metadata" entries (__MACOSX, .DS_Store, Thumbs.db, desktop.ini).
 *  - If the filtered list is empty: archive-no-usable-content.
 *  - We do NOT auto-recurse into nested archives. T_b3 worker decides.
 */

import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { isToolAvailable } from './tool-availability';
import { runCommand as defaultRunCommand, type RunCommand } from './run-command';
import type { ConversionResult } from './types';

const SEVENZIP_INSTALL_HINT = 'apt install p7zip-full / brew install sevenzip';

/**
 * Filenames considered system metadata — irrelevant to any caller and
 * filtered from the extracted output list. Matched on basename only.
 */
const SYSTEM_METADATA_BASENAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

/** Top-level path components considered system metadata (e.g. macOS resource forks). */
const SYSTEM_METADATA_DIRS = new Set(['__MACOSX']);

export interface ExtractArchiveInput {
  inputPath: string;
  outputDir: string;
}

export interface ExtractArchiveOptions {
  runCommand?: RunCommand;
}

export async function extractArchive(
  input: ExtractArchiveInput,
  opts?: ExtractArchiveOptions,
): Promise<ConversionResult> {
  const runCmd = opts?.runCommand ?? defaultRunCommand;

  const tool = await pickSevenZipBinary(runCmd);
  if (!tool) {
    return {
      ok: false,
      reason: 'missing-tool',
      toolName: '7z',
      installHint: SEVENZIP_INSTALL_HINT,
      details: 'Neither `7z` nor `7za` is on PATH',
    };
  }

  await mkdir(input.outputDir, { recursive: true });

  // 7z extract: -y answers yes to overwrite prompts; -o<dir> sets output.
  // Note the -o flag has NO space before the path (7z quirk).
  const extractResult = await runCmd(
    tool,
    ['x', '-y', `-o${input.outputDir}`, input.inputPath],
    { timeout: 5 * 60_000 },
  );

  if (extractResult.code !== 0) {
    return {
      ok: false,
      reason: 'tool-failed',
      details: extractResult.stderr || extractResult.stdout || `${tool} exited ${extractResult.code}`,
    };
  }

  const allFiles = await walkFiles(input.outputDir);
  const usable = allFiles.filter((p) => !isSystemMetadata(input.outputDir, p));

  if (usable.length === 0) {
    return {
      ok: false,
      reason: 'archive-no-usable-content',
      details: `${allFiles.length} files extracted but all filtered out as system metadata`,
    };
  }

  return {
    ok: true,
    outputPaths: usable,
    outputFormat: 'archive-extract',
  };
}

/**
 * Find the first available 7z-family binary on PATH. Prefers `7z` over
 * `7za`. Returns `undefined` when neither is present.
 *
 * Exported for tests that want to probe the resolution logic in isolation.
 */
export async function pickSevenZipBinary(
  runCmd: RunCommand,
): Promise<string | undefined> {
  if (await isToolAvailable('7z', runCmd)) return '7z';
  if (await isToolAvailable('7za', runCmd)) return '7za';
  return undefined;
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, out);
  return out;
}

async function walk(dir: string, acc: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      await walk(full, acc);
    } else if (s.isFile()) {
      acc.push(full);
    }
  }
}

function isSystemMetadata(root: string, fullPath: string): boolean {
  const basename = path.basename(fullPath);
  if (SYSTEM_METADATA_BASENAMES.has(basename)) return true;
  // Detect any path-component that is a metadata dir (e.g. __MACOSX/foo).
  const rel = path.relative(root, fullPath);
  for (const part of rel.split(path.sep)) {
    if (SYSTEM_METADATA_DIRS.has(part)) return true;
  }
  return false;
}
