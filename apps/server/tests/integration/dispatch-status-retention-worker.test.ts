/**
 * Integration tests — V2-cleanup-batch-3 T2 (CF-2):
 *   dispatch-status retention worker.
 *
 * Drives `runRetentionTickOnce` against a real SQLite test DB, verifying
 * the env-driven retention window and the disabled-mode skip.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import {
  getRetentionDays,
  runRetentionTickOnce,
} from '../../src/workers/dispatch-status-retention-worker';

const DB_PATH = '/tmp/lootgoblin-dispatch-status-retention.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}
function uid(): string {
  return crypto.randomUUID();
}

const DAY_MS = 24 * 3600_000;

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      await fsp.unlink(`${DB_PATH}${suffix}`);
    } catch {
      /* ignore */
    }
  }
  process.env.DATABASE_URL = DB_URL;
  resetDbCache();
  await runMigrations(DB_URL);
});

beforeEach(async () => {
  await db().delete(schema.dispatchStatusEvents);
  await db().delete(schema.dispatchJobs);
  await db().delete(schema.printers);
  await db().delete(schema.lootFiles);
  await db().delete(schema.loot);
  await db().delete(schema.collections);
  await db().delete(schema.stashRoots);
  await db().delete(schema.user);
  delete process.env.DISPATCH_STATUS_EVENTS_RETENTION_DAYS;
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedDispatch(): Promise<string> {
  const userId = uid();
  await db().insert(schema.user).values({
    id: userId,
    name: 'retention-test',
    email: `${userId}@retention.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const rootId = uid();
  await db().insert(schema.stashRoots).values({
    id: rootId,
    ownerId: userId,
    name: 'r',
    path: '/tmp/r',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId: userId,
    name: `c-${collectionId.slice(0, 6)}`,
    pathTemplate: '{title|slug}',
    stashRootId: rootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootId = uid();
  await db().insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: 'm',
    tags: [],
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const printerId = uid();
  await db().insert(schema.printers).values({
    id: printerId,
    ownerId: userId,
    kind: 'fdm_klipper',
    name: 'p',
    connectionConfig: { url: 'http://1.1.1.1' },
    active: true,
    createdAt: new Date(),
  });
  const dispatchJobId = uid();
  await db().insert(schema.dispatchJobs).values({
    id: dispatchJobId,
    ownerId: userId,
    lootId,
    targetKind: 'printer',
    targetId: printerId,
    status: 'dispatched',
    createdAt: new Date(),
  });
  return dispatchJobId;
}

async function seedEvent(dispatchJobId: string, ageDays: number, now: Date): Promise<string> {
  const id = uid();
  const occurredAt = new Date(now.getTime() - ageDays * DAY_MS);
  await db().insert(schema.dispatchStatusEvents).values({
    id,
    dispatchJobId,
    eventKind: 'progress',
    eventData: JSON.stringify({ progressPct: 50 }),
    sourceProtocol: 'moonraker',
    occurredAt,
    ingestedAt: occurredAt,
  });
  return id;
}

async function countEvents(): Promise<number> {
  const rows = await db().select().from(schema.dispatchStatusEvents);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatch-status retention worker (T2)', () => {
  it('deletes events older than retention cutoff (default 30d)', async () => {
    const dispatchJobId = await seedDispatch();
    const now = new Date('2026-05-01T00:00:00Z');
    await seedEvent(dispatchJobId, 31, now); // older than 30d → delete
    await seedEvent(dispatchJobId, 15, now); // within window
    await seedEvent(dispatchJobId, 0.1, now); // fresh

    expect(await countEvents()).toBe(3);

    const result = await runRetentionTickOnce({ dbUrl: DB_URL, now });

    expect(result.skipped).toBe(false);
    expect(result.retentionDays).toBe(30);
    expect(result.deleted).toBe(1);
    expect(await countEvents()).toBe(2);
  });

  it('respects DISPATCH_STATUS_EVENTS_RETENTION_DAYS env override', async () => {
    process.env.DISPATCH_STATUS_EVENTS_RETENTION_DAYS = '7';

    const dispatchJobId = await seedDispatch();
    const now = new Date('2026-05-01T00:00:00Z');
    await seedEvent(dispatchJobId, 8, now); // older than 7d → delete
    await seedEvent(dispatchJobId, 5, now);
    await seedEvent(dispatchJobId, 1, now);
    await seedEvent(dispatchJobId, 0.1, now);

    const result = await runRetentionTickOnce({ dbUrl: DB_URL, now });

    expect(result.retentionDays).toBe(7);
    expect(result.deleted).toBe(1);
    expect(await countEvents()).toBe(3);
  });

  it('skips when retention is disabled (0 or negative)', async () => {
    process.env.DISPATCH_STATUS_EVENTS_RETENTION_DAYS = '0';

    const dispatchJobId = await seedDispatch();
    const now = new Date('2026-05-01T00:00:00Z');
    await seedEvent(dispatchJobId, 365, now); // very old, would normally be deleted

    const result = await runRetentionTickOnce({ dbUrl: DB_URL, now });

    expect(result.skipped).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.retentionDays).toBe(0);
    expect(await countEvents()).toBe(1);
  });

  it('default retention is 30 days when env unset', () => {
    delete process.env.DISPATCH_STATUS_EVENTS_RETENTION_DAYS;
    expect(getRetentionDays()).toBe(30);
  });

  it('handles malformed env gracefully (falls back to default)', () => {
    process.env.DISPATCH_STATUS_EVENTS_RETENTION_DAYS = 'not-a-number';
    expect(getRetentionDays()).toBe(30);
  });
});
