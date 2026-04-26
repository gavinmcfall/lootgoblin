/**
 * Integration tests — watchlist worker — V2-004-T4
 *
 * Real SQLite. The worker is exercised via `runOneWatchlistJob` so we can
 * assert deterministic outcomes against a controllable `now`. Adapters are
 * stubbed via the `defaultRegistry.registerSubscribable(...)` API.
 *
 * Coverage (15 cases):
 *   1.  Idle: no queued jobs → 'idle'
 *   2.  Happy path: 3 items + completed → 3 ingest_jobs rows + cursor + reset streak + completed
 *   3.  Atomic claim race: parallel runOne calls → exactly one 'ran'
 *   4.  Adapter not subscribable → marked failed with reason mention
 *   5.  Adapter missing kind capability → marked failed
 *   6.  Auth-revoked cascade across same source_adapter_id; other source unchanged
 *   7.  Error-streak exactly hits threshold → active=0
 *   8.  Below-threshold failure → streak increments, active stays 1
 *   9.  Successful run resets error_streak
 *  10.  Cursor advancement only on success — failure leaves cursor alone
 *  11.  Atomic transaction failure (mid-loop INSERT trigger abort) → cursor unchanged + job NOT completed
 *  12.  Token refresh during discovery — onTokenRefreshed persists merged bag
 *  13.  Stale recovery on startup — old running rows reset
 *  14.  Owner_id propagation — child ingest_jobs use subscription.owner_id
 *  15.  default_collection_id propagation — child ingest_jobs use subscription.default_collection_id
 *  16.  Subscription with NULL default_collection_id → marked failed
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import { encrypt, decrypt } from '../../src/crypto';
import {
  runOneWatchlistJob,
  resetStaleRunningWatchlistJobs,
} from '../../src/workers/watchlist-worker';
import { defaultRegistry } from '../../src/scavengers';
import type {
  SubscribableAdapter,
  DiscoveryEvent,
  DiscoveryContext,
} from '../../src/scavengers/subscribable';
import type { WatchlistSubscriptionKind } from '../../src/watchlist/types';

const DB_PATH = '/tmp/lootgoblin-t4-watchlist-worker.db';
const DB_URL = `file:${DB_PATH}`;
const SECRET = 'watchlist-worker-test-secret-32-chars-min';

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
  process.env.LOOTGOBLIN_SECRET = SECRET;
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
    name: 'Watchlist Worker User',
    email: `${id}@worker.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashAndCollection(ownerId: string): Promise<{ collectionId: string; stashRootId: string }> {
  const stashRootId = uid();
  await db().insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId,
    name: `WW Root ${stashRootId.slice(0, 8)}`,
    path: `/tmp/ww-stash-${stashRootId.slice(0, 8)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `WW Col ${collectionId.slice(0, 8)}`,
    pathTemplate: '{title}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { collectionId, stashRootId };
}

interface SeedSubArgs {
  ownerId: string;
  active?: 0 | 1;
  kind?: string;
  sourceAdapterId?: string;
  parameters?: Record<string, unknown>;
  cursorState?: string | null;
  errorStreak?: number;
  defaultCollectionId?: string | null;
}

async function seedSubscription(args: SeedSubArgs): Promise<string> {
  const id = uid();
  await db().insert(schema.watchlistSubscriptions).values({
    id,
    ownerId: args.ownerId,
    kind: args.kind ?? 'creator',
    sourceAdapterId: args.sourceAdapterId ?? 'sketchfab',
    parameters: JSON.stringify(args.parameters ?? { kind: 'creator', creatorId: 'designer-x' }),
    cadenceSeconds: 3600,
    lastFiredAt: null,
    cursorState: args.cursorState ?? null,
    active: args.active ?? 1,
    errorStreak: args.errorStreak ?? 0,
    defaultCollectionId: args.defaultCollectionId === undefined ? null : args.defaultCollectionId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedJob(args: {
  subscriptionId: string;
  status?: 'queued' | 'claimed' | 'running' | 'completed' | 'failed';
  claimedAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  createdAt?: Date;
}): Promise<string> {
  const id = uid();
  await db().insert(schema.watchlistJobs).values({
    id,
    subscriptionId: args.subscriptionId,
    status: args.status ?? 'queued',
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

async function getJob(id: string) {
  const rows = await db()
    .select()
    .from(schema.watchlistJobs)
    .where(eq(schema.watchlistJobs.id, id));
  return rows[0]!;
}

async function listIngestJobsForSub(subscriptionId: string) {
  return db()
    .select()
    .from(schema.ingestJobs)
    .where(eq(schema.ingestJobs.parentSubscriptionId, subscriptionId));
}

/**
 * Build a stub SubscribableAdapter for the given sourceId + kind that yields
 * the supplied scripted events on every discovery call.
 *
 * The factory is fresh for each test — registry has overwrite-warn semantics
 * but we explicitly reset on each test to keep behaviour deterministic.
 */
