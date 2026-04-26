/**
 * Integration tests — ingest worker — V2-003-T9 fix-pass
 *
 * Real SQLite. The worker is exercised via runOneIngestJob() (single-shot
 * dispatch) so we can assert deterministic outcomes. Adapters are stubbed via
 * the registry singleton.
 *
 * Cases:
 *   - returns 'idle' when no queued rows exist
 *   - claims a queued row, runs the pipeline, terminal status persists
 *   - two concurrent claim attempts → only one wins (atomic claim)
 *   - resetStaleRunningRows resets rows older than the timeout
 *   - missing adapter → row marked failed, returns 'errored'
 *   - invalid targetPayload → row marked failed
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import {
  runOneIngestJob,
  resetStaleRunningRows,
} from '../../src/workers/ingest-worker';
import { defaultRegistry } from '../../src/scavengers';
import type {
  ScavengerAdapter,
  ScavengerEvent,
  FetchContext,
  FetchTarget,
} from '../../src/scavengers/types';

const DB_PATH = '/tmp/lootgoblin-ingest-worker.db';
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
  process.env.LOOTGOBLIN_SECRET = 'ingest-worker-test-secret-32-chars-min';
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
    name: 'Worker Test User',
    email: `${id}@worker.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashAndCollection(ownerId: string): Promise<{ collectionId: string; stashRootPath: string }> {
  const stashRootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-iw-stash-'));
  const stashRootId = uid();
  await db().insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId,
    name: `Worker Root ${stashRootId.slice(0, 8)}`,
    path: stashRootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `Worker Col ${collectionId.slice(0, 8)}`,
    pathTemplate: '{title}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { collectionId, stashRootPath };
}

async function enqueueJob(args: {
  ownerId: string;
  sourceId: string;
  collectionId: string;
  target: FetchTarget;
}): Promise<string> {
  const id = uid();
  const now = new Date();
  await db().insert(schema.ingestJobs).values({
    id,
    ownerId: args.ownerId,
    sourceId: args.sourceId,
    targetKind: args.target.kind,
    targetPayload: JSON.stringify(args.target),
    collectionId: args.collectionId,
    status: 'queued',
    lootId: null,
    quarantineItemId: null,
    failureReason: null,
    failureDetails: null,
    attempt: 1,
    idempotencyKey: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/**
 * Replace the cults3d adapter in the singleton registry with a stub that
 * stages one tiny STL and emits a `completed` event. Returns a restore fn.
 */
