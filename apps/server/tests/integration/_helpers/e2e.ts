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
import { eq } from 'drizzle-orm';

import { runMigrations, getDb, schema, resetDbCache } from '../../../src/db/client';
import { encrypt } from '../../../src/crypto';
import { runOneIngestJob } from '../../../src/workers/ingest-worker';
import {
  defaultRegistry,
  createCults3dAdapter,
  createSketchfabAdapter,
  createGdriveAdapter,
  createMakerWorldAdapter,
  createPrintablesAdapter,
  createUploadAdapter,
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
  defaultRegistry.register(createCults3dAdapter({ httpFetch: lazyFetch, retryBaseMs: 0 }));
  defaultRegistry.register(createMakerWorldAdapter({ httpFetch: lazyFetch, retryBaseMs: 0 }));
  defaultRegistry.register(createPrintablesAdapter({ httpFetch: lazyFetch, retryBaseMs: 0 }));
  defaultRegistry.register(createSketchfabAdapter({ httpFetch: lazyFetch, retryBaseMs: 0 }));
  defaultRegistry.register(createGdriveAdapter({ httpFetch: lazyFetch, retryBaseMs: 0 }));
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
