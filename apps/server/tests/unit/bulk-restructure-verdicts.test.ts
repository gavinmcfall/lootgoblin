/**
 * Unit tests for bulk-restructure verdict classification — V2-002-T10
 *
 * These are pure tests targeting the verdict shape returned by preview().
 * They use an injected aclCheck seam and a fake DB (via dbUrl pointing at a
 * non-existent file) — actually we use the aclCheck injection seam so no DB
 * is hit at all for ACL decisions, but we still need to test the engine's
 * classification logic.
 *
 * Since preview() requires DB access for Loot/Collection rows, we use the
 * real integration DB for structural tests but inject the aclCheck seam for
 * permission tests. The "pure" cases (loot-not-found, unchanged, etc.) are
 * exercised here with minimal setup via the injected seam.
 *
 * Test cases:
 *   1. Move action: loot ids not found → action-incompatible.
 *   2. Move action: ACL denies → permission-skipped.
 *   3. Move action: target collection not found → action-incompatible for all loots.
 *   4. Change-template: ACL denies → permission-skipped.
 *   5. Change-template: invalid template → action-incompatible for all loots.
 *   6. Change-template: unchanged path → unchanged verdict.
 *   7. Change-template: incompatible template (missing-field) → action-incompatible.
 *   8. Summary counts aggregate correctly for mixed verdicts.
 *
 * Note: Collision detection and full integration flows are covered in the
 * integration test file (bulk-restructure.test.ts).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  createBulkRestructureEngine,
} from '../../src/stash/bulk-restructure';

// ---------------------------------------------------------------------------
// DB setup (lightweight — only for Loot/Collection rows that do exist)
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-bulk-verdicts.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Bulk Verdicts Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string): Promise<string> {
  const id = uid();
  const tmpDir = await fsp.mkdtemp(path.join('/tmp', 'lootgoblin-bv-'));
  await db().insert(schema.stashRoots).values({
    id,
    ownerId,
    name: 'Verdicts Test Root',
    path: tmpDir,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(
  ownerId: string,
  stashRootId: string,
  pathTemplate: string,
): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id,
    ownerId,
    name: `Test Collection ${id.slice(0, 8)}`,
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
): Promise<string> {
  const id = uid();
  const ext = path.extname(relativePath).slice(1).toLowerCase() || 'bin';
  await db().insert(schema.lootFiles).values({
    id,
    lootId,
    path: relativePath,
    format: ext,
    size: 100,
    hash: '0000000000000000000000000000000000000000000000000000000000000000',
    origin: 'adoption',
    provenance: null,
    createdAt: new Date(),
  });
  return id;
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
// 1. Move action: loot ids not found → action-incompatible
// ---------------------------------------------------------------------------

describe('preview move-to-collection: loot ids not found', () => {
  it('classifies missing lootIds as action-incompatible with reason loot-not-found', async () => {
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId);
    const targetCollectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async () => true,
    });

    const fakeId1 = 'does-not-exist-1';
    const fakeId2 = 'does-not-exist-2';

    const preview = await engine.preview({
      action: { kind: 'move-to-collection', targetCollectionId },
      lootIds: [fakeId1, fakeId2],
      ownerId,
    });

    expect(preview.verdicts).toHaveLength(2);
    for (const v of preview.verdicts) {
      expect(v.kind).toBe('action-incompatible');
      if (v.kind === 'action-incompatible') {
        expect(v.reason).toBe('loot-not-found');
      }
    }
    expect(preview.summary.actionIncompatible).toBe(2);
    expect(preview.summary.ready).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Move action: ACL denies → permission-skipped
// ---------------------------------------------------------------------------

describe('preview move-to-collection: ACL denial', () => {
  it('classifies loots as permission-skipped when aclCheck returns false', async () => {
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId);
    const sourceCollectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');
    const targetCollectionId = await seedCollection(ownerId, stashRootId, '{creator|slug}/{title|slug}');

    const lootId1 = await seedLoot(sourceCollectionId, { title: 'Dragon Figurine', creator: 'bulka' });
    const lootId2 = await seedLoot(sourceCollectionId, { title: 'Cat Model', creator: 'artisan' });

    await seedLootFile(lootId1, 'legacy/dragon-figurine.stl');
    await seedLootFile(lootId2, 'legacy/cat-model.stl');

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async () => false, // deny everything
    });

    const preview = await engine.preview({
      action: { kind: 'move-to-collection', targetCollectionId },
      lootIds: [lootId1, lootId2],
      ownerId,
    });

    expect(preview.verdicts).toHaveLength(2);
    for (const v of preview.verdicts) {
      expect(v.kind).toBe('permission-skipped');
    }
    expect(preview.summary.permissionSkipped).toBe(2);
    expect(preview.summary.ready).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Move action: target collection not found → action-incompatible for all
// ---------------------------------------------------------------------------

describe('preview move-to-collection: target collection not found', () => {
  it('classifies all loots as action-incompatible when target collection does not exist', async () => {
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId);
    const sourceCollectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');
    const lootId = await seedLoot(sourceCollectionId, { title: 'Test Loot' });
    await seedLootFile(lootId, 'test/test-loot.stl');

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async () => true,
    });

    const preview = await engine.preview({
      action: { kind: 'move-to-collection', targetCollectionId: 'nonexistent-collection-id' },
      lootIds: [lootId],
      ownerId,
    });

    expect(preview.verdicts).toHaveLength(1);
    expect(preview.verdicts[0].kind).toBe('action-incompatible');
    if (preview.verdicts[0].kind === 'action-incompatible') {
      expect(preview.verdicts[0].reason).toContain('not found');
    }
    expect(preview.summary.actionIncompatible).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Change-template: ACL denies → permission-skipped
// ---------------------------------------------------------------------------

describe('preview change-template: ACL denial', () => {
  it('classifies loots as permission-skipped when aclCheck returns false', async () => {
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId);
    const collectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');
    const lootId = await seedLoot(collectionId, { title: 'Test Loot', creator: 'creator1' });
    await seedLootFile(lootId, 'test-loot.stl');

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async () => false,
    });

    const preview = await engine.preview({
      action: { kind: 'change-template', newTemplate: '{creator|slug}/{title|slug}' },
      lootIds: [lootId],
      ownerId,
    });

    expect(preview.verdicts).toHaveLength(1);
    expect(preview.verdicts[0].kind).toBe('permission-skipped');
    expect(preview.summary.permissionSkipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Change-template: invalid template syntax → action-incompatible for all
// ---------------------------------------------------------------------------

describe('preview change-template: invalid template', () => {
  it('classifies all loots as action-incompatible when template syntax is invalid', async () => {
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId);
    const collectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');
    const lootId1 = await seedLoot(collectionId, { title: 'Loot A' });
    const lootId2 = await seedLoot(collectionId, { title: 'Loot B' });

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async () => true,
    });

    const preview = await engine.preview({
      action: { kind: 'change-template', newTemplate: '{unclosed' }, // invalid syntax
      lootIds: [lootId1, lootId2],
      ownerId,
    });

    expect(preview.verdicts).toHaveLength(2);
    for (const v of preview.verdicts) {
      expect(v.kind).toBe('action-incompatible');
    }
    expect(preview.summary.actionIncompatible).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. Change-template: unchanged path → unchanged verdict
// ---------------------------------------------------------------------------

describe('preview change-template: unchanged path', () => {
  it('classifies a loot as unchanged when proposed path equals current path', async () => {
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId);
    // pathTemplate resolves to same path as the lootFile's current path
    const collectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');
    const lootId = await seedLoot(collectionId, { title: 'Dragon Figurine' });
    // The current path already matches what the template would resolve to
    await seedLootFile(lootId, 'dragon-figurine.stl');

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async () => true,
    });

    const preview = await engine.preview({
      action: { kind: 'change-template', newTemplate: '{title|slug}' },
      lootIds: [lootId],
      ownerId,
    });

    expect(preview.verdicts).toHaveLength(1);
    expect(preview.verdicts[0].kind).toBe('unchanged');
    expect(preview.summary.unchanged).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Change-template: missing required field → action-incompatible
// ---------------------------------------------------------------------------

describe('preview change-template: template-incompatible (missing field)', () => {
  it('classifies loot as action-incompatible when template requires a missing metadata field', async () => {
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId);
    const collectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');
    // Loot has no creator field
    const lootId = await seedLoot(collectionId, { title: 'No Creator Loot' });
    await seedLootFile(lootId, 'no-creator-loot.stl');

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async () => true,
    });

    // New template requires {creator} but loot has no creator
    const preview = await engine.preview({
      action: { kind: 'change-template', newTemplate: '{creator|slug}/{title|slug}' },
      lootIds: [lootId],
      ownerId,
    });

    expect(preview.verdicts).toHaveLength(1);
    expect(preview.verdicts[0].kind).toBe('action-incompatible');
    if (preview.verdicts[0].kind === 'action-incompatible') {
      expect(preview.verdicts[0].reason).toContain('missing-field');
    }
    expect(preview.summary.actionIncompatible).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Summary counts aggregate correctly for mixed verdicts
// ---------------------------------------------------------------------------

describe('preview: summary counts for mixed verdicts', () => {
  it('aggregates ready + permission-skipped + action-incompatible correctly', async () => {
    const ownerId = await seedUser();
    const stashRootId = await seedStashRoot(ownerId);
    const sourceCollectionId = await seedCollection(ownerId, stashRootId, '{title|slug}');
    const targetCollectionId = await seedCollection(ownerId, stashRootId, '{creator|slug}/{title|slug}');

    // Loot 1: has creator — will be ready (can move)
    const lootId1 = await seedLoot(sourceCollectionId, { title: 'With Creator', creator: 'bulka' });
    await seedLootFile(lootId1, 'with-creator.stl');

    // Loot 2: does not exist — action-incompatible
    const fakeId = 'nonexistent-loot-id-mixed';

    // Loot 3: ACL denied (we'll deny specifically for lootId3)
    const lootId3 = await seedLoot(sourceCollectionId, { title: 'ACL Denied', creator: 'artisan' });
    await seedLootFile(lootId3, 'acl-denied.stl');

    const engine = createBulkRestructureEngine({
      dbUrl: DB_URL,
      aclCheck: async ({ lootId }) => lootId !== lootId3, // deny loot3
    });

    const preview = await engine.preview({
      action: { kind: 'move-to-collection', targetCollectionId },
      lootIds: [lootId1, fakeId, lootId3],
      ownerId,
    });

    expect(preview.summary.ready).toBe(1);
    expect(preview.summary.actionIncompatible).toBe(1);
    expect(preview.summary.permissionSkipped).toBe(1);
    expect(preview.summary.collision).toBe(0);
    expect(preview.summary.unchanged).toBe(0);
  });
});
