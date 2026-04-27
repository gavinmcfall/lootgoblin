#!/usr/bin/env -S npx tsx
/**
 * SpoolmanDB filament seed importer — V2-007b T_B5a.
 *
 * Pulls the per-brand JSON files from a pinned Donkie/SpoolmanDB commit and
 * inserts (or updates) `filament_products` rows with `source='system:spoolmandb'`,
 * `owner_id=NULL`. Idempotent on re-run.
 *
 * Usage:
 *
 *     cd apps/server
 *     npx tsx src/scripts/import-spoolmandb.ts --ref <commit-sha>
 *     npx tsx src/scripts/import-spoolmandb.ts --ref <sha> --dry-run
 *     npx tsx src/scripts/import-spoolmandb.ts --ref <sha> --update
 *     npx tsx src/scripts/import-spoolmandb.ts --ref <sha> --brand Bambu
 *     npx tsx src/scripts/import-spoolmandb.ts --ref <sha> --limit 3
 *
 * Default `--ref` is `main` (with a warning that pinning is recommended for
 * reproducibility). `--update` switches conflict-resolution from skip to
 * UPDATE-on-conflict. `--dry-run` reports counts but doesn't write to the DB.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { logger } from '../logger';
import {
  createFilamentProduct,
  updateFilamentProduct,
  type CreateFilamentProductInput,
} from '../materials/catalog';
import {
  fetchSpoolmanDbBrandManifest,
  fetchSpoolmanDbBrandFile,
} from './_spoolmandb-fetch';
import {
  transformSpoolmanDbFilament,
  type SpoolmanDbBrandFile,
  type SpoolmanDbFilament,
} from './_spoolmandb-transform';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

export interface ImportOptions {
  ref: string;
  dryRun: boolean;
  update: boolean;
  /** Filter to one specific brand filename stem (case-insensitive). */
  brand: string | null;
  /** Cap brand count for testing. */
  limit: number | null;
  /** Override actor user id (default `'system-importer'`). Used in tests. */
  actorUserId: string;
  /** Skip writing THIRD_PARTY_LICENSES.md (used in dry-run + tests). */
  skipLicenseWrite: boolean;
  /** Override DB url (used in tests). */
  dbUrl?: string;
  /** Override repo root used to locate THIRD_PARTY_LICENSES.md. */
  repoRoot?: string;
}

