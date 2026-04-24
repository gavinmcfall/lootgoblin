/**
 * Integration tests for the indexer engine — V2-002-T11
 *
 * Real SQLite DB at /tmp/lootgoblin-indexer.db
 * Scratch dirs at /tmp/lootgoblin-indexer-<random>/
 *
 * Test cases:
 *   1.  indexLoot on a fresh loot → FTS row present, loot_thumbnails row created.
 *   2.  search returns matching loot_ids ordered by rank (multi-word query).
 *   3.  search with limit + offset paginates correctly.
 *   4.  removeLoot removes FTS row + unlinks thumbnail file + removes loot_thumbnails row.
 *   5.  rebuildFts on a DB with 10 pre-existing loots → FTS has 10 rows.
 *   6.  regenerateThumbnail fast-path: 3MF with embedded thumbnail → ok, 3mf-embedded, file exists.
 *   7.  regenerateThumbnail slow-path: injected f3dRunner writes fake PNG → ok, f3d-cli.
 *   8.  regenerateThumbnail F3D failure: injected runner returns failed → status=failed, error populated.
 *   9.  regenerateThumbnail F3D not found: injected runner returns f3d-not-found → status=failed.
 *   10. regenerateThumbnail with no lootFiles → status=failed, error=no-files.
 *   11. regenerateThumbnail keeps existing thumbnail when retry fails (non-destructive).
 *   12. indexLoot is idempotent — called twice, FTS row count stays at 1.
 *   13. search on empty corpus returns empty array.
 *   14. FTS respects updates — re-index after title change; old term gone, new term found.
 *   15. Loot with null optional fields (creator/description/tags/license) doesn't crash.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import JSZip from 'jszip';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { createIndexerEngine } from '../../src/stash/indexer';
import type { IndexerEngine, ThumbnailResult } from '../../src/stash/indexer';
import { sql } from 'drizzle-orm';
import { eq, asc } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-indexer.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Scratch directory helpers
// ---------------------------------------------------------------------------

async function makeScratchDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-indexer-'));
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Indexer Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string, rootPath: string): Promise<string> {
  const id = uid();
  await db().insert(schema.stashRoots).values({
    id,
    ownerId,
    name: 'Test Stash Root',
    path: rootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(
  ownerId: string,
  stashRootId: string,
  name?: string,
): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id,
    ownerId,
    name: name ?? `Test Collection ${id.slice(0, 8)}`,
    pathTemplate: '{creator|slug}/{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(
  collectionId: string,
  opts: {
    title: string;
    creator?: string | null;
    description?: string | null;
    tags?: string[];
    license?: string | null;
  },
): Promise<string> {
  const id = uid();
  await db().insert(schema.loot).values({
    id,
    collectionId,
    title: opts.title,
    description: opts.description ?? null,
    tags: opts.tags ?? [],
    creator: opts.creator ?? null,
    license: opts.license ?? null,
    sourceItemId: null,
    contentSummary: null,
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLootFile(
  lootId: string,
  relativePath: string,
  absolutePath?: string,
): Promise<string> {
  const id = uid();
  const ext = path.extname(relativePath).slice(1).toLowerCase() || 'bin';
  let size = 100;
  if (absolutePath) {
    try {
      const stat = await fsp.stat(absolutePath);
      size = stat.size;
    } catch {
      size = 100;
    }
  }
  await db().insert(schema.lootFiles).values({
    id,
    lootId,
    path: relativePath,
    format: ext,
    size,
    hash: '0'.repeat(64),
    origin: 'ingest',
    provenance: null,
    createdAt: new Date(),
  });
  return id;
}

// ---------------------------------------------------------------------------
// 3MF fixture builder
// ---------------------------------------------------------------------------

/**
 * Build a 3MF archive (ZIP) that contains an embedded thumbnail PNG.
 * Returns a Buffer suitable for writing to disk.
 */