function makeStubAdapter(opts: {
  id: string;
  capabilities: WatchlistSubscriptionKind[];
  events?: (ctx: DiscoveryContext) => AsyncIterable<DiscoveryEvent>;
  /** When set, capability flag is declared but no method implemented. */
  declareWithoutImpl?: boolean;
}): SubscribableAdapter {
  const events = opts.events ?? (async function* () {
    yield { kind: 'discovery-completed', cursor: 'cursor-stub', itemsTotal: 0 };
  });

  const adapter: SubscribableAdapter = {
    id: opts.id as never,
    capabilities: new Set(opts.capabilities),
  };
  if (!opts.declareWithoutImpl) {
    if (opts.capabilities.includes('creator')) {
      (adapter as { listCreator?: unknown }).listCreator = (ctx: DiscoveryContext) => events(ctx);
    }
    if (opts.capabilities.includes('tag')) {
      (adapter as { searchByTag?: unknown }).searchByTag = (ctx: DiscoveryContext) => events(ctx);
    }
    if (opts.capabilities.includes('saved_search')) {
      (adapter as { search?: unknown }).search = (ctx: DiscoveryContext) => events(ctx);
    }
    if (opts.capabilities.includes('folder_watch')) {
      (adapter as { enumerateFolder?: unknown }).enumerateFolder = (ctx: DiscoveryContext) => events(ctx);
    }
    if (opts.capabilities.includes('url_watch')) {
      (adapter as { pollUrl?: unknown }).pollUrl = (ctx: DiscoveryContext) => events(ctx);
    }
  }
  return adapter;
}

async function seedCredentials(sourceId: string, bag: Record<string, unknown>): Promise<string> {
  const id = uid();
  const blob = JSON.stringify(bag);
  const encrypted = encrypt(blob, SECRET);
  await db().insert(schema.sourceCredentials).values({
    id,
    sourceId,
    label: `cred-${id.slice(0, 8)}`,
    kind: 'oauth-token',
    encryptedBlob: Buffer.from(encrypted),
  });
  return id;
}

async function readCredentials(sourceId: string): Promise<Record<string, unknown> | null> {
  const rows = await db()
    .select({ encryptedBlob: schema.sourceCredentials.encryptedBlob })
    .from(schema.sourceCredentials)
    .where(eq(schema.sourceCredentials.sourceId, sourceId));
  const row = rows[0];
  if (!row) return null;
  const buf = Buffer.from(row.encryptedBlob as Uint8Array);
  return JSON.parse(decrypt(buf.toString('utf8'), SECRET));
}

