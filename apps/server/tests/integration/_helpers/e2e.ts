/**
 * Shared helpers for V2-003-T10 end-to-end integration tests.
 *
 * Each e2e test file uses its own SQLite path + LOOTGOBLIN_SECRET (set in
 * `beforeAll`). The helpers below assume the DB is already initialised and
 * `process.env.DATABASE_URL` is set to the file's URL.
 *
 * Design notes (gotchas, recorded so future T10-style tests stay sane):
 *
 *   1. The HTTP `POST /api/v1/ingest` route uses `getServerDb()` which reads
 *      `process.env.DATABASE_URL` lazily. Tests MUST set DATABASE_URL BEFORE
 *      importing the route module + call `resetDbCache()` so the cache picks
 *      up the new URL.
 *
 *   2. The ingest worker's `runOneIngestJob()` likewise uses `getDb()` which
 *      defaults to `process.env.DATABASE_URL`. Same caveat as above.
 *
 *   3. `waitForJobTerminal` drives the queue itself by calling
 *      `runOneIngestJob()` between polls instead of starting the worker loop.
 *      Side benefit: deterministic test runtime — no setInterval/jitter races.
 *
 *   4. Adapters fall back to `globalThis.fetch` when no `httpFetch` override
 *      is supplied. e2e tests override the network with `msw setupServer` at
 *      the file's `beforeAll` so adapter HTTP calls are intercepted without
 *      touching the registry.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { runMigrations, getDb, schema, resetDbCache } from '../../../src/db/client';
import { encrypt } from '../../../src/crypto';
import { runOneIngestJob } from '../../../src/workers/ingest-worker';
import { runOneSchedulerTick } from '../../../src/workers/watchlist-scheduler';
import { runOneWatchlistJob } from '../../../src/workers/watchlist-worker';
import {
  defaultRegistry,
  createCults3dAdapter,
  createSketchfabAdapter,
  createGdriveAdapter,
  createMakerWorldAdapter,
  createPrintablesAdapter,
  createUploadAdapter,
  createThingiverseAdapter,
} from '../../../src/scavengers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

export type TestActor = {
  id: string;
  role: 'admin' | 'user';
  source: 'session';
};

export type IngestPostInput =
  | { url: string; collectionId: string; idempotencyKey?: string }
  | { sourceId: string; sourceItemId: string; collectionId: string; idempotencyKey?: string };

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

/**
 * Wipe any existing SQLite file at `dbPath` (including journal/wal/shm), point
 * `process.env.DATABASE_URL` at it, run migrations.
 *
 * Caller must invoke this in `beforeAll` BEFORE importing route modules so
 * the route's lazy DB client picks up the test URL.
 */
export async function setupE2eDb(dbPath: string, secret = 'e2e-test-secret-32-chars-minimum'): Promise<string> {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { await fsp.unlink(`${dbPath}${suffix}`); } catch { /* ignore missing */ }
  }
  const url = `file:${dbPath}`;
  process.env.DATABASE_URL = url;
  process.env.LOOTGOBLIN_SECRET = secret;
  resetDbCache();
  await runMigrations(url);
  return url;
}

/**
 * Re-register every default adapter with a `httpFetch` override that calls
 * `globalThis.fetch` lazily at request time. This ensures msw's monkey-patched
 * `globalThis.fetch` (installed by `server.listen()` later) is the one used,
 * even though the registry singleton is created at module import time before
 * msw has wrapped fetch.
 *
 * Why this dance is necessary
 * ───────────────────────────
 * Adapters do `const httpFetch = options?.httpFetch ?? globalThis.fetch;` at
 * factory call time. If msw hasn't patched fetch yet, the captured reference
 * points at the real native fetch and bypasses msw. We re-register with a
 * thin closure `(input, init) => globalThis.fetch(input, init)` so the lookup
 * is deferred to call time and msw's wrapper is honoured.
 *
 * Call this in `beforeAll` AFTER `server.listen()` so handlers are active by
 * the time the first request fires.
 */
