#!/usr/bin/env -S npx tsx
/**
 * Seed validation CLI — V2-007b T_B5c.
 *
 * Reads seed JSON files from `apps/server/seed/filaments/` and
 * `apps/server/seed/resins/` and validates them WITHOUT touching the DB.
 * Intended use: CI step on PRs that touch the seed/ tree.
 *
 * Validates:
 *   - JSON parses cleanly (with line-ish error reporting from JSON.parse).
 *   - Top-level shape matches the seed schemas (filament + resin) below.
 *   - Each `colors` entry matches `^#?[0-9A-Fa-f]{6}$`; normalised form is
 *     `#XXXXXX` uppercase. The validator reports invalid hex but does NOT
 *     rewrite the file.
 *   - Filament: `colorPattern` length-rules — solid=1, dual-tone=2,
 *     gradient=2-3, multi-section=2-4 — checked against `colors[].length`.
 *   - Subtype enum membership against FILAMENT_SUBTYPES / RESIN_SUBTYPES.
 *   - Source enum against PRODUCT_SOURCES, restricted to `community-pr` or
 *     `user` (the `system:*` prefix is reserved for live-fetched data).
 *   - Duplicate `id` detection within a file AND across files of the same
 *     kind.
 *   - In `--strict` mode, also fails on missing `sourceRef` (filament + resin)
 *     and on missing `defaultExposure` (resin).
 *
 * Outputs:
 *   - `[OK] file.json (N entries)` per clean file.
 *   - `[ERROR] file.json: <issue>` per failure (one line per issue).
 *   - Final summary line + appropriate exit code.
 *
 * Usage:
 *
 *     npx tsx src/scripts/validate-seed.ts
 *     npx tsx src/scripts/validate-seed.ts --strict
 *     npx tsx src/scripts/validate-seed.ts --filaments-only
 *     npx tsx src/scripts/validate-seed.ts --resins-only
 *     npx tsx src/scripts/validate-seed.ts --seed-root apps/server/seed
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

import {
  FILAMENT_SUBTYPES,
  RESIN_SUBTYPES,
  RESIN_MATERIAL_CLASSES,
} from '../db/schema.materials';

// ---------------------------------------------------------------------------
// Allowed values for the SEED files (NOT the DB enum).
// ---------------------------------------------------------------------------

/**
 * Source values legal in seed files. The full PRODUCT_SOURCES set includes
 * `system:*` slugs — those are reserved for live-fetched data (SpoolmanDB
 * etc.) and MUST NOT appear in committed seed JSON.
 */
const SEED_FILE_SOURCES = ['community-pr', 'user'] as const;

const COLOR_PATTERNS = [
  'solid',
  'dual-tone',
  'gradient',
  'multi-section',
] as const;

const HEX6_RE = /^#?[0-9A-Fa-f]{6}$/;

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/**
 * A hex literal that the file format permits (with or without `#`, any case).
 * The validator only checks shape; canonicalisation to `#XXXXXX` is the
 * import-time transform's job.
 */
const HexSchema = z.string().regex(HEX6_RE, 'must match /^#?[0-9A-Fa-f]{6}$/');

const FilamentSubtypeSchema = z.enum(FILAMENT_SUBTYPES);
const ResinSubtypeSchema = z.enum(RESIN_SUBTYPES);
const ResinMaterialClassSchema = z.enum(RESIN_MATERIAL_CLASSES);
const ColorPatternSchema = z.enum(COLOR_PATTERNS);
const SeedSourceSchema = z.enum(SEED_FILE_SOURCES);