export function parseArgs(argv: string[]): ImportOptions {
  const opts: ImportOptions = {
    ref: 'main',
    dryRun: false,
    update: false,
    brand: null,
    limit: null,
    actorUserId: 'system-importer',
    skipLicenseWrite: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    switch (arg) {
      case '--ref':
        if (!next) throw new Error('--ref requires a value');
        opts.ref = next;
        i++;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--update':
        opts.update = true;
        break;
      case '--brand':
        if (!next) throw new Error('--brand requires a value');
        opts.brand = next;
        i++;
        break;
      case '--limit':
        if (!next) throw new Error('--limit requires a value');
        opts.limit = Number.parseInt(next, 10);
        if (!Number.isFinite(opts.limit) || opts.limit <= 0) {
          throw new Error(`--limit must be a positive integer, got ${next}`);
        }
        i++;
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
  return opts;
}

function printHelp(): void {
  // eslint-disable-next-line no-console -- CLI help text.
  console.log(`SpoolmanDB filament seed importer

Options:
  --ref <commit-sha>     SpoolmanDB git ref to import from (default: main).
                         Pinning to a commit SHA is strongly recommended for
                         reproducibility.
  --dry-run              Fetch + transform + report counts without writing.
  --update               Update existing rows on id-conflict (default: skip).
  --brand <name>         Filter to one brand filename stem (case-insensitive).
                         Example: --brand Bambu
  --limit <N>            Cap the number of brand files processed (testing aid).
  -h, --help             Print this help.

Environment:
  GITHUB_TOKEN           Optional. Avoids the unauthenticated rate-limit when
                         fetching the brand manifest.
  SPOOLMANDB_CACHE_DIR   Optional. Override on-disk cache root
                         (default: <cwd>/.cache/spoolmandb).
`);
}

// ---------------------------------------------------------------------------
// Stats + result types
// ---------------------------------------------------------------------------

export interface ImportStats {
  brandsProcessed: number;
  filamentsProcessed: number;
  colorVariants: number;
  inserted: number;
  updated: number;
  replayed: number;
  skipped: number;
  errors: number;
}

function emptyStats(): ImportStats {
  return {
    brandsProcessed: 0,
    filamentsProcessed: 0,
    colorVariants: 0,
    inserted: 0,
    updated: 0,
    replayed: 0,
    skipped: 0,
    errors: 0,
  };
}

// ---------------------------------------------------------------------------
// THIRD_PARTY_LICENSES.md writer
// ---------------------------------------------------------------------------

const SPOOLMANDB_BLOCK_START = '<!-- BEGIN spoolmandb -->';
const SPOOLMANDB_BLOCK_END = '<!-- END spoolmandb -->';

export function buildSpoolmanDbLicenseBlock(commitSha: string, isoDate: string): string {
  return `${SPOOLMANDB_BLOCK_START}
## SpoolmanDB
- **License**: MIT
- **Source**: https://github.com/Donkie/SpoolmanDB
- **Used for**: Filament product catalog seed (\`filament_products\` rows with \`source='system:spoolmandb'\`)
- **Pinned commit**: ${commitSha}
- **Last imported**: ${isoDate}
${SPOOLMANDB_BLOCK_END}`;
}

export function upsertLicenseFile(
  filePath: string,
  commitSha: string,
  isoDate: string,
): void {
  const block = buildSpoolmanDbLicenseBlock(commitSha, isoDate);
  let body: string;
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing.includes(SPOOLMANDB_BLOCK_START) && existing.includes(SPOOLMANDB_BLOCK_END)) {
      // Replace existing block in place.
      const re = new RegExp(
        `${SPOOLMANDB_BLOCK_START}[\\s\\S]*?${SPOOLMANDB_BLOCK_END}`,
        'm',
      );
      body = existing.replace(re, block);
    } else {
      body = existing.trimEnd() + '\n\n' + block + '\n';
    }
  } else {
    body =
      `# Third-Party Licenses\n\nThis file lists third-party data + code redistributed by lootgoblin.\n\n${block}\n`;
  }
  fs.writeFileSync(filePath, body);
}

// ---------------------------------------------------------------------------
// Per-brand-file → per-filament-input
// ---------------------------------------------------------------------------

function isSpoolmanDbBrandFile(x: unknown): x is SpoolmanDbBrandFile {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.manufacturer === 'string' &&
    Array.isArray(o.filaments) &&
    o.filaments.every((f) => typeof f === 'object' && f !== null)
  );
}

async function processBrand(
  brandFilename: string,
  parsed: unknown,
  opts: ImportOptions,
  stats: ImportStats,
): Promise<void> {
  if (!isSpoolmanDbBrandFile(parsed)) {
    logger.warn({ brandFilename }, 'spoolmandb-import: brand file shape invalid; skipping');
    stats.errors++;
    return;
  }

  stats.brandsProcessed++;
  const sourcePath = `filaments/${brandFilename}`;

  for (const filament of parsed.filaments as SpoolmanDbFilament[]) {
    stats.filamentsProcessed++;
    const inputs = transformSpoolmanDbFilament(
      parsed,
      filament,
      { commitSha: opts.ref, sourcePath },
      opts.actorUserId,
    );
    for (const input of inputs) {
      stats.colorVariants++;
      await applyOne(input, opts, stats);
    }
  }
}