export function rewireAdaptersForMsw(): void {
  const lazyFetch: typeof fetch = (input, init) => globalThis.fetch(input as never, init as never);
  defaultRegistry.register(createUploadAdapter());

  // Adapters that are BOTH ScavengerAdapter (ingest) AND SubscribableAdapter
  // (watchlist discovery) need re-registering on both sides so the same
  // lazy-fetch closure is used for ingest fetch() and discovery iterators.
  // (Mirrors createDefaultRegistry in src/scavengers/index.ts.)
  const cults = createCults3dAdapter({ httpFetch: lazyFetch, retryBaseMs: 0 });
  defaultRegistry.register(cults);
  defaultRegistry.registerSubscribable(cults);

  defaultRegistry.register(createMakerWorldAdapter({ httpFetch: lazyFetch, retryBaseMs: 0 }));
  defaultRegistry.register(createPrintablesAdapter({ httpFetch: lazyFetch, retryBaseMs: 0 }));

  const sketchfab = createSketchfabAdapter({ httpFetch: lazyFetch, retryBaseMs: 0 });
  defaultRegistry.register(sketchfab);
  defaultRegistry.registerSubscribable(sketchfab);

  const gdrive = createGdriveAdapter({ httpFetch: lazyFetch, retryBaseMs: 0 });
  defaultRegistry.register(gdrive);
  defaultRegistry.registerSubscribable(gdrive);

  const thingiverse = createThingiverseAdapter({ httpFetch: lazyFetch, retryBaseMs: 0 });
  defaultRegistry.register(thingiverse);
  defaultRegistry.registerSubscribable(thingiverse);
}

