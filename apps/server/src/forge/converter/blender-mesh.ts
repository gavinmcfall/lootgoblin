/**
 * blender-mesh.ts — V2-005b T_b3
 *
 * Blender CLI mesh converter. Replaces the T_b1 stub. Shells out to the
 * `blender` binary in headless mode, running a Python helper that imports
 * the input file, clears the scene, and exports to the target format.
 *
 * Supported pairs (`SUPPORTED_BLENDER_PAIRS`):
 *   stl → 3mf, 3mf → stl, obj → stl, fbx → stl, glb → stl
 *
 * Architecture:
 *   - Tool availability is probed via the shared `isToolAvailable` cache.
 *     Missing → `missing-tool` with platform-specific install hint.
 *   - `FORGE_DISABLE_MESH_CONVERSION=1` short-circuits to
 *     `disabled-by-config` without invoking Blender.
 *   - The Python helper script ships in `./blender-scripts/`. We resolve
 *     it via the same multi-candidate strategy used by `resolveMigrationsFolder`
 *     in `db/client.ts`, so it works under `npx vitest`, `next dev`, AND
 *     the Next.js standalone build (where Webpack does not bundle .py files).
 *   - Blender is invoked as:
 *       blender --background --python-exit-code 1 --python <script> -- \
 *         <input> <output> <input-format> <output-format>
 *     The `--` separator passes the user args through to the Python script
 *     via `sys.argv` (Blender's convention).
 *   - 5-minute default timeout absorbs Blender startup (~3-5s) plus large
 *     mesh conversions (under 1-3s typical, but worst-case multi-MB STL).
 *
 * Mesh formats this backend recognizes (T_b1's `MESH_FORMATS` is a
 * superset including `gltf`/`ply`/`step`/`amf` so the framework still
 * routes them here, but `convertMeshViaBlender` returns
 * `unsupported-pair` for anything outside `SUPPORTED_BLENDER_PAIRS`).
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { isToolAvailable } from './tool-availability';
import { runCommand as defaultRunCommand, type RunCommand } from './run-command';
import type { ConversionResult } from './types';

const PYTHON_SCRIPT_NAME = 'mesh-import-export.py';
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const BLENDER_INSTALL_HINT_BY_PLATFORM: Record<string, string> = {
  linux: 'apt install blender / download from https://www.blender.org/download/',
  darwin: 'brew install --cask blender / download from https://www.blender.org/download/',
  win32: 'winget install BlenderFoundation.Blender / download from https://www.blender.org/download/',
};

function blenderInstallHint(): string {
  return (
    BLENDER_INSTALL_HINT_BY_PLATFORM[process.platform] ??
    'Install Blender from https://www.blender.org/download/'
  );
}

/**
 * Mesh formats this backend recognizes for routing. T_b1 declared a
 * superset (`MESH_FORMATS`) so the framework dispatches mesh-ish pairs
 * here even when we can't actually convert them — we surface
 * `unsupported-pair` rather than silently routing back to "no converter".
 */
export const MESH_FORMATS: ReadonlySet<string> = new Set([
  'stl',
  '3mf',
  'obj',
  'fbx',
  'glb',
  'gltf',
  'ply',
  'step',
  'stp',
  'amf',
]);

export function isMeshFormat(format: string): boolean {
  return MESH_FORMATS.has(format);
}

/** Conversion pairs the Blender helper script can actually do. */
export const SUPPORTED_BLENDER_PAIRS: ReadonlySet<string> = new Set([
  'stl→3mf',
  '3mf→stl',
  'obj→stl',
  'fbx→stl',
  'glb→stl',
]);

export interface ConvertMeshInput {
  inputPath: string;
  inputFormat: string;
  outputFormat: string;
  outputDir: string;
}

export interface ConvertMeshOptions {
  runCommand?: RunCommand;
  /** Default 5 minutes. Override in tests for fast-fail timeout assertions. */
  timeoutMs?: number;
  /** Override the Python script path for tests. */
  scriptPath?: string;
}

/**
 * Convert a mesh file via the Blender CLI. Returns a `ConversionResult`
 * describing success (with `outputPaths: [<single output file>]`) or a
 * structured failure (`disabled-by-config`, `missing-tool`,
 * `unsupported-pair`, `tool-failed`).
 *
 * Caller owns the output file's lifecycle — we never delete on failure
 * either (consistent with sevenzip-archives.ts).
 */
