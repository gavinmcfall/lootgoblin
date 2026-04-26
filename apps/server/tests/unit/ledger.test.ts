/**
 * Unit tests for persistLedgerEvent — V2-002-T13
 *
 * Uses a real SQLite DB at /tmp/lootgoblin-ledger-unit.db for tests 1-4.
 * Test 5 uses vi.spyOn to inject a failing getDb to prove non-throwing behaviour.
 *
 * Test cases:
 *   1. Valid event → returns { eventId: UUID }, row persisted.
 *   2. Payload JSON round-trip — Record → INSERT → SELECT → JSON.parse matches.
 *   3. Null actorId is stored as NULL.
 *   4. Undefined payload is stored as NULL.
 *   5. DB write failure → returns { eventId: null }, no throw.
 */

import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { persistLedgerEvent } from '../../src/stash/ledger';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-ledger-unit.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
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
// Test 1 — Valid event → row persisted, returns UUID eventId
// ---------------------------------------------------------------------------

describe('persistLedgerEvent — happy path', () => {
  it('returns a UUID eventId and persists the row', async () => {
    const result = await persistLedgerEvent(
      {
        kind: 'migration.execute',
        actorId: 'user-123',
        resourceType: 'loot',
        resourceId: 'loot-abc',
        payload: { oldPath: 'a/b.stl', newPath: 'c/d.stl' },
      },
      DB_URL,
    );

    expect(result.eventId).toBeTruthy();
    expect(typeof result.eventId).toBe('string');
    // UUID v4 shape: 8-4-4-4-12 hex chars
    expect(result.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    // Row persisted
    const rows = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, result.eventId!));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('migration.execute');
    expect(row.actorId).toBe('user-123');
    expect(row.resourceType).toBe('loot');
    expect(row.resourceId).toBe('loot-abc');
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Payload JSON round-trip
// ---------------------------------------------------------------------------

describe('persistLedgerEvent — payload round-trip', () => {
  it('JSON-serializes payload on INSERT and parses back to matching shape', async () => {
    const payload = {
      oldPath: 'legacy/thing.stl',
      newPath: 'creator/thing.stl',
      collectionId: 'coll-xyz',
      extra: { nested: true, count: 42 },
    };

    const result = await persistLedgerEvent(
      {
        kind: 'migration.execute',
        resourceType: 'loot',
        resourceId: 'loot-round-trip',
        payload,
      },
      DB_URL,
    );

    expect(result.eventId).toBeTruthy();

    const rows = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, result.eventId!));

    expect(rows).toHaveLength(1);
    const storedPayload = JSON.parse(rows[0]!.payload!);
    expect(storedPayload).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Null actorId stored as NULL
// ---------------------------------------------------------------------------

describe('persistLedgerEvent — null actorId', () => {
  it('stores actorId as NULL when not provided', async () => {
    const result = await persistLedgerEvent(
      {
        kind: 'bulk.move-to-collection',
        resourceType: 'collection',
        resourceId: 'coll-no-actor',
      },
      DB_URL,
    );

    expect(result.eventId).toBeTruthy();

    const rows = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, result.eventId!));

    expect(rows[0]!.actorId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Undefined payload stored as NULL
// ---------------------------------------------------------------------------

describe('persistLedgerEvent — null payload', () => {
  it('stores payload as NULL when not provided', async () => {
    const result = await persistLedgerEvent(
      {
        kind: 'migration.execute',
        resourceType: 'loot',
        resourceId: 'loot-no-payload',
      },
      DB_URL,
    );

    expect(result.eventId).toBeTruthy();

    const rows = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, result.eventId!));

    expect(rows[0]!.payload).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 5 — DB write failure → returns { eventId: null }, no throw
// ---------------------------------------------------------------------------

describe('persistLedgerEvent — DB failure is non-fatal', () => {
  it('returns { eventId: null } and does not throw when getDb throws', async () => {
    // Spy on getDb to throw — simulates a broken DB connection.
    // persistLedgerEvent imports getDb from '../db/client' at module level;
    // we spy on the named export to intercept it.
    const clientModule = await import('../../src/db/client');
    vi.spyOn(clientModule, 'getDb').mockImplementation(() => {
      throw new Error('simulated DB connection failure');
    });

    // Re-import to pick up the spy. Since ES modules are cached, we call
    // persistLedgerEvent directly — it imports getDb at call time from the
    // cached module, which now has the spy on it.
    const result = await persistLedgerEvent({
      kind: 'migration.execute',
      resourceType: 'loot',
      resourceId: 'loot-fail',
    });

    expect(result.eventId).toBeNull();
    // No throw — test itself proves it by reaching here.
  });
});