function stubCults3dCompletes(): () => void {
  const original = defaultRegistry.getById('cults3d');
  const stub: ScavengerAdapter = {
    id: 'cults3d',
    metadata: original?.metadata,
    supports: () => true,
    async *fetch(ctx: FetchContext, _target: FetchTarget): AsyncIterable<ScavengerEvent> {
      const stagedPath = path.join(ctx.stagingDir, 'model.stl');
      await fsp.writeFile(stagedPath, 'solid worker-test\nendsolid worker-test');
      yield {
        kind: 'completed',
        item: {
          sourceId: 'cults3d',
          sourceItemId: `wt-${uid()}`,
          title: `Worker test ${uid().slice(0, 6)}`,
          files: [
            {
              stagedPath,
              suggestedName: 'model.stl',
              size: 32,
              format: 'stl',
            },
          ],
        },
      };
    },
  };
  defaultRegistry.register(stub);
  return () => {
    if (original) defaultRegistry.register(original);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runOneIngestJob', () => {
  beforeEach(async () => {
    // Clear ingest_jobs table between tests so cases stay independent.
    await db().delete(schema.ingestJobs);
  });

  it("returns 'idle' when no queued rows exist", async () => {
    const outcome = await runOneIngestJob();
    expect(outcome).toBe('idle');
  });

  it('claims a queued row, runs pipeline to terminal status, persists row', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const jobId = await enqueueJob({
      ownerId: userId,
      sourceId: 'cults3d',
      collectionId,
      target: { kind: 'url', url: 'https://www.cults3d.com/en/3d-models/worker-1' },
    });

    const restore = stubCults3dCompletes();
    try {
      const outcome = await runOneIngestJob();
      expect(outcome).toBe('ran');
    } finally {
      restore();
    }

    const rows = await db()
      .select({
        id: schema.ingestJobs.id,
        status: schema.ingestJobs.status,
        lootId: schema.ingestJobs.lootId,
      })
      .from(schema.ingestJobs)
      .where(eq(schema.ingestJobs.id, jobId));
    expect(rows[0]!.status).toBe('completed');
    expect(typeof rows[0]!.lootId).toBe('string');
    expect(rows[0]!.lootId!.length).toBeGreaterThan(0);
  });

  it('atomic claim: two concurrent calls process at most one queued row', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const jobId = await enqueueJob({
      ownerId: userId,
      sourceId: 'cults3d',
      collectionId,
      target: { kind: 'url', url: 'https://www.cults3d.com/en/3d-models/worker-race' },
    });

    const restore = stubCults3dCompletes();
    try {
      const [a, b] = await Promise.all([runOneIngestJob(), runOneIngestJob()]);
      // Exactly one should have processed the row, the other should be idle.
      const ran = [a, b].filter((o) => o === 'ran').length;
      const idle = [a, b].filter((o) => o === 'idle').length;
      expect(ran).toBe(1);
      expect(idle).toBe(1);
    } finally {
      restore();
    }

    const rows = await db()
      .select({ status: schema.ingestJobs.status })
      .from(schema.ingestJobs)
      .where(eq(schema.ingestJobs.id, jobId));
    expect(rows[0]!.status).toBe('completed');
  });

  it("marks the row failed and returns 'errored' when no adapter is registered for the sourceId", async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    // Use 'mega' — declared in SourceId union but never registered.
    const jobId = await enqueueJob({
      ownerId: userId,
      sourceId: 'mega',
      collectionId,
      target: { kind: 'url', url: 'https://mega.example/x' },
    });

    const outcome = await runOneIngestJob();
    expect(outcome).toBe('errored');

    const rows = await db()
      .select({ status: schema.ingestJobs.status, failureReason: schema.ingestJobs.failureReason })
      .from(schema.ingestJobs)
      .where(eq(schema.ingestJobs.id, jobId));
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.failureReason).toBe('unknown');
  });

  it('marks the row failed when targetPayload is corrupt', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const jobId = uid();
    const now = new Date();
    await db().insert(schema.ingestJobs).values({
      id: jobId,
      ownerId: userId,
      sourceId: 'cults3d',
      targetKind: 'url',
      targetPayload: 'not-json{{',
      collectionId,
      status: 'queued',
      attempt: 1,
      idempotencyKey: null,
      createdAt: now,
      updatedAt: now,
    });

    const outcome = await runOneIngestJob();
    expect(outcome).toBe('errored');

    const rows = await db()
      .select({ status: schema.ingestJobs.status })
      .from(schema.ingestJobs)
      .where(eq(schema.ingestJobs.id, jobId));
    expect(rows[0]!.status).toBe('failed');
  });
});

describe('resetStaleRunningRows', () => {
  beforeEach(async () => {
    await db().delete(schema.ingestJobs);
  });

  it('resets rows that have been running longer than the stale timeout', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const jobId = uid();
    const oldTime = new Date(Date.now() - 20 * 60_000); // 20 minutes ago

    await db().insert(schema.ingestJobs).values({
      id: jobId,
      ownerId: userId,
      sourceId: 'cults3d',
      targetKind: 'url',
      targetPayload: JSON.stringify({ kind: 'url', url: 'https://www.cults3d.com/x' }),
      collectionId,
      status: 'running',
      attempt: 1,
      idempotencyKey: null,
      createdAt: oldTime,
      updatedAt: oldTime,
    });

    const recovered = await resetStaleRunningRows(new Date());
    expect(recovered).toBeGreaterThanOrEqual(1);

    const rows = await db()
      .select({ status: schema.ingestJobs.status })
      .from(schema.ingestJobs)
      .where(eq(schema.ingestJobs.id, jobId));
    expect(rows[0]!.status).toBe('queued');
  });

  it('does NOT reset rows that are running but recent', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const jobId = uid();
    const now = new Date();

    await db().insert(schema.ingestJobs).values({
      id: jobId,
      ownerId: userId,
      sourceId: 'cults3d',
      targetKind: 'url',
      targetPayload: JSON.stringify({ kind: 'url', url: 'https://www.cults3d.com/x' }),
      collectionId,
      status: 'running',
      attempt: 1,
      idempotencyKey: null,
      createdAt: now,
      updatedAt: now,
    });

    await resetStaleRunningRows(new Date());

    const rows = await db()
      .select({ status: schema.ingestJobs.status })
      .from(schema.ingestJobs)
      .where(eq(schema.ingestJobs.id, jobId));
    expect(rows[0]!.status).toBe('running');
  });
});
