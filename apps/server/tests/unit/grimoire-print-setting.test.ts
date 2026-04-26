/**
 * Unit tests for PrintSetting CRUD — V2-007a-T10.
 *
 * Mirrors grimoire-slicer-profile.test.ts but with the simpler PrintSetting
 * shape (no slicer/printer/material kind columns).
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  createPrintSetting,
  updatePrintSetting,
  deletePrintSetting,
  getPrintSetting,
  listPrintSettings,
} from '../../src/grimoire/print-setting';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-grimoire-print-setting-unit.db';
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
    name: 'Print Setting Test User',
    email: `${id}@test.example`,
    emailVerified: false,
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
// Test helpers
// ---------------------------------------------------------------------------

function validInput(ownerId: string, overrides: Record<string, unknown> = {}) {
  return {
    ownerId,
    name: 'Dragon — supports off, 3mm brim',
    settingsPayload: { supports: false, brim_width: 3 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe('createPrintSetting — happy paths', () => {
  it('1. creates a setting with all required fields', async () => {
    const ownerId = await seedUser();
    const result = await createPrintSetting(validInput(ownerId), { dbUrl: DB_URL });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = await db()
      .select()
      .from(schema.printSettings)
      .where(eq(schema.printSettings.id, result.settingId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.name).toBe('Dragon — supports off, 3mm brim');
    expect(row.settingsPayload).toEqual({ supports: false, brim_width: 3 });
    expect(row.notes).toBeNull();
    expect(row.ownerId).toBe(ownerId);
  });

  it('2. trims whitespace from name', async () => {
    const ownerId = await seedUser();
    const result = await createPrintSetting(
      validInput(ownerId, { name: '   Trimmed   ' }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = (
      await db()
        .select()
        .from(schema.printSettings)
        .where(eq(schema.printSettings.id, result.settingId))
    )[0]!;
    expect(row.name).toBe('Trimmed');
  });

  it('3. round-trips a deep settingsPayload via JSON column', async () => {
    const ownerId = await seedUser();
    const payload = {
      supports: { tree: true, density: 12 },
      adhesion: 'brim',
      tweaks: [{ layer: 5, speed: 200 }, { layer: 50, speed: 300 }],
    };
    const result = await createPrintSetting(
      validInput(ownerId, { settingsPayload: payload }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = (
      await db()
        .select()
        .from(schema.printSettings)
        .where(eq(schema.printSettings.id, result.settingId))
    )[0]!;
    expect(row.settingsPayload).toEqual(payload);
  });

  it('4. persists optional notes', async () => {
    const ownerId = await seedUser();
    const result = await createPrintSetting(
      validInput(ownerId, { notes: 'remember to slice on cool plate' }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = (
      await db()
        .select()
        .from(schema.printSettings)
        .where(eq(schema.printSettings.id, result.settingId))
    )[0]!;
    expect(row.notes).toBe('remember to slice on cool plate');
  });
});

describe('createPrintSetting — validation', () => {
  it('5. rejects empty name', async () => {
    const ownerId = await seedUser();
    const result = await createPrintSetting(
      validInput(ownerId, { name: '' }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-name');
  });

  it('6. rejects whitespace-only name', async () => {
    const ownerId = await seedUser();
    const result = await createPrintSetting(
      validInput(ownerId, { name: '\t\n   ' }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-name');
  });

  it('7. rejects null settingsPayload', async () => {
    const ownerId = await seedUser();
    const result = await createPrintSetting(
      validInput(ownerId, { settingsPayload: null }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-settings-payload');
  });

  it('8. rejects array settingsPayload', async () => {
    const ownerId = await seedUser();
    const result = await createPrintSetting(
      validInput(ownerId, { settingsPayload: [] }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-settings-payload');
  });

  it('9. rejects primitive settingsPayload', async () => {
    const ownerId = await seedUser();
    const result = await createPrintSetting(
      validInput(ownerId, { settingsPayload: 42 }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-settings-payload');
  });

  it('10. rejects blank ownerId', async () => {
    const result = await createPrintSetting(validInput(''), { dbUrl: DB_URL });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('owner-required');
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('updatePrintSetting', () => {
  async function seedSetting(ownerId: string): Promise<string> {
    const r = await createPrintSetting(validInput(ownerId), { dbUrl: DB_URL });
    if (!r.ok) throw new Error('seed failed');
    return r.settingId;
  }

  it('11. updates name only; payload preserved', async () => {
    const ownerId = await seedUser();
    const id = await seedSetting(ownerId);
    const before = (
      await db()
        .select()
        .from(schema.printSettings)
        .where(eq(schema.printSettings.id, id))
    )[0]!;
    const result = await updatePrintSetting(
      { id, ownerId, name: 'Renamed' },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    const after = (
      await db()
        .select()
        .from(schema.printSettings)
        .where(eq(schema.printSettings.id, id))
    )[0]!;
    expect(after.name).toBe('Renamed');
    expect(after.settingsPayload).toEqual(before.settingsPayload);
  });

  it('12. fully replaces settingsPayload', async () => {
    const ownerId = await seedUser();
    const id = await seedSetting(ownerId);
    const next = { only: 'this' };
    const result = await updatePrintSetting(
      { id, ownerId, settingsPayload: next },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    const after = (
      await db()
        .select()
        .from(schema.printSettings)
        .where(eq(schema.printSettings.id, id))
    )[0]!;
    expect(after.settingsPayload).toEqual({ only: 'this' });
  });

  it('13. updatedAt bumps; createdAt preserved', async () => {
    const ownerId = await seedUser();
    const t0 = new Date('2025-01-01T00:00:00Z');
    const r = await createPrintSetting(validInput(ownerId), {
      dbUrl: DB_URL,
      now: t0,
    });
    if (!r.ok) throw new Error('seed failed');
    const id = r.settingId;
    const t1 = new Date('2025-09-01T00:00:00Z');
    const result = await updatePrintSetting(
      { id, ownerId, name: 'New' },
      { dbUrl: DB_URL, now: t1 },
    );
    expect(result.ok).toBe(true);
    const after = (
      await db()
        .select()
        .from(schema.printSettings)
        .where(eq(schema.printSettings.id, id))
    )[0]!;
    expect(after.updatedAt.getTime()).toBe(t1.getTime());
    expect(after.createdAt.getTime()).toBe(t0.getTime());
  });

  it('14. cross-owner update returns setting-not-found', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const id = await seedSetting(ownerA);
    const result = await updatePrintSetting(
      { id, ownerId: ownerB, name: 'Hijacked' },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('setting-not-found');

    const after = (
      await db()
        .select()
        .from(schema.printSettings)
        .where(eq(schema.printSettings.id, id))
    )[0]!;
    expect(after.name).toBe('Dragon — supports off, 3mm brim');
  });

  it('15. notes: explicit null clears, omitted preserves', async () => {
    const ownerId = await seedUser();
    const id = await seedSetting(ownerId);

    const r1 = await updatePrintSetting(
      { id, ownerId, notes: 'temp' },
      { dbUrl: DB_URL },
    );
    expect(r1.ok).toBe(true);
    let row = (
      await db()
        .select()
        .from(schema.printSettings)
        .where(eq(schema.printSettings.id, id))
    )[0]!;
    expect(row.notes).toBe('temp');

    const r2 = await updatePrintSetting(
      { id, ownerId, name: 'still-here' },
      { dbUrl: DB_URL },
    );
    expect(r2.ok).toBe(true);
    row = (
      await db()
        .select()
        .from(schema.printSettings)
        .where(eq(schema.printSettings.id, id))
    )[0]!;
    expect(row.notes).toBe('temp');

    const r3 = await updatePrintSetting(
      { id, ownerId, notes: null },
      { dbUrl: DB_URL },
    );
    expect(r3.ok).toBe(true);
    row = (
      await db()
        .select()
        .from(schema.printSettings)
        .where(eq(schema.printSettings.id, id))
    )[0]!;
    expect(row.notes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('deletePrintSetting', () => {
  async function seedSetting(ownerId: string): Promise<string> {
    const r = await createPrintSetting(validInput(ownerId), { dbUrl: DB_URL });
    if (!r.ok) throw new Error('seed failed');
    return r.settingId;
  }

  it('16. happy path: removes the row, deletedAttachments=0', async () => {
    const ownerId = await seedUser();
    const id = await seedSetting(ownerId);
    const result = await deletePrintSetting({ id, ownerId }, { dbUrl: DB_URL });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deletedAttachments).toBe(0);

    const remaining = await db()
      .select()
      .from(schema.printSettings)
      .where(eq(schema.printSettings.id, id));
    expect(remaining).toHaveLength(0);
  });

  it('17. cascades to grimoire_attachments and reports the count', async () => {
    const ownerId = await seedUser();
    const id = await seedSetting(ownerId);

    const stashRootId = uid();
    await db().insert(schema.stashRoots).values({
      id: stashRootId,
      ownerId,
      name: 'Test Root PS',
      path: '/tmp/test-root-ps',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const collectionId = uid();
    await db().insert(schema.collections).values({
      id: collectionId,
      ownerId,
      name: `PS Collection ${collectionId.slice(0, 8)}`,
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

    await db().insert(schema.grimoireAttachments).values([
      {
        id: uid(),
        lootId,
        slicerProfileId: null,
        printSettingId: id,
        note: null,
        ownerId,
        attachedAt: new Date(),
      },
    ]);

    const result = await deletePrintSetting({ id, ownerId }, { dbUrl: DB_URL });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deletedAttachments).toBe(1);

    const remaining = await db()
      .select()
      .from(schema.grimoireAttachments)
      .where(eq(schema.grimoireAttachments.printSettingId, id));
    expect(remaining).toHaveLength(0);
  });

  it('18. cross-owner delete returns setting-not-found', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const id = await seedSetting(ownerA);
    const result = await deletePrintSetting({ id, ownerId: ownerB }, { dbUrl: DB_URL });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('setting-not-found');

    const stillThere = await db()
      .select()
      .from(schema.printSettings)
      .where(eq(schema.printSettings.id, id));
    expect(stillThere).toHaveLength(1);
  });

  it('19. idempotent: second delete returns setting-not-found', async () => {
    const ownerId = await seedUser();
    const id = await seedSetting(ownerId);
    const r1 = await deletePrintSetting({ id, ownerId }, { dbUrl: DB_URL });
    expect(r1.ok).toBe(true);
    const r2 = await deletePrintSetting({ id, ownerId }, { dbUrl: DB_URL });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('setting-not-found');
  });
});

// ---------------------------------------------------------------------------
// Get single
// ---------------------------------------------------------------------------

describe('getPrintSetting', () => {
  it('20. happy path', async () => {
    const ownerId = await seedUser();
    const r = await createPrintSetting(validInput(ownerId), { dbUrl: DB_URL });
    if (!r.ok) throw new Error('seed failed');
    const got = await getPrintSetting(
      { id: r.settingId, ownerId },
      { dbUrl: DB_URL },
    );
    expect(got).not.toBeNull();
    expect(got!.id).toBe(r.settingId);
  });

  it('21. cross-owner returns null', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const r = await createPrintSetting(validInput(ownerA), { dbUrl: DB_URL });
    if (!r.ok) throw new Error('seed failed');
    const got = await getPrintSetting(
      { id: r.settingId, ownerId: ownerB },
      { dbUrl: DB_URL },
    );
    expect(got).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('listPrintSettings', () => {
  it('22. lists user settings only (cross-owner isolation)', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    await createPrintSetting(validInput(ownerA, { name: 'A1' }), { dbUrl: DB_URL });
    await createPrintSetting(validInput(ownerA, { name: 'A2' }), { dbUrl: DB_URL });
    await createPrintSetting(validInput(ownerB, { name: 'B1' }), { dbUrl: DB_URL });

    const result = await listPrintSettings({ ownerId: ownerA }, { dbUrl: DB_URL });
    expect(result.settings.length).toBe(2);
    for (const s of result.settings) expect(s.ownerId).toBe(ownerA);
    expect(result.nextCursor).toBeUndefined();
  });

  it('23. paginates: 25 settings, limit=10 across 3 pages', async () => {
    const ownerId = await seedUser();
    for (let i = 0; i < 25; i++) {
      const r = await createPrintSetting(
        validInput(ownerId, { name: `S${String(i).padStart(2, '0')}` }),
        { dbUrl: DB_URL },
      );
      expect(r.ok).toBe(true);
    }

    const seenIds = new Set<string>();

    const page1 = await listPrintSettings(
      { ownerId, limit: 10 },
      { dbUrl: DB_URL },
    );
    expect(page1.settings.length).toBe(10);
    expect(page1.nextCursor).toBeDefined();
    for (const s of page1.settings) seenIds.add(s.id);

    const page2 = await listPrintSettings(
      { ownerId, limit: 10, cursor: page1.nextCursor },
      { dbUrl: DB_URL },
    );
    expect(page2.settings.length).toBe(10);
    expect(page2.nextCursor).toBeDefined();
    for (const s of page2.settings) seenIds.add(s.id);

    const page3 = await listPrintSettings(
      { ownerId, limit: 10, cursor: page2.nextCursor },
      { dbUrl: DB_URL },
    );
    expect(page3.settings.length).toBe(5);
    expect(page3.nextCursor).toBeUndefined();
    for (const s of page3.settings) seenIds.add(s.id);

    expect(seenIds.size).toBe(25);
  });

  it('24. empty result for user with no settings', async () => {
    const ownerId = await seedUser();
    const result = await listPrintSettings({ ownerId }, { dbUrl: DB_URL });
    expect(result.settings).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });
});
