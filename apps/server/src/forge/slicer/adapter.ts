/**
 * adapter.ts — V2-005c T_c8
 *
 * Prusa-fork shared SlicerAdapter. PrusaSlicer, OrcaSlicer, and Bambu Studio
 * all descend from PrusaSlicer's CLI lineage and accept the same
 * `--slice <input> --load <config> --output <dir>` invocation, so a single
 * adapter covers all three. If a future fork diverges (e.g. Bambu Studio
 * 02+ requiring `--export-gcode` instead of `--slice`), refine here per
 * `slicerKind` rather than fanning out to per-fork modules.
 *
 * The adapter is pure I/O routing:
 *   1. Honor FORGE_DISABLE_SLICING=1 kill-switch.
 *   2. Resolve the install row via getInstall(); fail fast if not 'ready'.
 *   3. Verify the binary file exists on disk (catches "user manually
 *      deleted ~/.lootgoblin/slicers/" between install and slice).
 *   4. Invoke the slicer with a 10-minute cap.
 *   5. Locate the produced gcode/bgcode in outputDir, hash it, parse
 *      best-effort metadata from stdout, return SliceResult.
 *
 * RunCommand is injected per-call (not constructor-bound) so the worker
 * can pass execFileRunCommand in production and unit tests can pass a
 * stub. Same DI pattern as blender-mesh.ts.
 */

import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import type { ForgeSlicerKindInstallable } from '@/db/schema.forge';
import { logger } from '@/logger';

import { getInstall } from './registry';
import type { RunCommand } from '../converter/run-command';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Output filename suffixes the slicers produce. `.bgcode` is Prusa's
 *  binary G-code; `.gcode` is plaintext. Bambu/Orca emit `.gcode`. */
const GCODE_EXTENSIONS = new Set(['.gcode', '.bgcode']);

export type SliceResult =
  | {
      kind: 'success';
      gcodePath: string;
      sizeBytes: number;
      sha256: string;
      metadata: {
        estimatedPrintTimeSeconds?: number;
        filamentUsedGrams?: number;
        layers?: number;
        /** Last 2KB of stdout for debugging post-mortems. */
        rawReport?: string;
      };
    }
  | {
      kind: 'failure';
      reason:
        | 'not-installed'
        | 'disabled-by-config'
        | 'binary-missing'
        | 'slicer-error'
        | 'no-output';
      details?: string;
    };

export interface SlicerAdapter {
  slice(opts: {
    inputPath: string;
    outputDir: string;
    configPath: string;
    run: RunCommand;
  }): Promise<SliceResult>;
}

export interface CreateSlicerAdapterOpts {
  slicerKind: ForgeSlicerKindInstallable;
  /** Pass-through for getInstall lookup in tests. */
  dbUrl?: string;
}

