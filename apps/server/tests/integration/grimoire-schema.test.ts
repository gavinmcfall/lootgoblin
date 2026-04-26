/**
 * Integration tests for the Grimoire schema — V2-007a-T2
 *
 * Real SQLite DB at /tmp/lootgoblin-t2-grimoire.db
 *
 * Coverage:
 *   1. Migration applies cleanly to a fresh DB (slicer_profiles, print_settings,
 *      grimoire_attachments).
 *   2. Insert SlicerProfile across enum combinations.
 *   3. Insert a PrintSetting.
 *   4. Insert an attachment linking Loot → SlicerProfile (printSettingId NULL).
 *   5. Insert an attachment linking Loot → PrintSetting (slicerProfileId NULL).
 *   6. DB allows both "neither set" and "both set" — XOR is app-layer only.
 *   7. FK enforcement: attachment with non-existent loot_id fails.
 *   8. FK enforcement: attachment with non-existent slicer_profile_id fails.
 *   9. Cascade: deleting the user removes profiles + settings + attachments.
 *  10. Cascade: deleting the loot removes its attachments.
 *  11. Cascade: deleting a slicer profile removes referencing attachments.
 *  12. Cascade: deleting a print setting removes referencing attachments.
 *  13. Expected indexes are present.
 *  14. JSON column round-trip — settings_payload deep-equal across write/read.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  SLICER_KINDS,
  PRINTER_KINDS,
  PROFILE_MATERIAL_KINDS,
} from '../../src/grimoire/types';

const DB_PATH = '/tmp/lootgoblin-t2-grimoire.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

function now(): Date {
  return new Date();
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

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Grimoire Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

async function seedLoot(ownerId: string): Promise<string> {
  // Need stash_root → collection → loot.
  const rootId = uid();
  await db().insert(schema.stashRoots).values({
    id: rootId,
    ownerId,
    name: 'Grimoire Root',
    path: '/tmp/grimoire-test-root',
  });

  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `Grimoire Collection ${collectionId.slice(0, 8)}`,
    pathTemplate: '{title|slug}',
    stashRootId: rootId,
  });

  const lootId = uid();
  await db().insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: 'Test Dragon',
  });
  return lootId;
}

async function seedSlicerProfile(opts: {
  ownerId: string;
  slicerKind?: string;
  printerKind?: string;
  materialKind?: string;
  settings?: Record<string, unknown>;
}): Promise<string> {
  const id = uid();
  await db().insert(schema.slicerProfiles).values({
    id,
    ownerId: opts.ownerId,
    name: `Profile ${id.slice(0, 8)}`,
    slicerKind: opts.slicerKind ?? 'bambu-studio',
    printerKind: opts.printerKind ?? 'bambu-x1',
    materialKind: opts.materialKind ?? 'pla',
    settingsPayload: opts.settings ?? { layer_height: 0.2, infill_density: 15 },
  });
  return id;
}

async function seedPrintSetting(opts: {
  ownerId: string;
  settings?: Record<string, unknown>;
}): Promise<string> {
  const id = uid();
  await db().insert(schema.printSettings).values({
    id,
    ownerId: opts.ownerId,
    name: `Setting ${id.slice(0, 8)}`,
    settingsPayload: opts.settings ?? { supports: false, brim_width_mm: 3 },
  });
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V2-007a-T2 grimoire schema migration', () => {
  it('1. migrations applied — all new tables exist', () => {
    const sqlite = (
      db() as unknown as {
        $client: { prepare: (s: string) => { all: () => Array<{ name: string }> } };
      }
    ).$client;
    const expected = ['grimoire_attachments', 'print_settings', 'slicer_profiles'];
    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${expected
          .map((n) => `'${n}'`)
          .join(',')})`,
      )
      .all();
    expect(tables.map((t) => t.name).sort()).toEqual(expected);
  });

  it('2. accepts SlicerProfile inserts across enum combinations', async () => {
    const ownerId = await seedUser();
    // Sample 3 combinations that exercise FDM, SLA, and "any/other" axes.
    const combos: Array<{ slicerKind: string; printerKind: string; materialKind: string }> = [
      { slicerKind: 'bambu-studio', printerKind: 'bambu-x1', materialKind: 'petg' },
      { slicerKind: 'chitubox', printerKind: 'elegoo-mars', materialKind: 'standard-resin' },
      { slicerKind: 'other', printerKind: 'other', materialKind: 'any' },
    ];

    // Sanity: each value comes from the published enum lists.
    for (const c of combos) {
      expect((SLICER_KINDS as readonly string[]).includes(c.slicerKind)).toBe(true);
      expect((PRINTER_KINDS as readonly string[]).includes(c.printerKind)).toBe(true);
      expect((PROFILE_MATERIAL_KINDS as readonly string[]).includes(c.materialKind)).toBe(true);
    }

    for (const c of combos) {
      await seedSlicerProfile({ ownerId, ...c });
    }

    const rows = await db()
      .select()
      .from(schema.slicerProfiles)
      .where(eq(schema.slicerProfiles.ownerId, ownerId));
    expect(rows.length).toBe(combos.length);
    expect(rows.every((r) => r.opaqueUnsupported === false)).toBe(true);
  });

  it('3. accepts PrintSetting inserts', async () => {
    const ownerId = await seedUser();
    const id = await seedPrintSetting({ ownerId });
    const row = (
      await db()
        .select()
        .from(schema.printSettings)
        .where(eq(schema.printSettings.id, id))
    )[0];
    expect(row).toBeTruthy();
    expect(row?.ownerId).toBe(ownerId);
  });

  it('4. attachment links Loot → SlicerProfile (printSettingId NULL)', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const slicerProfileId = await seedSlicerProfile({ ownerId });

    const id = uid();
    await db().insert(schema.grimoireAttachments).values({
      id,
      lootId,
      slicerProfileId,
      printSettingId: null,
      ownerId,
    });

    const row = (
      await db()
        .select()
        .from(schema.grimoireAttachments)
        .where(eq(schema.grimoireAttachments.id, id))
    )[0];
    expect(row?.slicerProfileId).toBe(slicerProfileId);
    expect(row?.printSettingId).toBeNull();
  });

  it('5. attachment links Loot → PrintSetting (slicerProfileId NULL)', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const printSettingId = await seedPrintSetting({ ownerId });

    const id = uid();
    await db().insert(schema.grimoireAttachments).values({
      id,
      lootId,
      slicerProfileId: null,
      printSettingId,
      ownerId,
    });

    const row = (
      await db()
        .select()
        .from(schema.grimoireAttachments)
        .where(eq(schema.grimoireAttachments.id, id))
    )[0];
    expect(row?.printSettingId).toBe(printSettingId);
    expect(row?.slicerProfileId).toBeNull();
  });

  it('6. DB allows neither-set and both-set — XOR enforced at app layer', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const slicerProfileId = await seedSlicerProfile({ ownerId });
    const printSettingId = await seedPrintSetting({ ownerId });

    // Neither set — DB accepts; T11 will reject at app layer.
    const neitherId = uid();
    await db().insert(schema.grimoireAttachments).values({
      id: neitherId,
      lootId,
      slicerProfileId: null,
      printSettingId: null,
      ownerId,
    });

    // Both set — DB accepts; T11 will reject at app layer.
    const bothId = uid();
    await db().insert(schema.grimoireAttachments).values({
      id: bothId,
      lootId,
      slicerProfileId,
      printSettingId,
      ownerId,
    });

    const rows = await db()
      .select()
      .from(schema.grimoireAttachments)
      .where(eq(schema.grimoireAttachments.lootId, lootId));
    expect(rows.length).toBe(2);
  });

  it('7. FK enforcement: attachment with non-existent loot_id fails', async () => {
    const ownerId = await seedUser();
    const slicerProfileId = await seedSlicerProfile({ ownerId });

    let threw = false;
    try {
      await db().insert(schema.grimoireAttachments).values({
        id: uid(),
        lootId: 'no-such-loot',
        slicerProfileId,
        printSettingId: null,
        ownerId,
      });
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/FOREIGN KEY|foreign key/i);
    }
    expect(threw).toBe(true);
  });

  it('8. FK enforcement: attachment with non-existent slicer_profile_id fails', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);

    let threw = false;
    try {
      await db().insert(schema.grimoireAttachments).values({
        id: uid(),
        lootId,
        slicerProfileId: 'no-such-profile',
        printSettingId: null,
        ownerId,
      });
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/FOREIGN KEY|foreign key/i);
    }
    expect(threw).toBe(true);
  });

  it('9. cascade: deleting the user removes profiles + settings + attachments', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const slicerProfileId = await seedSlicerProfile({ ownerId });
    const printSettingId = await seedPrintSetting({ ownerId });

    await db().insert(schema.grimoireAttachments).values({
      id: uid(),
      lootId,
      slicerProfileId,
      printSettingId: null,
      ownerId,
    });
    await db().insert(schema.grimoireAttachments).values({
      id: uid(),
      lootId,
      slicerProfileId: null,
      printSettingId,
      ownerId,
    });

    // Sanity
    expect(
      (
        await db()
          .select()
          .from(schema.slicerProfiles)
          .where(eq(schema.slicerProfiles.ownerId, ownerId))
      ).length,
    ).toBe(1);

    await db().delete(schema.user).where(eq(schema.user.id, ownerId));

    expect(
      (
        await db()
          .select()
          .from(schema.slicerProfiles)
          .where(eq(schema.slicerProfiles.ownerId, ownerId))
      ).length,
    ).toBe(0);
    expect(
      (
        await db()
          .select()
          .from(schema.printSettings)
          .where(eq(schema.printSettings.ownerId, ownerId))
      ).length,
    ).toBe(0);
    expect(
      (
        await db()
          .select()
          .from(schema.grimoireAttachments)
          .where(eq(schema.grimoireAttachments.ownerId, ownerId))
      ).length,
    ).toBe(0);
  });

  it('10. cascade: deleting the loot removes its attachments', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const slicerProfileId = await seedSlicerProfile({ ownerId });

    const attId = uid();
    await db().insert(schema.grimoireAttachments).values({
      id: attId,
      lootId,
      slicerProfileId,
      printSettingId: null,
      ownerId,
    });

    expect(
      (
        await db()
          .select()
          .from(schema.grimoireAttachments)
          .where(eq(schema.grimoireAttachments.id, attId))
      ).length,
    ).toBe(1);

    await db().delete(schema.loot).where(eq(schema.loot.id, lootId));

    expect(
      (
        await db()
          .select()
          .from(schema.grimoireAttachments)
          .where(eq(schema.grimoireAttachments.id, attId))
      ).length,
    ).toBe(0);

    // Profile is independent and survives.
    expect(
      (
        await db()
          .select()
          .from(schema.slicerProfiles)
          .where(eq(schema.slicerProfiles.id, slicerProfileId))
      ).length,
    ).toBe(1);
  });

  it('11. cascade: deleting a slicer profile removes referencing attachments', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const slicerProfileId = await seedSlicerProfile({ ownerId });

    const attId = uid();
    await db().insert(schema.grimoireAttachments).values({
      id: attId,
      lootId,
      slicerProfileId,
      printSettingId: null,
      ownerId,
    });

    await db()
      .delete(schema.slicerProfiles)
      .where(eq(schema.slicerProfiles.id, slicerProfileId));

    expect(
      (
        await db()
          .select()
          .from(schema.grimoireAttachments)
          .where(eq(schema.grimoireAttachments.id, attId))
      ).length,
    ).toBe(0);

    // Loot survives.
    expect(
      (await db().select().from(schema.loot).where(eq(schema.loot.id, lootId))).length,
    ).toBe(1);
  });

  it('12. cascade: deleting a print setting removes referencing attachments', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const printSettingId = await seedPrintSetting({ ownerId });

    const attId = uid();
    await db().insert(schema.grimoireAttachments).values({
      id: attId,
      lootId,
      slicerProfileId: null,
      printSettingId,
      ownerId,
    });

    await db()
      .delete(schema.printSettings)
      .where(eq(schema.printSettings.id, printSettingId));

    expect(
      (
        await db()
          .select()
          .from(schema.grimoireAttachments)
          .where(eq(schema.grimoireAttachments.id, attId))
      ).length,
    ).toBe(0);
  });

  it('13. expected indexes are present', () => {
    const sqlite = (
      db() as unknown as {
        $client: {
          prepare: (s: string) => { all: () => Array<{ name: string }> };
        };
      }
    ).$client;

    const idxFor = (table: string): string[] =>
      sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${table}'`)
        .all()
        .map((r) => r.name);

    expect(idxFor('slicer_profiles')).toEqual(
      expect.arrayContaining([
        'slicer_profiles_owner_idx',
        'slicer_profiles_owner_printer_idx',
        'slicer_profiles_slicer_kind_idx',
      ]),
    );
    expect(idxFor('print_settings')).toEqual(
      expect.arrayContaining(['print_settings_owner_idx']),
    );
    expect(idxFor('grimoire_attachments')).toEqual(
      expect.arrayContaining([
        'grimoire_attachments_loot_idx',
        'grimoire_attachments_profile_idx',
        'grimoire_attachments_setting_idx',
        'grimoire_attachments_owner_idx',
      ]),
    );
  });

  it('14. settings_payload JSON round-trips deep-equal', async () => {
    const ownerId = await seedUser();
    const payload = {
      layer_height: 0.2,
      infill_density: 15,
      supports: { enabled: true, threshold_deg: 45 },
      perimeters: 3,
      tags: ['engineering', 'cf'],
    };

    const id = await seedSlicerProfile({ ownerId, settings: payload });
    const row = (
      await db()
        .select()
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.id, id))
    )[0];

    expect(row?.settingsPayload).toEqual(payload);

    // Same on print_settings.
    const sparseOverride = { supports: false, brim_width_mm: 3, deeply: { nested: { v: 1 } } };
    const psId = await seedPrintSetting({ ownerId, settings: sparseOverride });
    const psRow = (
      await db()
        .select()
        .from(schema.printSettings)
        .where(eq(schema.printSettings.id, psId))
    )[0];
    expect(psRow?.settingsPayload).toEqual(sparseOverride);
  });
});
