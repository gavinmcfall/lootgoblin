/**
 * Integration test — SpoolmanDB seed import (V2-007b T_B5a).
 *
 * Real SQLite at /tmp/lootgoblin-spoolmandb-import.db. Mocks the SpoolmanDB
 * GitHub fetches via a monkey-patched `globalThis.fetch` that serves the
 * fixture JSON.
 *
 * Coverage:
 *  1. Manifest + brand file fetched + transformed; rows inserted with the
 *     correct shape (system:spoolmandb source, ownerId=NULL, slug ids,
 *     multi-hex colors).
 *  2. Re-run with same data is idempotent (replayed; no duplicates).
 *  3. Re-run with --update flag + modified hex updates in place.
 *  4. --dry-run leaves the DB empty; summary counts are still produced.
 */

import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { runImport, type ImportOptions } from '../../src/scripts/import-spoolmandb';

const DB_PATH = '/tmp/lootgoblin-spoolmandb-import.db';
const DB_URL = `file:${DB_PATH}`;
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/spoolmandb');
const CACHE_DIR = '/tmp/lootgoblin-spoolmandb-cache';
const COMMIT_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function baseOpts(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    ref: COMMIT_SHA,
    dryRun: false,
    update: false,
    brand: null,
    limit: null,
    actorUserId: 'system-importer',
    skipLicenseWrite: true,
    dbUrl: DB_URL,
    ...overrides,
  };
}

function clearCache(): void {
  if (fs.existsSync(CACHE_DIR)) fs.rmSync(CACHE_DIR, { recursive: true, force: true });
}

function clearTable(): void {
  // Delete all rows so each test starts clean. (Truncate-via-delete; the
  // SQLite optimizer turns this into a fast DELETE FROM.)
  db().delete(schema.filamentProducts).run();
}

/**
 * Mock fetch: returns canned JSON for SpoolmanDB URLs based on the fixture
 * directory. Anything else is rejected.
 */
function installFetchMock(opts: { mutateBambu?: (json: string) => string } = {}): void {
  const fakeManifest = JSON.stringify(
    [
      {
        name: 'Bambu.json',
        path: 'filaments/Bambu.json',
        type: 'file',
      },
    ],
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('api.github.com/repos/Donkie/SpoolmanDB/contents/filaments')) {
        return new Response(fakeManifest, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('raw.githubusercontent.com/Donkie/SpoolmanDB')) {
        if (u.endsWith('/Bambu.json')) {
          let raw = fs.readFileSync(path.join(FIXTURE_DIR, 'Bambu.json'), 'utf-8');
          if (opts.mutateBambu) raw = opts.mutateBambu(raw);
          return new Response(raw, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      return new Response(`unmocked URL: ${u}`, { status: 500 });
    }),
  );
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  process.env.SPOOLMANDB_CACHE_DIR = CACHE_DIR;
  await runMigrations(DB_URL);
}, 30_000);

