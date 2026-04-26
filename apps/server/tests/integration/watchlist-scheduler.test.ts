/**
 * Integration tests — watchlist scheduler — V2-004-T3
 *
 * Real SQLite at /tmp/lootgoblin-t3-watchlist-scheduler.db. The scheduler
 * is exercised via runOneSchedulerTick() so we can assert deterministic
 * outcomes against a controllable `now`.
 *
 * Coverage:
 *   1. No active subscriptions → enqueued=0, no rows inserted
 *   2. Active subscription, never fired → fired; row inserted; last_fired_at stamped
 *   3. Last fired 30s ago, cadence 60s → not due; not fired
 *   4. Last fired 90s ago, cadence 60s → due; fired
 *   5. Subscription with in-flight 'queued' job → skipped
 *   6. Subscription with in-flight 'running' job → skipped
 *   7. Subscription with terminal 'completed' job → fires
 *   8. Inactive subscription (active=0) → never fired even if "due"
 *   9. Multiple due subscriptions → all fired
 *  10. Atomic transaction — INSERT failure leaves last_fired_at unchanged
 *  11. Missed-window collapse — single tick fires once; sequential tick skips
 *  12. resetStaleRunningWatchlistJobs resets stale rows; recent rows untouched
 *  13. Concurrent ticks — two parallel ticks produce exactly ONE new
 *      watchlist_job (in-flight check + per-row transaction prevents double-fire)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import {
  runOneSchedulerTick,
  resetStaleRunningWatchlistJobs,
} from '../../src/workers/watchlist-scheduler';

const DB_PATH = '/tmp/lootgoblin-t3-watchlist-scheduler.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB { return getDb(DB_URL) as DB; }
function uid(): string { return crypto.randomUUID(); }

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  process.env.LOOTGOBLIN_SECRET = 'watchlist-scheduler-test-secret-32-chars-min';
  await runMigrations(DB_URL);
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Scheduler Test User',
    email: `${id}@scheduler.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

interface SeedSubscriptionArgs {
  ownerId: string;
  active?: 0 | 1;
  cadenceSeconds?: number;
  lastFiredAt?: Date | null;
  kind?: string;
  sourceAdapterId?: string;
  parameters?: Record<string, unknown>;
}

async function seedSubscription(args: SeedSubscriptionArgs): Promise<string> {
  const id = uid();
  await db().insert(schema.watchlistSubscriptions).values({
    id,
    ownerId: args.ownerId,
    kind: args.kind ?? 'creator',
    sourceAdapterId: args.sourceAdapterId ?? 'makerworld',
    parameters: JSON.stringify(args.parameters ?? { kind: 'creator', creatorId: 'designer-x' }),
    cadenceSeconds: args.cadenceSeconds ?? 3600,
    lastFiredAt: args.lastFiredAt ?? null,
    cursorState: null,
    active: args.active ?? 1,
    errorStreak: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

interface SeedJobArgs {
  subscriptionId: string;
  status: 'queued' | 'claimed' | 'running' | 'completed' | 'failed';
  claimedAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  createdAt?: Date;
}

async function seedJob(args: SeedJobArgs): Promise<string> {
  const id = uid();
  await db().insert(schema.watchlistJobs).values({
    id,
    subscriptionId: args.subscriptionId,
    status: args.status,
    claimedAt: args.claimedAt ?? null,
    startedAt: args.startedAt ?? null,
    completedAt: args.completedAt ?? null,
    itemsDiscovered: 0,
    itemsEnqueued: 0,
    createdAt: args.createdAt ?? new Date(),
  });
  return id;
}

async function getSubscription(id: string) {
  const rows = await db()
    .select()
    .from(schema.watchlistSubscriptions)
    .where(eq(schema.watchlistSubscriptions.id, id));
  return rows[0]!;
}

async function listJobs(subscriptionId: string) {
  return db()
    .select()
    .from(schema.watchlistJobs)
    .where(eq(schema.watchlistJobs.subscriptionId, subscriptionId));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runOneSchedulerTick', () => {
  beforeEach(async () => {
    // Clear in dependency order — jobs reference subscriptions.
    await db().delete(schema.watchlistJobs);
    await db().delete(schema.watchlistSubscriptions);
  });

  it('1. no active subscriptions → enqueued=0', async () => {
    const result = await runOneSchedulerTick();
    expect(result).toEqual({ enqueued: 0, skippedInFlight: 0, skippedNotDue: 0, errors: 0 });
  });

  it('2. active subscription, never fired → fired and last_fired_at stamped', async () => {
    const userId = await seedUser();
    const subId = await seedSubscription({ ownerId: userId, lastFiredAt: null });

    const tickNow = new Date('2026-04-25T10:00:00Z');
    const result = await runOneSchedulerTick({ now: tickNow });

    expect(result.enqueued).toBe(1);
    expect(result.errors).toBe(0);

    const jobs = await listJobs(subId);
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.status).toBe('queued');

    const sub = await getSubscription(subId);
    expect(sub.lastFiredAt?.getTime()).toBe(tickNow.getTime());
  });

  it('3. last fired 30s ago, cadence 60s → not due; not fired', async () => {
    const userId = await seedUser();
    const tickNow = new Date('2026-04-25T10:00:00Z');
    const lastFired = new Date(tickNow.getTime() - 30_000);
    const subId = await seedSubscription({
      ownerId: userId,
      cadenceSeconds: 60,
      lastFiredAt: lastFired,
    });

    const result = await runOneSchedulerTick({ now: tickNow });
    expect(result.enqueued).toBe(0);
    expect(result.skippedInFlight).toBe(0);

    const jobs = await listJobs(subId);
    expect(jobs.length).toBe(0);

    const sub = await getSubscription(subId);
    expect(sub.lastFiredAt?.getTime()).toBe(lastFired.getTime());
  });

  it('4. last fired 90s ago, cadence 60s → due; fired', async () => {
    const userId = await seedUser();
    const tickNow = new Date('2026-04-25T10:00:00Z');
    const lastFired = new Date(tickNow.getTime() - 90_000);
    const subId = await seedSubscription({
      ownerId: userId,
      cadenceSeconds: 60,
      lastFiredAt: lastFired,
    });

    const result = await runOneSchedulerTick({ now: tickNow });
    expect(result.enqueued).toBe(1);

    const jobs = await listJobs(subId);
    expect(jobs.length).toBe(1);
  });

  it("5. subscription with in-flight 'queued' job → skipped", async () => {
    const userId = await seedUser();
    const subId = await seedSubscription({ ownerId: userId, lastFiredAt: null });
    await seedJob({ subscriptionId: subId, status: 'queued' });

    const result = await runOneSchedulerTick();
    expect(result.enqueued).toBe(0);
    expect(result.skippedInFlight).toBe(1);

    const jobs = await listJobs(subId);
    expect(jobs.length).toBe(1); // still just the seeded one
  });

  it("6. subscription with in-flight 'running' job → skipped", async () => {
    const userId = await seedUser();
    const subId = await seedSubscription({ ownerId: userId, lastFiredAt: null });
    await seedJob({ subscriptionId: subId, status: 'running', claimedAt: new Date(), startedAt: new Date() });

    const result = await runOneSchedulerTick();
    expect(result.enqueued).toBe(0);
    expect(result.skippedInFlight).toBe(1);
  });

  it("7. subscription with terminal 'completed' job → fires (in-flight check excludes completed)", async () => {
    const userId = await seedUser();
    const tickNow = new Date('2026-04-25T10:00:00Z');
    // Sub is "due" (never fired), and prior firing finished cleanly.
    const subId = await seedSubscription({ ownerId: userId, lastFiredAt: null });
    await seedJob({
      subscriptionId: subId,
      status: 'completed',
      completedAt: new Date(tickNow.getTime() - 60_000),
    });

    const result = await runOneSchedulerTick({ now: tickNow });
    expect(result.enqueued).toBe(1);

    const jobs = await listJobs(subId);
    expect(jobs.length).toBe(2); // one completed + one new queued
  });

  it('8. inactive subscription (active=0) is never fired', async () => {
    const userId = await seedUser();
    const tickNow = new Date('2026-04-25T10:00:00Z');
    // Make it appear "due" (last_fired_at well in the past) but inactive.
    await seedSubscription({
      ownerId: userId,
      active: 0,
      cadenceSeconds: 60,
      lastFiredAt: new Date(tickNow.getTime() - 24 * 3600_000),
    });

    const result = await runOneSchedulerTick({ now: tickNow });
    expect(result.enqueued).toBe(0);
    expect(result.skippedInFlight).toBe(0);
    expect(result.errors).toBe(0);

    const jobs = await db().select().from(schema.watchlistJobs);
    expect(jobs.length).toBe(0);
  });

  it('9. multiple due subscriptions → all fired', async () => {
    const userId = await seedUser();
    const idA = await seedSubscription({ ownerId: userId, lastFiredAt: null });
    const idB = await seedSubscription({
      ownerId: userId,
      cadenceSeconds: 60,
      lastFiredAt: new Date(Date.now() - 5 * 60_000),
    });
    const idC = await seedSubscription({ ownerId: userId, lastFiredAt: null, kind: 'tag' });

    const result = await runOneSchedulerTick();
    expect(result.enqueued).toBe(3);

    expect((await listJobs(idA)).length).toBe(1);
    expect((await listJobs(idB)).length).toBe(1);
    expect((await listJobs(idC)).length).toBe(1);
  });

  it('10. atomic transaction — if INSERT into watchlist_jobs fails, last_fired_at must NOT advance', async () => {
    const userId = await seedUser();
    const subId = await seedSubscription({ ownerId: userId, lastFiredAt: null });

    // Force the INSERT to throw by replacing the table with something that
    // the better-sqlite3 driver will reject — easier: spy on db().transaction
    // via the schema object. The transaction wraps the INSERT + UPDATE, so
    // any throw inside rolls back both.
    //
    // Approach: stub the underlying db() proxy by spying on insert -> values
    // chain. But simpler: temporarily rename the watchlist_jobs table by
    // running a raw SQL ALTER, fire the tick, then rename back. Way simpler:
    // wrap the better-sqlite3 client to fail INSERTs into watchlist_jobs.
    //
    // The cleanest available knob: use a TRIGGER that aborts INSERTs. SQLite
    // RAISE(ROLLBACK,...) inside a BEFORE INSERT trigger does exactly this.
    const sqlite = (db() as unknown as { $client: { exec: (s: string) => void } }).$client;
    sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS test_block_watchlist_jobs_insert
      BEFORE INSERT ON watchlist_jobs
      BEGIN
        SELECT RAISE(ROLLBACK, 'test forced abort');
      END;
    `);

    try {
      const tickNow = new Date('2026-04-25T10:00:00Z');
      const result = await runOneSchedulerTick({ now: tickNow });
      expect(result.errors).toBe(1);
      expect(result.enqueued).toBe(0);

      const sub = await getSubscription(subId);
      expect(sub.lastFiredAt).toBeNull();

      const jobs = await listJobs(subId);
      expect(jobs.length).toBe(0);
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS test_block_watchlist_jobs_insert;');
    }
  });

  it('11. missed-window collapse — multiple cadence windows fire ONCE, second tick skips', async () => {
    const userId = await seedUser();
    const tickNow = new Date('2026-04-25T10:00:00Z');
    // Cadence 1h, last fired 5h ago = 5 missed windows.
    const subId = await seedSubscription({
      ownerId: userId,
      cadenceSeconds: 3600,
      lastFiredAt: new Date(tickNow.getTime() - 5 * 3600_000),
    });

    const first = await runOneSchedulerTick({ now: tickNow });
    expect(first.enqueued).toBe(1);

    const jobsAfterFirst = await listJobs(subId);
    expect(jobsAfterFirst.length).toBe(1);

    // A second tick 1ms later: subscription no longer "due" (last_fired_at
    // was just stamped to tickNow), so it isn't a candidate at all. Either
    // way, no second job is enqueued — this is the missed-window collapse.
    const second = await runOneSchedulerTick({ now: new Date(tickNow.getTime() + 1) });
    expect(second.enqueued).toBe(0);

    const jobsAfterSecond = await listJobs(subId);
    expect(jobsAfterSecond.length).toBe(1);

    // Even much later — within the cadence window but with the queued job
    // still in-flight — the in-flight check prevents a second fire.
    const third = await runOneSchedulerTick({
      now: new Date(tickNow.getTime() + 2 * 3600_000), // 2h later
    });
    expect(third.enqueued).toBe(0);
    expect(third.skippedInFlight).toBe(1);

    const jobsAfterThird = await listJobs(subId);
    expect(jobsAfterThird.length).toBe(1);
  });

  it('13. concurrent ticks — exactly ONE new watchlist_job per due subscription', async () => {
    const userId = await seedUser();
    const subId = await seedSubscription({ ownerId: userId, lastFiredAt: null });

    const tickNow = new Date('2026-04-25T10:00:00Z');
    const [a, b] = await Promise.all([
      runOneSchedulerTick({ now: tickNow }),
      runOneSchedulerTick({ now: tickNow }),
    ]);

    // Sum of "fired" outcomes across both ticks must equal exactly 1.
    const totalEnqueued = a.enqueued + b.enqueued;
    expect(totalEnqueued).toBe(1);

    const jobs = await listJobs(subId);
    expect(jobs.length).toBe(1);
  });
});

describe('resetStaleRunningWatchlistJobs', () => {
  beforeEach(async () => {
    await db().delete(schema.watchlistJobs);
    await db().delete(schema.watchlistSubscriptions);
  });

  it('12a. resets jobs that have been running longer than the stale timeout', async () => {
    const userId = await seedUser();
    const subId = await seedSubscription({ ownerId: userId, lastFiredAt: new Date() });
    const oldClaim = new Date(Date.now() - 30 * 60_000); // 30 min ago
    const jobId = await seedJob({
      subscriptionId: subId,
      status: 'running',
      claimedAt: oldClaim,
      startedAt: oldClaim,
    });

    const reset = await resetStaleRunningWatchlistJobs();
    expect(reset).toBeGreaterThanOrEqual(1);

    const jobs = await db()
      .select()
      .from(schema.watchlistJobs)
      .where(eq(schema.watchlistJobs.id, jobId));
    expect(jobs[0]!.status).toBe('queued');
    expect(jobs[0]!.claimedAt).toBeNull();
  });

  it('12b. does NOT reset rows that are running but recently claimed', async () => {
    const userId = await seedUser();
    const subId = await seedSubscription({ ownerId: userId, lastFiredAt: new Date() });
    const recentClaim = new Date();
    const jobId = await seedJob({
      subscriptionId: subId,
      status: 'running',
      claimedAt: recentClaim,
      startedAt: recentClaim,
    });

    const reset = await resetStaleRunningWatchlistJobs();
    expect(reset).toBe(0);

    const jobs = await db()
      .select()
      .from(schema.watchlistJobs)
      .where(eq(schema.watchlistJobs.id, jobId));
    expect(jobs[0]!.status).toBe('running');
  });
});
