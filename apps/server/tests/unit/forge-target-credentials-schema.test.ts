/**
 * Unit tests for V2-005d-a schema — forge_target_credentials.
 *
 * Stores per-printer encrypted credential blobs for the dispatch worker /
 * adapters (Moonraker API key today; Bambu LAN, SDCP, OctoPrint reuse the
 * same table in V2-005d-{b,c,d}).
 *
 *   - one row per printer (UNIQUE on printer_id)
 *   - encrypted_blob is BLOB NOT NULL — base64(nonce||ct||tag) from
 *     apps/server/src/crypto.ts encrypt()
 *   - kind discriminator validated app-side against
 *     FORGE_TARGET_CREDENTIAL_KINDS
 *   - ON DELETE CASCADE from printers (deleting a printer drops its creds)
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { runMigrations, resetDbCache, getDb } from '../../src/db/client';

const DB_PATH = '/tmp/lootgoblin-forge-target-credentials-schema.db';

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

describe('V2-005d-a forge_target_credentials schema', () => {
  it('has expected columns', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const cols = db.all(sql`PRAGMA table_info(forge_target_credentials)`).map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'printer_id', 'kind', 'encrypted_blob', 'label',
      'last_used_at', 'created_at', 'updated_at',
    ]));
  });

  it('printer_id has UNIQUE constraint (one cred row per printer)', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const indexes = db.all(sql`PRAGMA index_list(forge_target_credentials)`);
    const uniques = indexes.filter((i: any) => i.unique === 1);
    expect(uniques.length).toBeGreaterThan(0);
    // verify at least one unique covers printer_id
    const found = uniques.some((idx: any) => {
      const cols = db.all(sql`PRAGMA index_info(${sql.raw(idx.name)})`);
      return cols.some((c: any) => c.name === 'printer_id');
    });
    expect(found).toBe(true);
  });

  it('encrypted_blob is BLOB-typed and NOT NULL', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const cols = db.all(sql`PRAGMA table_info(forge_target_credentials)`);
    const eb = cols.find((c: any) => c.name === 'encrypted_blob');
    expect(eb).toBeDefined();
    expect(String(eb.type).toUpperCase()).toBe('BLOB');
    expect(eb.notnull).toBe(1);
  });
});
