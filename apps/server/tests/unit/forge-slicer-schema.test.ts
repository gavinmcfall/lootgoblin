/**
 * Unit tests for V2-005c schema — runtime-installable slicer support.
 *
 * Verifies that the three new tables are created with the columns that
 * downstream tasks (T_c2 GitHub probe, T_c3 installer, T_c5 update checker,
 * T_c7 profile materializer, T_c8 SlicerAdapter, T_c9 converter wiring)
 * depend on.
 *
 *   forge_artifacts                        — machine-facing intermediates
 *                                            (gcode, slice metadata, profile
 *                                            snapshots) tied to a dispatch job.
 *   forge_slicer_installs                  — runtime-installed slicer binaries
 *                                            (PrusaSlicer/Orca/Bambu Studio,
 *                                            installed on demand).
 *   forge_slicer_profile_materializations  — Grimoire SlicerProfile → on-disk
 *                                            slicer config file with drift
 *                                            detection via source hash.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { runMigrations, resetDbCache, getDb } from '../../src/db/client';

const DB_PATH = '/tmp/lootgoblin-forge-slicer-schema.db';

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = `file:${DB_PATH}`;
  await runMigrations(`file:${DB_PATH}`);
});

beforeEach(() => {
  resetDbCache();
  process.env.DATABASE_URL = `file:${DB_PATH}`;
});

describe('V2-005c schema', () => {
  it('forge_artifacts table has expected columns', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const cols = db.all(sql`PRAGMA table_info(forge_artifacts)`).map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'dispatch_job_id', 'kind', 'storage_path', 'size_bytes',
      'sha256', 'mime_type', 'metadata_json', 'created_at',
    ]));
  });

  it('forge_slicer_installs table has expected columns', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const cols = db.all(sql`PRAGMA table_info(forge_slicer_installs)`).map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'slicer_kind', 'installed_version', 'binary_path', 'install_root',
      'install_status', 'last_update_check_at', 'available_version',
      'update_available', 'installed_at', 'sha256',
    ]));
  });

  it('forge_slicer_profile_materializations table has expected columns', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const cols = db
      .all(sql`PRAGMA table_info(forge_slicer_profile_materializations)`)
      .map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'slicer_profile_id', 'slicer_kind', 'config_path',
      'source_profile_hash', 'sync_required', 'materialized_at',
    ]));
  });
});