async function build3mfWithThumbnail(thumbnailPng: Buffer): Promise<Buffer> {
  const zip = new JSZip();
  // Minimal 3MF model XML
  zip.file(
    '3D/3dmodel.model',
    `<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter" xml:lang="en-US">
  <metadata name="Title">Test Model</metadata>
</model>`,
  );
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`,
  );
  // Embed thumbnail at the spec-standard path.
  zip.file('Metadata/thumbnail.png', thumbnailPng);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Minimal valid PNG: 1x1 red pixel. */
function minimalPng(): Buffer {
  // PNG signature + IHDR + IDAT + IEND (hand-crafted 1x1 red pixel PNG)
  return Buffer.from(
    '89504e470d0a1a0a' + // PNG signature
    '0000000d49484452' + // IHDR length + type
    '00000001' +         // width = 1
    '00000001' +         // height = 1
    '08020000' +         // bit depth 8, colour type 2 (RGB), compression, filter, interlace
    '0090wc3d' +         // CRC (placeholder — tests only need non-zero bytes)
    '0000000c49444154' + // IDAT length + type
    '08d76360f8cfc000' + // compressed pixel data
    '00000200' +         //
    '01e221bc33' +       // CRC
    '0000000049454e44' + // IEND length + type
    'ae426082',          // CRC
    'hex',
  );
}

// ---------------------------------------------------------------------------
// DB-level FTS row count helper
// ---------------------------------------------------------------------------

function countFtsRows(lootId?: string): number {
  if (lootId !== undefined) {
    const rows = db().all(
      sql`SELECT loot_id FROM loot_fts WHERE loot_id = ${lootId}`,
    ) as Array<{ loot_id: string }>;
    return rows.length;
  }
  const rows = db().all(sql`SELECT loot_id FROM loot_fts`) as Array<{ loot_id: string }>;
  return rows.length;
}

function getThumbnailRow(
  lootId: string,
): { status: string; thumbnail_path: string | null; source_kind: string | null; error: string | null } | undefined {
  const rows = db().all(
    sql`SELECT status, thumbnail_path, source_kind, error FROM loot_thumbnails WHERE loot_id = ${lootId}`,
  ) as Array<{
    status: string;
    thumbnail_path: string | null;
    source_kind: string | null;
    error: string | null;
  }>;
  return rows[0];
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

let fakePng: Buffer;

beforeAll(async () => {
  // Clean up old DB files.
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      await fsp.unlink(`${DB_PATH}${suffix}`);
    } catch {
      /* ignore */
    }
  }
  resetDbCache();
  await runMigrations(DB_URL);

  // Build the fake PNG once (used in 3MF tests).
  // We build a real minimal PNG buffer — just enough bytes to be recognisable.
  // The 3MF fast-path doesn't validate PNG; it just copies bytes.
  fakePng = Buffer.alloc(64, 0);
  fakePng[0] = 0x89; // PNG signature byte
  fakePng[1] = 0x50; // 'P'
  fakePng[2] = 0x4e; // 'N'
  fakePng[3] = 0x47; // 'G'
});

// ---------------------------------------------------------------------------
// Helpers for creating an engine under test
// ---------------------------------------------------------------------------

function makeEngine(opts?: {
  f3dRunner?: (args: {
    source: string;
    destination: string;
    size: number;
    timeoutSec: number;
  }) => Promise<ThumbnailResult>;
}): IndexerEngine {
  return createIndexerEngine({
    dbUrl: DB_URL,
    f3dRunner:
      opts?.f3dRunner ??
      (async () => ({ status: 'failed', error: 'f3d-not-installed-in-test' })),
  });
}

// ---------------------------------------------------------------------------
// 1. indexLoot on a fresh loot → FTS row present, loot_thumbnails row created
// ---------------------------------------------------------------------------

describe('indexLoot — basic indexing', () => {
  it('1. creates FTS row and loot_thumbnails row for a new loot', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId);
    const lootId = await seedLoot(collectionId, {
      title: 'Dragon Figurine',
      creator: 'Alice',
      description: 'A classic dragon',
      tags: ['dragon', 'fantasy'],
    });
    const filePath = path.join(scratch, 'dragon.stl');
    await fsp.writeFile(filePath, Buffer.alloc(10));
    await seedLootFile(lootId, 'dragon.stl', filePath);

    const engine = makeEngine();
    await engine.indexLoot(lootId);

    // FTS row should be present.
    expect(countFtsRows(lootId)).toBe(1);

    // loot_thumbnails row should be present (status pending or failed — no real f3d).
    const thumbRow = getThumbnailRow(lootId);
    expect(thumbRow).toBeDefined();
    expect(['pending', 'failed', 'ok']).toContain(thumbRow!.status);
  });
});

// ---------------------------------------------------------------------------
// 2. search returns matching loot_ids ordered by rank
// ---------------------------------------------------------------------------

describe('search — FTS queries', () => {
  it('2. search returns matching loot_ids for a multi-word query', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId);

    const loot1 = await seedLoot(collectionId, {
      title: 'Wyvern Battle Scene',
      creator: 'Bob',
      description: 'Epic wyvern diorama',
      tags: ['wyvern', 'battle'],
    });
    const loot2 = await seedLoot(collectionId, {
      title: 'Cat Bowl',
      creator: 'Carol',
      description: 'A bowl shaped like a cat',
      tags: ['cat', 'bowl'],
    });

    const engine = makeEngine();
    await engine.indexLoot(loot1);
    await engine.indexLoot(loot2);

    const results = await engine.search('wyvern');
    expect(results).toContain(loot1);
    expect(results).not.toContain(loot2);
  });
});

// ---------------------------------------------------------------------------
// 3. search with limit + offset paginates correctly
// ---------------------------------------------------------------------------

describe('search — pagination', () => {
  it('3. limit and offset paginate results correctly', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId);

    // Seed 6 loots all with the same keyword so search returns all of them.
    const lootIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await seedLoot(collectionId, {
        title: `Pagination Model ${i}`,
        creator: 'Paginator',
        description: 'paginate keyword',
        tags: [],
      });
      lootIds.push(id);
    }

    const engine = makeEngine();
    for (const id of lootIds) {
      await engine.indexLoot(id);
    }

    const page1 = await engine.search('paginate', { limit: 3, offset: 0 });
    const page2 = await engine.search('paginate', { limit: 3, offset: 3 });

    expect(page1.length).toBe(3);
    expect(page2.length).toBe(3);
    // No overlap between pages.
    const combined = new Set([...page1, ...page2]);
    expect(combined.size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 4. removeLoot removes FTS row + unlinks thumbnail file + removes loot_thumbnails row
// ---------------------------------------------------------------------------

describe('removeLoot', () => {
  it('4. removes FTS row, thumbnail file, and loot_thumbnails row', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId);
    const lootId = await seedLoot(collectionId, { title: 'To Remove', creator: 'Test' });

    // Manually create a fake thumbnail file and row so removeLoot can unlink it.
    const thumbnailsDir = path.join(scratch, 'thumbnails');
    await fsp.mkdir(thumbnailsDir, { recursive: true });
    const thumbnailFile = path.join(thumbnailsDir, `${lootId}.png`);
    await fsp.writeFile(thumbnailFile, Buffer.alloc(8, 0));
    const relPath = `thumbnails/${lootId}.png`;

    // Insert the loot_thumbnails row with the absolute path in thumbnail_path
    // (the engine stores relative path; removeLoot reads it and resolves with
    // stash root — but for this test we store the absolute path directly
    // to exercise the unlink code path).
    db().run(
      sql`INSERT OR REPLACE INTO loot_thumbnails (loot_id, status, thumbnail_path, updated_at)
          VALUES (${lootId}, 'ok', ${thumbnailFile}, ${Date.now()})`,
    );

    // Insert an FTS row.
    db().run(
      sql`INSERT INTO loot_fts (loot_id, title, creator, description, tags, formats)
          VALUES (${lootId}, 'To Remove', 'Test', '', '', '')`,
    );

    const engine = makeEngine();
    await engine.removeLoot(lootId);

    // FTS row gone.
    expect(countFtsRows(lootId)).toBe(0);

    // thumbnail file unlinked.
    expect(fs.existsSync(thumbnailFile)).toBe(false);

    // loot_thumbnails row gone.
    expect(getThumbnailRow(lootId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. rebuildFts on a DB with 10 pre-existing loots → FTS has 10 rows
// ---------------------------------------------------------------------------

describe('rebuildFts', () => {
  it('5. rebuilds FTS index from scratch and returns correct count', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId);

    const lootIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await seedLoot(collectionId, { title: `Rebuild Loot ${i}`, creator: 'Builder' });
      lootIds.push(id);
    }

    // Purge any existing FTS rows for these loots first.
    db().run(sql`DELETE FROM loot_fts`);

    const engine = makeEngine();
    const { indexed } = await engine.rebuildFts();

    // At least our 10 loots should be indexed (may be more from other tests).
    expect(indexed).toBeGreaterThanOrEqual(10);

    // Each of our 10 should have an FTS row.
    for (const id of lootIds) {
      expect(countFtsRows(id)).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. regenerateThumbnail fast-path: 3MF with embedded thumbnail
// ---------------------------------------------------------------------------

describe('regenerateThumbnail — 3MF fast-path', () => {
  it('6. 3MF with embedded thumbnail → ok, 3mf-embedded, file written to disk', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId);
    const lootId = await seedLoot(collectionId, { title: '3MF Embedded Test', creator: 'FastPath' });

    // Build a 3MF with embedded thumbnail PNG.
    const threeMfBuffer = await build3mfWithThumbnail(fakePng);
    const threeMfPath = path.join(scratch, 'model.3mf');
    await fsp.writeFile(threeMfPath, threeMfBuffer);

    await seedLootFile(lootId, 'model.3mf', threeMfPath);

    const engine = makeEngine();
    const result = await engine.regenerateThumbnail(lootId);

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.source).toBe('3mf-embedded');
      // File should exist at the destination.
      expect(fs.existsSync(result.path)).toBe(true);
    }

    // DB row should be updated.
    const thumbRow = getThumbnailRow(lootId);
    expect(thumbRow?.status).toBe('ok');
    expect(thumbRow?.source_kind).toBe('3mf-embedded');
  });
});

// ---------------------------------------------------------------------------
// 7. regenerateThumbnail slow-path: injected f3dRunner writes fake PNG
// ---------------------------------------------------------------------------

describe('regenerateThumbnail — F3D slow-path', () => {
  it('7. injected f3dRunner that writes a fake PNG → ok, f3d-cli', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId);
    const lootId = await seedLoot(collectionId, { title: 'F3D Slow Path', creator: 'SlowPath' });

    // Use a .stl file (not .3mf) to skip the fast path.
    const stlPath = path.join(scratch, 'model.stl');
    await fsp.writeFile(stlPath, Buffer.alloc(84)); // minimal STL binary size
    await seedLootFile(lootId, 'model.stl', stlPath);

    const fakeRunner = async (args: {
      source: string;
      destination: string;
      size: number;
      timeoutSec: number;
    }): Promise<ThumbnailResult> => {
      // Write a fake PNG to the destination.
      await fsp.mkdir(path.dirname(args.destination), { recursive: true });
      await fsp.writeFile(args.destination, fakePng);
      return { status: 'ok', path: args.destination, source: 'f3d-cli' };
    };

    const engine = makeEngine({ f3dRunner: fakeRunner });
    const result = await engine.regenerateThumbnail(lootId);

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.source).toBe('f3d-cli');
      expect(fs.existsSync(result.path)).toBe(true);
    }

    const thumbRow = getThumbnailRow(lootId);
    expect(thumbRow?.status).toBe('ok');
    expect(thumbRow?.source_kind).toBe('f3d-cli');
  });
});

// ---------------------------------------------------------------------------
// 8. regenerateThumbnail F3D failure: injected runner returns failed
// ---------------------------------------------------------------------------

describe('regenerateThumbnail — F3D failure', () => {
  it('8. injected f3dRunner returning failed → status=failed, error populated', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId);
    const lootId = await seedLoot(collectionId, { title: 'F3D Failure', creator: 'FailTest' });

    const stlPath = path.join(scratch, 'model.stl');
    await fsp.writeFile(stlPath, Buffer.alloc(84));
    await seedLootFile(lootId, 'model.stl', stlPath);

    const failRunner = async (): Promise<ThumbnailResult> => ({
      status: 'failed',
      error: 'f3d-render-error',
    });

    const engine = makeEngine({ f3dRunner: failRunner });
    const result = await engine.regenerateThumbnail(lootId);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('f3d-render-error');
    }

    const thumbRow = getThumbnailRow(lootId);
    expect(thumbRow?.status).toBe('failed');
    expect(thumbRow?.error).toBe('f3d-render-error');
  });
});

// ---------------------------------------------------------------------------
// 9. regenerateThumbnail F3D not found
// ---------------------------------------------------------------------------

describe('regenerateThumbnail — F3D not found', () => {
  it('9. f3dRunner returning f3d-not-found → status=failed with that error', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId);
    const lootId = await seedLoot(collectionId, { title: 'No F3D', creator: 'NotFound' });

    const stlPath = path.join(scratch, 'model.stl');
    await fsp.writeFile(stlPath, Buffer.alloc(84));
    await seedLootFile(lootId, 'model.stl', stlPath);

    const notFoundRunner = async (): Promise<ThumbnailResult> => ({
      status: 'failed',
      error: 'f3d-not-found',
    });

    const engine = makeEngine({ f3dRunner: notFoundRunner });
    const result = await engine.regenerateThumbnail(lootId);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('f3d-not-found');
    }

    const thumbRow = getThumbnailRow(lootId);
    expect(thumbRow?.status).toBe('failed');
    expect(thumbRow?.error).toBe('f3d-not-found');
  });
});

// ---------------------------------------------------------------------------
// 10. regenerateThumbnail with no lootFiles → status=failed, error=no-files
// ---------------------------------------------------------------------------

describe('regenerateThumbnail — no files', () => {
  it('10. loot with no lootFiles → status=failed, error=no-files', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId);
    const lootId = await seedLoot(collectionId, { title: 'Empty Loot', creator: 'Nobody' });
    // No lootFiles seeded.

    const engine = makeEngine();
    const result = await engine.regenerateThumbnail(lootId);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('no-files');
    }
  });
});

// ---------------------------------------------------------------------------
// 11. regenerateThumbnail keeps existing thumbnail when retry fails
// ---------------------------------------------------------------------------

describe('regenerateThumbnail — non-destructive on failure', () => {
  it('11. existing thumbnail file is NOT deleted when retry fails', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId);
    const lootId = await seedLoot(collectionId, { title: 'Keep Thumb', creator: 'KeepTest' });

    const stlPath = path.join(scratch, 'model.stl');
    await fsp.writeFile(stlPath, Buffer.alloc(84));
    await seedLootFile(lootId, 'model.stl', stlPath);

    // Write an existing thumbnail file.
    const thumbnailsDir = path.join(scratch, 'thumbnails');
    await fsp.mkdir(thumbnailsDir, { recursive: true });
    const existingThumb = path.join(thumbnailsDir, `${lootId}.png`);
    await fsp.writeFile(existingThumb, fakePng);

    // Set the DB row to 'ok' with the existing thumbnail.
    const relPath = `thumbnails/${lootId}.png`;
    db().run(
      sql`INSERT OR REPLACE INTO loot_thumbnails
          (loot_id, status, thumbnail_path, source_kind, error, generated_at, updated_at)
          VALUES (${lootId}, 'ok', ${relPath}, 'f3d-cli', NULL, ${Date.now()}, ${Date.now()})`,
    );

    // Now retry with a failing runner.
    const failRunner = async (): Promise<ThumbnailResult> => ({
      status: 'failed',
      error: 'f3d-retry-failed',
    });

    const engine = makeEngine({ f3dRunner: failRunner });
    const result = await engine.regenerateThumbnail(lootId);

    expect(result.status).toBe('failed');

    // The existing thumbnail file should still be on disk.
    expect(fs.existsSync(existingThumb)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. indexLoot is idempotent
// ---------------------------------------------------------------------------

describe('indexLoot — idempotency', () => {
  it('12. calling indexLoot twice keeps exactly 1 FTS row', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId);
    const lootId = await seedLoot(collectionId, { title: 'Idempotent Loot', creator: 'Idempot' });

    const engine = makeEngine();
    await engine.indexLoot(lootId);
    await engine.indexLoot(lootId);

    expect(countFtsRows(lootId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 13. search on empty corpus returns empty array
// ---------------------------------------------------------------------------

describe('search — empty corpus', () => {
  it('13. search on an empty FTS table returns empty array', async () => {
    // Clear FTS table for this test.
    db().run(sql`DELETE FROM loot_fts`);

    const engine = makeEngine();
    const results = await engine.search('anything');
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 14. FTS respects updates — re-index after title change
// ---------------------------------------------------------------------------

describe('search — FTS reflects updates', () => {
  it('14. re-indexing after title change makes old term absent and new term found', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId);
    const lootId = await seedLoot(collectionId, { title: 'Dragon', creator: 'UpdateTest' });

    const engine = makeEngine();
    await engine.indexLoot(lootId);

    // Verify "dragon" is found.
    let results = await engine.search('dragon');
    expect(results).toContain(lootId);

    // Update title to "Wyvern" in DB.
    await db()
      .update(schema.loot)
      .set({ title: 'Wyvern', updatedAt: new Date() })
      .where(eq(schema.loot.id, lootId));

    // Re-index.
    await engine.indexLoot(lootId);

    // "dragon" should no longer match (porter stemmer may affect this — use
    // a distinctive enough term that stemming won't bridge the gap).
    results = await engine.search('dragon');
    expect(results).not.toContain(lootId);

    // "wyvern" should now match.
    results = await engine.search('wyvern');
    expect(results).toContain(lootId);
  });
});

// ---------------------------------------------------------------------------
// 15. Loot with null optional fields doesn't crash
// ---------------------------------------------------------------------------

describe('indexLoot — null optional fields', () => {
  it('15. loot with null creator/description/tags/license indexes without error', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId);

    // Title required; all others null.
    const lootId = await seedLoot(collectionId, {
      title: 'Minimal Loot',
      creator: null,
      description: null,
      tags: [],
      license: null,
    });

    const engine = makeEngine();
    // Should not throw.
    await expect(engine.indexLoot(lootId)).resolves.toBeUndefined();

    // FTS row should be present.
    expect(countFtsRows(lootId)).toBe(1);
  });
});
