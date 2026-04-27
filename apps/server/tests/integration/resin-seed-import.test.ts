/**
 * Integration test — resin seed import (V2-007b T_B5b).
 *
 * Real SQLite at /tmp/lootgoblin-resin-seed-import.db. No fetch mocking
 * needed — the resin importer reads from a local fixtures directory.
 *
 * Coverage:
 *  1. runImport inserts rows with `source='community-pr'`, `ownerId=NULL`,
 *     and slug ids matching the system:community-pr pattern.
 *  2. Idempotent re-run replays cleanly (no duplicates).
 *  3. --update flag overwrites changed rows in place.
 *  4. --dry-run leaves the DB empty.
 *  5. --brand filter narrows to one file stem.
 *  6. License attribution: THIRD_PARTY_LICENSES.md gets a resin-seed section
 *     listing the brand source URLs (NOT PrusaSlicerSLA).
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  runImport,
  parseArgs,
  buildResinLicenseBlock,
  upsertLicenseFile,
  type ImportOptions,
} from '../../src/scripts/import-resin-seed';

const DB_PATH = '/tmp/lootgoblin-resin-seed-import.db';
const DB_URL = `file:${DB_PATH}`;
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/resin-seed');

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function baseOpts(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    seedDir: FIXTURE_DIR,
    dryRun: false,
    update: false,
    brand: null,
    actorUserId: 'system-importer',
    skipLicenseWrite: true,
    dbUrl: DB_URL,
    ...overrides,
  };
}

function clearTable(): void {
  db().delete(schema.resinProducts).run();
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
}, 30_000);

beforeEach(() => {
  clearTable();
});

describe('runImport — initial run', () => {
  it('inserts rows with correct shape (source, ownerId, slug pattern)', async () => {
    const stats = await runImport(baseOpts());
    expect(stats.errors).toBe(0);
    // example-co.json (2 products) + another-brand.json (2 products) = 4
    expect(stats.filesProcessed).toBe(2);
    expect(stats.productsConsidered).toBe(4);
    expect(stats.inserted).toBe(4);
    expect(stats.updated).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(stats.invalidSubtype).toBe(0);

    const rows = await db().select().from(schema.resinProducts);
    expect(rows.length).toBe(4);

    // Every row has the correct provenance.
    for (const r of rows) {
      expect(r.source).toBe('community-pr');
      expect(r.ownerId).toBeNull();
      expect(r.id.startsWith('system:community-pr:')).toBe(true);
    }

    const sunset = rows.find((r) => r.colorName === 'Sunset Orange');
    expect(sunset).toBeDefined();
    expect(sunset!.id).toBe('system:community-pr:example-co:test-tough:sunset-orange');
    expect(sunset!.brand).toBe('Example Co');
    expect(sunset!.subtype).toBe('tough');
    expect(sunset!.colors).toEqual(['#FF6600']);
    expect(sunset!.densityGMl).toBe(1.13);
    expect(sunset!.bottleVolumeMl).toBe(1000);
    expect(sunset!.materialClass).toBe('consumer');
    expect(sunset!.compatibility).toEqual({ wavelength_nm: 405 });
    expect(sunset!.sourceRef).toBe('https://example.test/tough');

    // "Water Washable" alias normalised to enum.
    const clear = rows.find((r) => r.colorName === 'Clear');
    expect(clear).toBeDefined();
    expect(clear!.subtype).toBe('water-washable');

    // Casting resin with NULL colors (industrial).
    const casting = rows.find((r) => r.subtype === 'casting');
    expect(casting).toBeDefined();
    expect(casting!.colors).toBeNull();
    expect(casting!.materialClass).toBe('industrial');
  });

  it('skips _index.json (underscore-prefixed files reserved)', async () => {
    const stats = await runImport(baseOpts());
    // If _index.json had been processed, productsConsidered would be > 4.
    expect(stats.productsConsidered).toBe(4);
  });
});

describe('runImport — idempotent re-run', () => {
  it('replays cleanly with no duplicates', async () => {
    await runImport(baseOpts());
    const before = await db().select().from(schema.resinProducts);
    expect(before.length).toBe(4);

    const stats = await runImport(baseOpts());
    expect(stats.errors).toBe(0);
    expect(stats.replayed).toBe(4);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(0);

    const after = await db().select().from(schema.resinProducts);
    expect(after.length).toBe(4);
    expect(new Set(after.map((r) => r.id))).toEqual(
      new Set(before.map((r) => r.id)),
    );
  });
});

describe('runImport — update mode', () => {
  it('--update overwrites changed rows in place', async () => {
    // First import.
    await runImport(baseOpts());

    // Mutate fixture to a temp dir so we can run a second pass with new data.
    const tmpDir = '/tmp/lootgoblin-resin-seed-mutated';
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const name of fs.readdirSync(FIXTURE_DIR)) {
      const src = path.join(FIXTURE_DIR, name);
      const dst = path.join(tmpDir, name);
      let raw = fs.readFileSync(src, 'utf-8');
      // Bump density on Sunset Orange to a new value.
      raw = raw.replace('"densityGMl": 1.13', '"densityGMl": 1.15');
      fs.writeFileSync(dst, raw);
    }

    const stats = await runImport(
      baseOpts({ seedDir: tmpDir, update: true }),
    );
    expect(stats.errors).toBe(0);
    expect(stats.updated).toBe(1);
    expect(stats.replayed).toBe(3);
    expect(stats.skipped).toBe(0);

    const sunset = await db()
      .select()
      .from(schema.resinProducts)
      .where(eq(schema.resinProducts.id, 'system:community-pr:example-co:test-tough:sunset-orange'));
    expect(sunset[0]!.densityGMl).toBe(1.15);
  });

  it('skip-on-conflict (default) when fixture changes without --update', async () => {
    await runImport(baseOpts());

    const tmpDir = '/tmp/lootgoblin-resin-seed-mutated-skip';
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const name of fs.readdirSync(FIXTURE_DIR)) {
      let raw = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
      raw = raw.replace('"densityGMl": 1.13', '"densityGMl": 1.20');
      fs.writeFileSync(path.join(tmpDir, name), raw);
    }

    const stats = await runImport(baseOpts({ seedDir: tmpDir }));
    expect(stats.replayed).toBe(3);
    expect(stats.skipped).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.errors).toBe(0);

    const sunset = await db()
      .select()
      .from(schema.resinProducts)
      .where(eq(schema.resinProducts.id, 'system:community-pr:example-co:test-tough:sunset-orange'));
    // Original density preserved.
    expect(sunset[0]!.densityGMl).toBe(1.13);
  });
});

describe('runImport — dry-run', () => {
  it('does not write to the DB', async () => {
    const stats = await runImport(baseOpts({ dryRun: true }));
    expect(stats.filesProcessed).toBe(2);
    expect(stats.productsConsidered).toBe(4);
    expect(stats.inserted).toBe(4); // would-insert
    expect(stats.errors).toBe(0);

    const rows = await db().select().from(schema.resinProducts);
    expect(rows.length).toBe(0);
  });
});

describe('runImport — --brand filter', () => {
  it('filters to one brand file stem (case-insensitive)', async () => {
    const stats = await runImport(baseOpts({ brand: 'EXAMPLE-CO' }));
    expect(stats.filesProcessed).toBe(1);
    expect(stats.productsConsidered).toBe(2);
    expect(stats.inserted).toBe(2);
  });

  it('mismatched name yields 0 files processed', async () => {
    const stats = await runImport(baseOpts({ brand: 'nonexistent' }));
    expect(stats.filesProcessed).toBe(0);
    expect(stats.productsConsidered).toBe(0);
  });
});

describe('parseArgs', () => {
  it('accepts --seed-dir + --dry-run + --update + --brand', () => {
    const opts = parseArgs([
      '--seed-dir', '/tmp/seed',
      '--dry-run',
      '--update',
      '--brand', 'anycubic',
    ]);
    expect(opts.seedDir).toBe(path.resolve('/tmp/seed'));
    expect(opts.dryRun).toBe(true);
    expect(opts.update).toBe(true);
    expect(opts.brand).toBe('anycubic');
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['--bogus'])).toThrow();
  });

  it('rejects --seed-dir with no value', () => {
    expect(() => parseArgs(['--seed-dir'])).toThrow();
  });
});

describe('license attribution', () => {
  const TMP = '/tmp/lootgoblin-resin-seed-license-test';

  beforeEach(() => {
    if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
  });

  it('buildResinLicenseBlock lists fixture brand source URLs (not PrusaSlicer)', () => {
    const block = buildResinLicenseBlock(
      [
        { brand: 'Example Co', sourceUrls: ['https://example.test/tough', 'https://example.test/standard'] },
        { brand: 'Another Brand', sourceUrls: ['https://another.test/wash', 'https://another.test/casting'] },
      ],
      '2026-04-25T00:00:00.000Z',
    );
    expect(block).toMatch(/## Resin product catalog/);
    expect(block).toMatch(/Hand-keyed from public vendor pages/);
    expect(block).not.toMatch(/PrusaSlicerSLA|prusa-slicer/i);
    expect(block).toMatch(/Example Co/);
    expect(block).toMatch(/Another Brand/);
    expect(block).toMatch(/https:\/\/example\.test\/tough/);
    expect(block).toMatch(/https:\/\/another\.test\/casting/);
    // Last refreshed date present.
    expect(block).toMatch(/2026-04-25/);
  });

  it('upsertLicenseFile creates the file when missing', () => {
    const p = path.join(TMP, 'THIRD_PARTY_LICENSES.md');
    upsertLicenseFile(
      p,
      [{ brand: 'B', sourceUrls: ['https://b.test'] }],
      '2026-04-25T00:00:00.000Z',
    );
    const body = fs.readFileSync(p, 'utf-8');
    expect(body).toMatch(/# Third-Party Licenses/);
    expect(body).toMatch(/## Resin product catalog/);
    expect(body).toMatch(/https:\/\/b\.test/);
  });

  it('upsertLicenseFile replaces an existing block in place (no duplicates)', () => {
    const p = path.join(TMP, 'THIRD_PARTY_LICENSES.md');
    upsertLicenseFile(
      p,
      [{ brand: 'B', sourceUrls: ['https://b.test/v1'] }],
      '2026-01-01T00:00:00.000Z',
    );
    upsertLicenseFile(
      p,
      [{ brand: 'B', sourceUrls: ['https://b.test/v2'] }],
      '2026-02-02T00:00:00.000Z',
    );
    const body = fs.readFileSync(p, 'utf-8');
    expect(body).toMatch(/v2/);
    expect(body).not.toMatch(/v1/);
    const matches = body.match(/## Resin product catalog/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('upsertLicenseFile co-exists with other sections (e.g. SpoolmanDB)', () => {
    const p = path.join(TMP, 'THIRD_PARTY_LICENSES.md');
    fs.writeFileSync(
      p,
      '# Third-Party Licenses\n\n<!-- BEGIN spoolmandb -->\n## SpoolmanDB\n- pinned: abc\n<!-- END spoolmandb -->\n',
    );
    upsertLicenseFile(
      p,
      [{ brand: 'B', sourceUrls: ['https://b.test'] }],
      '2026-04-25T00:00:00.000Z',
    );
    const body = fs.readFileSync(p, 'utf-8');
    expect(body).toMatch(/## SpoolmanDB/);
    expect(body).toMatch(/## Resin product catalog/);
  });

  it('runImport writes the license block with brand source URLs (skipLicenseWrite=false)', async () => {
    const repoRoot = '/tmp/lootgoblin-resin-seed-licenses-runimport';
    if (fs.existsSync(repoRoot)) fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.mkdirSync(repoRoot, { recursive: true });

    const stats = await runImport(
      baseOpts({ skipLicenseWrite: false, repoRoot }),
    );
    expect(stats.errors).toBe(0);

    const licensePath = path.join(repoRoot, 'THIRD_PARTY_LICENSES.md');
    expect(fs.existsSync(licensePath)).toBe(true);
    const body = fs.readFileSync(licensePath, 'utf-8');
    expect(body).toMatch(/## Resin product catalog/);
    expect(body).toMatch(/Example Co/);
    expect(body).toMatch(/Another Brand/);
    expect(body).toMatch(/https:\/\/example\.test\/tough/);
    expect(body).toMatch(/https:\/\/another\.test\/casting/);
    expect(body).not.toMatch(/PrusaSlicerSLA/i);
  });
});
