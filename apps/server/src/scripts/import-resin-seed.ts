#!/usr/bin/env -S npx tsx
/**
 * Resin seed importer — V2-007b T_B5b.
 *
 * Reads hand-curated brand JSON files from `apps/server/seed/resins/` and
 * inserts (or updates) `resin_products` rows with `source='community-pr'`,
 * `owner_id=NULL`. Idempotent on re-run: same id + same body replays as a
 * no-op; same id + different body returns id-conflict (skip-by-default,
 * `--update` overwrites).
 *
 * Why hand-curated rather than scraping a slicer preset library: see
 * planning/odad/research/v2-007b-catalog-seed.md Q5. The PrusaSlicer SLA
 * preset library is AGPL — bulk-ingesting it propagates AGPL reciprocity
 * to the lootgoblin network surface. Stakeholder direction (locked):
 * hand-key facts (non-copyrightable) into our own JSON, with per-record
 * `sourceRef` URLs back to the public vendor product page.
 *
 * Usage:
 *
 *     cd apps/server
 *     npx tsx src/scripts/import-resin-seed.ts
 *     npx tsx src/scripts/import-resin-seed.ts --dry-run
 *     npx tsx src/scripts/import-resin-seed.ts --update
 *     npx tsx src/scripts/import-resin-seed.ts --brand anycubic
 *     npx tsx src/scripts/import-resin-seed.ts --seed-dir <path>
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { logger } from '../logger';
import {
  createResinProduct,
  updateResinProduct,
  type CreateResinProductInput,
} from '../materials/catalog';
import { loadResinSeedFiles, type LoadedResinSeedFile } from './_resin-seed-load';
import { transformResinSeed } from './_resin-seed-transform';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /** Override seed directory (default: apps/server/seed/resins/). */
  seedDir: string;
  dryRun: boolean;
  update: boolean;
  /** Filter to one specific brand filename stem (case-insensitive). */
  brand: string | null;
  /** Override actor user id (default `'system-importer'`). Used in tests. */
  actorUserId: string;
  /** Skip writing THIRD_PARTY_LICENSES.md (used in dry-run + tests). */
  skipLicenseWrite: boolean;
  /** Override DB url (used in tests). */
  dbUrl?: string;
  /** Override repo root used to locate THIRD_PARTY_LICENSES.md. */
  repoRoot?: string;
}

const DEFAULT_SEED_DIR_REL = path.join('apps', 'server', 'seed', 'resins');

function defaultSeedDir(): string {
  // When invoked from apps/server (e.g. via `cd apps/server && npx tsx ...`)
  // we want apps/server/seed/resins. When invoked from repo root the same
  // path resolves correctly. Use an absolute resolution rooted at cwd.
  const cwd = process.cwd();
  // If cwd is apps/server, return cwd/seed/resins.
  if (cwd.endsWith(`${path.sep}apps${path.sep}server`) || cwd.endsWith('/apps/server')) {
    return path.join(cwd, 'seed', 'resins');
  }
  // Otherwise, assume cwd is repo root; resolve via relative path. If that
  // doesn't exist we fall back to the apps/server-relative form anyway.
  const repoCandidate = path.join(cwd, DEFAULT_SEED_DIR_REL);
  if (fs.existsSync(repoCandidate)) return repoCandidate;
  return path.join(cwd, 'seed', 'resins');
}