// Cleanup between tests.
async function clearAll(): Promise<void> {
  // Order: child first.
  await db().delete(schema.ingestJobs);
  await db().delete(schema.watchlistJobs);
  await db().delete(schema.watchlistSubscriptions);
  await db().delete(schema.sourceCredentials);
  // Subscribable adapters are namespaced by sourceId — overwrite is harmless.
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runOneWatchlistJob', () => {
  beforeEach(async () => {
    await clearAll();
  });

  it('1. no queued watchlist_jobs → idle', async () => {
    const result = await runOneWatchlistJob();
    expect(result).toBe('idle');
  });

  it('2. happy path — 3 items + discovery-completed → child ingest_jobs + cursor + streak reset + completed', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const sourceId = `t4-happy-${uid().slice(0, 8)}`;

    defaultRegistry.registerSubscribable(makeStubAdapter({
      id: sourceId,
      capabilities: ['creator'],
      events: async function* () {
        yield { kind: 'item-discovered', sourceItemId: 'item-1', sourceUrl: 'https://example.test/1' };
        yield { kind: 'item-discovered', sourceItemId: 'item-2' };
        yield { kind: 'item-discovered', sourceItemId: 'item-3' };
        yield { kind: 'discovery-completed', cursor: 'cursor-after-3', itemsTotal: 3 };
      },
    }));

    const subId = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceId,
      errorStreak: 2,
      defaultCollectionId: collectionId,
    });
    const jobId = await seedJob({ subscriptionId: subId });

    const result = await runOneWatchlistJob({ now: new Date('2026-04-25T12:00:00Z') });
    expect(result).toBe('ran');

    const ingestJobs = await listIngestJobsForSub(subId);
    expect(ingestJobs.length).toBe(3);
    for (const ij of ingestJobs) {
      expect(ij.ownerId).toBe(userId);
      expect(ij.sourceId).toBe(sourceId);
      expect(ij.targetKind).toBe('source-item-id');
      expect(ij.collectionId).toBe(collectionId);
      expect(ij.status).toBe('queued');
      expect(ij.parentSubscriptionId).toBe(subId);
      const payload = JSON.parse(ij.targetPayload);
      expect(payload.kind).toBe('source-item-id');
      expect(['item-1', 'item-2', 'item-3']).toContain(payload.sourceItemId);
    }

    const sub = await getSubscription(subId);
    expect(sub.cursorState).toBe('cursor-after-3');
    expect(sub.errorStreak).toBe(0);

    const job = await getJob(jobId);
    expect(job.status).toBe('completed');
    expect(job.itemsDiscovered).toBe(3);
    expect(job.itemsEnqueued).toBe(3);
    expect(job.completedAt).not.toBeNull();
  });

  it('3. atomic claim race — two parallel calls produce exactly one ran', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const sourceId = `t4-race-${uid().slice(0, 8)}`;

    defaultRegistry.registerSubscribable(makeStubAdapter({
      id: sourceId,
      capabilities: ['creator'],
      events: async function* () {
        yield { kind: 'discovery-completed', cursor: 'c', itemsTotal: 0 };
      },
    }));

    const subId = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceId,
      defaultCollectionId: collectionId,
    });
    await seedJob({ subscriptionId: subId });

    const [a, b] = await Promise.all([runOneWatchlistJob(), runOneWatchlistJob()]);
    const ranCount = [a, b].filter((x) => x === 'ran').length;
    const idleCount = [a, b].filter((x) => x === 'idle').length;
    expect(ranCount).toBe(1);
    expect(idleCount).toBe(1);
  });

  it('4. adapter not subscribable → marked failed', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const sourceId = `t4-not-sub-${uid().slice(0, 8)}`;
    // NOTE: do NOT register adapter as subscribable.

    const subId = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceId,
      defaultCollectionId: collectionId,
    });
    const jobId = await seedJob({ subscriptionId: subId });

    const result = await runOneWatchlistJob();
    expect(result).toBe('errored');

    const job = await getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.failureDetails ?? '').toMatch(/not subscribable/);
  });

  it('5. adapter missing kind capability → marked failed', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const sourceId = `t4-no-cap-${uid().slice(0, 8)}`;

    // Register with `tag` only — subscription requests `creator`.
    defaultRegistry.registerSubscribable(makeStubAdapter({
      id: sourceId,
      capabilities: ['tag'],
    }));

    const subId = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceId,
      kind: 'creator',
      parameters: { kind: 'creator', creatorId: 'someone' },
      defaultCollectionId: collectionId,
    });
    const jobId = await seedJob({ subscriptionId: subId });

    const result = await runOneWatchlistJob();
    expect(result).toBe('errored');

    const job = await getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.failureDetails ?? '').toMatch(/capability/);
  });

  it('6. auth-revoked cascades across same source_adapter_id only', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const sourceA = `t4-cascadeA-${uid().slice(0, 8)}`;
    const sourceB = `t4-cascadeB-${uid().slice(0, 8)}`;

    defaultRegistry.registerSubscribable(makeStubAdapter({
      id: sourceA,
      capabilities: ['creator', 'tag'],
      events: async function* () {
        yield { kind: 'discovery-failed', reason: 'auth-revoked', details: 'tokens revoked' };
      },
    }));
    // sourceB adapter isn't exercised in this test but seed for realism.
    defaultRegistry.registerSubscribable(makeStubAdapter({
      id: sourceB,
      capabilities: ['creator'],
    }));

    const s1 = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceA,
      kind: 'creator',
      parameters: { kind: 'creator', creatorId: 'creator-1' },
      defaultCollectionId: collectionId,
    });
    const s2 = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceA,
      kind: 'tag',
      parameters: { kind: 'tag', tag: 'minis' },
      defaultCollectionId: collectionId,
    });
    const s3 = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceB,
      kind: 'creator',
      parameters: { kind: 'creator', creatorId: 'creator-3' },
      defaultCollectionId: collectionId,
    });

    const jobS1 = await seedJob({ subscriptionId: s1 });

    const result = await runOneWatchlistJob();
    expect(result).toBe('errored');

    const job = await getJob(jobS1);
    expect(job.status).toBe('failed');
    expect(job.failureReason).toBe('auth-revoked');

    expect((await getSubscription(s1)).active).toBe(0);
    expect((await getSubscription(s2)).active).toBe(0);
    expect((await getSubscription(s3)).active).toBe(1);
  });

  it('7. error-streak exactly hits threshold (default 5) → active=0', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const sourceId = `t4-streak5-${uid().slice(0, 8)}`;

    defaultRegistry.registerSubscribable(makeStubAdapter({
      id: sourceId,
      capabilities: ['creator'],
      events: async function* () {
        yield { kind: 'discovery-failed', reason: 'network-error', details: 'transient' };
      },
    }));

    const subId = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceId,
      errorStreak: 4,
      defaultCollectionId: collectionId,
    });
    await seedJob({ subscriptionId: subId });

    await runOneWatchlistJob();

    const sub = await getSubscription(subId);
    expect(sub.errorStreak).toBe(5);
    expect(sub.active).toBe(0);
  });

  it('8. below-threshold failure → streak increments, active stays 1', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const sourceId = `t4-streak3-${uid().slice(0, 8)}`;

    defaultRegistry.registerSubscribable(makeStubAdapter({
      id: sourceId,
      capabilities: ['creator'],
      events: async function* () {
        yield { kind: 'discovery-failed', reason: 'network-error', details: 'transient' };
      },
    }));

    const subId = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceId,
      errorStreak: 3,
      defaultCollectionId: collectionId,
    });
    await seedJob({ subscriptionId: subId });

    await runOneWatchlistJob();

    const sub = await getSubscription(subId);
    expect(sub.errorStreak).toBe(4);
    expect(sub.active).toBe(1);
  });

  it('9. successful run resets error_streak to 0', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const sourceId = `t4-reset-${uid().slice(0, 8)}`;

    defaultRegistry.registerSubscribable(makeStubAdapter({
      id: sourceId,
      capabilities: ['creator'],
      events: async function* () {
        yield { kind: 'item-discovered', sourceItemId: 'a' };
        yield { kind: 'discovery-completed', cursor: 'ok', itemsTotal: 1 };
      },
    }));

    const subId = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceId,
      errorStreak: 4,
      defaultCollectionId: collectionId,
    });
    await seedJob({ subscriptionId: subId });

    await runOneWatchlistJob();

    const sub = await getSubscription(subId);
    expect(sub.errorStreak).toBe(0);
    expect(sub.active).toBe(1);
  });

  it('10. cursor advancement only on success — failure leaves cursor unchanged', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const sourceId = `t4-cursor-fail-${uid().slice(0, 8)}`;

    defaultRegistry.registerSubscribable(makeStubAdapter({
      id: sourceId,
      capabilities: ['creator'],
      events: async function* () {
        yield { kind: 'discovery-failed', reason: 'network-error', details: 'transient' };
      },
    }));

    const subId = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceId,
      cursorState: 'before-failure',
      defaultCollectionId: collectionId,
    });
    await seedJob({ subscriptionId: subId });

    await runOneWatchlistJob();

    const sub = await getSubscription(subId);
    expect(sub.cursorState).toBe('before-failure');
  });

  it('11. atomic transaction failure — INSERT trigger aborts mid-loop, cursor unchanged + job NOT completed', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const sourceId = `t4-atomic-${uid().slice(0, 8)}`;

    defaultRegistry.registerSubscribable(makeStubAdapter({
      id: sourceId,
      capabilities: ['creator'],
      events: async function* () {
        yield { kind: 'item-discovered', sourceItemId: 'will-fail' };
        yield { kind: 'discovery-completed', cursor: 'should-not-persist', itemsTotal: 1 };
      },
    }));

    const subId = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceId,
      cursorState: 'original',
      defaultCollectionId: collectionId,
    });
    const jobId = await seedJob({ subscriptionId: subId });

    // Force the INSERT into ingest_jobs to abort via a BEFORE INSERT trigger.
    const sqlite = (db() as unknown as { $client: { exec: (s: string) => void } }).$client;
    sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS test_block_ingest_jobs_insert
      BEFORE INSERT ON ingest_jobs
      BEGIN
        SELECT RAISE(ROLLBACK, 'test forced abort');
      END;
    `);

    try {
      const result = await runOneWatchlistJob();
      expect(result).toBe('errored');

      // Cursor must be unchanged because the discovery-completed transaction
      // rolled back as a unit.
      const sub = await getSubscription(subId);
      expect(sub.cursorState).toBe('original');

      // Job must NOT be 'completed' — it was either failed by the recovery
      // path or left at 'running'/'claimed' for the stale-recovery sweep.
      const job = await getJob(jobId);
      expect(job.status).not.toBe('completed');

      // No ingest_jobs were enqueued (rollback applied before any commit).
      const children = await listIngestJobsForSub(subId);
      expect(children.length).toBe(0);
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS test_block_ingest_jobs_insert;');
    }
  });

  it('12. token refresh during discovery — onTokenRefreshed merges + persists', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const sourceId = `t4-refresh-${uid().slice(0, 8)}`;

    // Seed an existing credential bag — refresh should MERGE, not replace.
    await seedCredentials(sourceId, {
      clientId: 'orig-client',
      clientSecret: 'orig-secret',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
    });

    defaultRegistry.registerSubscribable(makeStubAdapter({
      id: sourceId,
      capabilities: ['creator'],
      events: async function* (ctx: DiscoveryContext) {
        // Simulate adapter refreshing tokens mid-discovery.
        if (ctx.onTokenRefreshed) {
          await ctx.onTokenRefreshed({
            accessToken: 'new-access',
            refreshToken: 'new-refresh',
          });
        }
        yield { kind: 'discovery-completed', cursor: 'after-refresh', itemsTotal: 0 };
      },
    }));

    const subId = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceId,
      defaultCollectionId: collectionId,
    });
    await seedJob({ subscriptionId: subId });

    const result = await runOneWatchlistJob();
    expect(result).toBe('ran');

    const persisted = await readCredentials(sourceId);
    expect(persisted).toEqual({
      clientId: 'orig-client', // preserved
      clientSecret: 'orig-secret', // preserved
      accessToken: 'new-access', // updated
      refreshToken: 'new-refresh', // updated
    });
  });

  it('14. owner_id propagation — child ingest_jobs use subscription.ownerId', async () => {
    const userA = await seedUser();
    const { collectionId } = await seedStashAndCollection(userA);
    const sourceId = `t4-owner-${uid().slice(0, 8)}`;

    defaultRegistry.registerSubscribable(makeStubAdapter({
      id: sourceId,
      capabilities: ['creator'],
      events: async function* () {
        yield { kind: 'item-discovered', sourceItemId: 'x' };
        yield { kind: 'discovery-completed', cursor: 'c', itemsTotal: 1 };
      },
    }));

    const subId = await seedSubscription({
      ownerId: userA,
      sourceAdapterId: sourceId,
      defaultCollectionId: collectionId,
    });
    await seedJob({ subscriptionId: subId });
    await runOneWatchlistJob();

    const children = await listIngestJobsForSub(subId);
    expect(children.length).toBe(1);
    expect(children[0]!.ownerId).toBe(userA);
  });

  it('15. default_collection_id propagation — child ingest_jobs use subscription.defaultCollectionId', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const sourceId = `t4-collid-${uid().slice(0, 8)}`;

    defaultRegistry.registerSubscribable(makeStubAdapter({
      id: sourceId,
      capabilities: ['creator'],
      events: async function* () {
        yield { kind: 'item-discovered', sourceItemId: 'x' };
        yield { kind: 'discovery-completed', cursor: 'c', itemsTotal: 1 };
      },
    }));

    const subId = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceId,
      defaultCollectionId: collectionId,
    });
    await seedJob({ subscriptionId: subId });
    await runOneWatchlistJob();

    const children = await listIngestJobsForSub(subId);
    expect(children.length).toBe(1);
    expect(children[0]!.collectionId).toBe(collectionId);
  });

  it('16. subscription with NULL default_collection_id → marked failed with clear reason', async () => {
    const userId = await seedUser();
    const sourceId = `t4-no-coll-${uid().slice(0, 8)}`;

    defaultRegistry.registerSubscribable(makeStubAdapter({
      id: sourceId,
      capabilities: ['creator'],
    }));

    const subId = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: sourceId,
      defaultCollectionId: null,
    });
    const jobId = await seedJob({ subscriptionId: subId });

    const result = await runOneWatchlistJob();
    expect(result).toBe('errored');

    const job = await getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.failureDetails ?? '').toMatch(/default_collection_id/);
  });
});

describe('resetStaleRunningWatchlistJobs (worker startup recovery)', () => {
  beforeEach(async () => {
    await clearAll();
  });

  it('13. resets jobs that have been running longer than the stale timeout', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const subId = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: 'sketchfab',
      defaultCollectionId: collectionId,
    });
    const oldClaim = new Date(Date.now() - 30 * 60_000); // 30 min ago
    const jobId = await seedJob({
      subscriptionId: subId,
      status: 'running',
      claimedAt: oldClaim,
      startedAt: oldClaim,
    });

    const reset = await resetStaleRunningWatchlistJobs();
    expect(reset).toBeGreaterThanOrEqual(1);

    const job = await getJob(jobId);
    expect(job.status).toBe('queued');
    expect(job.claimedAt).toBeNull();
  });

  it('13b. does NOT reset rows that are running but recently claimed', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const subId = await seedSubscription({
      ownerId: userId,
      sourceAdapterId: 'sketchfab',
      defaultCollectionId: collectionId,
    });
    const recentClaim = new Date();
    const jobId = await seedJob({
      subscriptionId: subId,
      status: 'running',
      claimedAt: recentClaim,
      startedAt: recentClaim,
    });

    const reset = await resetStaleRunningWatchlistJobs();
    expect(reset).toBe(0);

    const job = await getJob(jobId);
    expect(job.status).toBe('running');
  });
});