export function createSlicerAdapter(adapterOpts: CreateSlicerAdapterOpts): SlicerAdapter {
  const { slicerKind, dbUrl } = adapterOpts;

  return {
    async slice(opts): Promise<SliceResult> {
      // 1. Kill-switch first — operators set this when they don't want a
      //    slicer invoked even if a binary is on disk.
      if (process.env.FORGE_DISABLE_SLICING === '1') {
        return {
          kind: 'failure',
          reason: 'disabled-by-config',
          details: 'Slicing disabled via FORGE_DISABLE_SLICING=1',
        };
      }

      // 2. Resolve install record. No row, wrong status, or null binary
      //    path all map to 'not-installed' — caller doesn't need to
      //    distinguish "never installed" from "install failed mid-flight".
      const install = getInstall({ slicerKind, dbUrl });
      if (!install || install.installStatus !== 'ready' || !install.binaryPath) {
        return {
          kind: 'failure',
          reason: 'not-installed',
          details: install
            ? `install row exists with status='${install.installStatus}'`
            : `no install row for ${slicerKind}`,
        };
      }

      // 3. Verify binary still exists on disk. The DB can lag reality if
      //    the user manually rm'd ~/.lootgoblin/slicers/ — surface a
      //    distinct reason so the UI can prompt re-install.
      try {
        await fsp.access(install.binaryPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          kind: 'failure',
          reason: 'binary-missing',
          details: msg,
        };
      }

      // 4. Build CLI args. PrusaSlicer / OrcaSlicer / Bambu Studio all
      //    accept the same trio. TODO(T_c8+): if a future Bambu/Orca
      //    version requires `--export-gcode` instead of `--slice`, branch
      //    on slicerKind here.
      const args = [
        '--slice',
        opts.inputPath,
        '--load',
        opts.configPath,
        '--output',
        opts.outputDir,
      ];

      let result;
      try {
        result = await opts.run(install.binaryPath, args, {
          timeout: DEFAULT_TIMEOUT_MS,
        });
      } catch (err) {
        // Production runCommand never throws, but tests may inject a
        // throwing stub. Surface as slicer-error with the message.
        const msg = err instanceof Error ? err.message : String(err);
        return {
          kind: 'failure',
          reason: 'slicer-error',
          details: `slicer invocation threw: ${msg}`,
        };
      }

      // 5. Non-zero exit → slicer-error with stderr last 2KB.
      if (result.code !== 0) {
        return {
          kind: 'failure',
          reason: 'slicer-error',
          details: lastBytes(result.stderr || result.stdout, 2048),
        };
      }

      // 6. Find the freshest .gcode/.bgcode in outputDir.
      const gcodePath = await findNewestGcode(opts.outputDir);
      if (!gcodePath) {
        return {
          kind: 'failure',
          reason: 'no-output',
          details: lastBytes(result.stdout, 1024),
        };
      }

      // 7. Hash + size.
      const sizeBytes = (await fsp.stat(gcodePath)).size;
      const sha256 = await sha256File(gcodePath);

      // 8. Best-effort metadata parse.
      const metadata = parseMetadata(result.stdout);

      logger.debug(
        {
          slicerKind,
          binaryPath: install.binaryPath,
          gcodePath,
          sizeBytes,
        },
        'forge.slicer.adapter: slice success',
      );

      return {
        kind: 'success',
        gcodePath,
        sizeBytes,
        sha256,
        metadata,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lastBytes(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(s.length - n);
}

async function findNewestGcode(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null;
  }

  const candidates: Array<{ p: string; mtimeMs: number }> = [];
  for (const name of entries) {
    const ext = path.extname(name).toLowerCase();
    if (!GCODE_EXTENSIONS.has(ext)) continue;
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (st.isFile()) {
        candidates.push({ p: full, mtimeMs: st.mtimeMs });
      }
    } catch {
      // skip unreadable entries
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.p ?? null;
}

async function sha256File(filePath: string): Promise<string> {
  const buf = await fsp.readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Best-effort parse of slicer stdout for telemetry. All fields optional —
 * if the regex misses (different fork, different version, future format
 * shift) we just leave them undefined rather than failing the slice.
 *
 * Recognised patterns:
 *   ;estimated printing time = 1d 2h 30m 45s  (Prusa lineage; also `(normal mode)` suffix)
 *   ;estimated printing time = 12345s
 *   ;filament used [g] = 12.34
 *   ;num_layers = 123
 */
export function parseMetadata(stdout: string): {
  estimatedPrintTimeSeconds?: number;
  filamentUsedGrams?: number;
  layers?: number;
  rawReport?: string;
} {
  const out: {
    estimatedPrintTimeSeconds?: number;
    filamentUsedGrams?: number;
    layers?: number;
    rawReport?: string;
  } = {};

  // Print time. Match `;estimated printing time` — the suffix may be
  // ` (normal mode)`, ` =`, etc; capture everything after the first `=`.
  const timeMatch = stdout.match(/;\s*estimated printing time[^=]*=\s*([^\n\r]+)/i);
  const timeRaw = timeMatch?.[1];
  if (timeRaw) {
    const seconds = parseDurationToSeconds(timeRaw.trim());
    if (seconds !== null) {
      out.estimatedPrintTimeSeconds = seconds;
    }
  }

  // Filament used in grams.
  const filMatch = stdout.match(/;\s*filament used \[g\]\s*=\s*([0-9]+(?:\.[0-9]+)?)/i);
  const filRaw = filMatch?.[1];
  if (filRaw) {
    const v = Number.parseFloat(filRaw);
    if (Number.isFinite(v)) out.filamentUsedGrams = v;
  }

  // Layer count.
  const layerMatch = stdout.match(/;\s*num_layers\s*=\s*([0-9]+)/i);
  const layerRaw = layerMatch?.[1];
  if (layerRaw) {
    const v = Number.parseInt(layerRaw, 10);
    if (Number.isFinite(v)) out.layers = v;
  }

  out.rawReport = lastBytes(stdout, 2048);
  return out;
}

/**
 * Parse durations like `1d 2h 30m 45s`, `2h 30m`, `12345s`, or pure
 * `12345` into total seconds. Returns null if nothing matched.
 */
function parseDurationToSeconds(s: string): number | null {
  const trimmed = s.trim();
  // Pure-number form (assume seconds).
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(trimmed)) {
    const v = Number.parseFloat(trimmed);
    return Number.isFinite(v) ? Math.round(v) : null;
  }

  let total = 0;
  let matched = false;
  const re = /([0-9]+(?:\.[0-9]+)?)\s*([dhms])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    const numStr = m[1];
    const unit = m[2];
    if (!numStr || !unit) continue;
    const v = Number.parseFloat(numStr);
    if (!Number.isFinite(v)) continue;
    matched = true;
    switch (unit.toLowerCase()) {
      case 'd':
        total += v * 86400;
        break;
      case 'h':
        total += v * 3600;
        break;
      case 'm':
        total += v * 60;
        break;
      case 's':
        total += v;
        break;
    }
  }
  return matched ? Math.round(total) : null;
}
