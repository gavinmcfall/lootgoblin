/**
 * Unit tests for V2-005c T_c7 — profile materialization + drift detection.
 *
 * Real-DB-on-tmpfile pattern (mirrors grimoire-slicer-profile.test.ts).
 * Per-test tmpdir for LOOTGOBLIN_DATA_ROOT so we never touch real /data.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { getDb, resetDbCache, runMigrations, schema } from '../../src/db/client';
import {
  detectDrift,
  getMaterializedConfigPath,
  materializeProfile,
} from '../../src/forge/slicer/profile-materialization';

const DB_PATH = '/tmp/lootgoblin-forge-slicer-profile-mat.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

let dataRoot: string;

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Mat Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedSlicerProfile(
  ownerId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = uid();
  await db().insert(schema.slicerProfiles).values({
    id,
    ownerId,
    name: `Profile ${id.slice(0, 6)}`,
    slicerKind: 'prusaslicer',
    printerKind: 'prusa-mk4',
    materialKind: 'pla',
    settingsPayload: payload,
    opaqueUnsupported: false,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function getMatRow(profileId: string, slicerKind: string) {
  const rows = await db()
    .select()
    .from(schema.forgeSlicerProfileMaterializations)
    .where(
      and(
        eq(schema.forgeSlicerProfileMaterializations.slicerProfileId, profileId),
        eq(schema.forgeSlicerProfileMaterializations.slicerKind, slicerKind),
      ),
    );
  return rows[0] ?? null;
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
});

beforeEach(() => {
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  dataRoot = mkdtempSync(path.join(tmpdir(), 'forge-slicer-data-'));
  process.env.LOOTGOBLIN_DATA_ROOT = dataRoot;
  // Wipe state between tests so each starts clean.
  const conn = getDb(DB_URL) as any;
  conn.run(sql`DELETE FROM forge_slicer_profile_materializations`);
  conn.run(sql`DELETE FROM slicer_profiles`);
  conn.run(sql`DELETE FROM user`);
});

afterAll(() => {
  delete process.env.LOOTGOBLIN_DATA_ROOT;
  if (dataRoot && fs.existsSync(dataRoot)) {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

describe('materializeProfile', () => {
  it('writes .ini file and inserts materialization row (happy path)', async () => {
    const owner = await seedUser();
    const profileId = await seedSlicerProfile(owner, {
      layer_height: 0.2,
      infill: { density: 0.15, pattern: 'gyroid' },
    });

    const result = await materializeProfile({
      profileId,
      slicerKind: 'prusaslicer',
      dbUrl: DB_URL,
    });

    expect(result.configPath).toBe(
      path.join(dataRoot, 'forge-slicer-configs', profileId, 'prusaslicer.ini'),
    );
    expect(result.sourceProfileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.syncRequired).toBe(false);

    // File written with expected key=value lines (top-level + nested flatten).
    const text = await fsp.readFile(result.configPath, 'utf8');
    expect(text).toContain('layer_height = 0.2');
    expect(text).toContain('infill.density = 0.15');
    expect(text).toContain('infill.pattern = gyroid');

    // Row persisted.
    const row = await getMatRow(profileId, 'prusaslicer');
    expect(row).not.toBeNull();
    expect(row!.sourceProfileHash).toBe(result.sourceProfileHash);
  });

  it('upserts on second call (idempotent UNIQUE on profile,slicer-kind)', async () => {
    const owner = await seedUser();
    const profileId = await seedSlicerProfile(owner, { layer_height: 0.2 });

    const first = await materializeProfile({
      profileId,
      slicerKind: 'prusaslicer',
      dbUrl: DB_URL,
    });
    // Make sure timestamp can advance (sqlite timestamp_ms resolution).
    await new Promise((r) => setTimeout(r, 10));

    const second = await materializeProfile({
      profileId,
      slicerKind: 'prusaslicer',
      dbUrl: DB_URL,
    });

    expect(second.id).toBe(first.id); // same row, upserted
    expect(second.materializedAt.getTime()).toBeGreaterThanOrEqual(
      first.materializedAt.getTime(),
    );

    const all = await db()
      .select()
      .from(schema.forgeSlicerProfileMaterializations)
      .where(eq(schema.forgeSlicerProfileMaterializations.slicerProfileId, profileId));
    expect(all).toHaveLength(1);
  });

  it('throws on missing profile', async () => {
    await expect(
      materializeProfile({
        profileId: 'does-not-exist',
        slicerKind: 'prusaslicer',
        dbUrl: DB_URL,
      }),
    ).rejects.toThrow(/profile .* not found/);
  });

  it('clears syncRequired=true on re-materialize', async () => {
    const owner = await seedUser();
    const profileId = await seedSlicerProfile(owner, { layer_height: 0.2 });

    // Pre-seed with syncRequired=true.
    await materializeProfile({ profileId, slicerKind: 'prusaslicer', dbUrl: DB_URL });
    await db()
      .update(schema.forgeSlicerProfileMaterializations)
      .set({ syncRequired: true })
      .where(eq(schema.forgeSlicerProfileMaterializations.slicerProfileId, profileId));

    const result = await materializeProfile({
      profileId,
      slicerKind: 'prusaslicer',
      dbUrl: DB_URL,
    });

    expect(result.syncRequired).toBe(false);
    const row = await getMatRow(profileId, 'prusaslicer');
    expect(row!.syncRequired).toBe(false);
  });
});

describe('detectDrift', () => {
  it('sets syncRequired=true when source hash drifts', async () => {
    const owner = await seedUser();
    const profileId = await seedSlicerProfile(owner, { layer_height: 0.2 });

    await materializeProfile({ profileId, slicerKind: 'prusaslicer', dbUrl: DB_URL });

    // Mutate the source profile (simulate user edit).
    await db()
      .update(schema.slicerProfiles)
      .set({ settingsPayload: { layer_height: 0.3 } })
      .where(eq(schema.slicerProfiles.id, profileId));

    const result = await detectDrift({ dbUrl: DB_URL });

    expect(result.checked).toBe(1);
    expect(result.driftedSet).toBe(1);
    const row = await getMatRow(profileId, 'prusaslicer');
    expect(row!.syncRequired).toBe(true);
  });

  it('is a no-op when hashes match', async () => {
    const owner = await seedUser();
    const profileId = await seedSlicerProfile(owner, { layer_height: 0.2 });

    await materializeProfile({ profileId, slicerKind: 'prusaslicer', dbUrl: DB_URL });

    const result = await detectDrift({ dbUrl: DB_URL });

    expect(result.checked).toBe(1);
    expect(result.driftedSet).toBe(0);
    const row = await getMatRow(profileId, 'prusaslicer');
    expect(row!.syncRequired).toBe(false);
  });
});

describe('getMaterializedConfigPath', () => {
  it('auto-materializes on first call (no row exists)', async () => {
    const owner = await seedUser();
    const profileId = await seedSlicerProfile(owner, { layer_height: 0.28 });

    const cfgPath = await getMaterializedConfigPath({
      profileId,
      slicerKind: 'prusaslicer',
      dbUrl: DB_URL,
    });

    expect(fs.existsSync(cfgPath)).toBe(true);
    const row = await getMatRow(profileId, 'prusaslicer');
    expect(row).not.toBeNull();
  });

  it('re-materializes when syncRequired=true', async () => {
    const owner = await seedUser();
    const profileId = await seedSlicerProfile(owner, { layer_height: 0.2 });

    await materializeProfile({ profileId, slicerKind: 'prusaslicer', dbUrl: DB_URL });

    // Mutate source + flag drift.
    await db()
      .update(schema.slicerProfiles)
      .set({ settingsPayload: { layer_height: 0.32 } })
      .where(eq(schema.slicerProfiles.id, profileId));
    await db()
      .update(schema.forgeSlicerProfileMaterializations)
      .set({ syncRequired: true })
      .where(eq(schema.forgeSlicerProfileMaterializations.slicerProfileId, profileId));

    const cfgPath = await getMaterializedConfigPath({
      profileId,
      slicerKind: 'prusaslicer',
      dbUrl: DB_URL,
    });

    const text = await fsp.readFile(cfgPath, 'utf8');
    expect(text).toContain('layer_height = 0.32');
    const row = await getMatRow(profileId, 'prusaslicer');
    expect(row!.syncRequired).toBe(false);
  });

  it('re-materializes when on-disk config file is missing', async () => {
    const owner = await seedUser();
    const profileId = await seedSlicerProfile(owner, { layer_height: 0.24 });

    const first = await materializeProfile({
      profileId,
      slicerKind: 'prusaslicer',
      dbUrl: DB_URL,
    });

    // Delete the file out from under the row.
    await fsp.rm(first.configPath);
    expect(fs.existsSync(first.configPath)).toBe(false);

    const cfgPath = await getMaterializedConfigPath({
      profileId,
      slicerKind: 'prusaslicer',
      dbUrl: DB_URL,
    });
    expect(fs.existsSync(cfgPath)).toBe(true);
  });
});
