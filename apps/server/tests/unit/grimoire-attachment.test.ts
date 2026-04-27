/**
 * Unit tests for GrimoireAttachment routes — V2-007a-T11.
 *
 * Real-DB-on-tmpfile pattern (mirrors grimoire-slicer-profile.test.ts).
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  attachToLoot,
  detachFromLoot,
  getAttachment,
  listAttachmentsForLoot,
  listAttachmentsForProfile,
  listAttachmentsForSetting,
} from '../../src/grimoire/attachment';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-grimoire-attachment-unit.db';
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
    name: 'Attach Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(ownerId: string): Promise<string> {
  const stashRootId = uid();
  await db().insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId,
    name: `Test Root ${stashRootId.slice(0, 6)}`,
    path: `/tmp/test-root-${stashRootId.slice(0, 6)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `Test Collection ${collectionId.slice(0, 8)}`,
    stashRootId,
    pathTemplate: '{title|slug}',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootId = uid();
  await db().insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: 'Dragon',
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return lootId;
}

async function seedSlicerProfile(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.slicerProfiles).values({
    id,
    ownerId,
    name: `Profile ${id.slice(0, 6)}`,
    slicerKind: 'bambu-studio',
    printerKind: 'bambu-x1',
    materialKind: 'petg',
    settingsPayload: { layer_height: 0.2 },
    opaqueUnsupported: false,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedPrintSetting(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.printSettings).values({
    id,
    ownerId,
    name: `Setting ${id.slice(0, 6)}`,
    settingsPayload: { infill_density: 25 },
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
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

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// attachToLoot — validation
// ---------------------------------------------------------------------------

describe('attachToLoot — validation', () => {
  it('1. both slicerProfileId AND printSettingId set → xor violation', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const profileId = await seedSlicerProfile(ownerId);
    const settingId = await seedPrintSetting(ownerId);

    const result = await attachToLoot(
      { ownerId, lootId, slicerProfileId: profileId, printSettingId: settingId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('attachment-target-xor-violation');
  });

  it('2. neither slicerProfileId nor printSettingId set → xor violation', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);

    const result = await attachToLoot({ ownerId, lootId }, { dbUrl: DB_URL });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('attachment-target-xor-violation');
  });

  it('3. only slicerProfileId set: happy path', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const profileId = await seedSlicerProfile(ownerId);

    const result = await attachToLoot(
      { ownerId, lootId, slicerProfileId: profileId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
  });

  it('4. only printSettingId set: happy path', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const settingId = await seedPrintSetting(ownerId);

    const result = await attachToLoot(
      { ownerId, lootId, printSettingId: settingId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
  });

  it('5. empty-string slicerProfileId treated as not-set (xor violation if both empty)', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);

    const result = await attachToLoot(
      { ownerId, lootId, slicerProfileId: '', printSettingId: '' },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('attachment-target-xor-violation');
  });

  it('5b. empty-string slicerProfileId + valid printSettingId is accepted', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const settingId = await seedPrintSetting(ownerId);

    const result = await attachToLoot(
      { ownerId, lootId, slicerProfileId: '', printSettingId: settingId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
  });

  it("6. lootId doesn't exist → loot-not-found", async () => {
    const ownerId = await seedUser();
    const profileId = await seedSlicerProfile(ownerId);

    const result = await attachToLoot(
      { ownerId, lootId: uid(), slicerProfileId: profileId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('loot-not-found');
  });

  it('7. lootId belongs to different owner → loot-not-found (no leak)', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const lootIdA = await seedLoot(ownerA);
    const profileIdB = await seedSlicerProfile(ownerB);

    const result = await attachToLoot(
      { ownerId: ownerB, lootId: lootIdA, slicerProfileId: profileIdB },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('loot-not-found');
  });

  it("8. slicerProfileId doesn't exist → profile-not-found", async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);

    const result = await attachToLoot(
      { ownerId, lootId, slicerProfileId: uid() },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('profile-not-found');
  });

  it('9. slicerProfileId belongs to different owner → profile-not-found', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const lootIdB = await seedLoot(ownerB);
    const profileIdA = await seedSlicerProfile(ownerA);

    const result = await attachToLoot(
      { ownerId: ownerB, lootId: lootIdB, slicerProfileId: profileIdA },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('profile-not-found');
  });

  it("10. printSettingId doesn't exist → setting-not-found", async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);

    const result = await attachToLoot(
      { ownerId, lootId, printSettingId: uid() },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('setting-not-found');
  });

  it('11. printSettingId belongs to different owner → setting-not-found', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const lootIdB = await seedLoot(ownerB);
    const settingIdA = await seedPrintSetting(ownerA);

    const result = await attachToLoot(
      { ownerId: ownerB, lootId: lootIdB, printSettingId: settingIdA },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('setting-not-found');
  });

  it('12. note empty after trim → invalid-note', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const profileId = await seedSlicerProfile(ownerId);

    const result = await attachToLoot(
      { ownerId, lootId, slicerProfileId: profileId, note: '   \t\n  ' },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-note');
  });

  it('13. note with valid content → trimmed + stored', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const profileId = await seedSlicerProfile(ownerId);

    const result = await attachToLoot(
      { ownerId, lootId, slicerProfileId: profileId, note: '  recommended for engineering parts  ' },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await getAttachment({ id: result.attachmentId, ownerId }, { dbUrl: DB_URL });
    expect(row?.note).toBe('recommended for engineering parts');
  });
});

// ---------------------------------------------------------------------------
// attachToLoot — happy paths (row shape, multiple, re-attach)
// ---------------------------------------------------------------------------

describe('attachToLoot — happy paths', () => {
  it('14. attach SlicerProfile: row has profile set, setting NULL, ownerId + attachedAt populated', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const profileId = await seedSlicerProfile(ownerId);
    const now = new Date('2026-04-25T10:00:00Z');

    const result = await attachToLoot(
      { ownerId, lootId, slicerProfileId: profileId },
      { dbUrl: DB_URL, now },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await db()
      .select()
      .from(schema.grimoireAttachments)
      .where(eq(schema.grimoireAttachments.id, result.attachmentId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.lootId).toBe(lootId);
    expect(row.slicerProfileId).toBe(profileId);
    expect(row.printSettingId).toBeNull();
    expect(row.ownerId).toBe(ownerId);
    expect(row.note).toBeNull();
    expect(row.attachedAt.getTime()).toBe(now.getTime());
  });

  it('15. attach PrintSetting: row has setting set, profile NULL', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const settingId = await seedPrintSetting(ownerId);

    const result = await attachToLoot(
      { ownerId, lootId, printSettingId: settingId },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await db()
      .select()
      .from(schema.grimoireAttachments)
      .where(eq(schema.grimoireAttachments.id, result.attachmentId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.printSettingId).toBe(settingId);
    expect(row.slicerProfileId).toBeNull();
  });

  it('16. multiple attachments to same Loot: profile + setting + another profile → all 3 rows', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const profileA = await seedSlicerProfile(ownerId);
    const profileB = await seedSlicerProfile(ownerId);
    const settingId = await seedPrintSetting(ownerId);

    const r1 = await attachToLoot(
      { ownerId, lootId, slicerProfileId: profileA },
      { dbUrl: DB_URL },
    );
    const r2 = await attachToLoot(
      { ownerId, lootId, printSettingId: settingId },
      { dbUrl: DB_URL },
    );
    const r3 = await attachToLoot(
      { ownerId, lootId, slicerProfileId: profileB },
      { dbUrl: DB_URL },
    );
    expect(r1.ok && r2.ok && r3.ok).toBe(true);

    const list = await listAttachmentsForLoot({ lootId, ownerId }, { dbUrl: DB_URL });
    expect(list).toHaveLength(3);
  });

  it('17. attach + detach + re-attach: works fine, no ghost records', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const profileId = await seedSlicerProfile(ownerId);

    const r1 = await attachToLoot(
      { ownerId, lootId, slicerProfileId: profileId },
      { dbUrl: DB_URL },
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const d = await detachFromLoot(
      { attachmentId: r1.attachmentId, ownerId },
      { dbUrl: DB_URL },
    );
    expect(d.ok).toBe(true);

    const r2 = await attachToLoot(
      { ownerId, lootId, slicerProfileId: profileId },
      { dbUrl: DB_URL },
    );
    expect(r2.ok).toBe(true);

    const list = await listAttachmentsForLoot({ lootId, ownerId }, { dbUrl: DB_URL });
    expect(list).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// detachFromLoot
// ---------------------------------------------------------------------------

describe('detachFromLoot', () => {
  it('18. happy path: deletes the row', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const profileId = await seedSlicerProfile(ownerId);

    const a = await attachToLoot(
      { ownerId, lootId, slicerProfileId: profileId },
      { dbUrl: DB_URL },
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const d = await detachFromLoot(
      { attachmentId: a.attachmentId, ownerId },
      { dbUrl: DB_URL },
    );
    expect(d.ok).toBe(true);

    const after = await getAttachment({ id: a.attachmentId, ownerId }, { dbUrl: DB_URL });
    expect(after).toBeNull();
  });

  it('19. cross-owner → attachment-not-found', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const lootIdA = await seedLoot(ownerA);
    const profileIdA = await seedSlicerProfile(ownerA);

    const a = await attachToLoot(
      { ownerId: ownerA, lootId: lootIdA, slicerProfileId: profileIdA },
      { dbUrl: DB_URL },
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const d = await detachFromLoot(
      { attachmentId: a.attachmentId, ownerId: ownerB },
      { dbUrl: DB_URL },
    );
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.reason).toBe('attachment-not-found');

    // The row is still there.
    const stillThere = await getAttachment(
      { id: a.attachmentId, ownerId: ownerA },
      { dbUrl: DB_URL },
    );
    expect(stillThere).not.toBeNull();
  });

  it('20. nonexistent attachmentId → attachment-not-found', async () => {
    const ownerId = await seedUser();
    const d = await detachFromLoot(
      { attachmentId: uid(), ownerId },
      { dbUrl: DB_URL },
    );
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.reason).toBe('attachment-not-found');
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('getAttachment', () => {
  it('21a. happy path returns the row', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const profileId = await seedSlicerProfile(ownerId);

    const a = await attachToLoot(
      { ownerId, lootId, slicerProfileId: profileId },
      { dbUrl: DB_URL },
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const row = await getAttachment({ id: a.attachmentId, ownerId }, { dbUrl: DB_URL });
    expect(row).not.toBeNull();
    expect(row?.id).toBe(a.attachmentId);
  });

  it('21b. cross-owner returns null', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const lootIdA = await seedLoot(ownerA);
    const profileIdA = await seedSlicerProfile(ownerA);

    const a = await attachToLoot(
      { ownerId: ownerA, lootId: lootIdA, slicerProfileId: profileIdA },
      { dbUrl: DB_URL },
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const row = await getAttachment(
      { id: a.attachmentId, ownerId: ownerB },
      { dbUrl: DB_URL },
    );
    expect(row).toBeNull();
  });
});

describe('listAttachmentsForLoot', () => {
  it('22. returns attachments matching loot+owner; sorted by attachedAt DESC', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const pA = await seedSlicerProfile(ownerId);
    const pB = await seedSlicerProfile(ownerId);
    const pC = await seedSlicerProfile(ownerId);

    const t1 = new Date('2026-04-01T00:00:00Z');
    const t2 = new Date('2026-04-02T00:00:00Z');
    const t3 = new Date('2026-04-03T00:00:00Z');

    const r1 = await attachToLoot(
      { ownerId, lootId, slicerProfileId: pA },
      { dbUrl: DB_URL, now: t1 },
    );
    const r2 = await attachToLoot(
      { ownerId, lootId, slicerProfileId: pB },
      { dbUrl: DB_URL, now: t2 },
    );
    const r3 = await attachToLoot(
      { ownerId, lootId, slicerProfileId: pC },
      { dbUrl: DB_URL, now: t3 },
    );
    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    if (!r1.ok || !r2.ok || !r3.ok) return;

    const list = await listAttachmentsForLoot({ lootId, ownerId }, { dbUrl: DB_URL });
    expect(list).toHaveLength(3);
    expect(list[0]!.id).toBe(r3.attachmentId);
    expect(list[1]!.id).toBe(r2.attachmentId);
    expect(list[2]!.id).toBe(r1.attachmentId);
  });

  it('23. cross-owner Loot → empty array (not error)', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const lootIdA = await seedLoot(ownerA);
    const profileIdA = await seedSlicerProfile(ownerA);

    await attachToLoot(
      { ownerId: ownerA, lootId: lootIdA, slicerProfileId: profileIdA },
      { dbUrl: DB_URL },
    );

    const list = await listAttachmentsForLoot(
      { lootId: lootIdA, ownerId: ownerB },
      { dbUrl: DB_URL },
    );
    expect(list).toEqual([]);
  });
});

describe('listAttachmentsForProfile', () => {
  it('24. returns ALL Loots that reference this profile', async () => {
    const ownerId = await seedUser();
    const lootA = await seedLoot(ownerId);
    const lootB = await seedLoot(ownerId);
    const profileId = await seedSlicerProfile(ownerId);

    await attachToLoot(
      { ownerId, lootId: lootA, slicerProfileId: profileId },
      { dbUrl: DB_URL },
    );
    await attachToLoot(
      { ownerId, lootId: lootB, slicerProfileId: profileId },
      { dbUrl: DB_URL },
    );
    // An unrelated attachment to a different profile, same loot.
    const otherProfile = await seedSlicerProfile(ownerId);
    await attachToLoot(
      { ownerId, lootId: lootA, slicerProfileId: otherProfile },
      { dbUrl: DB_URL },
    );

    const list = await listAttachmentsForProfile(
      { slicerProfileId: profileId, ownerId },
      { dbUrl: DB_URL },
    );
    expect(list).toHaveLength(2);
    const lootIds = new Set(list.map((r) => r.lootId));
    expect(lootIds).toEqual(new Set([lootA, lootB]));
  });

  it('26a. cross-owner profile → empty array', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const lootIdA = await seedLoot(ownerA);
    const profileIdA = await seedSlicerProfile(ownerA);

    await attachToLoot(
      { ownerId: ownerA, lootId: lootIdA, slicerProfileId: profileIdA },
      { dbUrl: DB_URL },
    );

    const list = await listAttachmentsForProfile(
      { slicerProfileId: profileIdA, ownerId: ownerB },
      { dbUrl: DB_URL },
    );
    expect(list).toEqual([]);
  });
});

describe('listAttachmentsForSetting', () => {
  it('25. returns ALL Loots that reference this setting', async () => {
    const ownerId = await seedUser();
    const lootA = await seedLoot(ownerId);
    const lootB = await seedLoot(ownerId);
    const settingId = await seedPrintSetting(ownerId);

    await attachToLoot(
      { ownerId, lootId: lootA, printSettingId: settingId },
      { dbUrl: DB_URL },
    );
    await attachToLoot(
      { ownerId, lootId: lootB, printSettingId: settingId },
      { dbUrl: DB_URL },
    );

    const list = await listAttachmentsForSetting(
      { printSettingId: settingId, ownerId },
      { dbUrl: DB_URL },
    );
    expect(list).toHaveLength(2);
    const lootIds = new Set(list.map((r) => r.lootId));
    expect(lootIds).toEqual(new Set([lootA, lootB]));
  });

  it('26b. cross-owner setting → empty array', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const lootIdA = await seedLoot(ownerA);
    const settingIdA = await seedPrintSetting(ownerA);

    await attachToLoot(
      { ownerId: ownerA, lootId: lootIdA, printSettingId: settingIdA },
      { dbUrl: DB_URL },
    );

    const list = await listAttachmentsForSetting(
      { printSettingId: settingIdA, ownerId: ownerB },
      { dbUrl: DB_URL },
    );
    expect(list).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cascade re-tests (defence — T2 already covers schema-level)
// ---------------------------------------------------------------------------

describe('cascade behaviour', () => {
  it('27. delete the SlicerProfile → its attachments cascade-delete', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const profileA = await seedSlicerProfile(ownerId);
    const profileB = await seedSlicerProfile(ownerId);

    await attachToLoot(
      { ownerId, lootId, slicerProfileId: profileA },
      { dbUrl: DB_URL },
    );
    await attachToLoot(
      { ownerId, lootId, slicerProfileId: profileB },
      { dbUrl: DB_URL },
    );

    let list = await listAttachmentsForLoot({ lootId, ownerId }, { dbUrl: DB_URL });
    expect(list).toHaveLength(2);

    // Direct schema-level delete (the slicer-profile route would do this and
    // we already cover that in its own test). We verify cascade itself here.
    await db().delete(schema.slicerProfiles).where(eq(schema.slicerProfiles.id, profileA));

    list = await listAttachmentsForLoot({ lootId, ownerId }, { dbUrl: DB_URL });
    expect(list).toHaveLength(1);
    expect(list[0]!.slicerProfileId).toBe(profileB);
  });

  it('28. delete the Loot → all its attachments cascade-delete', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const profileA = await seedSlicerProfile(ownerId);
    const settingA = await seedPrintSetting(ownerId);

    await attachToLoot(
      { ownerId, lootId, slicerProfileId: profileA },
      { dbUrl: DB_URL },
    );
    await attachToLoot(
      { ownerId, lootId, printSettingId: settingA },
      { dbUrl: DB_URL },
    );

    let list = await listAttachmentsForLoot({ lootId, ownerId }, { dbUrl: DB_URL });
    expect(list).toHaveLength(2);

    await db().delete(schema.loot).where(eq(schema.loot.id, lootId));

    list = await listAttachmentsForLoot({ lootId, ownerId }, { dbUrl: DB_URL });
    expect(list).toEqual([]);
  });
});