export function parseArgs(argv: string[]): ImportOptions {
  const opts: ImportOptions = {
    seedDir: defaultSeedDir(),
    dryRun: false,
    update: false,
    brand: null,
    actorUserId: 'system-importer',
    skipLicenseWrite: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    switch (arg) {
      case '--seed-dir':
        if (!next) throw new Error('--seed-dir requires a value');
        opts.seedDir = path.resolve(next);
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
  console.log(`Resin seed importer (community-pr provenance)

Options:
  --seed-dir <path>      Seed directory (default: apps/server/seed/resins/).
  --dry-run              Load + transform + report counts without writing.
  --update               Update existing rows on id-conflict (default: skip).
  --brand <name>         Filter to one brand filename stem (case-insensitive).
                         Example: --brand anycubic
  -h, --help             Print this help.
`);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface ImportStats {
  filesProcessed: number;
  productsConsidered: number;
  inserted: number;
  updated: number;
  replayed: number;
  skipped: number;
  invalidSubtype: number;
  errors: number;
}

function emptyStats(): ImportStats {
  return {
    filesProcessed: 0,
    productsConsidered: 0,
    inserted: 0,
    updated: 0,
    replayed: 0,
    skipped: 0,
    invalidSubtype: 0,
    errors: 0,
  };
}

// ---------------------------------------------------------------------------
// THIRD_PARTY_LICENSES.md writer
// ---------------------------------------------------------------------------

const RESIN_BLOCK_START = '<!-- BEGIN resin-seed -->';
const RESIN_BLOCK_END = '<!-- END resin-seed -->';

export function buildResinLicenseBlock(
  brandSources: Array<{ brand: string; sourceUrls: string[] }>,
  isoDate: string,
): string {
  const sortedBrands = [...brandSources].sort((a, b) =>
    a.brand.localeCompare(b.brand),
  );
  const brandLines: string[] = [];
  for (const { brand, sourceUrls } of sortedBrands) {
    const uniq = Array.from(new Set(sourceUrls)).sort();
    if (uniq.length === 0) {
      brandLines.push(`- ${brand}: (no public source URLs cited)`);
      continue;
    }
    if (uniq.length === 1) {
      brandLines.push(`- ${brand}: ${uniq[0]}`);
      continue;
    }
    brandLines.push(`- ${brand}:`);
    for (const u of uniq) brandLines.push(`  - ${u}`);
  }

  return `${RESIN_BLOCK_START}
## Resin product catalog

Hand-keyed from public vendor pages and product specifications. No data
redistributed from copyrighted compilations or AGPL-licensed slicer preset
libraries (see \`planning/odad/research/v2-007b-catalog-seed.md\` Q5 for
licensing analysis). Imported entries get \`source='community-pr'\` and
\`owner_id=NULL\`.

### Source pages cited per brand (last refreshed: ${isoDate})

${brandLines.join('\n')}
${RESIN_BLOCK_END}`;
}

export function upsertLicenseFile(
  filePath: string,
  brandSources: Array<{ brand: string; sourceUrls: string[] }>,
  isoDate: string,
): void {
  const block = buildResinLicenseBlock(brandSources, isoDate);
  let body: string;
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing.includes(RESIN_BLOCK_START) && existing.includes(RESIN_BLOCK_END)) {
      const re = new RegExp(
        `${RESIN_BLOCK_START}[\\s\\S]*?${RESIN_BLOCK_END}`,
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
// Per-product apply
// ---------------------------------------------------------------------------

async function applyOne(
  input: CreateResinProductInput,
  opts: ImportOptions,
  stats: ImportStats,
): Promise<void> {
  if (opts.dryRun) {
    stats.inserted++; // dry-run counts everything as "would-insert"
    return;
  }
  const result = await createResinProduct(input, { dbUrl: opts.dbUrl });
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
      const upd = await updateResinProduct(
        {
          id: input.id,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          patch: {
            brand: input.brand,
            productLine: input.productLine ?? null,
            subtype: input.subtype,
            colors: input.colors ?? null,
            colorName: input.colorName ?? null,
            defaultExposure: input.defaultExposure ?? null,
            densityGMl: input.densityGMl ?? null,
            viscosityCps: input.viscosityCps ?? null,
            bottleVolumeMl: input.bottleVolumeMl ?? null,
            compatibility: input.compatibility ?? null,
            materialClass: input.materialClass ?? null,
            retailUrl: input.retailUrl ?? null,
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
          'resin-seed-import: update failed',
        );
        stats.errors++;
      }
      return;
    }
    stats.skipped++;
    return;
  }
  logger.warn(
    { id: input.id, reason: result.reason, details: result.details },
    'resin-seed-import: create failed',
  );
  stats.errors++;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runImport(opts: ImportOptions): Promise<ImportStats> {
  const stats = emptyStats();

  let files: LoadedResinSeedFile[];
  try {
    files = await loadResinSeedFiles(opts.seedDir);
  } catch (err) {
    logger.warn(
      { seedDir: opts.seedDir, err: err instanceof Error ? err.message : String(err) },
      'resin-seed-import: failed to read seed dir',
    );
    stats.errors++;
    return stats;
  }

  if (opts.brand) {
    const want = opts.brand.toLowerCase();
    files = files.filter((f) => f.stem.toLowerCase() === want);
    if (files.length === 0) {
      logger.warn({ brand: opts.brand }, 'resin-seed-import: no brand file matched filter');
    }
  }

  // Track brand → source URLs for the license file aggregate.
  const brandSources: Array<{ brand: string; sourceUrls: string[] }> = [];

  for (const f of files) {
    stats.filesProcessed++;
    const transformed = transformResinSeed(f.file, opts.actorUserId);
    const collectedSources: string[] = [];
    for (const r of transformed) {
      stats.productsConsidered++;
      if (!r.ok) {
        if (r.reason === 'invalid-subtype') {
          stats.invalidSubtype++;
        } else {
          stats.errors++;
        }
        continue;
      }
      if (r.input.sourceRef) collectedSources.push(r.input.sourceRef);
      await applyOne(r.input, opts, stats);
    }
    if (typeof f.file?.brand === 'string' && f.file.brand.length > 0) {
      brandSources.push({ brand: f.file.brand, sourceUrls: collectedSources });
    }
  }

  if (!opts.dryRun && !opts.skipLicenseWrite && brandSources.length > 0) {
    const repoRoot = opts.repoRoot ?? findRepoRoot();
    const licensePath = path.join(repoRoot, 'THIRD_PARTY_LICENSES.md');
    upsertLicenseFile(licensePath, brandSources, new Date().toISOString());
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
    `Resin seed import summary [${mode}, seedDir=${opts.seedDir}]`,
    `  brand files processed: ${stats.filesProcessed}`,
    `  products considered:   ${stats.productsConsidered}`,
    `  inserted:              ${stats.inserted}${opts.dryRun ? ' (would-insert)' : ''}`,
    `  updated:               ${stats.updated}`,
    `  replayed (no-op):      ${stats.replayed}`,
    `  skipped (conflict):    ${stats.skipped}`,
    `  invalid subtype:       ${stats.invalidSubtype}`,
    `  errors:                ${stats.errors}`,
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

const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /import-resin-seed\.[cm]?[jt]s$/.test(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    // eslint-disable-next-line no-console -- top-level CLI error.
    console.error(err);
    process.exit(1);
  });
}
