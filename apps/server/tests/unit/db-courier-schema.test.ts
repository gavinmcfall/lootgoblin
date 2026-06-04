/**
 * Unit tests for V2-006a-T1 schema — courier_pair_nonces table +
 * printer_reachable_via reachability columns.
 *
 * Coverage:
 *   1. Migration applies cleanly to a fresh DB.
 *   2. printer_reachable_via has the 3 new columns with correct defaults.
 *   3. courier_pair_nonces table exists with the expected columns.
 *   4. courier_pair_nonces.agent_id FK is ON DELETE CASCADE.
 *   5. Insert + round-trip of the new printer_reachable_via columns.
 *   6. Insert + round-trip of a courier_pair_nonces row.
 *   7. PRINTER_REACHABLE_STATUSES exported constant contains the 4 values.
 *   8. Cascade: delete agent → courier_pair_nonces row disappears.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { runMigrations, resetDbCache, getServerDb } from '../../src/db/client';
import { schema } from '../../src/db/client';
import { PRINTER_REACHABLE_STATUSES } from '../../src/db/schema.forge';

const DB_PATH = '/tmp/lootgoblin-v2006a-t1.db';

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = `file:${DB_PATH}`;
  await runMigrations(`file:${DB_PATH}`);
}, 30_000);

function db() {
  return getServerDb(`file:${DB_PATH}`);
}

function uid() {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Seed helpers (minimal — we only need agents, printers, and a user)
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedAgent(kind = 'courier'): Promise<string> {
  const id = uid();
  db().insert(schema.agents).values({ id, kind }).run();
  return id;
}

async function seedPrinter(ownerId: string): Promise<string> {
  const id = uid();
  db()
    .insert(schema.printers)
    .values({
      id,
      ownerId,
      kind: 'fdm_klipper',
      name: `Printer ${id.slice(0, 8)}`,
      connectionConfig: { url: 'http://10.0.0.1:7125' },
    })
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V2-006a-T1 courier schema migration', () => {
  it('1. migration applied — courier_pair_nonces + new prv columns exist', () => {
    const d = db() as unknown as { $client: { prepare: (s: string) => { all: () => Array<{ name: string }> } } };
    const sqlite = d.$client;

    // courier_pair_nonces table must exist
    const tables = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='courier_pair_nonces'`)
      .all();
    expect(tables.map((t) => t.name)).toContain('courier_pair_nonces');

    // printer_reachable_via must have the 3 new columns
    const cols = sqlite.prepare(`PRAGMA table_info('printer_reachable_via')`).all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('reachable_status');
    expect(colNames).toContain('last_checked_at');
    expect(colNames).toContain('detail');
  });

  it('2. printer_reachable_via reachable_status defaults to "unknown"', () => {
    const d = db() as unknown as { $client: { prepare: (s: string) => { all: () => Array<{ name: string; dflt_value: string | null; notnull: number }> } } };
    const sqlite = d.$client;
    const cols = sqlite.prepare(`PRAGMA table_info('printer_reachable_via')`).all();
    const statusCol = cols.find((c) => c.name === 'reachable_status');
    expect(statusCol).toBeDefined();
    expect(statusCol!.dflt_value).toBe("'unknown'");
    expect(statusCol!.notnull).toBe(1);
  });

  it('3. courier_pair_nonces has exactly the expected columns', () => {
    const d = db() as unknown as { $client: { prepare: (s: string) => { all: () => Array<{ name: string }> } } };
    const sqlite = d.$client;
    const cols = sqlite.prepare(`PRAGMA table_info('courier_pair_nonces')`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(['nonce', 'consumed_at', 'agent_id']);
  });

  it('4. courier_pair_nonces.agent_id FK is ON DELETE CASCADE', () => {
    const d = db() as unknown as { $client: { prepare: (s: string) => { all: () => Array<{ from: string; table: string; on_delete: string }> } } };
    const sqlite = d.$client;
    const fks = sqlite.prepare(`PRAGMA foreign_key_list('courier_pair_nonces')`).all();
    const fk = fks.find((f) => f.from === 'agent_id');
    expect(fk).toBeDefined();
    expect(fk!.table).toBe('agents');
    expect(fk!.on_delete).toBe('CASCADE');
  });

  it('5. insert + read printer_reachable_via with new columns', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const agentId = await seedAgent();

    db().insert(schema.printerReachableVia).values({
      printerId,
      agentId,
      reachableStatus: 'reachable',
      lastCheckedAt: new Date(1_700_000_000_000),
      detail: 'Moonraker v0.12.0',
    }).run();

    const rows = db()
      .select()
      .from(schema.printerReachableVia)
      .where(eq(schema.printerReachableVia.printerId, printerId))
      .all();

    expect(rows.length).toBe(1);
    expect(rows[0]!.reachableStatus).toBe('reachable');
    expect(rows[0]!.lastCheckedAt).toEqual(new Date(1_700_000_000_000));
    expect(rows[0]!.detail).toBe('Moonraker v0.12.0');
  });

  it('5b. printer_reachable_via without explicit status defaults to "unknown"', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const agentId = await seedAgent();

    db().insert(schema.printerReachableVia).values({ printerId, agentId }).run();

    const rows = db()
      .select()
      .from(schema.printerReachableVia)
      .where(eq(schema.printerReachableVia.printerId, printerId))
      .all();

    expect(rows.length).toBe(1);
    expect(rows[0]!.reachableStatus).toBe('unknown');
    expect(rows[0]!.lastCheckedAt).toBeNull();
    expect(rows[0]!.detail).toBeNull();
  });

  it('6. insert + read a courier_pair_nonces row', async () => {
    const agentId = await seedAgent();
    const nonce = uid();
    const consumedAt = new Date(0); // epoch = unclaimed sentinel

    db().insert(schema.courierPairNonces).values({ nonce, consumedAt, agentId }).run();

    const rows = db()
      .select()
      .from(schema.courierPairNonces)
      .where(eq(schema.courierPairNonces.nonce, nonce))
      .all();

    expect(rows.length).toBe(1);
    expect(rows[0]!.nonce).toBe(nonce);
    expect(rows[0]!.consumedAt).toEqual(new Date(0));
    expect(rows[0]!.agentId).toBe(agentId);
  });

  it('7. PRINTER_REACHABLE_STATUSES constant has the 4 expected values', () => {
    expect(PRINTER_REACHABLE_STATUSES).toEqual(['unknown', 'reachable', 'unreachable', 'auth_failed']);
  });

  it('8. cascade: delete agent → courier_pair_nonces row disappears', async () => {
    const agentId = await seedAgent();
    const nonce = uid();

    db().insert(schema.courierPairNonces).values({ nonce, consumedAt: new Date(0), agentId }).run();

    // Verify row exists
    const before = db()
      .select()
      .from(schema.courierPairNonces)
      .where(eq(schema.courierPairNonces.nonce, nonce))
      .all();
    expect(before.length).toBe(1);

    // Delete the agent
    db().delete(schema.agents).where(eq(schema.agents.id, agentId)).run();

    // Row must be gone
    const after = db()
      .select()
      .from(schema.courierPairNonces)
      .where(eq(schema.courierPairNonces.nonce, nonce))
      .all();
    expect(after.length).toBe(0);
  });
});