beforeEach(() => {
  clearCache();
  clearTable();
  installFetchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('runImport — initial run', () => {
  it('inserts rows with correct shape', async () => {
    const stats = await runImport(baseOpts());
    expect(stats.errors).toBe(0);
    expect(stats.brandsProcessed).toBe(1);
    // Bambu.json: PLA Basic (3 colors) + PLA Silk Dual (2 colors) + PLA Galaxy (1) = 6
    expect(stats.colorVariants).toBe(6);
    expect(stats.inserted).toBe(6);
    expect(stats.updated).toBe(0);
    expect(stats.skipped).toBe(0);

    const rows = await db().select().from(schema.filamentProducts);
    expect(rows.length).toBe(6);

    const red = rows.find((r) => r.colorName === 'Red');
    expect(red).toBeDefined();
    expect(red!.source).toBe('system:spoolmandb');
    expect(red!.ownerId).toBeNull();
    expect(red!.id).toBe('system:spoolmandb:bambu-lab:pla-basic:red');
    expect(red!.colorPattern).toBe('solid');
    expect(red!.colors).toEqual(['#FF0000']);
    expect(red!.brand).toBe('Bambu Lab');
    expect(red!.subtype).toBe('PLA');
    expect(red!.diameterMm).toBe(1.75);
    expect(red!.density).toBe(1.24);
    expect(red!.spoolWeightG).toBe(1000);
    expect(red!.emptySpoolWeightG).toBe(250);
    expect(red!.defaultTemps).toEqual({ nozzle_min: 220, nozzle_max: 220, bed: 60 });
    expect(red!.sourceRef).toBe(`${COMMIT_SHA}:filaments/Bambu.json`);

    const velvet = rows.find((r) => r.colorName === 'Velvet Eclipse');
    expect(velvet).toBeDefined();
    expect(velvet!.colorPattern).toBe('dual-tone');
    expect(velvet!.colors).toEqual(['#000000', '#A34342']);
    expect(velvet!.subtype).toBe('PLA-Silk');

    const rainbow = rows.find((r) => r.colorName === 'Rainbow Quad');
    expect(rainbow).toBeDefined();
    expect(rainbow!.colorPattern).toBe('multi-section');
    expect(rainbow!.colors).toEqual(['#FF0000', '#00AE42', '#0066FF', '#FFFF00']);
  });
});

describe('runImport — idempotent re-run', () => {
  it('replays cleanly with no duplicates', async () => {
    await runImport(baseOpts());
    const before = await db().select().from(schema.filamentProducts);
    expect(before.length).toBe(6);

    // Second run with same data.
    const stats = await runImport(baseOpts());
    expect(stats.errors).toBe(0);
    expect(stats.replayed).toBe(6);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(0);

    const after = await db().select().from(schema.filamentProducts);
    expect(after.length).toBe(6);
    // Row ids are stable across runs.
    const beforeIds = new Set(before.map((r) => r.id));
    const afterIds = new Set(after.map((r) => r.id));
    expect(afterIds).toEqual(beforeIds);
  });

  it('skip-on-conflict (default) when SpoolmanDB shape changes', async () => {
    // First run: original data.
    await runImport(baseOpts());

    // Second run: clear cache + mutate the fixture so Red becomes #EE0000.
    clearCache();
    installFetchMock({
      mutateBambu: (raw) => raw.replace('"hex": "FF0000"', '"hex": "EE0000"'),
    });

    const stats = await runImport(baseOpts());
    // 5 unchanged + 1 conflict (Red).
    expect(stats.replayed).toBe(5);
    expect(stats.skipped).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.errors).toBe(0);

    // Red still has the original hex.
    const red = await db()
      .select()
      .from(schema.filamentProducts)
      .where(eq(schema.filamentProducts.id, 'system:spoolmandb:bambu-lab:pla-basic:red'));
    expect(red[0]!.colors).toEqual(['#FF0000']);
  });
});

describe('runImport — update mode', () => {
  it('--update overwrites changed rows in place', async () => {
    await runImport(baseOpts());

    clearCache();
    installFetchMock({
      mutateBambu: (raw) => raw.replace('"hex": "FF0000"', '"hex": "EE0000"'),
    });

    const stats = await runImport(baseOpts({ update: true }));
    expect(stats.errors).toBe(0);
    expect(stats.updated).toBe(1);
    expect(stats.replayed).toBe(5);
    expect(stats.skipped).toBe(0);

    const red = await db()
      .select()
      .from(schema.filamentProducts)
      .where(eq(schema.filamentProducts.id, 'system:spoolmandb:bambu-lab:pla-basic:red'));
    expect(red[0]!.colors).toEqual(['#EE0000']);
  });
});

describe('runImport — dry-run', () => {
  it('does not write to the DB', async () => {
    const stats = await runImport(baseOpts({ dryRun: true }));
    expect(stats.brandsProcessed).toBe(1);
    expect(stats.colorVariants).toBe(6);
    expect(stats.inserted).toBe(6); // counted as would-insert
    expect(stats.errors).toBe(0);

    const rows = await db().select().from(schema.filamentProducts);
    expect(rows.length).toBe(0);
  });
});

describe('runImport — --brand filter + --limit', () => {
  it('filters to a single brand stem (case-insensitive)', async () => {
    const stats = await runImport(baseOpts({ brand: 'bambu' }));
    expect(stats.brandsProcessed).toBe(1);
    expect(stats.colorVariants).toBe(6);
  });

  it('--brand mismatched name yields 0 brands processed', async () => {
    const stats = await runImport(baseOpts({ brand: 'nonexistent' }));
    expect(stats.brandsProcessed).toBe(0);
    expect(stats.colorVariants).toBe(0);
  });

  it('--limit 1 keeps single brand processed (single-brand fixture)', async () => {
    const stats = await runImport(baseOpts({ limit: 1 }));
    expect(stats.brandsProcessed).toBe(1);
    expect(stats.colorVariants).toBe(6);
  });
});

describe('parseArgs', () => {
  it('accepts --ref + --dry-run + --update + --brand + --limit', async () => {
    const { parseArgs } = await import('../../src/scripts/import-spoolmandb');
    const opts = parseArgs([
      '--ref', 'abc123',
      '--dry-run',
      '--update',
      '--brand', 'Bambu',
      '--limit', '5',
    ]);
    expect(opts.ref).toBe('abc123');
    expect(opts.dryRun).toBe(true);
    expect(opts.update).toBe(true);
    expect(opts.brand).toBe('Bambu');
    expect(opts.limit).toBe(5);
  });

  it('default ref is "main"', async () => {
    const { parseArgs } = await import('../../src/scripts/import-spoolmandb');
    const opts = parseArgs([]);
    expect(opts.ref).toBe('main');
    expect(opts.dryRun).toBe(false);
    expect(opts.update).toBe(false);
  });

  it('rejects invalid --limit', async () => {
    const { parseArgs } = await import('../../src/scripts/import-spoolmandb');
    expect(() => parseArgs(['--limit', '0'])).toThrow();
    expect(() => parseArgs(['--limit', 'nope'])).toThrow();
  });

  it('rejects unknown flags', async () => {
    const { parseArgs } = await import('../../src/scripts/import-spoolmandb');
    expect(() => parseArgs(['--bogus'])).toThrow();
  });
});

describe('upsertLicenseFile', () => {
  const TMP = '/tmp/lootgoblin-spoolmandb-license-test';

  beforeEach(() => {
    if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
  });

  it('creates the file when missing', async () => {
    const { upsertLicenseFile } = await import('../../src/scripts/import-spoolmandb');
    const p = path.join(TMP, 'THIRD_PARTY_LICENSES.md');
    upsertLicenseFile(p, 'abc123', '2026-04-25T00:00:00.000Z');
    const body = fs.readFileSync(p, 'utf-8');
    expect(body).toMatch(/# Third-Party Licenses/);
    expect(body).toMatch(/## SpoolmanDB/);
    expect(body).toMatch(/Pinned commit.*abc123/);
    expect(body).toMatch(/Last imported.*2026-04-25/);
  });

  it('replaces an existing block in place (no duplicates)', async () => {
    const { upsertLicenseFile } = await import('../../src/scripts/import-spoolmandb');
    const p = path.join(TMP, 'THIRD_PARTY_LICENSES.md');
    upsertLicenseFile(p, 'abc123', '2026-01-01T00:00:00.000Z');
    upsertLicenseFile(p, 'def456', '2026-02-02T00:00:00.000Z');
    const body = fs.readFileSync(p, 'utf-8');
    expect(body).toMatch(/def456/);
    expect(body).not.toMatch(/abc123/);
    // Only one ## SpoolmanDB section.
    const matches = body.match(/## SpoolmanDB/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('appends to an existing licenses file that has other sections', async () => {
    const { upsertLicenseFile } = await import('../../src/scripts/import-spoolmandb');
    const p = path.join(TMP, 'THIRD_PARTY_LICENSES.md');
    fs.writeFileSync(p, '# Third-Party Licenses\n\n## OtherThing\n- whatever\n');
    upsertLicenseFile(p, 'abc123', '2026-04-25T00:00:00.000Z');
    const body = fs.readFileSync(p, 'utf-8');
    expect(body).toMatch(/## OtherThing/);
    expect(body).toMatch(/## SpoolmanDB/);
  });
});
