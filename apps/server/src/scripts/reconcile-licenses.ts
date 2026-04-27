#!/usr/bin/env -S npx tsx
/**
 * License-attribution reconciler — V2-007b T_B5c.
 *
 * Ensures the resin-seed section of `THIRD_PARTY_LICENSES.md` (between
 * `<!-- BEGIN resin-seed -->` and `<!-- END resin-seed -->` markers)
 * matches the brand list in `apps/server/seed/resins/`. The spoolmandb
 * section (between `<!-- BEGIN spoolmandb -->` ... `<!-- END spoolmandb -->`)
 * is preserved as-is — it is auto-managed by `import-spoolmandb.ts`.
 *
 * Why this script exists separately from the resin importer's writer:
 * the importer only updates the license file when it actually runs
 * (which requires a DB). This reconciler is a static, no-DB step we
 * can invoke from CI to catch drift between committed seed files and
 * the committed THIRD_PARTY_LICENSES.md.
 *
 * Usage:
 *
 *     npx tsx src/scripts/reconcile-licenses.ts                # default --write
 *     npx tsx src/scripts/reconcile-licenses.ts --check        # exit 1 on diff
 *     npx tsx src/scripts/reconcile-licenses.ts --write        # apply changes
 *     npx tsx src/scripts/reconcile-licenses.ts --seed-root <p> --license <p>
 *
 * If the license file doesn't exist, `--write` creates it with appropriate
 * header content + per-section markers. `--check` against a missing file
 * returns non-zero (drift) since the expected output != current state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const RESIN_BLOCK_START = '<!-- BEGIN resin-seed -->';
const RESIN_BLOCK_END = '<!-- END resin-seed -->';
const SPOOLMANDB_BLOCK_START = '<!-- BEGIN spoolmandb -->';
const SPOOLMANDB_BLOCK_END = '<!-- END spoolmandb -->';

const LICENSE_HEADER =
  '# Third-Party Licenses\n\nThis file lists third-party data + code redistributed by lootgoblin.\n';

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------

export interface ReconcileOptions {
  seedRoot: string;
  licensePath: string;
  /** If true, exit non-zero when content would change. Default false → write. */
  check: boolean;
}

function defaultRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), '..', '..');
}

function defaultSeedRoot(): string {
  const cwd = process.cwd();
  if (cwd.endsWith(`${path.sep}apps${path.sep}server`) || cwd.endsWith('/apps/server')) {
    return path.join(cwd, 'seed');
  }
  return path.join(defaultRepoRoot(), 'apps', 'server', 'seed');
}

export function parseArgs(argv: string[]): ReconcileOptions {
  const opts: ReconcileOptions = {
    seedRoot: defaultSeedRoot(),
    licensePath: path.join(defaultRepoRoot(), 'THIRD_PARTY_LICENSES.md'),
    check: false,
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
      case '--license':
        if (!next) throw new Error('--license requires a value');
        opts.licensePath = path.resolve(next);
        i++;
        break;
      case '--check':
        opts.check = true;
        break;
      case '--write':
        opts.check = false;
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
  console.log(`License attribution reconciler (V2-007b T_B5c)

Options:
  --seed-root <path>   Root containing resins/ subdir
                       (default: apps/server/seed/).
  --license <path>     Path to THIRD_PARTY_LICENSES.md
                       (default: <repo-root>/THIRD_PARTY_LICENSES.md).
  --check              Exit 1 if file would change (CI mode).
  --write              Apply changes (default).
  -h, --help           Print this help.
`);
}

// ---------------------------------------------------------------------------
// Brand → source URL gather
// ---------------------------------------------------------------------------

export interface BrandCitation {
  brand: string;
  sourceUrls: string[];
}

interface RawSeedFile {
  brand?: unknown;
  products?: unknown;
}

/**
 * Walk `seedRoot/resins/*.json`, pull each file's brand + collected
 * sourceRefs from its products. Returns an array sorted alphabetically by
 * brand. Falls back to retailUrl when sourceRef is absent (some hand-curated
 * entries cite the retail page as the source).
 */
export function collectResinBrandCitations(seedRoot: string): BrandCitation[] {
  const resinsDir = path.join(seedRoot, 'resins');
  if (!fs.existsSync(resinsDir)) return [];
  const entries = fs.readdirSync(resinsDir, { withFileTypes: true });
  const out: BrandCitation[] = [];

  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.toLowerCase().endsWith('.json')) continue;
    if (ent.name.startsWith('_')) continue;

    const filePath = path.join(resinsDir, ent.name);
    let parsed: RawSeedFile;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RawSeedFile;
    } catch {
      // Bad JSON — skip; validate-seed will catch it.
      continue;
    }
    if (typeof parsed.brand !== 'string' || parsed.brand.length === 0) continue;
    const sourceUrls: string[] = [];
    if (Array.isArray(parsed.products)) {
      for (const p of parsed.products) {
        if (typeof p !== 'object' || p === null) continue;
        const o = p as Record<string, unknown>;
        const ref =
          typeof o.sourceRef === 'string' && o.sourceRef.length > 0
            ? o.sourceRef
            : typeof o.retailUrl === 'string' && o.retailUrl.length > 0
              ? o.retailUrl
              : null;
        if (ref) sourceUrls.push(ref);
      }
    }
    out.push({ brand: parsed.brand, sourceUrls });
  }

  out.sort((a, b) => a.brand.localeCompare(b.brand));
  return out;
}

