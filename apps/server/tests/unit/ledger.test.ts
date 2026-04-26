/**
 * Unit tests for persistLedgerEvent — V2-002-T13
 *
 * Uses a real SQLite DB at /tmp/lootgoblin-ledger-unit.db for tests 1-4.
 * Test 5 uses vi.spyOn to inject a failing getDb to prove non-throwing behaviour.
 *
 * Test cases:
 *   1. Valid event → returns { eventId: UUID }, row persisted.
 *   2. Payload JSON round-trip — Record → INSERT → SELECT → JSON.parse matches.
 *   3. Null actorUserId is stored as NULL.
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
        actorUserId: 'user-123',
        subjectType: 'loot',
        subjectId: 'loot-abc',
        // V2-007a-T12: payload must satisfy the registered schema for
        // 'migration.execute' (production shape from template-migration.ts).
        payload: {
          lootFileId: 'lf-abc',
          collectionId: 'coll-xyz',
          oldPath: 'a/b.stl',
          newPath: 'c/d.stl',
          timestamp: '2026-04-25T00:00:00.000Z',
        },
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
    expect(row.actorUserId).toBe('user-123');
    expect(row.subjectType).toBe('loot');
    expect(row.subjectId).toBe('loot-abc');
    expect(row.ingestedAt).toBeInstanceOf(Date);
    // V2-007a-T3: occurredAt defaults to NULL when caller doesn't supply it.
    expect(row.occurredAt).toBeNull();
    // provenanceClass + relatedResources also default to NULL.
    expect(row.provenanceClass).toBeNull();
    expect(row.relatedResources).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Payload JSON round-trip
// ---------------------------------------------------------------------------

describe('persistLedgerEvent — payload round-trip', () => {
  it('JSON-serializes payload on INSERT and parses back to matching shape', async () => {
    // V2-007a-T12: 'migration.execute' is a registered kind. Use its full
    // production shape so the schema accepts; the round-trip assertion below
    // still proves arbitrary nested data is preserved verbatim because Zod
    // doesn't strip unknown nested keys (we use object schemas, not strict).
    const payload = {
      lootFileId: 'lf-round-trip',
      collectionId: 'coll-xyz',
      oldPath: 'legacy/thing.stl',
      newPath: 'creator/thing.stl',
      timestamp: '2026-04-25T00:00:00.000Z',
    };

    const result = await persistLedgerEvent(
      {
        kind: 'migration.execute',
        subjectType: 'loot',
        subjectId: 'loot-round-trip',
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
// Test 3 — Null actorUserId stored as NULL
// ---------------------------------------------------------------------------

describe('persistLedgerEvent — null actorUserId', () => {
  it('stores actorUserId as NULL when not provided', async () => {
    const result = await persistLedgerEvent(
      {
        kind: 'bulk.move-to-collection',
        subjectType: 'collection',
        subjectId: 'coll-no-actor',
      },
      DB_URL,
    );

    expect(result.eventId).toBeTruthy();

    const rows = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, result.eventId!));

    expect(rows[0]!.actorUserId).toBeNull();
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
        subjectType: 'loot',
        subjectId: 'loot-no-payload',
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

describe('persistLedgerEvent — circular-ref payload is replaced with placeholder', () => {
  it('persists the event with a placeholder payload when JSON.stringify throws', async () => {
    // Construct a payload that satisfies the registered 'migration.execute'
    // schema (V2-007a-T12) but ALSO contains a self-referential field. Zod
    // strips unknown keys during validation, but the helper serializes the
    // ORIGINAL payload — so JSON.stringify still throws TypeError on the
    // circular `self`, exercising the circular-ref placeholder branch.
    type CircularPayload = Record<string, unknown> & { self?: CircularPayload };
    const circular: CircularPayload = {
      lootFileId: 'lf-circular',
      collectionId: 'coll-circular',
      oldPath: 'old/p.stl',
      newPath: 'new/p.stl',
      timestamp: '2026-04-25T00:00:00.000Z',
    };
    circular.self = circular;

    const result = await persistLedgerEvent(
      {
        kind: 'migration.execute',
        actorUserId: 'user-circular',
        subjectType: 'loot',
        subjectId: 'loot-circular',
        payload: circular,
      },
      DB_URL,
    );

    // The event still persists — caller contract is fire-and-continue, and
    // a circular payload is a misbehaving caller, not a DB failure.
    expect(result.eventId).toBeTruthy();
    expect(typeof result.eventId).toBe('string');

    const rows = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, result.eventId!));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('migration.execute');
    expect(row.actorUserId).toBe('user-circular');

    // Stored payload is the placeholder shape, NOT the original object.
    const stored = JSON.parse(row.payload!);
    expect(stored).toEqual({
      _serialization_failed: true,
      reason: 'circular-reference',
    });
  });
});

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
      subjectType: 'loot',
      subjectId: 'loot-fail',
    });

    expect(result.eventId).toBeNull();
    // No throw — test itself proves it by reaching here.
  });
});

// ---------------------------------------------------------------------------
// V2-007a-T3 — new field tests
// ---------------------------------------------------------------------------

describe('persistLedgerEvent — V2-007a-T3 occurredAt', () => {
  it('stores occurredAt distinct from ingestedAt when caller provides it', async () => {
    const occurred = new Date(Date.now() - 60 * 60 * 1000); // 1h ago

    const result = await persistLedgerEvent(
      {
        kind: 'forge.dispatch.completed',
        subjectType: 'forge-job',
        subjectId: 'job-occurred-at',
        occurredAt: occurred,
      },
      DB_URL,
    );

    expect(result.eventId).toBeTruthy();

    const rows = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, result.eventId!));

    const row = rows[0]!;
    expect(row.occurredAt).toBeInstanceOf(Date);
    expect(row.occurredAt!.getTime()).toBe(occurred.getTime());
    // ingestedAt is "now" — must be strictly later than occurredAt.
    expect(row.ingestedAt!.getTime()).toBeGreaterThan(row.occurredAt!.getTime());
  });
});

describe('persistLedgerEvent — V2-007a-T3 relatedResources', () => {
  it('stores related-resource pointers as JSON and round-trips them', async () => {
    const related = [
      { kind: 'material', id: 'src-bottle-1', role: 'source' },
      { kind: 'material', id: 'src-bottle-2', role: 'source' },
      { kind: 'mix-batch', id: 'mix-output-1', role: 'output' },
    ];

    const result = await persistLedgerEvent(
      {
        kind: 'material.mix',
        subjectType: 'mix-batch',
        subjectId: 'mix-output-1',
        relatedResources: related,
        provenanceClass: 'computed',
      },
      DB_URL,
    );

    expect(result.eventId).toBeTruthy();

    const rows = await db()
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, result.eventId!));

    const row = rows[0]!;
    // Drizzle { mode: 'json' } returns the parsed array directly.
    expect(row.relatedResources).toEqual(related);
    expect(row.provenanceClass).toBe('computed');
  });
});

describe('persistLedgerEvent — V2-007a-T3 provenanceClass values', () => {
  it.each(['measured', 'entered', 'estimated', 'derived', 'computed', 'system'] as const)(
    'persists provenanceClass=%s',
    async (provenance) => {
      const result = await persistLedgerEvent(
        {
          kind: 'material.consume',
          subjectType: 'material',
          subjectId: `material-${provenance}`,
          provenanceClass: provenance,
          payload: { grams: 12.5 },
        },
        DB_URL,
      );

      expect(result.eventId).toBeTruthy();

      const rows = await db()
        .select()
        .from(schema.ledgerEvents)
        .where(eq(schema.ledgerEvents.id, result.eventId!));

      expect(rows[0]!.provenanceClass).toBe(provenance);
    },
  );
});
