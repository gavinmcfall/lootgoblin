/**
 * Integration tests — warning dedup logic — V2-005f-CF-5a T_a6
 *
 * Tests the full warning-dedup pipeline:
 *   dedupAndPersistWarning (atomic ON CONFLICT upsert) +
 *   createStatusEventSink warning-branch wiring
 *
 * Uses real SQLite + drizzle-kit migrations (no mocks). Each test gets a
 * fresh DB seeded with a minimal user / collection / loot / printer /
 * dispatch_job so the correlator resolves correctly.
 *
 * Coverage:
 *   1. First warning: persists to dispatch_status_events + dispatch_warnings
 *      (count=1), emits via bus.
 *   2. Repeat warning (5×): dispatch_status_events stays at 1 row,
 *      dispatch_warnings count bumps to 5, bus emits only once.
 *   3. Different errorCode on same job: separate dispatch_warnings row.
 *   4. Same errorCode on different jobs: separate dispatch_warnings rows.
 *   5. Warning without errorCode: falls through to normal audit path
 *      (no dedup), bus emits, dispatch_status_events gets a row.
 *   6. Severity default: warning event with severity=undefined → warning
 *      row stored with severity='warning' default.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import {
  runMigrations,
  resetDbCache,
  getDb,
} from '../../src/db/client';
import * as schema from '../../src/db/schema';
import { createStatusEventSink } from '../../src/forge/status/status-event-handler';
import type { StatusEvent } from '../../src/forge/status/types';

const DB_PATH = '/tmp/lootgoblin-status-event-handler-warnings.db';
const DB_URL = `file:${DB_PATH}`;

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  process.env.LOOTGOBLIN_SECRET ??= 'a'.repeat(32);
  await runMigrations(DB_URL);
}, 30_000);

beforeEach(() => {
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
});

afterEach(async () => {
  const db = getDb(DB_URL) as any;
  await db.delete(schema.dispatchWarnings);
  await db.delete(schema.dispatchStatusEvents);
  await db.delete(schema.dispatchJobs);
  await db.delete(schema.lootFiles);
  await db.delete(schema.printers);
  await db.delete(schema.loot);
  await db.delete(schema.collections);
  await db.delete(schema.stashRoots);
  await db.delete(schema.user);
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
}

async function seedMinimal(): Promise<{
  printerId: string;
  dispatchJobId: string;
}> {
  const db = getDb(DB_URL) as any;

  const userId = uid('u');
  await db.insert(schema.user).values({
    id: userId,
    name: 'warning-dedup test',
    email: `${userId}@dedup.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const rootId = uid('r');
  await db.insert(schema.stashRoots).values({
    id: rootId,
    ownerId: userId,
    name: 'root',
    path: `/tmp/lg-warn-${userId.slice(0, 8)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const collectionId = uid('c');
  await db.insert(schema.collections).values({
    id: collectionId,
    ownerId: userId,
    name: `c-${collectionId.slice(0, 6)}`,
    pathTemplate: '{title|slug}',
    stashRootId: rootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const lootId = uid('l');
  await db.insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: 'cube',
    tags: [],
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const printerId = uid('p');
  // Use bambu_x1c so derivePrinterProtocol → 'bambu_lan'
  await db.insert(schema.printers).values({
    id: printerId,
    ownerId: userId,
    kind: 'bambu_x1c',
    name: `printer-${printerId.slice(0, 6)}`,
    connectionConfig: { ip: '192.168.1.99' },
    active: true,
    createdAt: new Date(),
  });

  const dispatchJobId = uid('j');
  await db.insert(schema.dispatchJobs).values({
    id: dispatchJobId,
    ownerId: userId,
    lootId,
    targetKind: 'printer',
    targetId: printerId,
    status: 'dispatched',
    createdAt: new Date(),
  });

  return { printerId, dispatchJobId };
}

function warningEvent(overrides: Partial<StatusEvent> = {}): StatusEvent {
  return {
    kind: 'warning',
    remoteJobRef: '',
    errorCode: '0C00-0300',
    errorMessage: 'Filament tangle detected',
    severity: 'warning',
    rawPayload: { hms_code: '0C00-0300' },
    occurredAt: new Date('2026-05-09T10:00:00Z'),
    ...overrides,
  };
}

// ===========================================================================
// Tests — warning dedup — V2-005f-CF-5a T_a6
// ===========================================================================

describe('warning dedup — V2-005f-CF-5a T_a6', () => {
  it('1. first warning persists to dispatch_status_events + dispatch_warnings + emits via bus', async () => {
    const { printerId, dispatchJobId } = await seedMinimal();

    const busCalls: string[] = [];
    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: {
        emitToBus: (id) => {
          busCalls.push(id);
        },
      },
    });

    await sink(printerId, warningEvent({ errorCode: '0C00-0300' }));

    const db = getDb(DB_URL) as any;

    // 1 row in dispatch_status_events
    const statusEvents = await db
      .select()
      .from(schema.dispatchStatusEvents)
      .where(eq(schema.dispatchStatusEvents.dispatchJobId, dispatchJobId));
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0].eventKind).toBe('warning');

    // 1 row in dispatch_warnings with count=1
    const warnings = await db
      .select()
      .from(schema.dispatchWarnings)
      .where(eq(schema.dispatchWarnings.dispatchJobId, dispatchJobId));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].errorCode).toBe('0C00-0300');
    expect(warnings[0].count).toBe(1);
    expect(warnings[0].protocol).toBe('bambu_lan');

    // 1 bus emit
    expect(busCalls).toHaveLength(1);
    expect(busCalls[0]).toBe(dispatchJobId);
  });

  it('2. repeat warning bumps count + last_seen_at, NO new dispatch_status_events row, NO extra bus emit', async () => {
    const { printerId, dispatchJobId } = await seedMinimal();

    const busCalls: string[] = [];
    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: {
        emitToBus: (id) => {
          busCalls.push(id);
        },
      },
    });

    const baseTime = new Date('2026-05-09T10:00:00Z');
    // Drive the same warning event 5 times with advancing timestamps
    for (let i = 0; i < 5; i++) {
      await sink(
        printerId,
        warningEvent({
          errorCode: '0C00-0300',
          occurredAt: new Date(baseTime.getTime() + i * 1000),
        }),
      );
    }

    const db = getDb(DB_URL) as any;

    // Still only 1 row in dispatch_status_events
    const statusEvents = await db
      .select()
      .from(schema.dispatchStatusEvents)
      .where(eq(schema.dispatchStatusEvents.dispatchJobId, dispatchJobId));
    expect(statusEvents).toHaveLength(1);

    // 1 row in dispatch_warnings with count=5
    const warnings = await db
      .select()
      .from(schema.dispatchWarnings)
      .where(eq(schema.dispatchWarnings.dispatchJobId, dispatchJobId));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].count).toBe(5);
    // last_seen_at should be the 5th event's occurredAt (4000ms after base)
    expect(warnings[0].lastSeenAt.getTime()).toBe(baseTime.getTime() + 4 * 1000);
    // first_seen_at should be the first event's occurredAt
    expect(warnings[0].firstSeenAt.getTime()).toBe(baseTime.getTime());

    // Only 1 bus emit (the first occurrence)
    expect(busCalls).toHaveLength(1);
  });

  it('3. different errorCode on same job creates separate dispatch_warnings rows', async () => {
    const { printerId, dispatchJobId } = await seedMinimal();

    const sink = createStatusEventSink({ dbUrl: DB_URL });

    await sink(printerId, warningEvent({ errorCode: '0C00-0300' }));
    await sink(printerId, warningEvent({ errorCode: '0300-4000' }));

    const db = getDb(DB_URL) as any;

    const warnings = await db
      .select()
      .from(schema.dispatchWarnings)
      .where(eq(schema.dispatchWarnings.dispatchJobId, dispatchJobId));
    expect(warnings).toHaveLength(2);

    const codes = warnings.map((w: { errorCode: string }) => w.errorCode).sort();
    expect(codes).toEqual(['0300-4000', '0C00-0300']);

    // Both should have count=1
    for (const w of warnings) {
      expect(w.count).toBe(1);
    }
  });

  it('4. same errorCode on different jobs creates separate dispatch_warnings rows', async () => {
    const { printerId: p1, dispatchJobId: j1 } = await seedMinimal();
    const { printerId: p2, dispatchJobId: j2 } = await seedMinimal();

    const sink = createStatusEventSink({ dbUrl: DB_URL });

    await sink(p1, warningEvent({ errorCode: 'A100' }));
    await sink(p2, warningEvent({ errorCode: 'A100' }));

    const db = getDb(DB_URL) as any;

    const w1 = await db
      .select()
      .from(schema.dispatchWarnings)
      .where(eq(schema.dispatchWarnings.dispatchJobId, j1));
    expect(w1).toHaveLength(1);
    expect(w1[0].errorCode).toBe('A100');

    const w2 = await db
      .select()
      .from(schema.dispatchWarnings)
      .where(eq(schema.dispatchWarnings.dispatchJobId, j2));
    expect(w2).toHaveLength(1);
    expect(w2[0].errorCode).toBe('A100');

    // Separate rows (different dispatch_job_id)
    expect(w1[0].id).not.toBe(w2[0].id);
  });

  it('5. warning event without errorCode falls through to normal audit path (no dedup, bus emits, row persisted)', async () => {
    const { printerId, dispatchJobId } = await seedMinimal();

    const busCalls: string[] = [];
    const sink = createStatusEventSink({
      dbUrl: DB_URL,
      deps: {
        emitToBus: (id) => {
          busCalls.push(id);
        },
      },
    });

    // Warning with no errorCode — should still go through normal persist path
    await sink(
      printerId,
      warningEvent({ errorCode: undefined }),
    );

    const db = getDb(DB_URL) as any;

    // Row persisted in dispatch_status_events
    const statusEvents = await db
      .select()
      .from(schema.dispatchStatusEvents)
      .where(eq(schema.dispatchStatusEvents.dispatchJobId, dispatchJobId));
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0].eventKind).toBe('warning');

    // No row in dispatch_warnings (dedup only fires when errorCode is truthy)
    const warnings = await db
      .select()
      .from(schema.dispatchWarnings)
      .where(eq(schema.dispatchWarnings.dispatchJobId, dispatchJobId));
    expect(warnings).toHaveLength(0);

    // Bus still emits
    expect(busCalls).toHaveLength(1);
  });

  it('6. severity default: warning event with severity=undefined stores severity="warning" in dispatch_warnings', async () => {
    const { printerId, dispatchJobId } = await seedMinimal();

    const sink = createStatusEventSink({ dbUrl: DB_URL });

    // Emit warning with no severity
    await sink(
      printerId,
      warningEvent({ severity: undefined, errorCode: 'Z999' }),
    );

    const db = getDb(DB_URL) as any;

    const warnings = await db
      .select()
      .from(schema.dispatchWarnings)
      .where(eq(schema.dispatchWarnings.dispatchJobId, dispatchJobId));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('warning');
  });
});