const FilamentSeedProductSchema = z.object({
  id: z.string().min(1).optional(),
  productLine: z.string().optional(),
  subtype: FilamentSubtypeSchema,
  colors: z.array(HexSchema).min(1).max(4),
  colorPattern: ColorPatternSchema,
  colorName: z.string().optional(),
  defaultTemps: z
    .object({
      nozzle_min: z.number().optional(),
      nozzle_max: z.number().optional(),
      bed: z.number().optional(),
      chamber: z.number().optional(),
    })
    .passthrough()
    .optional(),
  diameterMm: z.number().optional(),
  density: z.number().optional(),
  spoolWeightG: z.number().optional(),
  emptySpoolWeightG: z.number().optional(),
  finish: z.string().optional(),
  pattern: z.string().optional(),
  isGlow: z.boolean().optional(),
  isTranslucent: z.boolean().optional(),
  retailUrl: z.string().optional(),
  sourceRef: z.string().optional(),
  source: SeedSourceSchema.optional(),
});

export const FilamentSeedFileSchema = z.object({
  brand: z.string().min(1),
  license_note: z.string().optional(),
  products: z.array(FilamentSeedProductSchema),
});

const ResinSeedProductSchema = z.object({
  id: z.string().min(1).optional(),
  productLine: z.string().optional(),
  subtype: ResinSubtypeSchema,
  colors: z.array(HexSchema).min(1).max(4).nullable().optional(),
  colorName: z.string().optional(),
  defaultExposure: z
    .object({
      layer_height_mm: z.number().optional(),
      exposure_seconds: z.number().optional(),
      bottom_layers: z.number().optional(),
      bottom_exposure_seconds: z.number().optional(),
      lift_speed_mm_min: z.number().optional(),
    })
    .passthrough()
    .optional(),
  densityGMl: z.number().optional(),
  viscosityCps: z.number().optional(),
  bottleVolumeMl: z.number().optional(),
  compatibility: z
    .object({
      wavelength_nm: z.number().optional(),
      printer_compat: z.array(z.string()).optional(),
    })
    .passthrough()
    .optional(),
  materialClass: ResinMaterialClassSchema.optional(),
  retailUrl: z.string().optional(),
  sourceRef: z.string().optional(),
  source: SeedSourceSchema.optional(),
});

export const ResinSeedFileSchema = z.object({
  brand: z.string().min(1),
  license_note: z.string().optional(),
  products: z.array(ResinSeedProductSchema),
});

export type FilamentSeedFile = z.infer<typeof FilamentSeedFileSchema>;
export type ResinSeedFile = z.infer<typeof ResinSeedFileSchema>;

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  seedRoot: string;
  strict: boolean;
  filamentsOnly: boolean;
  resinsOnly: boolean;
}

function defaultSeedRoot(): string {
  const cwd = process.cwd();
  if (cwd.endsWith(`${path.sep}apps${path.sep}server`) || cwd.endsWith('/apps/server')) {
    return path.join(cwd, 'seed');
  }
  const candidate = path.join(cwd, 'apps', 'server', 'seed');
  if (fs.existsSync(candidate)) return candidate;
  return path.join(cwd, 'seed');
}

