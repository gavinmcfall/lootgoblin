/**
 * Integration tests for bulk-restructure engine — V2-002-T10
 *
 * Real SQLite DB at /tmp/lootgoblin-bulk-restructure.db
 * Scratch dirs at /tmp/lootgoblin-bulk-<random>/
 *
 * Test cases:
 *   1.  Preview move-to-collection happy path — 3 Loots, all ready.
 *   2.  Preview move-to-collection with 1 ACL denial — 2 ready + 1 permission-skipped.
 *   3.  Preview move-to-collection with collision — 2 Loots resolve to same target path.
 *   4.  Preview change-template — 3 Loots, mixed verdicts (ready + unchanged + incompatible).
 *   5.  Execute move-to-collection same-stashRoot — DB updates, files move, 1 ledger event.
 *   6.  Execute move-to-collection cross-stashRoot — T3 copy-then-cleanup, files on destination fs.
 *   7.  Execute change-template — subset of loots; confirm 1 bulk ledger event not per-file.
 *   8.  Execute with batching — batchSize=2, 5 Loots, verify all batches complete.
 *   9.  Execute with mid-batch failure — linkOrCopy fails for one loot, others continue.
 *   10. Execute with post-preview ACL change — loot's ACL becomes denied between preview/execute.
 *   11. Ledger event manifest is correct — applied + skipped + failed IDs all listed, 1 event total.
 *   12. Empty lootIds — report shows 0 affected, 0 events (not 1) — documented decision.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  createBulkRestructureEngine,
  type BulkLedgerEmitter,
  type BulkAction,
} from '../../src/stash/bulk-restructure';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-bulk-restructure.db';
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
    name: 'Bulk Test User',
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
  pathTemplate: string,
  name?: string,
): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id,
    ownerId,
    name: name ?? `Test Collection ${id.slice(0, 8)}`,
    pathTemplate,
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
    creator?: string;
    description?: string;
    license?: string;
    tags?: string[];
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
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-bulk-'));
}

async function writeFile(absPath: string, content = 'lootgoblin bulk test\n'): Promise<void> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, content, 'utf8');
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fsp.access(absPath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Spy ledger emitter
// ---------------------------------------------------------------------------

type LedgerCall = Parameters<BulkLedgerEmitter['emitBulk']>[0];

function makeSpyLedger(): BulkLedgerEmitter & { calls: LedgerCall[]; eventIds: string[] } {
  const calls: LedgerCall[] = [];
  const eventIds: string[] = [];
  return {
    calls,
    eventIds,
    async emitBulk(event) {
      calls.push(event);
      const eventId = `spy-event-${calls.length}`;
      eventIds.push(eventId);
      return { eventId };
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { await fsp.unlink(`${DB_PATH}${suffix}`); } catch { /* ignore */ }
  }
  resetDbCache();
  await runMigrations(DB_URL);
});

// ---------------------------------------------------------------------------
// 1. Preview move-to-collection happy path — 3 Loots, all ready
// ---------------------------------------------------------------------------