export async function convertMeshViaBlender(
  input: ConvertMeshInput,
  opts?: ConvertMeshOptions,
): Promise<ConversionResult> {
  // Honor the kill-switch first — operators set this when they don't want
  // Blender invoked even though the binary is on PATH.
  if (process.env.FORGE_DISABLE_MESH_CONVERSION === '1') {
    return {
      ok: false,
      reason: 'disabled-by-config',
      details: 'Mesh conversion disabled via FORGE_DISABLE_MESH_CONVERSION=1',
    };
  }

  const inputFormat = input.inputFormat.toLowerCase();
  const outputFormat = input.outputFormat.toLowerCase();
  const pair = `${inputFormat}→${outputFormat}`; // → U+2192
  if (!SUPPORTED_BLENDER_PAIRS.has(pair)) {
    return {
      ok: false,
      reason: 'unsupported-pair',
      details: `Blender backend does not support '${inputFormat}' → '${outputFormat}'`,
    };
  }

  const runCmd = opts?.runCommand ?? defaultRunCommand;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!(await isToolAvailable('blender', runCmd))) {
    return {
      ok: false,
      reason: 'missing-tool',
      toolName: 'blender',
      installHint: blenderInstallHint(),
      details: '`blender` is not on PATH',
    };
  }

  const scriptPath = opts?.scriptPath ?? resolvePythonScriptPath();
  if (!scriptPath) {
    return {
      ok: false,
      reason: 'tool-failed',
      details:
        `Could not locate ${PYTHON_SCRIPT_NAME}. Set FORGE_DISABLE_MESH_CONVERSION=1 to skip Blender, ` +
        'or report this as a packaging bug.',
    };
  }

  // Output filename: <input-basename>-<8-hex>.<ext> to avoid collisions
  // when multiple jobs share an outputDir. Mirrors the discipline the
  // 7z and image backends apply.
  const inputBase = path.basename(input.inputPath, path.extname(input.inputPath));
  const suffix = randomBytes(4).toString('hex');
  const outputPath = path.join(
    input.outputDir,
    `${inputBase}-${suffix}.${outputFormat}`,
  );

  const args = [
    '--background',
    '--python-exit-code',
    '1',
    '--python',
    scriptPath,
    '--',
    input.inputPath,
    outputPath,
    inputFormat,
    outputFormat,
  ];

  let result;
  try {
    result = await runCmd('blender', args, { timeout: timeoutMs });
  } catch (err) {
    // Production runCommand never throws, but tests sometimes inject a
    // throwing stub (e.g. to simulate a timeout before the runner can
    // resolve). Surface as `tool-failed` with the message in details.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: 'tool-failed',
      details: `blender invocation threw: ${msg}`,
    };
  }

  if (result.code !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `blender exited ${result.code}`;
    return {
      ok: false,
      reason: 'tool-failed',
      details: detail,
    };
  }

  return {
    ok: true,
    outputPaths: [outputPath],
    outputFormat,
  };
}

/**
 * Locate `mesh-import-export.py` at runtime. We use a multi-candidate
 * strategy mirroring `resolveMigrationsFolder` in `src/db/client.ts`:
 *
 *   1. `import.meta.url` — works under `next dev`, `vitest`, and any
 *      ESM-aware runtime that doesn't strip the source tree.
 *   2. `process.cwd()` candidates — covers the `npm run dev` and CI cases.
 *   3. `apps/server/src/...` candidate — covers running from the repo root.
 *
 * The Dockerfile ships the script at
 * `/app/apps/server/src/forge/converter/blender-scripts/mesh-import-export.py`
 * via an explicit COPY (sibling to the migrations COPY), so the cwd
 * candidate `apps/server/src/...` resolves correctly there.
 *
 * Returns `undefined` when no candidate exists — caller surfaces the
 * structured failure.
 */
function resolvePythonScriptPath(): string | undefined {
  const candidates: Array<string | undefined> = [
    (() => {
      try {
        // Build the relative path dynamically so webpack's static analyser
        // can't try to resolve it as a module at bundle time. Same trick
        // db/client.ts uses for migrations.
        const rel = './blender-scrip' + 'ts/' + PYTHON_SCRIPT_NAME;
        return fileURLToPath(/* webpackIgnore: true */ new URL(rel, import.meta.url));
      } catch {
        return undefined;
      }
    })(),
    path.resolve(
      process.cwd(),
      'src/forge/converter/blender-scripts',
      PYTHON_SCRIPT_NAME,
    ),
    path.resolve(
      process.cwd(),
      'apps/server/src/forge/converter/blender-scripts',
      PYTHON_SCRIPT_NAME,
    ),
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}
