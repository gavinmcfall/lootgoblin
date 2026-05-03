/**
 * V2-005e-T_e3: Matcher orchestration — DB-backed, with real sidecar +
 * heuristic modules. Covers the three terminal outcomes:
 *
 *   - Tier 1 sidecar match → parent_loot_id is set, pendingPairingId null.
 *   - Tier 3 fallback     → no sidecar / no heuristic match → pending row
 *                           inserted with the slice's basename as hint.
 *
 * The Tier 2 heuristic path is exercised end-to-end by the integration
 * suite where many candidate Loot rows are seeded.
 */

import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import JSZip from 'jszip';

import {
  runMigrations,
  resetDbCache,
  getDb,
  schema,
} from '../../src/db/client';
import { matchSliceArrival } from '../../src/forge/slice-pairings/matcher';

const DB_PATH = '/tmp/lootgoblin-slice-pairings-matcher.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}

const uid = (): string => crypto.randomUUID();

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
});

beforeEach(async () => {
  const dbc = db();
  await dbc.delete(schema.forgePendingPairings);
  await dbc.delete(schema.lootFiles);
  await dbc.delete(schema.loot);
  await dbc.delete(schema.collections);
  await dbc.delete(schema.stashRoots);
  await dbc.delete(schema.forgeInboxes);
  await dbc.delete(schema.user);
});

async function seedOwnerWithCollection(): Promise<{
  ownerId: string;
  collectionId: string;
}> {
  const ownerId = uid();
  await db().insert(schema.user).values({
    id: ownerId,
    name: `matcher-${ownerId.slice(0, 6)}`,
    email: `${ownerId}@matcher.test`,
    emailVerified: false,
    role: 'user',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const stashRootId = uid();
  await db().insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId,
    name: 'root',
    path: '/tmp/matcher-root',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `c-${collectionId.slice(0, 4)}`,
    pathTemplate: '{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { ownerId, collectionId };
}

async function seedSourceLoot(
  collectionId: string,
  title: string,
): Promise<string> {
  const id = uid();
  await db().insert(schema.loot).values({
    id,
    collectionId,
    title,
    description: null,
    tags: [],
    creator: null,
    license: null,
    sourceItemId: null,
    contentSummary: null,
    fileMissing: false,
    parentLootId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function buildThreemfWithSource(
  scratch: string,
  filename: string,
  sourceFile: string,
): Promise<string> {
  const filePath = path.join(scratch, filename);
  const zip = new JSZip();
  zip.file(
    'Metadata/model_settings.config',
    `<?xml version="1.0"?><config><object id="1"><metadata key="source_file" value="${sourceFile}"/></object></config>`,
  );
  await fsp.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  return filePath;
}

describe('matchSliceArrival — Tier 1 sidecar', () => {
  it('sets parent_loot_id when sidecar names a known source basename', async () => {
    const { ownerId, collectionId } = await seedOwnerWithCollection();
    const sourceLootId = await seedSourceLoot(collectionId, 'cube.stl');

    const inboxId = uid();
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'matcher-tier1-'));
    await db().insert(schema.forgeInboxes).values({
      id: inboxId,
      ownerId,
      name: 'i',
      path: scratch,
      defaultPrinterId: null,
      active: true,
      notes: null,
      createdAt: new Date(),
    });
    const inbox = (
      await db()
        .select()
        .from(schema.forgeInboxes)
        .where(eq(schema.forgeInboxes.id, inboxId))
    )[0]!;

    const filePath = await buildThreemfWithSource(scratch, 'plate_1.gcode.3mf', 'cube.stl');
    const result = await matchSliceArrival({ inbox, filePath });

    expect(result.sliceLootId).not.toBeNull();
    expect(result.parentLootId).toBe(sourceLootId);
    expect(result.pendingPairingId).toBeNull();

    const slice = (
      await db()
        .select()
        .from(schema.loot)
        .where(eq(schema.loot.id, result.sliceLootId!))
    )[0]!;
    expect(slice.parentLootId).toBe(sourceLootId);
  });
});

describe('matchSliceArrival — Tier 3 fallback', () => {
  it('queues a pending pairing when no sidecar / no heuristic match', async () => {
    const { ownerId, collectionId } = await seedOwnerWithCollection();
    // A source Loot whose title shares no bigrams with the slice basename.
    await seedSourceLoot(collectionId, 'wholly-unrelated-thing');

    const inboxId = uid();
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'matcher-tier3-'));
    await db().insert(schema.forgeInboxes).values({
      id: inboxId,
      ownerId,
      name: 'i',
      path: scratch,
      defaultPrinterId: null,
      active: true,
      notes: null,
      createdAt: new Date(),
    });
    const inbox = (
      await db()
        .select()
        .from(schema.forgeInboxes)
        .where(eq(schema.forgeInboxes.id, inboxId))
    )[0]!;

    const filePath = path.join(scratch, 'mystery_xyz.gcode');
    await fsp.writeFile(filePath, '; not a slicer-tagged header\nG28\n');

    const result = await matchSliceArrival({ inbox, filePath });

    expect(result.sliceLootId).not.toBeNull();
    expect(result.parentLootId).toBeNull();
    expect(result.pendingPairingId).not.toBeNull();

    const pending = (
      await db()
        .select()
        .from(schema.forgePendingPairings)
        .where(eq(schema.forgePendingPairings.id, result.pendingPairingId!))
    )[0]!;
    expect(pending.sliceLootId).toBe(result.sliceLootId);
    expect(pending.sourceFilenameHint).toBe('mystery_xyz.gcode');
    expect(pending.resolvedAt).toBeNull();
  });

  it('skips ingest when the owner has no Collection', async () => {
    const ownerId = uid();
    await db().insert(schema.user).values({
      id: ownerId,
      name: `no-coll-${ownerId.slice(0, 6)}`,
      email: `${ownerId}@matcher.test`,
      emailVerified: false,
      role: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const inboxId = uid();
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'matcher-no-coll-'));
    await db().insert(schema.forgeInboxes).values({
      id: inboxId,
      ownerId,
      name: 'i',
      path: scratch,
      defaultPrinterId: null,
      active: true,
      notes: null,
      createdAt: new Date(),
    });
    const inbox = (
      await db()
        .select()
        .from(schema.forgeInboxes)
        .where(eq(schema.forgeInboxes.id, inboxId))
    )[0]!;
    const filePath = path.join(scratch, 'something.gcode');
    await fsp.writeFile(filePath, 'G28\n');

    const result = await matchSliceArrival({ inbox, filePath });
    expect(result.sliceLootId).toBeNull();
    expect(result.skipReason).toBe('no-collection-for-owner');
  });
});
