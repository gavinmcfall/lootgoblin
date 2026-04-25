/**
 * Integration tests for the Watchlist schema — V2-004-T1
 *
 * Real SQLite DB at /tmp/lootgoblin-t1-watchlist.db
 *
 * Coverage:
 *   1. Migration applies cleanly to a fresh DB.
 *   2. Insert one watchlist_subscription per `kind` value.
 *   3. Insert a watchlist_job; FK to watchlist_subscriptions enforced.
 *   4. Insert an ingest_job with parent_subscription_id set; FK resolves.
 *   5. Cascade delete: deleting a subscription deletes its watchlist_jobs
 *      but only NULLs ingest_jobs.parent_subscription_id (does NOT delete).
 *   6. Indexes exist on both new tables.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import type {
  WatchlistSubscriptionKind,
  WatchlistSubscriptionParameters,
} from '../../src/watchlist/types';

const DB_PATH = '/tmp/lootgoblin-t1-watchlist.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

function now(): Date {
  return new Date();
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

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Watchlist Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

async function seedSubscription(
  ownerId: string,
  kind: WatchlistSubscriptionKind,
  params: WatchlistSubscriptionParameters,
): Promise<string> {
  const id = uid();
  await db().insert(schema.watchlistSubscriptions).values({
    id,
    ownerId,
    kind,
    sourceAdapterId: 'makerworld',
    parameters: JSON.stringify(params),
    cadenceSeconds: 3600,
    active: 1,
    errorStreak: 0,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V2-004-T1 watchlist schema migration', () => {
  it('1. migrations applied — both new tables exist', () => {
    const sqlite = (db() as unknown as { $client: { prepare: (s: string) => { all: () => Array<{ name: string }> } } }).$client;
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('watchlist_subscriptions','watchlist_jobs')")
      .all();
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(['watchlist_jobs', 'watchlist_subscriptions']);
  });

  it('2. accepts inserts for every kind value', async () => {
    const ownerId = await seedUser();
    const kinds: Array<{ kind: WatchlistSubscriptionKind; params: WatchlistSubscriptionParameters }> = [
      { kind: 'creator', params: { kind: 'creator', creatorId: 'designer-1' } },
      { kind: 'tag', params: { kind: 'tag', tag: 'miniature' } },
      { kind: 'saved_search', params: { kind: 'saved_search', query: 'dragon' } },
      { kind: 'url_watch', params: { kind: 'url_watch', url: 'https://makerworld.com/en/models/123' } },
      { kind: 'folder_watch', params: { kind: 'folder_watch', folderId: 'gdrive-folder-1' } },
    ];

    const ids: string[] = [];
    for (const { kind, params } of kinds) {
      ids.push(await seedSubscription(ownerId, kind, params));
    }

    const rows = await db()
      .select()
      .from(schema.watchlistSubscriptions)
      .where(eq(schema.watchlistSubscriptions.ownerId, ownerId));

    expect(rows.length).toBe(kinds.length);
    const persistedKinds = rows.map((r) => r.kind).sort();
    expect(persistedKinds).toEqual(['creator', 'folder_watch', 'saved_search', 'tag', 'url_watch']);

    // parameters round-trip
    const creatorRow = rows.find((r) => r.kind === 'creator')!;
    const parsed = JSON.parse(creatorRow.parameters) as WatchlistSubscriptionParameters;
    expect(parsed).toEqual({ kind: 'creator', creatorId: 'designer-1' });
  });

  it('3. inserts a watchlist_job and enforces the FK to watchlist_subscriptions', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId, 'creator', {
      kind: 'creator',
      creatorId: 'creator-x',
    });

    const jobId = uid();
    await db().insert(schema.watchlistJobs).values({
      id: jobId,
      subscriptionId,
      status: 'queued',
      itemsDiscovered: 0,
      itemsEnqueued: 0,
      createdAt: now(),
    });

    const job = (
      await db().select().from(schema.watchlistJobs).where(eq(schema.watchlistJobs.id, jobId))
    )[0];
    expect(job?.status).toBe('queued');
    expect(job?.subscriptionId).toBe(subscriptionId);

    // FK violation when inserting against a non-existent subscription_id
    let threw = false;
    try {
      await db().insert(schema.watchlistJobs).values({
        id: uid(),
        subscriptionId: 'no-such-subscription',
        status: 'queued',
        itemsDiscovered: 0,
        itemsEnqueued: 0,
        createdAt: now(),
      });
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/FOREIGN KEY|foreign key/i);
    }
    expect(threw).toBe(true);
  });

  it('4. inserts an ingest_job with parent_subscription_id and resolves it', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId, 'tag', { kind: 'tag', tag: 'orc' });

    const ingestId = uid();
    await db().insert(schema.ingestJobs).values({
      id: ingestId,
      ownerId,
      sourceId: 'makerworld',
      targetKind: 'url',
      targetPayload: JSON.stringify({ kind: 'url', url: 'https://makerworld.com/en/models/1' }),
      status: 'queued',
      attempt: 1,
      parentSubscriptionId: subscriptionId,
      createdAt: now(),
      updatedAt: now(),
    });

    const row = (
      await db().select().from(schema.ingestJobs).where(eq(schema.ingestJobs.id, ingestId))
    )[0];
    expect(row?.parentSubscriptionId).toBe(subscriptionId);
  });

  it('5. cascade: deleting a subscription deletes watchlist_jobs but NULLs ingest_jobs.parent_subscription_id', async () => {
    const ownerId = await seedUser();
    const subscriptionId = await seedSubscription(ownerId, 'creator', {
      kind: 'creator',
      creatorId: 'designer-cascade',
    });

    // One watchlist_job (should cascade-delete)
    const jobId = uid();
    await db().insert(schema.watchlistJobs).values({
      id: jobId,
      subscriptionId,
      status: 'completed',
      itemsDiscovered: 1,
      itemsEnqueued: 1,
      createdAt: now(),
    });

    // One ingest_job pointing at the subscription (should be NULLed, NOT deleted)
    const ingestId = uid();
    await db().insert(schema.ingestJobs).values({
      id: ingestId,
      ownerId,
      sourceId: 'makerworld',
      targetKind: 'url',
      targetPayload: JSON.stringify({ kind: 'url', url: 'https://makerworld.com/en/models/777' }),
      status: 'completed',
      attempt: 1,
      parentSubscriptionId: subscriptionId,
      createdAt: now(),
      updatedAt: now(),
    });

    // Delete the subscription
    await db()
      .delete(schema.watchlistSubscriptions)
      .where(eq(schema.watchlistSubscriptions.id, subscriptionId));

    // watchlist_jobs row gone
    const remainingJobs = await db()
      .select()
      .from(schema.watchlistJobs)
      .where(eq(schema.watchlistJobs.id, jobId));
    expect(remainingJobs.length).toBe(0);

    // ingest_jobs row STILL EXISTS, but parent_subscription_id is NULL
    const remainingIngests = await db()
      .select()
      .from(schema.ingestJobs)
      .where(eq(schema.ingestJobs.id, ingestId));
    expect(remainingIngests.length).toBe(1);
    expect(remainingIngests[0]?.parentSubscriptionId).toBeNull();
  });

  it('6. expected indexes are present', () => {
    const sqlite = (db() as unknown as { $client: { prepare: (s: string) => { all: (...args: unknown[]) => Array<{ name: string }> } } }).$client;

    const subIdx = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='watchlist_subscriptions'")
      .all()
      .map((r) => r.name);
    expect(subIdx).toEqual(
      expect.arrayContaining([
        'watchlist_subs_owner_active_idx',
        'watchlist_subs_active_source_idx',
        'watchlist_subs_active_fired_idx',
      ]),
    );

    const jobIdx = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='watchlist_jobs'")
      .all()
      .map((r) => r.name);
    expect(jobIdx).toEqual(
      expect.arrayContaining([
        'watchlist_jobs_status_idx',
        'watchlist_jobs_sub_created_idx',
        'watchlist_jobs_status_claimed_idx',
      ]),
    );

    // Also verify the partial index on ingest_jobs(parent_subscription_id)
    const ingestIdx = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ingest_jobs'")
      .all()
      .map((r) => r.name);
    expect(ingestIdx).toEqual(expect.arrayContaining(['ingest_jobs_parent_sub_idx']));
  });
});
