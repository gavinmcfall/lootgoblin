/**
 * Unit tests for V2-005e-T_e1 schema — forge_inboxes + loot.parent_loot_id +
 * forge_pending_pairings.
 *
 *   - forge_inboxes is the per-user watched filesystem drop. FKs:
 *       owner_id          ON DELETE CASCADE   (owner removal drops inboxes)
 *       default_printer_id ON DELETE SET NULL (printer removal → watch-only)
 *   - loot.parent_loot_id is the slice → source fast-path FK; ON DELETE SET
 *     NULL preserves the slice row when its source is removed. Distinct from
 *     the `loot_relationships` m:n graph (V3+ remix/derivative edges).
 *   - forge_pending_pairings is the pairing-queue backstop. The partial
 *     UNIQUE index `idx_pending_pairings_slice` enforces "at most one open
 *     pending row per slice"; closed (resolved_at NOT NULL) rows freely
 *     repeat for audit.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { runMigrations, resetDbCache, getDb } from '../../src/db/client';

const DB_PATH = '/tmp/lootgoblin-forge-inboxes-schema.db';

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = `file:${DB_PATH}`;
  await runMigrations(`file:${DB_PATH}`);
});

describe('V2-005e-T_e1 schema', () => {
  it('forge_inboxes table has required columns + types', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const cols = db.all(sql`PRAGMA table_info('forge_inboxes')`) as Array<{
      name: string;
      notnull: number;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual([
      'id',
      'owner_id',
      'name',
      'path',
      'default_printer_id',
      'active',
      'notes',
      'created_at',
    ]);

    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('id')!.notnull).toBe(1);
    expect(byName.get('owner_id')!.notnull).toBe(1);
    expect(byName.get('name')!.notnull).toBe(1);
    expect(byName.get('path')!.notnull).toBe(1);
    expect(byName.get('active')!.notnull).toBe(1);
    expect(byName.get('created_at')!.notnull).toBe(1);
    // Nullable columns:
    expect(byName.get('default_printer_id')!.notnull).toBe(0);
    expect(byName.get('notes')!.notnull).toBe(0);
  });

  it('forge_inboxes FKs: owner CASCADE, default_printer SET NULL', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const fks = db.all(sql`PRAGMA foreign_key_list('forge_inboxes')`) as Array<{
      from: string;
      table: string;
      on_delete: string;
    }>;

    const ownerFk = fks.find((f) => f.from === 'owner_id');
    expect(ownerFk).toBeDefined();
    expect(ownerFk!.table).toBe('user');
    expect(ownerFk!.on_delete).toBe('CASCADE');

    const printerFk = fks.find((f) => f.from === 'default_printer_id');
    expect(printerFk).toBeDefined();
    expect(printerFk!.table).toBe('printers');
    expect(printerFk!.on_delete).toBe('SET NULL');
  });

  it('idx_forge_inboxes_owner index is present', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const idxs = db.all(sql`PRAGMA index_list('forge_inboxes')`) as Array<{
      name: string;
    }>;
    expect(idxs.find((i) => i.name === 'idx_forge_inboxes_owner')).toBeDefined();
  });

  it('loot.parent_loot_id column exists and is nullable', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const cols = db.all(sql`PRAGMA table_info('loot')`) as Array<{
      name: string;
      notnull: number;
    }>;
    const col = cols.find((c) => c.name === 'parent_loot_id');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
  });

  it('loot.parent_loot_id FK is SET NULL → loot(id)', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const fks = db.all(sql`PRAGMA foreign_key_list('loot')`) as Array<{
      from: string;
      table: string;
      to: string;
      on_delete: string;
    }>;
    const parentFk = fks.find((f) => f.from === 'parent_loot_id');
    expect(parentFk).toBeDefined();
    expect(parentFk!.table).toBe('loot');
    expect(parentFk!.to).toBe('id');
    expect(parentFk!.on_delete).toBe('SET NULL');
  });

  it('idx_loot_parent index is present', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const idxs = db.all(sql`PRAGMA index_list('loot')`) as Array<{
      name: string;
    }>;
    expect(idxs.find((i) => i.name === 'idx_loot_parent')).toBeDefined();
  });

  it('idx_pending_pairings_slice is partial unique index where resolved_at IS NULL', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const idxs = db.all(sql`PRAGMA index_list('forge_pending_pairings')`) as Array<{
      name: string;
      unique: number;
    }>;
    const idx = idxs.find((i) => i.name === 'idx_pending_pairings_slice');
    expect(idx).toBeDefined();
    expect(idx!.unique).toBe(1);

    const ddlRows = db.all(
      sql`SELECT sql FROM sqlite_master WHERE name = 'idx_pending_pairings_slice'`,
    ) as Array<{ sql: string }>;
    expect(ddlRows).toHaveLength(1);
    expect(ddlRows[0]!.sql).toMatch(/UNIQUE/i);
    expect(ddlRows[0]!.sql).toMatch(/WHERE\s+resolved_at\s+IS\s+NULL/i);
  });
});
