// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for V2-005f-CF-1-T_g1 schema — printer_loadouts table + drop of
 * the legacy `materials.loaded_in_printer_ref` column.
 *
 *   - printer_loadouts is the per-(printer, slot) load history that replaces
 *     the v1 free-text `materials.loaded_in_printer_ref`. The new design lets
 *     the Forge dispatch worker attribute per-slot consumption to a stable
 *     material_id at claim time (T_g4) and powers the Materials UI history
 *     view (T_g3).
 *   - FK on printer_id is ON DELETE CASCADE; FK on material_id is ON DELETE
 *     RESTRICT (deleting a material that's still loaded is forbidden).
 *   - The partial UNIQUE index `idx_printer_loadouts_current` enforces "at
 *     most one open loadout per (printer, slot)" — closed rows (unloaded_at
 *     NOT NULL) freely repeat.
 *   - Migration 0030 also drops `materials.loaded_in_printer_ref` and the
 *     `materials_loaded_idx` index. The backfill INSERT runs BEFORE the
 *     column drop so existing v1 load state carries forward.
 */

import { readFileSync } from 'node:fs';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { runMigrations, resetDbCache, getDb } from '../../src/db/client';

const DB_PATH = '/tmp/lootgoblin-printer-loadouts-schema.db';
const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../src/db/migrations/0000_true_viper.sql',
);

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = `file:${DB_PATH}`;
  await runMigrations(`file:${DB_PATH}`);
});

describe('V2-005f-CF-1-T_g1 printer_loadouts schema', () => {
  it('creates printer_loadouts table with required columns', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const cols = db.all(sql`PRAGMA table_info('printer_loadouts')`) as Array<{
      name: string;
      notnull: number;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual([
      'id',
      'printer_id',
      'slot_index',
      'material_id',
      'loaded_at',
      'unloaded_at',
      'loaded_by_user_id',
      'unloaded_by_user_id',
      'notes',
    ]);

    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('id')!.notnull).toBe(1);
    expect(byName.get('printer_id')!.notnull).toBe(1);
    expect(byName.get('slot_index')!.notnull).toBe(1);
    expect(byName.get('material_id')!.notnull).toBe(1);
    expect(byName.get('loaded_at')!.notnull).toBe(1);
    // Nullable columns:
    expect(byName.get('unloaded_at')!.notnull).toBe(0);
    expect(byName.get('loaded_by_user_id')!.notnull).toBe(0);
    expect(byName.get('unloaded_by_user_id')!.notnull).toBe(0);
    expect(byName.get('notes')!.notnull).toBe(0);
  });

  it('FK on printer_id is CASCADE; FK on material_id is RESTRICT; user FKs are SET NULL', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const fks = db.all(sql`PRAGMA foreign_key_list('printer_loadouts')`) as Array<{
      from: string;
      table: string;
      on_delete: string;
    }>;

    const printerFk = fks.find((f) => f.from === 'printer_id');
    expect(printerFk).toBeDefined();
    expect(printerFk!.table).toBe('printers');
    expect(printerFk!.on_delete).toBe('CASCADE');

    const materialFk = fks.find((f) => f.from === 'material_id');
    expect(materialFk).toBeDefined();
    expect(materialFk!.table).toBe('materials');
    expect(materialFk!.on_delete).toBe('RESTRICT');

    const loadedByFk = fks.find((f) => f.from === 'loaded_by_user_id');
    expect(loadedByFk).toBeDefined();
    expect(loadedByFk!.on_delete).toBe('SET NULL');

    const unloadedByFk = fks.find((f) => f.from === 'unloaded_by_user_id');
    expect(unloadedByFk).toBeDefined();
    expect(unloadedByFk!.on_delete).toBe('SET NULL');
  });

  it('idx_printer_loadouts_current is a partial unique index on (printer_id, slot_index) WHERE unloaded_at IS NULL', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const idxs = db.all(sql`PRAGMA index_list('printer_loadouts')`) as Array<{
      name: string;
      unique: number;
    }>;
    const idx = idxs.find((i) => i.name === 'idx_printer_loadouts_current');
    expect(idx).toBeDefined();
    expect(idx!.unique).toBe(1);

    // Verify the partial WHERE clause is present in the stored DDL.
    const ddlRows = db.all(
      sql`SELECT sql FROM sqlite_master WHERE name = 'idx_printer_loadouts_current'`,
    ) as Array<{ sql: string }>;
    expect(ddlRows).toHaveLength(1);
    expect(ddlRows[0]!.sql).toMatch(/WHERE\s+unloaded_at\s+IS\s+NULL/i);

    // The two non-unique helper indexes also exist.
    const allNames = idxs.map((i) => i.name);
    expect(allNames).toEqual(
      expect.arrayContaining([
        'idx_printer_loadouts_current',
        'idx_printer_loadouts_printer_history',
        'idx_printer_loadouts_material',
      ]),
    );
  });

  it('materials.loaded_in_printer_ref column is removed and materials_loaded_idx is gone', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const cols = db.all(sql`PRAGMA table_info('materials')`) as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).not.toContain('loaded_in_printer_ref');

    const idxs = db.all(sql`PRAGMA index_list('materials')`) as Array<{ name: string }>;
    expect(idxs.map((i) => i.name)).not.toContain('materials_loaded_idx');
  });

  /**
   * Test 5 — consolidated migration contains printer_loadouts CREATE TABLE.
   *
   * The original backfill logic (INSERT from legacy loaded_in_printer_ref) was
   * part of the incremental migration from v1. The consolidated migration creates
   * tables fresh — no data backfill is needed. This test verifies the consolidated
   * migration SQL contains the CREATE TABLE for printer_loadouts.
   */
  it('consolidated migration creates printer_loadouts table', () => {
    const sqlText = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sqlText).toContain('CREATE TABLE `printer_loadouts`');
  });
});
