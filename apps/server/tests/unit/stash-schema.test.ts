/**
 * Unit tests for the Stash pillar schema — V2-002-T1
 *
 * Tests:
 *   - runMigrations() applies migration 0007 cleanly against a fresh DB
 *   - Insert chain: user → stashRoot → collection → loot → lootFile +
 *                   lootSourceRecord + lootRelationship + quarantineItem
 *   - FK cascade: delete collection removes its loot rows
 *   - FK restrict: delete stashRoot that has a Collection → error
 *   - UNIQUE constraint on collections(ownerId, name)
 *   - UNIQUE constraint on lootSourceRecords(lootId, sourceType, sourceIdentifier)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { runMigrations, resetDbCache, getDb } from '../../src/db/client';
import {
  user,
  stashRoots,
  collections,
  loot,
  lootFiles,
  lootSourceRecords,
  lootRelationships,
  quarantineItems,
} from '../../src/db/schema';

const DB_PATH = '/tmp/lootgoblin-stash-schema.db';

// ---------------------------------------------------------------------------
// Setup — fresh DB with all migrations applied
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Unlink DB + SQLite sidecars to guarantee a clean slate across vitest runs.
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = `file:${DB_PATH}`;
  await runMigrations(`file:${DB_PATH}`);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function db() {
  return getDb(`file:${DB_PATH}`) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
}

function uid() {
  return crypto.randomUUID();
}

async function seedUser(id = uid()) {
  await db().insert(user).values({
    id,
    name: 'Test User',
    email: `${id}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string, id = uid()) {
  await db().insert(stashRoots).values({
    id,
    ownerId,
    name: 'Test Root',
    path: `/tmp/test-root-${id}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(ownerId: string, stashRootId: string, name = 'Test Collection', id = uid()) {
  await db().insert(collections).values({
    id,
    ownerId,
    name,
    pathTemplate: '{creator|slug}/{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(collectionId: string, id = uid()) {
  await db().insert(loot).values({
    id,
    collectionId,
    title: 'Test Loot',
    description: null,
    tags: [],
    creator: 'creator_name',
    license: null,
    sourceItemId: null,
    contentSummary: null,
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

// ---------------------------------------------------------------------------
// Insert chain
// ---------------------------------------------------------------------------

describe('Insert chain — user → stashRoot → collection → loot → lootFile + related', () => {
  it('inserts the full chain without error', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const collId = await seedCollection(userId, rootId, 'Full Chain Collection');
    const lootId = await seedLoot(collId);

    // lootFile
    const fileId = uid();
    await expect(
      db().insert(lootFiles).values({
        id: fileId,
        lootId,
        path: 'creator_name/test-loot/test-loot.3mf',
        format: '3mf',
        size: 1_234_567,
        hash: 'a'.repeat(64), // 64-char hex SHA-256
        origin: 'ingest',
        provenance: null,
        createdAt: new Date(),
      }),
    ).resolves.toBeDefined();

    // lootSourceRecord
    const srcId = uid();
    await expect(
      db().insert(lootSourceRecords).values({
        id: srcId,
        lootId,
        sourceType: 'makerworld',
        sourceUrl: 'https://makerworld.com/models/12345',
        sourceIdentifier: 'mw-12345',
        capturedAt: new Date(),
      }),
    ).resolves.toBeDefined();

    // lootRelationship
    const childLootId = await seedLoot(collId);
    const relId = uid();
    await expect(
      db().insert(lootRelationships).values({
        id: relId,
        parentLootId: lootId,
        childLootId,
        relationship: 'part-of',
        createdAt: new Date(),
      }),
    ).resolves.toBeDefined();

    // quarantineItem
    const qId = uid();
    await expect(
      db().insert(quarantineItems).values({
        id: qId,
        stashRootId: rootId,
        path: `/tmp/test-root-${rootId}/bad-file.stl`,
        reason: 'integrity-failed',
        details: { checksum_expected: 'abc', checksum_actual: 'def' },
        createdAt: new Date(),
        resolvedAt: null,
      }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FK cascade — delete collection removes its loot rows
// ---------------------------------------------------------------------------

describe('FK cascade — delete collection removes loot', () => {
  it('loot rows are gone after their collection is deleted', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const collId = await seedCollection(userId, rootId, 'Cascade Collection');
    const lootId = await seedLoot(collId);

    // Confirm the loot row exists.
    const before = await db().select().from(loot).where(
      (await import('drizzle-orm')).eq(loot.id, lootId),
    );
    expect(before).toHaveLength(1);

    // Delete the collection — should cascade to loot.
    await db().delete(collections).where(
      (await import('drizzle-orm')).eq(collections.id, collId),
    );

    const after = await db().select().from(loot).where(
      (await import('drizzle-orm')).eq(loot.id, lootId),
    );
    expect(after).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FK restrict — delete stashRoot blocked when Collection references it
// ---------------------------------------------------------------------------

describe('FK restrict — cannot delete stashRoot with Collections', () => {
  it('throws when deleting a stashRoot that still has a Collection', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    await seedCollection(userId, rootId, 'Blocker Collection');

    // Deleting the root should fail due to the RESTRICT FK on collections.stash_root_id.
    await expect(
      db().delete(stashRoots).where(
        (await import('drizzle-orm')).eq(stashRoots.id, rootId),
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// UNIQUE constraint — collections(ownerId, name)
// ---------------------------------------------------------------------------

describe('UNIQUE collections(ownerId, name)', () => {
  it('rejects a second collection with the same ownerId+name', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    await seedCollection(userId, rootId, 'Duplicate Name');

    await expect(
      db().insert(collections).values({
        id: uid(),
        ownerId: userId,
        name: 'Duplicate Name', // same name, same owner
        pathTemplate: '{creator|slug}/{title|slug}',
        stashRootId: rootId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('allows the same collection name for different owners', async () => {
    const userId1 = await seedUser();
    const userId2 = await seedUser();
    const rootId1 = await seedStashRoot(userId1);
    const rootId2 = await seedStashRoot(userId2);

    await seedCollection(userId1, rootId1, 'Shared Name');
    // Different owner — should succeed.
    await expect(
      db().insert(collections).values({
        id: uid(),
        ownerId: userId2,
        name: 'Shared Name',
        pathTemplate: '{creator|slug}/{title|slug}',
        stashRootId: rootId2,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// UNIQUE constraint — lootSourceRecords(lootId, sourceType, sourceIdentifier)
// ---------------------------------------------------------------------------

describe('UNIQUE lootSourceRecords(lootId, sourceType, sourceIdentifier)', () => {
  it('rejects two identical attribution records', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const collId = await seedCollection(userId, rootId, 'Dedup Source Collection');
    const lootId = await seedLoot(collId);

    await db().insert(lootSourceRecords).values({
      id: uid(),
      lootId,
      sourceType: 'makerworld',
      sourceUrl: 'https://makerworld.com/models/99999',
      sourceIdentifier: 'mw-99999',
      capturedAt: new Date(),
    });

    await expect(
      db().insert(lootSourceRecords).values({
        id: uid(),
        lootId,
        sourceType: 'makerworld',
        sourceIdentifier: 'mw-99999', // same triple
        sourceUrl: null,
        capturedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('allows same sourceType+identifier for different loot items', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const collId = await seedCollection(userId, rootId, 'Cross Loot Source');
    const lootId1 = await seedLoot(collId);
    const lootId2 = await seedLoot(collId);

    await db().insert(lootSourceRecords).values({
      id: uid(),
      lootId: lootId1,
      sourceType: 'printables',
      sourceIdentifier: 'p-777',
      sourceUrl: null,
      capturedAt: new Date(),
    });

    await expect(
      db().insert(lootSourceRecords).values({
        id: uid(),
        lootId: lootId2, // different loot — should succeed
        sourceType: 'printables',
        sourceIdentifier: 'p-777',
        sourceUrl: null,
        capturedAt: new Date(),
      }),
    ).resolves.toBeDefined();
  });

  it('allows multiple NULL sourceIdentifier rows for the same (lootId, sourceType) — intentional per schema comment', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const collId = await seedCollection(userId, rootId, 'Null Identifier Case');
    const lootId = await seedLoot(collId);

    await db().insert(lootSourceRecords).values({
      id: uid(),
      lootId,
      sourceType: 'manual',
      sourceIdentifier: null,
      sourceUrl: null,
      capturedAt: new Date(),
    });

    // Second row with same (lootId, sourceType, NULL) — SQLite treats NULLs as
    // distinct in UNIQUE indexes, so this is allowed by design.
    await expect(
      db().insert(lootSourceRecords).values({
        id: uid(),
        lootId,
        sourceType: 'manual',
        sourceIdentifier: null,
        sourceUrl: null,
        capturedAt: new Date(),
      }),
    ).resolves.toBeDefined();
  });
});