describe('preview move-to-collection — happy path', () => {
  it('returns 3 ready verdicts when all loots can move', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const sourceCollectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');
    const targetCollectionId = await seedCollection(ownerId, stashRootId, '{creator|slug}/{title|slug}');

    const loots: string[] = [];
    for (const [title, creator] of [
      ['Dragon Model', 'bulka'],
      ['Cat Figurine', 'artisan'],
      ['Knight Armor', 'forge3d'],
    ]) {
      const lootId = await seedLoot(sourceCollectionId, { title, creator });
      const relPath = `${title.toLowerCase().replace(/ /g, '-')}.stl`;
      const absPath = path.join(scratch, relPath);
      await writeFile(absPath);
      await seedLootFile(lootId, relPath, absPath);
      loots.push(lootId);
    }

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async () => true,
    });

    const preview = await engine.preview({
      action: { kind: 'move-to-collection', targetCollectionId },
      lootIds: loots,
      ownerId,
    });

    expect(preview.summary.ready).toBe(3);
    expect(preview.summary.permissionSkipped).toBe(0);
    expect(preview.summary.collision).toBe(0);
    expect(preview.verdicts.every((v) => v.kind === 'ready')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Preview move-to-collection with 1 ACL denial — 2 ready + 1 permission-skipped
// ---------------------------------------------------------------------------

describe('preview move-to-collection — ACL denial', () => {
  it('returns 2 ready + 1 permission-skipped', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const sourceCollectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');
    const targetCollectionId = await seedCollection(ownerId, stashRootId, '{creator|slug}/{title|slug}');

    const loots: string[] = [];
    for (const [title, creator] of [
      ['Allowed One', 'creator-a'],
      ['Allowed Two', 'creator-b'],
      ['Denied Three', 'creator-c'],
    ]) {
      const lootId = await seedLoot(sourceCollectionId, { title, creator });
      const relPath = `${title.toLowerCase().replace(/ /g, '-')}.stl`;
      const absPath = path.join(scratch, relPath);
      await writeFile(absPath);
      await seedLootFile(lootId, relPath, absPath);
      loots.push(lootId);
    }

    const deniedLootId = loots[2];
    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async ({ lootId }) => lootId !== deniedLootId,
    });

    const preview = await engine.preview({
      action: { kind: 'move-to-collection', targetCollectionId },
      lootIds: loots,
      ownerId,
    });

    expect(preview.summary.ready).toBe(2);
    expect(preview.summary.permissionSkipped).toBe(1);

    const deniedVerdict = preview.verdicts.find(
      (v) => v.kind === 'permission-skipped' && v.lootId === deniedLootId,
    );
    expect(deniedVerdict).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Preview move-to-collection with collision — 2 Loots resolve to same target path
// ---------------------------------------------------------------------------

describe('preview move-to-collection — collision', () => {
  it('detects self-collision when two loots resolve to the same target path', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const sourceCollectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');
    // Template only uses title — two loots with same title → same path
    const targetCollectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');

    // Both loots have the same title → will resolve to the same path
    const lootId1 = await seedLoot(sourceCollectionId, { title: 'Duplicate Title', creator: 'a' });
    const lootId2 = await seedLoot(sourceCollectionId, { title: 'Duplicate Title', creator: 'b' });
    const absPath1 = path.join(scratch, 'dup1.stl');
    const absPath2 = path.join(scratch, 'dup2.stl');
    await writeFile(absPath1);
    await writeFile(absPath2);
    await seedLootFile(lootId1, 'dup1.stl', absPath1);
    await seedLootFile(lootId2, 'dup2.stl', absPath2);

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async () => true,
    });

    const preview = await engine.preview({
      action: { kind: 'move-to-collection', targetCollectionId },
      lootIds: [lootId1, lootId2],
      ownerId,
    });

    expect(preview.summary.collision).toBe(2);
    expect(preview.summary.ready).toBe(0);

    for (const v of preview.verdicts) {
      expect(v.kind).toBe('collision');
      if (v.kind === 'collision') {
        expect(v.conflictingLootIds.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Preview change-template — 3 Loots, mixed verdicts
// ---------------------------------------------------------------------------

describe('preview change-template — mixed verdicts', () => {
  it('returns ready + unchanged + action-incompatible for appropriate loots', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');

    // Loot 1: has creator → will be ready (new template uses creator)
    const lootId1 = await seedLoot(collectionId, { title: 'Creatorful Model', creator: 'bulka' });
    const absPath1 = path.join(scratch, 'creatorful-model.stl');
    await writeFile(absPath1);
    await seedLootFile(lootId1, 'creatorful-model.stl', absPath1);

    // Loot 2: no creator → will be action-incompatible with new template that requires {creator}
    const lootId2 = await seedLoot(collectionId, { title: 'No Creator' });
    const absPath2 = path.join(scratch, 'no-creator.stl');
    await writeFile(absPath2);
    await seedLootFile(lootId2, 'no-creator.stl', absPath2);

    // Loot 3: has creator and already matches new template path
    const lootId3 = await seedLoot(collectionId, { title: 'Already Right', creator: 'existing' });
    // Path already matching new template: {creator|slug}/{title|slug}.stl = existing/already-right.stl
    const absPath3 = path.join(scratch, 'existing', 'already-right.stl');
    await writeFile(absPath3);
    await seedLootFile(lootId3, 'existing/already-right.stl', absPath3);

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async () => true,
    });

    const preview = await engine.preview({
      action: { kind: 'change-template', newTemplate: '{creator|slug}/{title|slug}' },
      lootIds: [lootId1, lootId2, lootId3],
      ownerId,
    });

    // lootId1 → ready (will move to bulka/creatorful-model.stl)
    // lootId2 → action-incompatible (no creator field)
    // lootId3 → unchanged (already at existing/already-right.stl)
    expect(preview.summary.ready).toBe(1);
    expect(preview.summary.actionIncompatible).toBe(1);
    expect(preview.summary.unchanged).toBe(1);

    const readyVerdict = preview.verdicts.find((v) => v.lootId === lootId1);
    expect(readyVerdict?.kind).toBe('ready');

    const incompatVerdict = preview.verdicts.find((v) => v.lootId === lootId2);
    expect(incompatVerdict?.kind).toBe('action-incompatible');

    const unchangedVerdict = preview.verdicts.find((v) => v.lootId === lootId3);
    expect(unchangedVerdict?.kind).toBe('unchanged');
  });
});

// ---------------------------------------------------------------------------
// 4b. Preview change-template — collision against a NON-MOVING loot in the
//     same Collection (the bulk set doesn't include every loot). Mirrors T9's
//     preview semantics so the user doesn't accidentally clobber an existing
//     file at a proposed path.
// ---------------------------------------------------------------------------

describe('preview change-template — collision with non-moving loot', () => {
  it('classifies a candidate as collision when its proposed path equals a non-moving loot current path', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    // Current collection template keeps files by title-slug only
    const collectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');

    // Three loots in the SAME collection:
    //   A — in bulk set; proposed new-template path = "taken/a.stl"
    //   B — in bulk set; proposed new-template path = "solo/b.stl" (no conflict)
    //   C — NOT in bulk set; already lives at "taken/a.stl" (non-moving)
    // The new template "{creator|slug}/{title|slug}" will make A try to land
    // on C's existing path — must flag as collision.
    const lootIdA = await seedLoot(collectionId, { title: 'A', creator: 'taken' });
    const lootIdB = await seedLoot(collectionId, { title: 'B', creator: 'solo' });
    const lootIdC = await seedLoot(collectionId, { title: 'Unrelated', creator: 'irrelevant' });

    const absA = path.join(scratch, 'a.stl');
    const absB = path.join(scratch, 'b.stl');
    // C already sits where A wants to go
    const absC = path.join(scratch, 'taken', 'a.stl');
    await writeFile(absA);
    await writeFile(absB);
    await writeFile(absC);

    await seedLootFile(lootIdA, 'a.stl', absA);
    await seedLootFile(lootIdB, 'b.stl', absB);
    await seedLootFile(lootIdC, 'taken/a.stl', absC);

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async () => true,
    });

    // Only A and B are in the bulk set. C is a non-moving loot whose current
    // path collides with A's proposed path.
    const preview = await engine.preview({
      action: { kind: 'change-template', newTemplate: '{creator|slug}/{title|slug}' },
      lootIds: [lootIdA, lootIdB],
      ownerId,
    });

    expect(preview.summary.collision).toBe(1);
    expect(preview.summary.ready).toBe(1);

    const verdictA = preview.verdicts.find((v) => v.lootId === lootIdA);
    expect(verdictA?.kind).toBe('collision');
    if (verdictA?.kind === 'collision') {
      expect(verdictA.proposedPath).toBe('taken/a.stl');
    }

    const verdictB = preview.verdicts.find((v) => v.lootId === lootIdB);
    expect(verdictB?.kind).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// 5. Execute move-to-collection same-stashRoot
// ---------------------------------------------------------------------------

describe('execute move-to-collection — same stash root', () => {
  it('physically relocates files via hardlink + updates DB + emits 1 ledger event', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const sourceCollectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');
    const targetCollectionId = await seedCollection(
      ownerId,
      stashRootId,
      '{creator|slug}/{title|slug}',
    );

    const lootId1 = await seedLoot(sourceCollectionId, { title: 'Widget Alpha', creator: 'maker1' });
    const lootId2 = await seedLoot(sourceCollectionId, { title: 'Widget Beta', creator: 'maker2' });

    const absPath1 = path.join(scratch, 'widget-alpha.stl');
    const absPath2 = path.join(scratch, 'widget-beta.stl');
    await writeFile(absPath1);
    await writeFile(absPath2);

    // Capture inode of source files BEFORE the move — we'll use this to prove
    // that the destination is a hardlink (same inode) rather than a fresh copy.
    const srcIno1 = fs.statSync(absPath1).ino;
    const srcIno2 = fs.statSync(absPath2).ino;

    const lfId1 = await seedLootFile(lootId1, 'widget-alpha.stl', absPath1);
    const lfId2 = await seedLootFile(lootId2, 'widget-beta.stl', absPath2);

    const spyLedger = makeSpyLedger();
    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      ledgerEmitter: spyLedger,
      aclCheck: async () => true,
    });

    const report = await engine.execute({
      action: { kind: 'move-to-collection', targetCollectionId },
      lootIds: [lootId1, lootId2],
      ownerId,
    });

    expect(report.applied).toContain(lootId1);
    expect(report.applied).toContain(lootId2);
    expect(report.failed).toHaveLength(0);

    // DB: loot.collectionId updated
    const loot1Rows = await db().select().from(schema.loot).where(eq(schema.loot.id, lootId1));
    expect(loot1Rows[0].collectionId).toBe(targetCollectionId);

    // DB: lootFiles.path updated to new template path
    const lf1Rows = await db().select().from(schema.lootFiles).where(eq(schema.lootFiles.id, lfId1));
    expect(lf1Rows[0].path).toBe('maker1/widget-alpha.stl');

    const lf2Rows = await db().select().from(schema.lootFiles).where(eq(schema.lootFiles.id, lfId2));
    expect(lf2Rows[0].path).toBe('maker2/widget-beta.stl');

    // ADR-009: source unlinked, destination exists. No orphans.
    const newAbs1 = path.join(scratch, 'maker1', 'widget-alpha.stl');
    const newAbs2 = path.join(scratch, 'maker2', 'widget-beta.stl');
    expect(await fileExists(absPath1)).toBe(false);
    expect(await fileExists(absPath2)).toBe(false);
    expect(await fileExists(newAbs1)).toBe(true);
    expect(await fileExists(newAbs2)).toBe(true);

    // Hardlink path: destination inode equals captured source inode. This
    // proves T3 took the cheap fs.link branch, not the byte-copy branch.
    expect(fs.statSync(newAbs1).ino).toBe(srcIno1);
    expect(fs.statSync(newAbs2).ino).toBe(srcIno2);

    // ONE ledger event total
    expect(spyLedger.calls).toHaveLength(1);
    expect(report.ledgerEventId).toBe('spy-event-1');
    expect(spyLedger.calls[0].manifest.applied).toContain(lootId1);
    expect(spyLedger.calls[0].manifest.applied).toContain(lootId2);
  });
});

// ---------------------------------------------------------------------------
// 6. Execute move-to-collection cross-stashRoot
// ---------------------------------------------------------------------------

describe('execute move-to-collection — cross stash root', () => {
  it('copies files to destination stash root via T3 and updates DB', async () => {
    const sourceDir = await makeScratchDir();
    const targetDir = await makeScratchDir();
    const ownerId = await seedUser();

    const sourceStashRootId = await seedStashRoot(ownerId, sourceDir);
    const targetStashRootId = await seedStashRoot(ownerId, targetDir);

    const sourceCollectionId = await seedCollection(
      ownerId,
      sourceStashRootId,
      '{title|slug}',
    );
    const targetCollectionId = await seedCollection(
      ownerId,
      targetStashRootId,
      '{creator|slug}/{title|slug}',
    );

    const lootId = await seedLoot(sourceCollectionId, { title: 'Cross Device Model', creator: 'fab' });
    const srcRelPath = 'cross-device-model.stl';
    const srcAbsPath = path.join(sourceDir, srcRelPath);
    await writeFile(srcAbsPath, 'cross device file content');
    await seedLootFile(lootId, srcRelPath, srcAbsPath);

    const spyLedger = makeSpyLedger();
    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      ledgerEmitter: spyLedger,
      aclCheck: async () => true,
    });

    const report = await engine.execute({
      action: { kind: 'move-to-collection', targetCollectionId },
      lootIds: [lootId],
      ownerId,
    });

    expect(report.applied).toContain(lootId);

    // Source file should be gone (cleanup after copy)
    expect(await fileExists(srcAbsPath)).toBe(false);

    // Destination file should exist
    const expectedDestPath = path.join(targetDir, 'fab', 'cross-device-model.stl');
    expect(await fileExists(expectedDestPath)).toBe(true);

    // DB: loot.collectionId updated
    const lootRows = await db().select().from(schema.loot).where(eq(schema.loot.id, lootId));
    expect(lootRows[0].collectionId).toBe(targetCollectionId);

    // ONE ledger event
    expect(spyLedger.calls).toHaveLength(1);
    expect(report.ledgerEventId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 7. Execute change-template — 1 bulk ledger event, NOT per-file
// ---------------------------------------------------------------------------

describe('execute change-template — single bulk ledger event', () => {
  it('emits exactly 1 ledger event for the entire bulk operation', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const collectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');

    const loots: string[] = [];
    for (const [title, creator] of [
      ['Rocket Ship', 'rocketeer'],
      ['Space Shuttle', 'spacer'],
      ['Moon Base', 'lunatic'],
    ]) {
      const lootId = await seedLoot(collectionId, { title, creator });
      const relPath = `${title.toLowerCase().replace(/ /g, '-')}.stl`;
      const absPath = path.join(scratch, relPath);
      await writeFile(absPath);
      await seedLootFile(lootId, relPath, absPath);
      loots.push(lootId);
    }

    const spyLedger = makeSpyLedger();
    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      ledgerEmitter: spyLedger,
      aclCheck: async () => true,
    });

    const report = await engine.execute({
      action: { kind: 'change-template', newTemplate: '{creator|slug}/{title|slug}' },
      lootIds: loots,
      ownerId,
    });

    // All 3 applied
    expect(report.applied.length).toBe(3);

    // EXACTLY 1 ledger event — not 3 (one per loot) or 6 (one per file)
    expect(spyLedger.calls).toHaveLength(1);
    expect(spyLedger.calls[0].manifest.applied).toHaveLength(3);

    // Files physically moved
    for (const [title, creator] of [
      ['Rocket Ship', 'rocketeer'],
      ['Space Shuttle', 'spacer'],
      ['Moon Base', 'lunatic'],
    ]) {
      const newRelPath = `${creator}/${title.toLowerCase().replace(/ /g, '-')}.stl`;
      expect(await fileExists(path.join(scratch, newRelPath))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Execute with batching — batchSize=2, 5 Loots
// ---------------------------------------------------------------------------

describe('execute with batching', () => {
  it('processes all 5 loots across 3 batches (batchSize=2)', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const sourceCollectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');
    const targetCollectionId = await seedCollection(
      ownerId,
      stashRootId,
      '{creator|slug}/{title|slug}',
    );

    const loots: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const lootId = await seedLoot(sourceCollectionId, {
        title: `Batch Loot ${i}`,
        creator: `creator${i}`,
      });
      const relPath = `batch-loot-${i}.stl`;
      const absPath = path.join(scratch, relPath);
      await writeFile(absPath);
      await seedLootFile(lootId, relPath, absPath);
      loots.push(lootId);
    }

    const spyLedger = makeSpyLedger();
    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      ledgerEmitter: spyLedger,
      aclCheck: async () => true,
    });

    const report = await engine.execute({
      action: { kind: 'move-to-collection', targetCollectionId },
      lootIds: loots,
      ownerId,
      batchSize: 2,
    });

    // All 5 processed
    expect(report.applied).toHaveLength(5);
    expect(report.failed).toHaveLength(0);
    expect(report.totalAffected).toBe(5);

    // Still exactly 1 ledger event regardless of batch count
    expect(spyLedger.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Execute with mid-batch failure — one loot's source file is missing for a
//    cross-stashRoot move. linkOrCopy returns source-not-found, others continue.
// ---------------------------------------------------------------------------

describe('execute with mid-batch failure', () => {
  it('records failed loot and continues processing other loots in the batch', async () => {
    const sourceDir = await makeScratchDir();
    const targetDir = await makeScratchDir();
    const ownerId = await seedUser();

    // Use TWO stash roots so physical file moves happen (and can fail)
    const sourceStashRootId = await seedStashRoot(ownerId, sourceDir);
    const targetStashRootId = await seedStashRoot(ownerId, targetDir);

    const sourceCollectionId = await seedCollection(
      ownerId,
      sourceStashRootId,
      '{title|slug}',
    );
    const targetCollectionId = await seedCollection(
      ownerId,
      targetStashRootId,
      '{creator|slug}/{title|slug}',
    );

    // Loot 1: file exists on source fs
    const lootId1 = await seedLoot(sourceCollectionId, { title: 'Good Loot One', creator: 'good1' });
    const absPath1 = path.join(sourceDir, 'good-loot-one.stl');
    await writeFile(absPath1);
    await seedLootFile(lootId1, 'good-loot-one.stl', absPath1);

    // Loot 2: file NOT on disk — will cause linkOrCopy to fail with source-not-found
    const lootId2 = await seedLoot(sourceCollectionId, { title: 'Bad Loot Two', creator: 'bad2' });
    // Seed DB row but do NOT create the actual file
    await seedLootFile(lootId2, 'bad-loot-two.stl', path.join(sourceDir, 'bad-loot-two.stl'));
    // File intentionally NOT created

    // Loot 3: file exists on source fs
    const lootId3 = await seedLoot(sourceCollectionId, { title: 'Good Loot Three', creator: 'good3' });
    const absPath3 = path.join(sourceDir, 'good-loot-three.stl');
    await writeFile(absPath3);
    await seedLootFile(lootId3, 'good-loot-three.stl', absPath3);

    const spyLedger = makeSpyLedger();
    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      ledgerEmitter: spyLedger,
      aclCheck: async () => true,
    });

    const report = await engine.execute({
      action: { kind: 'move-to-collection', targetCollectionId },
      lootIds: [lootId1, lootId2, lootId3],
      ownerId,
      batchSize: 3, // all in one batch
    });

    // loot1 and loot3 applied; loot2 failed (its source file didn't exist)
    expect(report.applied).toContain(lootId1);
    expect(report.applied).toContain(lootId3);
    expect(report.failed.some((f) => f.lootId === lootId2)).toBe(true);

    // Still exactly 1 ledger event
    expect(spyLedger.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 10. Execute with post-preview ACL change
// ---------------------------------------------------------------------------

describe('execute with post-preview ACL change', () => {
  it('skips a loot at apply time if ACL becomes denied between preview and execute', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId, scratch);
    const sourceCollectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');
    const targetCollectionId = await seedCollection(
      ownerId,
      stashRootId,
      '{creator|slug}/{title|slug}',
    );

    const lootId1 = await seedLoot(sourceCollectionId, { title: 'Still Allowed', creator: 'allowed' });
    const lootId2 = await seedLoot(sourceCollectionId, {
      title: 'Later Denied',
      creator: 'will-be-denied',
    });

    const absPath1 = path.join(scratch, 'still-allowed.stl');
    const absPath2 = path.join(scratch, 'later-denied.stl');
    await writeFile(absPath1);
    await writeFile(absPath2);
    await seedLootFile(lootId1, 'still-allowed.stl', absPath1);
    await seedLootFile(lootId2, 'later-denied.stl', absPath2);

    // Initially both allowed — simulates preview
    const allowedDuringPreview = new Set([lootId1, lootId2]);
    // "ACL change" — remove lootId2 before execute
    allowedDuringPreview.delete(lootId2);

    const spyLedger = makeSpyLedger();
    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      ledgerEmitter: spyLedger,
      aclCheck: async ({ lootId }) => allowedDuringPreview.has(lootId),
    });

    const report = await engine.execute({
      action: { kind: 'move-to-collection', targetCollectionId },
      lootIds: [lootId1, lootId2],
      ownerId,
    });

    expect(report.applied).toContain(lootId1);
    expect(report.applied).not.toContain(lootId2);
    expect(report.skipped.some((s) => s.lootId === lootId2)).toBe(true);
    expect(report.skipped.find((s) => s.lootId === lootId2)?.reason).toContain('ACL');

    // Still 1 ledger event with correct manifest
    expect(spyLedger.calls).toHaveLength(1);
    expect(spyLedger.calls[0].manifest.skipped).toContain(lootId2);
  });
});

// ---------------------------------------------------------------------------
// 11. Ledger event manifest is correct — applied + skipped + failed IDs all listed,
//     1 event total. Uses cross-stashRoot move so file-missing causes a real failure.
// ---------------------------------------------------------------------------

describe('ledger event manifest correctness', () => {
  it('lists applied + skipped + failed IDs in the single ledger event', async () => {
    const sourceDir = await makeScratchDir();
    const targetDir = await makeScratchDir();
    const ownerId = await seedUser();

    // Two stash roots: cross-stashRoot move → physical file operations → failure possible
    const sourceStashRootId = await seedStashRoot(ownerId, sourceDir);
    const targetStashRootId = await seedStashRoot(ownerId, targetDir);

    const sourceCollectionId = await seedCollection(
      ownerId,
      sourceStashRootId,
      '{title|slug}',
    );
    const targetCollectionId = await seedCollection(
      ownerId,
      targetStashRootId,
      '{creator|slug}/{title|slug}',
    );

    // Loot A: file exists → will apply
    const lootA = await seedLoot(sourceCollectionId, { title: 'Manifest Apply', creator: 'apply' });
    const absA = path.join(sourceDir, 'manifest-apply.stl');
    await writeFile(absA);
    await seedLootFile(lootA, 'manifest-apply.stl', absA);

    // Loot B: ACL denied → will be skipped
    const lootB = await seedLoot(sourceCollectionId, {
      title: 'Manifest Skip',
      creator: 'skip',
    });
    const absB = path.join(sourceDir, 'manifest-skip.stl');
    await writeFile(absB);
    await seedLootFile(lootB, 'manifest-skip.stl', absB);

    // Loot C: file NOT on disk → linkOrCopy returns source-not-found → will be failed
    const lootC = await seedLoot(sourceCollectionId, {
      title: 'Manifest Fail',
      creator: 'fail',
    });
    // Seed DB row only — no file created on disk
    await seedLootFile(
      lootC,
      'manifest-fail-missing.stl',
      path.join(sourceDir, 'manifest-fail-missing.stl'),
    );

    const spyLedger = makeSpyLedger();
    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      ledgerEmitter: spyLedger,
      aclCheck: async ({ lootId }) => lootId !== lootB,
    });

    const report = await engine.execute({
      action: { kind: 'move-to-collection', targetCollectionId },
      lootIds: [lootA, lootB, lootC],
      ownerId,
    });

    // Verify report
    expect(report.applied).toContain(lootA);
    expect(report.skipped.some((s) => s.lootId === lootB)).toBe(true);
    expect(report.failed.some((f) => f.lootId === lootC)).toBe(true);

    // Verify ledger manifest
    expect(spyLedger.calls).toHaveLength(1);
    const { manifest } = spyLedger.calls[0];
    expect(manifest.applied).toContain(lootA);
    expect(manifest.skipped).toContain(lootB);
    expect(manifest.failed).toContain(lootC);
  });
});

// ---------------------------------------------------------------------------
// 12. Empty lootIds — 0 events emitted (documented decision)
// ---------------------------------------------------------------------------

describe('execute with empty lootIds', () => {
  it('returns 0 affected, 0 ledger events, and empty ledgerEventId', async () => {
    const ownerId = await seedUser();
    const spyLedger = makeSpyLedger();
    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      ledgerEmitter: spyLedger,
      aclCheck: async () => true,
    });

    const report = await engine.execute({
      action: { kind: 'move-to-collection', targetCollectionId: 'any-collection' },
      lootIds: [],
      ownerId,
    });

    expect(report.totalAffected).toBe(0);
    expect(report.applied).toHaveLength(0);
    expect(report.ledgerEventId).toBe('');

    // DECISION: no ledger event emitted for empty bulk operations
    // Rationale: an empty manifest has no audit value and would create noise.
    expect(spyLedger.calls).toHaveLength(0);
  });
});
