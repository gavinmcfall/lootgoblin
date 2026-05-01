/**
 * Unit tests for V2-005f-T_dcf1 schema — dispatch_status_events table +
 * dispatch_jobs cache columns (materials_used / last_status_at / progress_pct).
 *
 *   - dispatch_status_events is the per-dispatch-job audit trail of every
 *     status update from any printer protocol (Moonraker, OctoPrint, Bambu
 *     LAN, SDCP, ChituBox-network). Append-only.
 *   - FK from dispatch_status_events.dispatch_job_id → dispatch_jobs.id is
 *     ON DELETE CASCADE: deleting a dispatch row drops its events.
 *   - occurred_at + ingested_at default to (unixepoch() * 1000).
 *   - dispatch_jobs gains three nullable columns the V2-005f status worker
 *     populates incrementally as events arrive.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { runMigrations, resetDbCache, getDb } from '../../src/db/client';
import * as schema from '../../src/db/schema';

const DB_PATH = '/tmp/lootgoblin-dispatch-status-events-schema.db';

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

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

/**
 * Seed user → stash_root → collection → loot → dispatch_job. Returns the
 * dispatch_job id so tests can attach status events to it.
 */
async function seedDispatchJob(): Promise<string> {
  const db = getDb(`file:${DB_PATH}`) as any;
  const userId = uid('u');
  const rootId = uid('r');
  const collectionId = uid('c');
  const lootId = uid('l');
  const jobId = uid('j');
  const root = mkdtempSync(join(tmpdir(), 'lg-status-evt-'));

  await db.insert(schema.user).values({
    id: userId,
    name: 'status-events test user',
    email: `${userId}@example.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.stashRoots).values({
    id: rootId,
    ownerId: userId,
    name: 'root',
    path: root,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.collections).values({
    id: collectionId,
    ownerId: userId,
    name: `c-${collectionId.slice(0, 6)}`,
    pathTemplate: '{title|slug}',
    stashRootId: rootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: 'cube',
    tags: [],
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.dispatchJobs).values({
    id: jobId,
    ownerId: userId,
    lootId,
    targetKind: 'printer',
    targetId: uid('p'),
    status: 'claimable',
    createdAt: new Date(),
  });
  return jobId;
}

describe('V2-005f-T_dcf1 dispatch_status_events schema', () => {
  it('creates dispatch_status_events table with FK cascade', async () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const jobId = await seedDispatchJob();
    const eventId = uid('e');

    await db.insert(schema.dispatchStatusEvents).values({
      id: eventId,
      dispatchJobId: jobId,
      eventKind: 'progress',
      eventData: '{"pct":42}',
      sourceProtocol: 'moonraker',
    });

    const before = await db
      .select()
      .from(schema.dispatchStatusEvents)
      .where(eq(schema.dispatchStatusEvents.id, eventId));
    expect(before).toHaveLength(1);

    // Delete parent → CASCADE drops the event row.
    await db.delete(schema.dispatchJobs).where(eq(schema.dispatchJobs.id, jobId));

    const after = await db
      .select()
      .from(schema.dispatchStatusEvents)
      .where(eq(schema.dispatchStatusEvents.id, eventId));
    expect(after).toHaveLength(0);
  });

  it('defaults occurred_at and ingested_at to unixepoch * 1000', async () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const jobId = await seedDispatchJob();
    const eventId = uid('e');

    const beforeMs = Date.now();
    await db.insert(schema.dispatchStatusEvents).values({
      id: eventId,
      dispatchJobId: jobId,
      eventKind: 'started',
      eventData: '{}',
      sourceProtocol: 'moonraker',
    });
    const afterMs = Date.now();

    const rows = db.all(
      sql`SELECT occurred_at, ingested_at FROM dispatch_status_events WHERE id = ${eventId}`,
    );
    expect(rows).toHaveLength(1);
    const occurredAt = Number((rows[0] as any).occurred_at);
    const ingestedAt = Number((rows[0] as any).ingested_at);

    // Allow 5s of clock drift in either direction.
    expect(occurredAt).toBeGreaterThanOrEqual(beforeMs - 5000);
    expect(occurredAt).toBeLessThanOrEqual(afterMs + 5000);
    expect(ingestedAt).toBeGreaterThanOrEqual(beforeMs - 5000);
    expect(ingestedAt).toBeLessThanOrEqual(afterMs + 5000);
  });

  it('idx_dispatch_status_events_job index is present', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const indexes = db
      .all(sql`PRAGMA index_list(dispatch_status_events)`)
      .map((i: any) => i.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_dispatch_status_events_job',
        'idx_dispatch_status_events_kind',
      ]),
    );
  });

  it('dispatch_jobs has materials_used, last_status_at, progress_pct columns', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const cols = db.all(sql`PRAGMA table_info(dispatch_jobs)`);
    const byName = new Map<string, any>(cols.map((c: any) => [c.name, c]));

    expect(byName.has('materials_used')).toBe(true);
    expect(byName.has('last_status_at')).toBe(true);
    expect(byName.has('progress_pct')).toBe(true);

    // All three are nullable (status worker fills incrementally).
    expect(byName.get('materials_used').notnull).toBe(0);
    expect(byName.get('last_status_at').notnull).toBe(0);
    expect(byName.get('progress_pct').notnull).toBe(0);

    // Type sanity: SQLite affinity from Drizzle generator.
    expect(String(byName.get('materials_used').type).toUpperCase()).toBe('TEXT');
    expect(String(byName.get('last_status_at').type).toUpperCase()).toBe('INTEGER');
    expect(String(byName.get('progress_pct').type).toUpperCase()).toBe('INTEGER');
  });
});