/** Best-effort SQLite teardown. Quiet on missing files. */
export async function teardownE2eDb(dbPath: string): Promise<void> {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { await fsp.unlink(`${dbPath}${suffix}`); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Seeders
// ---------------------------------------------------------------------------

function db(dbUrl?: string): DB { return getDb(dbUrl) as DB; }

export function uid(): string { return crypto.randomUUID(); }

export function actor(userId: string, role: 'admin' | 'user' = 'user'): TestActor {
  return { id: userId, role, source: 'session' };
}

export async function seedUser(dbUrl?: string): Promise<string> {
  const id = uid();
  await db(dbUrl).insert(schema.user).values({
    id,
    name: `E2E Test User ${id.slice(0, 8)}`,
    email: `${id}@e2e.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

export async function seedStashRoot(ownerId: string, dbUrl?: string): Promise<{ id: string; path: string }> {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-e2e-stash-'));
  const id = uid();
  await db(dbUrl).insert(schema.stashRoots).values({
    id,
    ownerId,
    name: `E2E Root ${id.slice(0, 8)}`,
    path: rootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id, path: rootPath };
}

export async function seedCollection(
  ownerId: string,
  stashRootId: string,
  dbUrl?: string,
): Promise<{ id: string }> {
  const id = uid();
  await db(dbUrl).insert(schema.collections).values({
    id,
    ownerId,
    name: `E2E Col ${id.slice(0, 8)}`,
    pathTemplate: '{title}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id };
}

/**
 * Insert a source_credentials row with the given `bag` encrypted-at-rest.
 * `dbUrl` is optional; defaults to the env-cached connection.
 */
export async function seedSourceCredential(opts: {
  sourceId: string;
  kind: 'cookie-jar' | 'oauth-token' | 'api-key';
  bag: Record<string, unknown>;
  label?: string;
  status?: 'active' | 'expired' | 'revoked';
  expiresAt?: Date | null;
  dbUrl?: string;
}): Promise<{ id: string }> {
  const secret = process.env.LOOTGOBLIN_SECRET;
  if (!secret) throw new Error('seedSourceCredential: LOOTGOBLIN_SECRET unset');
  const id = uid();
  const blob = encrypt(JSON.stringify(opts.bag), secret);
  await db(opts.dbUrl).insert(schema.sourceCredentials).values({
    id,
    sourceId: opts.sourceId,
    label: opts.label ?? `e2e-${opts.sourceId}-${id.slice(0, 6)}`,
    kind: opts.kind,
    encryptedBlob: Buffer.from(blob, 'utf8'),
    expiresAt: opts.expiresAt ?? null,
    status: opts.status ?? 'active',
  });
  return { id };
}

// ---------------------------------------------------------------------------
// Queue driver
// ---------------------------------------------------------------------------

/**
 * Poll an ingest_jobs row until it reaches a terminal status (completed,
 * failed, quarantined, or paused-auth). Calls `runOneIngestJob()` between
 * polls so the test drives the queue without waiting for the worker loop.
 *
 * Bounded at 50 iterations × 100ms = 5s. Anything longer is a real failure.
 */
export async function waitForJobTerminal(
  jobId: string,
  opts?: { timeoutMs?: number; dbUrl?: string },
): Promise<{
  status: 'completed' | 'failed' | 'quarantined' | 'paused-auth' | 'queued' | 'running' | 'fetching' | 'placing' | 'rate-limit-deferred';
  lootId?: string | null;
  failureReason?: string | null;
  failureDetails?: string | null;
  quarantineItemId?: string | null;
}> {
  const TERMINAL = new Set(['completed', 'failed', 'quarantined', 'paused-auth']);
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const intervalMs = 100;
  const maxIters = Math.max(1, Math.floor(timeoutMs / intervalMs));

  for (let i = 0; i < maxIters; i++) {
    // Drive the queue first so even the very first iteration runs the job.
    await runOneIngestJob();

    const rows = await db(opts?.dbUrl)
      .select({
        status: schema.ingestJobs.status,
        lootId: schema.ingestJobs.lootId,
        failureReason: schema.ingestJobs.failureReason,
        failureDetails: schema.ingestJobs.failureDetails,
        quarantineItemId: schema.ingestJobs.quarantineItemId,
      })
      .from(schema.ingestJobs)
      .where(eq(schema.ingestJobs.id, jobId));

    const row = rows[0];
    if (!row) throw new Error(`waitForJobTerminal: job ${jobId} not found`);
    if (TERMINAL.has(row.status)) {
      return row as never;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // Read final state for diagnostics.
  const final = await db(opts?.dbUrl)
    .select({
      status: schema.ingestJobs.status,
      failureReason: schema.ingestJobs.failureReason,
      failureDetails: schema.ingestJobs.failureDetails,
    })
    .from(schema.ingestJobs)
    .where(eq(schema.ingestJobs.id, jobId));
  throw new Error(
    `waitForJobTerminal: job ${jobId} did not reach terminal state in ${timeoutMs}ms; final=${JSON.stringify(final[0])}`,
  );
}

// ---------------------------------------------------------------------------
// HTTP request builders (mirror api-v1-ingest.test.ts patterns)
// ---------------------------------------------------------------------------

export function makeIngestPost(body: unknown, idempotencyKey?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return new Request('http://local/api/v1/ingest', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Watchlist helpers — V2-004-T10 e2e
// ---------------------------------------------------------------------------

/**
 * Drain the watchlist queue by calling `runOneWatchlistJob()` until it
 * reports 'idle'. Returns the number of jobs drained.
 *
 * Bounded at `maxIterations` to fail fast if the queue is somehow unbounded
 * (worker contract violation).
 */
export async function drainWatchlistJobs(opts?: { maxIterations?: number }): Promise<number> {
  const max = opts?.maxIterations ?? 50;
  let drained = 0;
  for (let i = 0; i < max; i++) {
    const result = await runOneWatchlistJob();
    if (result === 'idle') return drained;
    drained++;
  }
  throw new Error(`drainWatchlistJobs: did not idle within ${max} iterations`);
}

/**
 * Drain the ingest queue by calling `runOneIngestJob()` until it reports
 * 'idle'. Returns the number of jobs drained.
 */
export async function drainIngestJobs(opts?: { maxIterations?: number }): Promise<number> {
  const max = opts?.maxIterations ?? 50;
  let drained = 0;
  for (let i = 0; i < max; i++) {
    const result = await runOneIngestJob();
    if (result === 'idle') return drained;
    drained++;
  }
  throw new Error(`drainIngestJobs: did not idle within ${max} iterations`);
}

/**
 * Drive a watchlist subscription through the full chain:
 *
 *   1. Drain any pre-queued watchlist_jobs (e.g. from fire-now).
 *   2. (Optional) Run a scheduler tick to enqueue a job if cadence is due.
 *   3. Drain watchlist_jobs again — discovery happens here, child ingest_jobs
 *      get enqueued.
 *   4. Drain ingest_jobs — adapter.fetch() runs, Loot rows materialize.
 *
 * Returns DB rows so the test can assert on terminal state. Does NOT poll —
 * each step is a deterministic loop over the queue.
 */
export async function driveSubscriptionChain(opts: {
  subscriptionId: string;
  /** When true, run a scheduler tick before draining watchlist_jobs. */
  runScheduler?: boolean;
  schedulerNow?: Date;
  maxIterations?: number;
}): Promise<{
  watchlistJobsRun: number;
  ingestJobsRun: number;
}> {
  const max = opts.maxIterations ?? 50;
  // Drain anything already queued (fire-now etc).
  const initialWatchlist = await drainWatchlistJobs({ maxIterations: max });
  // Optionally fire the scheduler so cadence-based subs enqueue.
  if (opts.runScheduler) {
    await runOneSchedulerTick({ now: opts.schedulerNow });
  }
  const secondWatchlist = await drainWatchlistJobs({ maxIterations: max });
  const ingestRun = await drainIngestJobs({ maxIterations: max });
  return {
    watchlistJobsRun: initialWatchlist + secondWatchlist,
    ingestJobsRun: ingestRun,
  };
}

type DBClient = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

/**
 * Wipe all watchlist + ingest + loot state between tests. Order respects
 * FK dependencies. Caller is responsible for re-seeding users/collections
 * after this fires.
 */
export async function wipeWatchlistE2eState(): Promise<void> {
  const dbc = db() as DBClient;
  // Children first.
  await dbc.delete(schema.lootSourceRecords);
  await dbc.delete(schema.lootFiles);
  await dbc.delete(schema.loot);
  await dbc.delete(schema.ingestJobs);
  await dbc.delete(schema.watchlistJobs);
  // GDrive push channels — FK to watchlist_subscriptions, must drop before
  // the parent subscription rows (cascade also handles this, but explicit
  // wipe keeps test ordering predictable).
  await dbc.delete(schema.gdriveWatchChannels);
  await dbc.delete(schema.watchlistSubscriptions);
  await dbc.delete(schema.sourceCredentials);
}

/**
 * Insert a watchlist_subscriptions row directly. Returns the row id. Used by
 * tests that want a known cursor or active state pre-seeded; HTTP-driven
 * tests should use the `POST /api/v1/watchlist/subscriptions` route instead.
 */
export async function seedWatchlistSubscription(opts: {
  ownerId: string;
  kind: string;
  sourceAdapterId: string;
  parameters: Record<string, unknown>;
  defaultCollectionId: string;
  cadenceSeconds?: number;
  cursorState?: string | null;
  active?: 0 | 1;
  errorStreak?: number;
  lastFiredAt?: Date | null;
  idempotencyKey?: string | null;
}): Promise<string> {
  const id = uid();
  await db().insert(schema.watchlistSubscriptions).values({
    id,
    ownerId: opts.ownerId,
    kind: opts.kind,
    sourceAdapterId: opts.sourceAdapterId,
    parameters: JSON.stringify(opts.parameters),
    cadenceSeconds: opts.cadenceSeconds ?? 3600,
    lastFiredAt: opts.lastFiredAt ?? null,
    cursorState: opts.cursorState ?? null,
    active: opts.active ?? 1,
    errorStreak: opts.errorStreak ?? 0,
    defaultCollectionId: opts.defaultCollectionId,
    idempotencyKey: opts.idempotencyKey ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

/**
 * Insert a queued watchlist_jobs row directly. Mirrors what the scheduler
 * (or fire-now route) would do.
 */
export async function seedWatchlistJob(subscriptionId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.watchlistJobs).values({
    id,
    subscriptionId,
    status: 'queued',
    itemsDiscovered: 0,
    itemsEnqueued: 0,
    createdAt: new Date(),
  });
  return id;
}

/**
 * Read the subscription row by id. Convenience wrapper for tests.
 */
export async function getWatchlistSubscription(id: string) {
  const rows = await db()
    .select()
    .from(schema.watchlistSubscriptions)
    .where(eq(schema.watchlistSubscriptions.id, id));
  return rows[0]!;
}

/**
 * List ingest_jobs with the given parent subscription id.
 */
export async function listIngestJobsForSubscription(subscriptionId: string) {
  return db()
    .select()
    .from(schema.ingestJobs)
    .where(eq(schema.ingestJobs.parentSubscriptionId, subscriptionId));
}

/**
 * List Loot rows in the given collection. Loot has no `ownerId` column —
 * ownership is derived through `collections.ownerId` — so e2e tests scope
 * by collection id (the test seeds a fresh collection per user).
 */
export async function listLootInCollection(collectionId: string) {
  return db()
    .select()
    .from(schema.loot)
    .where(eq(schema.loot.collectionId, collectionId));
}

/**
 * List watchlist_jobs for the given subscription id, optional status filter.
 */
export async function listWatchlistJobs(
  subscriptionId: string,
  status?: 'queued' | 'claimed' | 'running' | 'completed' | 'failed',
) {
  if (status) {
    return db()
      .select()
      .from(schema.watchlistJobs)
      .where(
        and(
          eq(schema.watchlistJobs.subscriptionId, subscriptionId),
          eq(schema.watchlistJobs.status, status),
        ),
      );
  }
  return db()
    .select()
    .from(schema.watchlistJobs)
    .where(eq(schema.watchlistJobs.subscriptionId, subscriptionId));
}