async function applyOne(
  input: CreateFilamentProductInput,
  opts: ImportOptions,
  stats: ImportStats,
): Promise<void> {
  if (opts.dryRun) {
    // Just count it.
    stats.inserted++; // dry-run counts everything as "would-insert"
    return;
  }
  const result = await createFilamentProduct(input, { dbUrl: opts.dbUrl });
  if (result.ok) {
    if (result.replayed) {
      stats.replayed++;
    } else {
      stats.inserted++;
    }
    return;
  }
  if (result.reason === 'id-conflict') {
    if (opts.update && input.id) {
      // Switch to update with the same shape.
      const upd = await updateFilamentProduct(
        {
          id: input.id,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          patch: {
            brand: input.brand,
            productLine: input.productLine ?? null,
            subtype: input.subtype,
            colors: input.colors,
            colorPattern: input.colorPattern,
            colorName: input.colorName ?? null,
            defaultTemps: input.defaultTemps ?? null,
            diameterMm: input.diameterMm ?? null,
            density: input.density ?? null,
            spoolWeightG: input.spoolWeightG ?? null,
            emptySpoolWeightG: input.emptySpoolWeightG ?? null,
            finish: input.finish ?? null,
            pattern: input.pattern ?? null,
            isGlow: input.isGlow ?? null,
            isTranslucent: input.isTranslucent ?? null,
            sourceRef: input.sourceRef ?? null,
          },
        },
        { dbUrl: opts.dbUrl },
      );
      if (upd.ok) {
        stats.updated++;
      } else {
        logger.warn(
          { id: input.id, reason: upd.reason, details: upd.details },
          'spoolmandb-import: update failed',
        );
        stats.errors++;
      }
      return;
    }
    // Default: skip-on-conflict.
    stats.skipped++;
    return;
  }
  // Other failure.
  logger.warn(
    { id: input.id, reason: result.reason, details: result.details },
    'spoolmandb-import: create failed',
  );
  stats.errors++;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runImport(opts: ImportOptions): Promise<ImportStats> {
  if (opts.ref === 'main') {
    logger.warn(
      'spoolmandb-import: --ref defaults to "main" (mutable). Pin to a commit SHA for reproducible imports.',
    );
  }

  const stats = emptyStats();
  let manifest = await fetchSpoolmanDbBrandManifest(opts.ref);

  if (opts.brand) {
    const wantStem = opts.brand.toLowerCase();
    manifest = manifest.filter((f) => {
      const stem = f.replace(/\.json$/i, '').toLowerCase();
      return stem === wantStem;
    });
    if (manifest.length === 0) {
      logger.warn({ brand: opts.brand }, 'spoolmandb-import: no brand matched filter');
    }
  }
  if (opts.limit !== null && manifest.length > opts.limit) {
    manifest = manifest.slice(0, opts.limit);
  }

  for (const brandFilename of manifest) {
    let parsed: unknown;
    try {
      parsed = await fetchSpoolmanDbBrandFile(opts.ref, brandFilename);
    } catch (err) {
      logger.warn(
        { err, brandFilename },
        'spoolmandb-import: fetch failed for brand file',
      );
      stats.errors++;
      continue;
    }
    await processBrand(brandFilename, parsed, opts, stats);
  }

  // Update license file (only on real runs).
  if (!opts.dryRun && !opts.skipLicenseWrite) {
    const repoRoot = opts.repoRoot ?? findRepoRoot();
    const licensePath = path.join(repoRoot, 'THIRD_PARTY_LICENSES.md');
    upsertLicenseFile(licensePath, opts.ref, new Date().toISOString());
  }

  return stats;
}

/** Walk up from cwd to find the repo root (the dir containing `.git/`). */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume cwd is apps/server, repo root is two levels up.
  return path.resolve(process.cwd(), '..', '..');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function summarize(stats: ImportStats, opts: ImportOptions): string {
  const mode = opts.dryRun ? 'DRY-RUN (no DB writes)' : 'LIVE';
  return [
    `SpoolmanDB import summary [${mode}, ref=${opts.ref}]`,
    `  brands processed:    ${stats.brandsProcessed}`,
    `  filaments processed: ${stats.filamentsProcessed}`,
    `  color variants:      ${stats.colorVariants}`,
    `  inserted:            ${stats.inserted}${opts.dryRun ? ' (would-insert)' : ''}`,
    `  updated:             ${stats.updated}`,
    `  replayed (no-op):    ${stats.replayed}`,
    `  skipped (conflict):  ${stats.skipped}`,
    `  errors:              ${stats.errors}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const stats = await runImport(opts);
  // eslint-disable-next-line no-console -- CLI summary output.
  console.log(summarize(stats, opts));
  if (stats.errors > 0) {
    process.exit(1);
  }
}

// Detect direct execution (tsx / node) vs. import.
const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /import-spoolmandb\.[cm]?[jt]s$/.test(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    // eslint-disable-next-line no-console -- top-level CLI error.
    console.error(err);
    process.exit(1);
  });
}
