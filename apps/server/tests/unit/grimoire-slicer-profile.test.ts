/**
 * Unit tests for SlicerProfile CRUD — V2-007a-T10.
 *
 * Real-DB-on-tmpfile pattern (mirrors materials-lifecycle.test.ts).
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  createSlicerProfile,
  updateSlicerProfile,
  deleteSlicerProfile,
  getSlicerProfile,
  listSlicerProfiles,
} from '../../src/grimoire/slicer-profile';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-grimoire-slicer-profile-unit.db';
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
    name: 'Slicer Test User',
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
    name: 'X1C • PETG-CF • Engineering 0.2mm',
    slicerKind: 'bambu-studio' as const,
    printerKind: 'bambu-x1' as const,
    materialKind: 'petg' as const,
    settingsPayload: { layer_height: 0.2, infill_density: 15 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Create — happy paths + opaqueUnsupported invariant
// ---------------------------------------------------------------------------

describe('createSlicerProfile — happy paths', () => {
  it('1. creates a profile with all required fields', async () => {
    const ownerId = await seedUser();
    const result = await createSlicerProfile(validInput(ownerId), { dbUrl: DB_URL });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.profileId).toBe('string');
    expect(result.profileId.length).toBeGreaterThan(0);

    const rows = await db()
      .select()
      .from(schema.slicerProfiles)
      .where(eq(schema.slicerProfiles.id, result.profileId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.name).toBe('X1C • PETG-CF • Engineering 0.2mm');
    expect(row.slicerKind).toBe('bambu-studio');
    expect(row.printerKind).toBe('bambu-x1');
    expect(row.materialKind).toBe('petg');
    expect(row.settingsPayload).toEqual({ layer_height: 0.2, infill_density: 15 });
    expect(row.opaqueUnsupported).toBe(false);
    expect(row.notes).toBeNull();
    expect(row.ownerId).toBe(ownerId);
  });

  it('2. opaqueUnsupported is always false on v2-007a manual create', async () => {
    const ownerId = await seedUser();
    const result = await createSlicerProfile(validInput(ownerId), { dbUrl: DB_URL });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = (
      await db()
        .select()
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.id, result.profileId))
    )[0]!;
    expect(row.opaqueUnsupported).toBe(false);
  });

  it('3. trims surrounding whitespace from name', async () => {
    const ownerId = await seedUser();
    const result = await createSlicerProfile(
      validInput(ownerId, { name: '   Trimmed Name   ' }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = (
      await db()
        .select()
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.id, result.profileId))
    )[0]!;
    expect(row.name).toBe('Trimmed Name');
  });

  it('4. round-trips a deeply nested settingsPayload via JSON column', async () => {
    const ownerId = await seedUser();
    const payload = {
      print_settings_id: ['Some Profile'],
      layer_height: 0.16,
      filament_settings_id: ['PETG-CF'],
      nested: { inner: [1, 2, 3], object: { deeper: true } },
      mixed_array: [1, 'two', { three: 3 }],
    };
    const result = await createSlicerProfile(
      validInput(ownerId, { settingsPayload: payload }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = (
      await db()
        .select()
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.id, result.profileId))
    )[0]!;
    expect(row.settingsPayload).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Create — validation rejections
// ---------------------------------------------------------------------------

describe('createSlicerProfile — validation', () => {
  it('5. rejects empty name', async () => {
    const ownerId = await seedUser();
    const result = await createSlicerProfile(
      validInput(ownerId, { name: '' }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-name');
  });

  it('6. rejects whitespace-only name', async () => {
    const ownerId = await seedUser();
    const result = await createSlicerProfile(
      validInput(ownerId, { name: '   \t\n   ' }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-name');
  });

  it('7. rejects invalid slicerKind', async () => {
    const ownerId = await seedUser();
    const result = await createSlicerProfile(
      validInput(ownerId, { slicerKind: 'simplify3d' }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-slicer-kind');
  });

  it('8. rejects invalid printerKind', async () => {
    const ownerId = await seedUser();
    const result = await createSlicerProfile(
      validInput(ownerId, { printerKind: 'creality-ender-3' }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-printer-kind');
  });

  it('9. rejects invalid materialKind', async () => {
    const ownerId = await seedUser();
    const result = await createSlicerProfile(
      validInput(ownerId, { materialKind: 'kevlar' }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-material-kind');
  });

  it('10. rejects null settingsPayload', async () => {
    const ownerId = await seedUser();
    const result = await createSlicerProfile(
      validInput(ownerId, { settingsPayload: null }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-settings-payload');
  });

  it('11. rejects array settingsPayload', async () => {
    const ownerId = await seedUser();
    const result = await createSlicerProfile(
      validInput(ownerId, { settingsPayload: [1, 2, 3] }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-settings-payload');
  });

  it('12. rejects primitive settingsPayload', async () => {
    const ownerId = await seedUser();
    const result = await createSlicerProfile(
      validInput(ownerId, { settingsPayload: 'a string' }),
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-settings-payload');
  });

  it('13. rejects blank ownerId', async () => {
    const result = await createSlicerProfile(validInput(''), { dbUrl: DB_URL });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('owner-required');
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('updateSlicerProfile', () => {
  async function seedProfile(ownerId: string): Promise<string> {
    const r = await createSlicerProfile(validInput(ownerId), { dbUrl: DB_URL });
    if (!r.ok) throw new Error('seed failed');
    return r.profileId;
  }

  it('14. updates name only; other fields preserved', async () => {
    const ownerId = await seedUser();
    const id = await seedProfile(ownerId);
    const before = (
      await db()
        .select()
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.id, id))
    )[0]!;

    const result = await updateSlicerProfile(
      { id, ownerId, name: 'Renamed Profile' },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);

    const after = (
      await db()
        .select()
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.id, id))
    )[0]!;
    expect(after.name).toBe('Renamed Profile');
    expect(after.slicerKind).toBe(before.slicerKind);
    expect(after.printerKind).toBe(before.printerKind);
    expect(after.materialKind).toBe(before.materialKind);
    expect(after.settingsPayload).toEqual(before.settingsPayload);
  });

  it('15. updates slicerKind (corrects misclassification)', async () => {
    const ownerId = await seedUser();
    const id = await seedProfile(ownerId);
    const result = await updateSlicerProfile(
      { id, ownerId, slicerKind: 'orca-slicer' },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    const after = (
      await db()
        .select()
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.id, id))
    )[0]!;
    expect(after.slicerKind).toBe('orca-slicer');
  });

  it('16. fully replaces settingsPayload (not merge)', async () => {
    const ownerId = await seedUser();
    const id = await seedProfile(ownerId);
    const next = { only: 'this-key' };
    const result = await updateSlicerProfile(
      { id, ownerId, settingsPayload: next },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    const after = (
      await db()
        .select()
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.id, id))
    )[0]!;
    expect(after.settingsPayload).toEqual({ only: 'this-key' });
  });

  it('17. updatedAt bumps on every successful mutation', async () => {
    const ownerId = await seedUser();
    const t0 = new Date('2025-01-01T00:00:00Z');
    const r = await createSlicerProfile(validInput(ownerId), {
      dbUrl: DB_URL,
      now: t0,
    });
    if (!r.ok) throw new Error('seed failed');
    const id = r.profileId;

    const t1 = new Date('2025-06-01T00:00:00Z');
    const result = await updateSlicerProfile(
      { id, ownerId, name: 'New Name' },
      { dbUrl: DB_URL, now: t1 },
    );
    expect(result.ok).toBe(true);

    const after = (
      await db()
        .select()
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.id, id))
    )[0]!;
    expect(after.updatedAt.getTime()).toBe(t1.getTime());
    expect(after.createdAt.getTime()).toBe(t0.getTime());
  });

  it('18. cross-owner update returns profile-not-found', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const id = await seedProfile(ownerA);
    const result = await updateSlicerProfile(
      { id, ownerId: ownerB, name: 'Hijacked' },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('profile-not-found');

    // Verify ownerA's row was not mutated.
    const after = (
      await db()
        .select()
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.id, id))
    )[0]!;
    expect(after.name).toBe('X1C • PETG-CF • Engineering 0.2mm');
  });

  it('19. rejects invalid slicerKind in update', async () => {
    const ownerId = await seedUser();
    const id = await seedProfile(ownerId);
    const result = await updateSlicerProfile(
      { id, ownerId, slicerKind: 'meatball-slicer' as never },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-slicer-kind');
  });

  it('20. notes: explicit null clears, omitted preserves', async () => {
    const ownerId = await seedUser();
    const id = await seedProfile(ownerId);

    // First set notes.
    const r1 = await updateSlicerProfile(
      { id, ownerId, notes: 'temporary note' },
      { dbUrl: DB_URL },
    );
    expect(r1.ok).toBe(true);
    let row = (
      await db()
        .select()
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.id, id))
    )[0]!;
    expect(row.notes).toBe('temporary note');

    // Omit notes — preserve.
    const r2 = await updateSlicerProfile(
      { id, ownerId, name: 'still-here' },
      { dbUrl: DB_URL },
    );
    expect(r2.ok).toBe(true);
    row = (
      await db()
        .select()
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.id, id))
    )[0]!;
    expect(row.notes).toBe('temporary note');

    // Explicit null — clear.
    const r3 = await updateSlicerProfile(
      { id, ownerId, notes: null },
      { dbUrl: DB_URL },
    );
    expect(r3.ok).toBe(true);
    row = (
      await db()
        .select()
        .from(schema.slicerProfiles)
        .where(eq(schema.slicerProfiles.id, id))
    )[0]!;
    expect(row.notes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('deleteSlicerProfile', () => {
  async function seedProfile(ownerId: string): Promise<string> {
    const r = await createSlicerProfile(validInput(ownerId), { dbUrl: DB_URL });
    if (!r.ok) throw new Error('seed failed');
    return r.profileId;
  }

  it('21. happy path: removes the row, returns deletedAttachments=0', async () => {
    const ownerId = await seedUser();
    const id = await seedProfile(ownerId);
    const result = await deleteSlicerProfile({ id, ownerId }, { dbUrl: DB_URL });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deletedAttachments).toBe(0);

    const remaining = await db()
      .select()
      .from(schema.slicerProfiles)
      .where(eq(schema.slicerProfiles.id, id));
    expect(remaining).toHaveLength(0);
  });

  it('22. cascades to grimoire_attachments and reports the count', async () => {
    const ownerId = await seedUser();
    const id = await seedProfile(ownerId);

    // Manually seed a Loot row + collection + stashRoot so we can attach attachments.
    const stashRootId = uid();
    await db().insert(schema.stashRoots).values({
      id: stashRootId,
      ownerId,
      name: 'Test Root',
      path: '/tmp/test-root',
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

    // Two attachments referencing this profile.
    await db().insert(schema.grimoireAttachments).values([
      {
        id: uid(),
        lootId,
        slicerProfileId: id,
        printSettingId: null,
        note: null,
        ownerId,
        attachedAt: new Date(),
      },
      {
        id: uid(),
        lootId,
        slicerProfileId: id,
        printSettingId: null,
        note: null,
        ownerId,
        attachedAt: new Date(),
      },
    ]);

    const result = await deleteSlicerProfile({ id, ownerId }, { dbUrl: DB_URL });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deletedAttachments).toBe(2);

    const remaining = await db()
      .select()
      .from(schema.grimoireAttachments)
      .where(eq(schema.grimoireAttachments.slicerProfileId, id));
    expect(remaining).toHaveLength(0);
  });

  it('23. cross-owner delete returns profile-not-found', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const id = await seedProfile(ownerA);
    const result = await deleteSlicerProfile({ id, ownerId: ownerB }, { dbUrl: DB_URL });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('profile-not-found');

    const stillThere = await db()
      .select()
      .from(schema.slicerProfiles)
      .where(eq(schema.slicerProfiles.id, id));
    expect(stillThere).toHaveLength(1);
  });

  it('24. idempotent (REST-style): second delete returns profile-not-found', async () => {
    const ownerId = await seedUser();
    const id = await seedProfile(ownerId);
    const r1 = await deleteSlicerProfile({ id, ownerId }, { dbUrl: DB_URL });
    expect(r1.ok).toBe(true);
    const r2 = await deleteSlicerProfile({ id, ownerId }, { dbUrl: DB_URL });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('profile-not-found');
  });
});

// ---------------------------------------------------------------------------
// Get single
// ---------------------------------------------------------------------------

describe('getSlicerProfile', () => {
  it('25. happy path: returns the row for owner', async () => {
    const ownerId = await seedUser();
    const r = await createSlicerProfile(validInput(ownerId), { dbUrl: DB_URL });
    if (!r.ok) throw new Error('seed failed');
    const got = await getSlicerProfile(
      { id: r.profileId, ownerId },
      { dbUrl: DB_URL },
    );
    expect(got).not.toBeNull();
    expect(got!.id).toBe(r.profileId);
    expect(got!.ownerId).toBe(ownerId);
  });

  it('26. cross-owner returns null (does not leak existence)', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const r = await createSlicerProfile(validInput(ownerA), { dbUrl: DB_URL });
    if (!r.ok) throw new Error('seed failed');
    const got = await getSlicerProfile(
      { id: r.profileId, ownerId: ownerB },
      { dbUrl: DB_URL },
    );
    expect(got).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('listSlicerProfiles', () => {
  it('27. lists user profiles only (cross-owner isolation)', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    await createSlicerProfile(validInput(ownerA, { name: 'A1' }), { dbUrl: DB_URL });
    await createSlicerProfile(validInput(ownerA, { name: 'A2' }), { dbUrl: DB_URL });
    await createSlicerProfile(validInput(ownerB, { name: 'B1' }), { dbUrl: DB_URL });

    const result = await listSlicerProfiles({ ownerId: ownerA }, { dbUrl: DB_URL });
    expect(result.profiles.length).toBe(2);
    for (const p of result.profiles) expect(p.ownerId).toBe(ownerA);
    expect(result.nextCursor).toBeUndefined();
  });

  it('28. filters by printerKind', async () => {
    const ownerId = await seedUser();
    await createSlicerProfile(
      validInput(ownerId, { name: 'X1', printerKind: 'bambu-x1' }),
      { dbUrl: DB_URL },
    );
    await createSlicerProfile(
      validInput(ownerId, { name: 'P1', printerKind: 'prusa-mk4' }),
      { dbUrl: DB_URL },
    );

    const result = await listSlicerProfiles(
      { ownerId, printerKind: 'bambu-x1' },
      { dbUrl: DB_URL },
    );
    expect(result.profiles.length).toBe(1);
    expect(result.profiles[0]!.name).toBe('X1');
  });

  it('29. filters by slicerKind', async () => {
    const ownerId = await seedUser();
    await createSlicerProfile(
      validInput(ownerId, { name: 'BS', slicerKind: 'bambu-studio' }),
      { dbUrl: DB_URL },
    );
    await createSlicerProfile(
      validInput(ownerId, { name: 'OS', slicerKind: 'orca-slicer' }),
      { dbUrl: DB_URL },
    );

    const result = await listSlicerProfiles(
      { ownerId, slicerKind: 'orca-slicer' },
      { dbUrl: DB_URL },
    );
    expect(result.profiles.length).toBe(1);
    expect(result.profiles[0]!.name).toBe('OS');
  });

  it('30. filters by materialKind', async () => {
    const ownerId = await seedUser();
    await createSlicerProfile(
      validInput(ownerId, { name: 'PLA', materialKind: 'pla' }),
      { dbUrl: DB_URL },
    );
    await createSlicerProfile(
      validInput(ownerId, { name: 'PETG', materialKind: 'petg' }),
      { dbUrl: DB_URL },
    );

    const result = await listSlicerProfiles(
      { ownerId, materialKind: 'pla' },
      { dbUrl: DB_URL },
    );
    expect(result.profiles.length).toBe(1);
    expect(result.profiles[0]!.name).toBe('PLA');
  });

  it('31. paginates: 25 profiles, limit=10 → 10 + cursor; 10 + cursor; 5 + no cursor', async () => {
    const ownerId = await seedUser();
    for (let i = 0; i < 25; i++) {
      const r = await createSlicerProfile(
        validInput(ownerId, { name: `P${String(i).padStart(2, '0')}` }),
        { dbUrl: DB_URL },
      );
      expect(r.ok).toBe(true);
    }

    const seenIds = new Set<string>();

    const page1 = await listSlicerProfiles(
      { ownerId, limit: 10 },
      { dbUrl: DB_URL },
    );
    expect(page1.profiles.length).toBe(10);
    expect(page1.nextCursor).toBeDefined();
    for (const p of page1.profiles) seenIds.add(p.id);

    const page2 = await listSlicerProfiles(
      { ownerId, limit: 10, cursor: page1.nextCursor },
      { dbUrl: DB_URL },
    );
    expect(page2.profiles.length).toBe(10);
    expect(page2.nextCursor).toBeDefined();
    for (const p of page2.profiles) seenIds.add(p.id);

    const page3 = await listSlicerProfiles(
      { ownerId, limit: 10, cursor: page2.nextCursor },
      { dbUrl: DB_URL },
    );
    expect(page3.profiles.length).toBe(5);
    expect(page3.nextCursor).toBeUndefined();
    for (const p of page3.profiles) seenIds.add(p.id);

    expect(seenIds.size).toBe(25);
  });

  it('32. empty result for user with no profiles', async () => {
    const ownerId = await seedUser();
    const result = await listSlicerProfiles({ ownerId }, { dbUrl: DB_URL });
    expect(result.profiles).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });
});
