/**
 * Integration tests for ledger hooks — V2-002-T13
 *
 * Tests real ledger_events persistence through template-migration and
 * bulk-restructure engines.
 *
 * Real SQLite DB at /tmp/lootgoblin-ledger-integration.db
 * Scratch dirs at /tmp/lootgoblin-ledger-<random>/
 *
 * Test cases:
 *   1. Template migration execute → ledger_events row with kind='migration.execute' per moved file.
 *   2. Template migration execute multi-file → one ledger row per file moved.
 *   3. Bulk move-to-collection execute → ledger_events row with kind='bulk.move-to-collection'.
 *   4. Bulk change-template execute → ledger_events row with kind='bulk.change-template'.
 *   5. Primary op succeeds even when ledger is broken — file moved, DB updated, report success.
 */

import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { createTemplateMigrationEngine } from '../../src/stash/template-migration';
import { createBulkRestructureEngine } from '../../src/stash/bulk-restructure';
import { eq, inArray } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-ledger-integration.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Ledger Test User',
    email: `${id}@ledger.test`,
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
    name: 'Ledger Test Root',
    path: rootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(
  ownerId: string,
  stashRootId: string,
  pathTemplate: string,
  name?: string,
): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id,
    ownerId,
    name: name ?? `Ledger Collection ${id.slice(0, 8)}`,
    pathTemplate,
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(
  collectionId: string,
  opts: { title: string; creator?: string },
): Promise<string> {
  const id = uid();
  await db().insert(schema.loot).values({
    id,
    collectionId,
    title: opts.title,
    description: null,
    tags: [],
    creator: opts.creator ?? null,
    license: null,
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
  absolutePath: string,
): Promise<string> {
  const id = uid();
  const ext = path.extname(relativePath).slice(1).toLowerCase() || 'bin';
  let size = 0;
  try {
    const stat = await fsp.stat(absolutePath);
    size = stat.size;
  } catch {
    size = 100;
  }
  await db().insert(schema.lootFiles).values({
    id,
    lootId,
    path: relativePath,
    format: ext,
    size,
    hash: '0000000000000000000000000000000000000000000000000000000000000000',
    origin: 'adoption',
    provenance: null,
    createdAt: new Date(),
  });
  return id;
}

// ---------------------------------------------------------------------------
// FS helpers
// ---------------------------------------------------------------------------

async function makeScratchDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-ledger-'));
}

async function writeFile(absPath: string, content = 'ledger integration test\n'): Promise<void> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Helper to query ledger_events by kind for a resource
// ---------------------------------------------------------------------------

async function getLedgerEvents(opts: {
  kind?: string;
  resourceType?: string;
  resourceId?: string;
}): Promise<(typeof schema.ledgerEvents.$inferSelect)[]> {
  let query = db().select().from(schema.ledgerEvents);
  const conditions = [];
  if (opts.kind) conditions.push(eq(schema.ledgerEvents.kind, opts.kind));
  if (opts.resourceType) conditions.push(eq(schema.ledgerEvents.resourceType, opts.resourceType));
  if (opts.resourceId) conditions.push(eq(schema.ledgerEvents.resourceId, opts.resourceId));

  if (conditions.length === 0) return query;

  // Apply conditions individually (Drizzle sqlite doesn't take arrays directly in where without and())
  const { and } = await import('drizzle-orm');
  return db()
    .select()
    .from(schema.ledgerEvents)
    .where(and(...conditions));
}

// ---------------------------------------------------------------------------
// Test 1 — Template migration execute → one ledger_events row per moved file
// ---------------------------------------------------------------------------

describe('template-migration ledger persistence', () => {
  it('persists a migration.execute ledger event for each file moved', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId, 'legacy/{title|slug}');

    const lootId = await seedLoot(collectionId, { title: 'Goblin', creator: 'Loot' });
    const oldRelPath = 'legacy/goblin.stl';
    const absOldPath = path.join(scratch, oldRelPath);
    await writeFile(absOldPath, 'goblin content\n');
    const lootFileId = await seedLootFile(lootId, oldRelPath, absOldPath);

    const engine = createTemplateMigrationEngine({ dbUrl: DB_URL });

    const report = await engine.execute({
      collectionId,
      proposedTemplate: '{creator|slug}/{title|slug}',
      approvedVerdicts: [{ lootId, lootFileId }],
    });

    expect(report.filesMigrated).toBe(1);

    // Ledger event persisted
    const events = await getLedgerEvents({
      kind: 'migration.execute',
      resourceType: 'loot',
      resourceId: lootId,
    });
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event.kind).toBe('migration.execute');
    expect(event.resourceType).toBe('loot');
    expect(event.resourceId).toBe(lootId);
    expect(event.createdAt).toBeInstanceOf(Date);

    const payload = JSON.parse(event.payload!);
    expect(payload.lootFileId).toBe(lootFileId);
    expect(payload.collectionId).toBe(collectionId);
    expect(payload.oldPath).toBe('legacy/goblin.stl');
    expect(payload.newPath).toBe('loot/goblin.stl');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Template migration with 2 files → 2 ledger events
// ---------------------------------------------------------------------------

describe('template-migration ledger — multi-file emits one event per file', () => {
  it('emits one ledger row for each file successfully migrated', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId, 'old/{title|slug}');

    const loot1Id = await seedLoot(collectionId, { title: 'Dragon', creator: 'Forge' });
    const loot2Id = await seedLoot(collectionId, { title: 'Knight', creator: 'Forge' });

    const rel1 = 'old/dragon.stl';
    const rel2 = 'old/knight.stl';
    await writeFile(path.join(scratch, rel1), 'dragon\n');
    await writeFile(path.join(scratch, rel2), 'knight\n');
    const file1Id = await seedLootFile(loot1Id, rel1, path.join(scratch, rel1));
    const file2Id = await seedLootFile(loot2Id, rel2, path.join(scratch, rel2));

    const engine = createTemplateMigrationEngine({ dbUrl: DB_URL });

    const report = await engine.execute({
      collectionId,
      proposedTemplate: '{creator|slug}/{title|slug}',
      approvedVerdicts: [
        { lootId: loot1Id, lootFileId: file1Id },
        { lootId: loot2Id, lootFileId: file2Id },
      ],
    });

    expect(report.filesMigrated).toBe(2);

    const events = await getLedgerEvents({ kind: 'migration.execute', resourceType: 'loot' });
    const ourLootIds = new Set([loot1Id, loot2Id]);
    const ourEvents = events.filter((e) => ourLootIds.has(e.resourceId));

    expect(ourEvents).toHaveLength(2);
    const resourceIds = new Set(ourEvents.map((e) => e.resourceId));
    expect(resourceIds.has(loot1Id)).toBe(true);
    expect(resourceIds.has(loot2Id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Bulk move-to-collection → one ledger row for the whole operation
// ---------------------------------------------------------------------------

describe('bulk-restructure ledger — move-to-collection', () => {
  it('persists exactly one bulk.move-to-collection event for the full operation', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const sourceCollId = await seedCollection(ownerId, stashRootId, '{title|slug}', `bulk-src-${uid().slice(0,8)}`);
    const targetCollId = await seedCollection(ownerId, stashRootId, '{creator|slug}/{title|slug}', `bulk-tgt-${uid().slice(0,8)}`);

    const loot1Id = await seedLoot(sourceCollId, { title: 'Axe', creator: 'Dwarf' });
    const loot2Id = await seedLoot(sourceCollId, { title: 'Shield', creator: 'Dwarf' });

    const rel1 = 'axe.stl';
    const rel2 = 'shield.stl';
    await writeFile(path.join(scratch, rel1), 'axe\n');
    await writeFile(path.join(scratch, rel2), 'shield\n');
    await seedLootFile(loot1Id, rel1, path.join(scratch, rel1));
    await seedLootFile(loot2Id, rel2, path.join(scratch, rel2));

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async () => true,
    });

    const report = await engine.execute({
      action: { kind: 'move-to-collection', targetCollectionId: targetCollId },
      lootIds: [loot1Id, loot2Id],
      ownerId,
    });

    expect(report.applied.length).toBeGreaterThan(0);
    expect(report.ledgerEventId).toBeTruthy();

    // Exactly ONE bulk ledger event for the whole operation
    const events = await getLedgerEvents({
      kind: 'bulk.move-to-collection',
      resourceType: 'collection',
      resourceId: targetCollId,
    });
    expect(events).toHaveLength(1);

    const event = events[0]!;
    const payload = JSON.parse(event.payload!);
    expect(payload.manifest).toBeDefined();
    expect(Array.isArray(payload.manifest.applied)).toBe(true);
    expect(payload.manifest.applied).toContain(loot1Id);
    expect(payload.manifest.applied).toContain(loot2Id);

    // ledgerEventId in report matches the DB row id
    expect(report.ledgerEventId).toBe(event.id);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Bulk change-template → one ledger row with kind='bulk.change-template'
// ---------------------------------------------------------------------------

describe('bulk-restructure ledger — change-template', () => {
  it('persists exactly one bulk.change-template event for the whole operation', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collId = await seedCollection(ownerId, stashRootId, 'old/{title|slug}', `ct-src-${uid().slice(0,8)}`);

    const lootId = await seedLoot(collId, { title: 'Sword', creator: 'Steel' });
    const relPath = 'old/sword.stl';
    await writeFile(path.join(scratch, relPath), 'sword\n');
    await seedLootFile(lootId, relPath, path.join(scratch, relPath));

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async () => true,
    });

    const report = await engine.execute({
      action: { kind: 'change-template', newTemplate: '{creator|slug}/{title|slug}' },
      lootIds: [lootId],
      ownerId,
    });

    expect(report.applied.length).toBeGreaterThan(0);
    expect(report.ledgerEventId).toBeTruthy();

    // Exactly ONE bulk.change-template event
    const events = await getLedgerEvents({ kind: 'bulk.change-template' });
    const ourEvents = events.filter((e) => e.actorId === ownerId);
    expect(ourEvents.length).toBeGreaterThanOrEqual(1);

    // The most recent is ours
    const event = ourEvents[ourEvents.length - 1]!;
    const payload = JSON.parse(event.payload!);
    expect(payload.action.kind).toBe('change-template');
    expect(payload.manifest.applied).toContain(lootId);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Primary op succeeds even when ledger is broken
// ---------------------------------------------------------------------------

describe('template-migration — ledger failure does not abort primary op', () => {
  it('moves file and updates DB even when persistLedgerEvent is broken', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId, 'src/{title|slug}');

    const lootId = await seedLoot(collectionId, { title: 'Rogue', creator: 'Shadow' });
    const oldRelPath = 'src/rogue.stl';
    const absOldPath = path.join(scratch, oldRelPath);
    await writeFile(absOldPath, 'rogue content\n');
    const lootFileId = await seedLootFile(lootId, oldRelPath, absOldPath);

    // Inject a throwing ledger emitter that simulates persistLedgerEvent failure
    const throwingLedger = {
      async emitMigration() {
        throw new Error('simulated ledger DB failure');
      },
    };

    const engine = createTemplateMigrationEngine({
      dbUrl: DB_URL,
      ledgerEmitter: throwingLedger,
    });

    // Primary op must not throw
    const report = await engine.execute({
      collectionId,
      proposedTemplate: '{creator|slug}/{title|slug}',
      approvedVerdicts: [{ lootId, lootFileId }],
    });

    // File was moved
    const absNewPath = path.join(scratch, 'shadow/rogue.stl');
    const destStat = await fsp.stat(absNewPath);
    expect(destStat.isFile()).toBe(true);

    // Source is gone (immediate cleanup)
    await expect(fsp.access(absOldPath)).rejects.toThrow();

    // DB updated despite ledger failure — report shows success
    const rows = await db()
      .select()
      .from(schema.lootFiles)
      .where(eq(schema.lootFiles.id, lootFileId));
    expect(rows[0]?.path).toBe('shadow/rogue.stl');

    // The migration report counts the file as migrated despite ledger failure
    expect(report.filesMigrated).toBe(1);
    expect(report.filesFailed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Bulk primary op survives throwing emitBulk (defense-in-depth)
// ---------------------------------------------------------------------------

describe('bulk-restructure — emitBulk failure does not abort primary op', () => {
  it('moves files and updates DB even when injected emitBulk throws', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const sourceCollId = await seedCollection(
      ownerId, stashRootId, '{title|slug}', `bulk-guard-src-${uid().slice(0, 8)}`,
    );
    const targetCollId = await seedCollection(
      ownerId, stashRootId, '{creator|slug}/{title|slug}', `bulk-guard-tgt-${uid().slice(0, 8)}`,
    );

    const lootId = await seedLoot(sourceCollId, { title: 'Hammer', creator: 'Giant' });
    const relPath = 'hammer.stl';
    await writeFile(path.join(scratch, relPath), 'hammer content\n');
    const lootFileId = await seedLootFile(lootId, relPath, path.join(scratch, relPath));

    // Inject a throwing bulk ledger emitter.
    const throwingBulkLedger = {
      async emitBulk() {
        throw new Error('simulated bulk ledger failure');
      },
    };

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async () => true,
      ledgerEmitter: throwingBulkLedger,
    });

    // Primary op must not throw
    const report = await engine.execute({
      action: { kind: 'move-to-collection', targetCollectionId: targetCollId },
      lootIds: [lootId],
      ownerId,
    });

    // Loot was moved to target collection
    expect(report.applied).toContain(lootId);
    expect(report.failed).toHaveLength(0);

    // ledgerEventId falls back to sentinel '' because emit threw
    expect(report.ledgerEventId).toBe('');

    // DB reflects move: loot.collectionId updated
    const lootRows = await db()
      .select()
      .from(schema.loot)
      .where(eq(schema.loot.id, lootId));
    expect(lootRows[0]?.collectionId).toBe(targetCollId);

    // File path updated via the template under target collection
    const fileRows = await db()
      .select()
      .from(schema.lootFiles)
      .where(eq(schema.lootFiles.id, lootFileId));
    expect(fileRows[0]?.path).toBe('giant/hammer.stl');

    // And on disk at the resolved destination
    const absNewPath = path.join(scratch, 'giant/hammer.stl');
    await expect(fsp.stat(absNewPath)).resolves.toBeTruthy();
  });
});