// ---------------------------------------------------------------------------
// Block builders + file rewriter
// ---------------------------------------------------------------------------

export function buildResinLicenseBlock(brandCitations: BrandCitation[]): string {
  const lines: string[] = [];
  for (const { brand, sourceUrls } of brandCitations) {
    const uniq = Array.from(new Set(sourceUrls)).sort();
    if (uniq.length === 0) {
      lines.push(`- ${brand}: (no public source URLs cited)`);
      continue;
    }
    if (uniq.length === 1) {
      lines.push(`- ${brand}: ${uniq[0]}`);
      continue;
    }
    lines.push(`- ${brand}:`);
    for (const u of uniq) lines.push(`  - ${u}`);
  }

  const body = lines.length > 0 ? lines.join('\n') : '_(no resin brands seeded)_';
  return `${RESIN_BLOCK_START}
## Resin product catalog

Hand-keyed from public vendor pages and product specifications. No data
redistributed from copyrighted compilations or AGPL-licensed slicer preset
libraries (see \`planning/odad/research/v2-007b-catalog-seed.md\` Q5 for
licensing analysis). Imported entries get \`source='community-pr'\` and
\`owner_id=NULL\`.

### Source pages cited per brand

${body}
${RESIN_BLOCK_END}`;
}

/**
 * Replace (or insert) the resin-seed block in `existing`. If the block is
 * absent, append it at the end. Spoolmandb block is left intact in either
 * branch.
 */
export function applyResinBlock(existing: string, block: string): string {
  if (existing.includes(RESIN_BLOCK_START) && existing.includes(RESIN_BLOCK_END)) {
    const re = new RegExp(
      `${RESIN_BLOCK_START}[\\s\\S]*?${RESIN_BLOCK_END}`,
      'm',
    );
    return existing.replace(re, block);
  }
  return existing.trimEnd() + '\n\n' + block + '\n';
}

/**
 * Compose the full reconciled file content. When the license file does not
 * exist on disk, this builds a fresh file with header + the resin block.
 * The spoolmandb block is preserved as-is when present.
 */
export function reconcileContent(
  existing: string | null,
  brandCitations: BrandCitation[],
): string {
  const block = buildResinLicenseBlock(brandCitations);
  if (existing === null) {
    return `${LICENSE_HEADER}\n${block}\n`;
  }
  return applyResinBlock(existing, block);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  changed: boolean;
  before: string | null;
  after: string;
  brandCount: number;
}

export function runReconcile(opts: ReconcileOptions): ReconcileResult {
  const brandCitations = collectResinBrandCitations(opts.seedRoot);
  const existing = fs.existsSync(opts.licensePath)
    ? fs.readFileSync(opts.licensePath, 'utf-8')
    : null;
  const after = reconcileContent(existing, brandCitations);
  const changed = existing !== after;

  if (changed && !opts.check) {
    fs.mkdirSync(path.dirname(opts.licensePath), { recursive: true });
    fs.writeFileSync(opts.licensePath, after);
  }

  return { changed, before: existing, after, brandCount: brandCitations.length };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function main(): void {
  let opts: ReconcileOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console -- CLI top-level
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
    return;
  }
  const result = runReconcile(opts);
  if (opts.check) {
    if (result.changed) {
      // eslint-disable-next-line no-console -- CLI status output
      console.log(
        `[DIFF] ${opts.licensePath} would be updated (${result.brandCount} brand(s) in seed)`,
      );
      process.exit(1);
    } else {
      // eslint-disable-next-line no-console -- CLI status output
      console.log(`[OK] ${opts.licensePath} is in sync (${result.brandCount} brand(s))`);
    }
    return;
  }
  // eslint-disable-next-line no-console -- CLI status output
  console.log(
    `[${result.changed ? 'WRITE' : 'NOOP'}] ${opts.licensePath} (${result.brandCount} brand(s))`,
  );
}

const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /reconcile-licenses\.[cm]?[jt]s$/.test(process.argv[1]);

if (isDirectRun) {
  main();
}