export function parseArgs(argv: string[]): ValidateOptions {
  const opts: ValidateOptions = {
    seedRoot: defaultSeedRoot(),
    strict: false,
    filamentsOnly: false,
    resinsOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    switch (arg) {
      case '--seed-root':
        if (!next) throw new Error('--seed-root requires a value');
        opts.seedRoot = path.resolve(next);
        i++;
        break;
      case '--strict':
        opts.strict = true;
        break;
      case '--filaments-only':
        opts.filamentsOnly = true;
        break;
      case '--resins-only':
        opts.resinsOnly = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (opts.filamentsOnly && opts.resinsOnly) {
    throw new Error('--filaments-only and --resins-only are mutually exclusive');
  }
  return opts;
}

function printHelp(): void {
  // eslint-disable-next-line no-console -- CLI help text.
  console.log(`Seed file validator (V2-007b T_B5c)

Options:
  --seed-root <path>   Root containing filaments/ and resins/ subdirs
                       (default: apps/server/seed/).
  --strict             Fail on missing sourceRef + missing defaultExposure (resin).
  --filaments-only     Only validate seed/filaments/.
  --resins-only        Only validate seed/resins/.
  -h, --help           Print this help.
`);
}

// ---------------------------------------------------------------------------
// Per-file validation
// ---------------------------------------------------------------------------

export interface FileReport {
  filePath: string;
  fileName: string;
  ok: boolean;
  entryCount: number;
  errors: string[];
  /** In strict mode these become errors; otherwise informational. */
  warnings: string[];
}

interface FileValidationContext {
  /** Used for cross-file duplicate-id detection. Keyed by id → filePath. */
  seenIds: Map<string, string>;
  strict: boolean;
}

/**
 * Validate a single seed file. Reads, JSON-parses, schema-validates, then
 * runs the cross-cutting checks. Pure relative to disk: returns a report
 * instead of mutating state.
 */
export function validateSeedFile(
  filePath: string,
  kind: 'filament' | 'resin',
  ctx: FileValidationContext,
): FileReport {
  const fileName = path.basename(filePath);
  const report: FileReport = {
    filePath,
    fileName,
    ok: true,
    entryCount: 0,
    errors: [],
    warnings: [],
  };

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    report.ok = false;
    report.errors.push(`failed to read file: ${err instanceof Error ? err.message : String(err)}`);
    return report;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    report.ok = false;
    // JSON.parse messages on V8 include line/col; surface verbatim.
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(`malformed JSON: ${msg}`);
    return report;
  }

  // Schema-validate the top-level shape.
  const schema = kind === 'filament' ? FilamentSeedFileSchema : ResinSeedFileSchema;
  const result = schema.safeParse(parsed);
  if (!result.success) {
    report.ok = false;
    for (const issue of result.error.issues) {
      const at = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      report.errors.push(`${at}: ${issue.message}`);
    }
    return report;
  }

  const file = result.data;
  report.entryCount = file.products.length;

  // Cross-cutting checks per product.
  const seenIdsInFile = new Set<string>();
  for (let i = 0; i < file.products.length; i++) {
    const p = file.products[i]!;
    const productLabel = `products[${i}]${'productLine' in p && p.productLine ? ` (${p.productLine})` : ''}`;

    // Filament-specific colors length vs colorPattern check.
    if (kind === 'filament') {
      const fp = p as z.infer<typeof FilamentSeedProductSchema>;
      const colorCount = fp.colors.length;
      const expected = expectedColorCountFor(fp.colorPattern);
      if (!expected.includes(colorCount)) {
        report.ok = false;
        report.errors.push(
          `${productLabel}: colorPattern '${fp.colorPattern}' requires colors length in [${expected.join(',')}], got ${colorCount}`,
        );
      }
    }

    // Duplicate-id within file + across files of the same kind.
    if (typeof p.id === 'string' && p.id.length > 0) {
      if (seenIdsInFile.has(p.id)) {
        report.ok = false;
        report.errors.push(`${productLabel}: duplicate id within file: '${p.id}'`);
      } else {
        seenIdsInFile.add(p.id);
        const seenElsewhere = ctx.seenIds.get(p.id);
        if (seenElsewhere && seenElsewhere !== filePath) {
          report.ok = false;
          report.errors.push(
            `${productLabel}: duplicate id '${p.id}' also seen in ${path.basename(seenElsewhere)}`,
          );
        } else {
          ctx.seenIds.set(p.id, filePath);
        }
      }
    }

    // Missing-sourceRef warning (errors in strict).
    if (typeof p.sourceRef !== 'string' || p.sourceRef.length === 0) {
      const msg = `${productLabel}: missing sourceRef`;
      if (ctx.strict) {
        report.ok = false;
        report.errors.push(msg);
      } else {
        report.warnings.push(msg);
      }
    }

    // Resin-specific strict warning: defaultExposure recommended.
    if (kind === 'resin') {
      const rp = p as z.infer<typeof ResinSeedProductSchema>;
      if (rp.defaultExposure === undefined) {
        const msg = `${productLabel}: missing defaultExposure`;
        if (ctx.strict) {
          report.ok = false;
          report.errors.push(msg);
        } else {
          report.warnings.push(msg);
        }
      }
    }
  }

  return report;
}

function expectedColorCountFor(pattern: (typeof COLOR_PATTERNS)[number]): number[] {
  switch (pattern) {
    case 'solid':
      return [1];
    case 'dual-tone':
      return [2];
    case 'gradient':
      return [2, 3];
    case 'multi-section':
      return [2, 3, 4];
  }
}

// ---------------------------------------------------------------------------
// Directory walking
// ---------------------------------------------------------------------------

function listSeedFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .filter((name) => !name.startsWith('_'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(dir, name));
}

// ---------------------------------------------------------------------------
// Public entry — runs validation, returns aggregate report.
// ---------------------------------------------------------------------------

export interface ValidateRunResult {
  reports: FileReport[];
  totalErrors: number;
  totalWarnings: number;
  okFiles: number;
  errorFiles: number;
}

export function runValidate(opts: ValidateOptions): ValidateRunResult {
  const reports: FileReport[] = [];

  const filamentDir = path.join(opts.seedRoot, 'filaments');
  const resinDir = path.join(opts.seedRoot, 'resins');

  // Each kind keeps its own seenIds map (cross-kind id collisions are
  // technically possible but the slug pattern keeps them disjoint by
  // construction, so we don't penalise it here).
  const filamentCtx: FileValidationContext = {
    seenIds: new Map(),
    strict: opts.strict,
  };
  const resinCtx: FileValidationContext = {
    seenIds: new Map(),
    strict: opts.strict,
  };

  if (!opts.resinsOnly) {
    for (const filePath of listSeedFiles(filamentDir)) {
      reports.push(validateSeedFile(filePath, 'filament', filamentCtx));
    }
  }
  if (!opts.filamentsOnly) {
    for (const filePath of listSeedFiles(resinDir)) {
      reports.push(validateSeedFile(filePath, 'resin', resinCtx));
    }
  }

  let totalErrors = 0;
  let totalWarnings = 0;
  let okFiles = 0;
  let errorFiles = 0;
  for (const r of reports) {
    totalErrors += r.errors.length;
    totalWarnings += r.warnings.length;
    if (r.ok) okFiles++;
    else errorFiles++;
  }
  return { reports, totalErrors, totalWarnings, okFiles, errorFiles };
}

// ---------------------------------------------------------------------------
// CLI rendering
// ---------------------------------------------------------------------------

export function formatReport(report: FileReport, strict: boolean): string {
  if (report.ok && (!strict || report.warnings.length === 0)) {
    const warnSuffix =
      !strict && report.warnings.length > 0
        ? ` (${report.warnings.length} warning${report.warnings.length === 1 ? '' : 's'})`
        : '';
    return `[OK] ${report.fileName} (${report.entryCount} entries)${warnSuffix}`;
  }
  const lines: string[] = [`[ERROR] ${report.fileName}:`];
  for (const e of report.errors) lines.push(`  - ${e}`);
  if (strict) {
    for (const w of report.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

function main(): void {
  let opts: ValidateOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console -- CLI top-level
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
    return;
  }
  const out = runValidate(opts);
  for (const r of out.reports) {
    // eslint-disable-next-line no-console -- CLI report output
    console.log(formatReport(r, opts.strict));
  }
  // eslint-disable-next-line no-console -- CLI summary
  console.log(
    `\nValidated ${out.reports.length} file(s): ${out.okFiles} ok, ${out.errorFiles} with errors, ${out.totalWarnings} warning(s)`,
  );
  if (out.errorFiles > 0) {
    process.exit(1);
  }
}

const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /validate-seed\.[cm]?[jt]s$/.test(process.argv[1]);

if (isDirectRun) {
  main();
}
