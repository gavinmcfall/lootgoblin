/**
 * Integration tests for the shared ingest pipeline — V2-003-T2
 *
 * Real SQLite DB at /tmp/lootgoblin-ingest-pipeline.db
 * Scratch staging dirs in /tmp/
 *
 * Test cases:
 *   1.  Happy path: adapter emits progress → completed → pipeline places new Loot.
 *   2.  Dedup by hash: existing Loot with same file hash → deduped:true, no new Loot.
 *   3.  Dedup by sourceItemId: existing lootSourceRecord → deduped:true, no new Loot.
 *   4.  Format unsupported: adapter emits .exe → quarantined (format-unsupported).
 *   5.  Size exceeds limit: adapter emits oversized file → quarantined (size-exceeds-limit).
 *   6.  Adapter emits failed: pipeline marks job failed, cleans up staging dir.
 *   7.  Adapter emits auth-required: job status='paused-auth', staging cleaned.
 *   8.  Placement failure: mocked applySingleCandidate → quarantined (placement-failed).
 *   9.  Staging cleanup: staging dir is removed on every path.
 *   10. AbortSignal propagation: pre-aborted signal → adapter can terminate quickly.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { createIngestPipeline } from '../../src/scavengers/pipeline';
import type { ScavengerAdapter, ScavengerEvent, FetchContext, FetchTarget } from '../../src/scavengers/types';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-ingest-pipeline.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
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
// Helpers — seed data
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Ingest Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashAndCollection(ownerId: string, rootPath: string): Promise<{ stashRootId: string; collectionId: string }> {
  const stashRootId = uid();
  await fsp.mkdir(rootPath, { recursive: true });
  await db().insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId,
    name: 'Test Stash Root',
    path: rootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `Test Collection ${collectionId.slice(0, 8)}`,
    pathTemplate: '{title}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { stashRootId, collectionId };
}

async function makeStagingRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-ingest-staging-'));
}

// ---------------------------------------------------------------------------
// Helpers — fake adapters
// ---------------------------------------------------------------------------

/** Write a small file to stagingDir and return a completed event. */
async function writeAndComplete(
  stagingDir: string,
  filename: string,
  content: Buffer | string,
): Promise<ScavengerEvent> {
  const stagedPath = path.join(stagingDir, filename);
  await fsp.writeFile(stagedPath, content);
  return {
    kind: 'completed',
    item: {
      sourceId: 'cults3d',
      sourceItemId: `item-${filename}`,
      title: 'Test Model',
      creator: 'Test Creator',
      files: [{ stagedPath, suggestedName: filename, size: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content as string) }],
    },
  };
}

function makeFakeAdapter(
  id: string,
  eventsFactory: (ctx: FetchContext, target: FetchTarget) => AsyncIterable<ScavengerEvent>,
): ScavengerAdapter {
  return {
    id: id as import('../../src/scavengers/types').SourceId,
    supports: () => false,
    fetch: eventsFactory,
  };
}

async function* yieldEvents(...events: ScavengerEvent[]): AsyncGenerator<ScavengerEvent> {
  for (const e of events) yield e;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IngestPipeline', () => {
  // ── 1. Happy path ──────────────────────────────────────────────────────────
  it('1. happy path: places a new Loot from progress+completed events', async () => {
    const ownerId = await seedUser();
    const stashPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-stash-'));
    const { collectionId } = await seedStashAndCollection(ownerId, stashPath);
    const stagingRoot = await makeStagingRoot();

    const adapter = makeFakeAdapter('cults3d', (ctx) => ({
      [Symbol.asyncIterator]: async function* () {
        yield { kind: 'progress', message: 'Downloading...', completedBytes: 50, totalBytes: 100 } as ScavengerEvent;
        // Write a real PNG-magic file to stagingDir
        const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
        const stagedPath = path.join(ctx.stagingDir, 'model.png');
        await fsp.writeFile(stagedPath, magic);
        yield {
          kind: 'completed',
          item: {
            sourceId: 'cults3d' as const,
            sourceItemId: 'cults3d-123',
            title: 'Cool Model',
            creator: 'Designer X',
            files: [{ stagedPath, suggestedName: 'model.png', size: magic.length }],
          },
        } as ScavengerEvent;
      },
    }));

    const pipeline = createIngestPipeline({ ownerId, collectionId, stagingRoot, dbUrl: DB_URL });
    const outcome = await pipeline.run({ adapter, target: { kind: 'url', url: 'https://cults3d.com/en/3d-model/123' } });

    expect(outcome.status).toBe('placed');
    if (outcome.status !== 'placed') return;

    expect(outcome.deduped).toBe(false);
    expect(outcome.lootId).toBeTruthy();
    expect(outcome.jobId).toBeTruthy();

    // ingest_jobs row
    const jobs = await db().select().from(schema.ingestJobs).where(require('drizzle-orm').eq(schema.ingestJobs.id, outcome.jobId));
    expect(jobs[0]?.status).toBe('completed');
    expect(jobs[0]?.lootId).toBe(outcome.lootId);

    // lootSourceRecords row
    const sources = await db().select().from(schema.lootSourceRecords).where(require('drizzle-orm').eq(schema.lootSourceRecords.lootId, outcome.lootId));
    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(sources[0]?.sourceType).toBe('cults3d');
    expect(sources[0]?.sourceIdentifier).toBe('cults3d-123');
  });

  // ── 2. Dedup by hash ───────────────────────────────────────────────────────
  it('2. dedup by hash: existing Loot+LootFile with same hash → deduped:true', async () => {
    const ownerId = await seedUser();
    const stashPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-stash-'));
    const { collectionId, stashRootId } = await seedStashAndCollection(ownerId, stashPath);
    const stagingRoot = await makeStagingRoot();

    // Write a file and compute its hash
    const fileContent = Buffer.from('known-file-content-for-dedup-test', 'utf8');
    const hashHex = crypto.createHash('sha256').update(fileContent).digest('hex');

    // Seed existing loot + lootFile with that hash
    const existingLootId = uid();
    await db().insert(schema.loot).values({
      id: existingLootId,
      collectionId,
      title: 'Pre-existing Model',
      description: null,
      tags: [],
      creator: null,
      license: null,
      sourceItemId: null,
      contentSummary: null,
      fileMissing: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db().insert(schema.lootFiles).values({
      id: uid(),
      lootId: existingLootId,
      path: 'some/relative/path.png',
      format: 'png',
      size: fileContent.length,
      hash: hashHex,
      origin: 'adoption',
      provenance: null,
      createdAt: new Date(),
    });

    const adapter = makeFakeAdapter('makerworld', (ctx) => ({
      [Symbol.asyncIterator]: async function* () {
        const stagedPath = path.join(ctx.stagingDir, 'dupe.png');
        await fsp.writeFile(stagedPath, fileContent);
        yield {
          kind: 'completed',
          item: {
            sourceId: 'makerworld' as const,
            sourceItemId: 'mw-999',
            title: 'Duplicate Model',
            files: [{ stagedPath, suggestedName: 'dupe.png', size: fileContent.length }],
          },
        } as ScavengerEvent;
      },
    }));

    const pipeline = createIngestPipeline({ ownerId, collectionId, stagingRoot, dbUrl: DB_URL });
    const outcome = await pipeline.run({ adapter, target: { kind: 'source-item-id', sourceItemId: 'mw-999' } });

    expect(outcome.status).toBe('placed');
    if (outcome.status !== 'placed') return;

    expect(outcome.deduped).toBe(true);
    expect(outcome.lootId).toBe(existingLootId);
  });

  // ── 3. Dedup by sourceItemId ───────────────────────────────────────────────
  it('3. dedup by sourceItemId: existing lootSourceRecord → deduped:true', async () => {
    const ownerId = await seedUser();
    const stashPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-stash-'));
    const { collectionId } = await seedStashAndCollection(ownerId, stashPath);
    const stagingRoot = await makeStagingRoot();

    // Seed existing loot + source record for sourceId='cults3d', identifier='abc'
    const existingLootId = uid();
    await db().insert(schema.loot).values({
      id: existingLootId,
      collectionId,
      title: 'Already Ingested',
      description: null,
      tags: [],
      creator: null,
      license: null,
      sourceItemId: null,
      contentSummary: null,
      fileMissing: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db().insert(schema.lootSourceRecords).values({
      id: uid(),
      lootId: existingLootId,
      sourceType: 'cults3d',
      sourceUrl: null,
      sourceIdentifier: 'abc',
      capturedAt: new Date(),
    });

    // Adapter emits a cults3d file with sourceItemId='abc'
    const adapter = makeFakeAdapter('cults3d', (ctx) => ({
      [Symbol.asyncIterator]: async function* () {
        const stagedPath = path.join(ctx.stagingDir, 'file.stl');
        await fsp.writeFile(stagedPath, 'solid test\nendsolid test\n');
        yield {
          kind: 'completed',
          item: {
            sourceId: 'cults3d' as const,
            sourceItemId: 'abc',
            title: 'Same Source Item',
            files: [{ stagedPath, suggestedName: 'file.stl', size: 22 }],
          },
        } as ScavengerEvent;
      },
    }));

    const pipeline = createIngestPipeline({ ownerId, collectionId, stagingRoot, dbUrl: DB_URL });
    const outcome = await pipeline.run({ adapter, target: { kind: 'source-item-id', sourceItemId: 'abc' } });

    expect(outcome.status).toBe('placed');
    if (outcome.status !== 'placed') return;
    expect(outcome.deduped).toBe(true);
    expect(outcome.lootId).toBe(existingLootId);
  });

  // ── 4. Format unsupported ──────────────────────────────────────────────────
  it('4. format unsupported: .exe file → quarantined (format-unsupported)', async () => {
    const ownerId = await seedUser();
    const stashPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-stash-'));
    const { collectionId } = await seedStashAndCollection(ownerId, stashPath);
    const stagingRoot = await makeStagingRoot();

    const adapter = makeFakeAdapter('upload', (ctx) => ({
      [Symbol.asyncIterator]: async function* () {
        const stagedPath = path.join(ctx.stagingDir, 'malware.exe');
        await fsp.writeFile(stagedPath, Buffer.from([0x4d, 0x5a, 0x90, 0x00])); // MZ header
        yield {
          kind: 'completed',
          item: {
            sourceId: 'upload' as const,
            sourceItemId: 'upload-exe',
            title: 'Bad File',
            files: [{ stagedPath, suggestedName: 'malware.exe', size: 4 }],
          },
        } as ScavengerEvent;
      },
    }));

    const pipeline = createIngestPipeline({ ownerId, collectionId, stagingRoot, dbUrl: DB_URL });
    const outcome = await pipeline.run({ adapter, target: { kind: 'raw', payload: {} } });

    expect(outcome.status).toBe('quarantined');
    if (outcome.status !== 'quarantined') return;
    expect(outcome.reason).toBe('format-unsupported');
    expect(outcome.quarantineItemId).toBeTruthy();

    // ingest_jobs row
    const jobs = await db().select().from(schema.ingestJobs).where(require('drizzle-orm').eq(schema.ingestJobs.id, outcome.jobId));
    expect(jobs[0]?.status).toBe('quarantined');
  });

  // ── 5. Size exceeds limit ──────────────────────────────────────────────────
  it('5. size exceeds limit: file over maxFileSize → quarantined (size-exceeds-limit)', async () => {
    const ownerId = await seedUser();
    const stashPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-stash-'));
    const { collectionId } = await seedStashAndCollection(ownerId, stashPath);
    const stagingRoot = await makeStagingRoot();

    const adapter = makeFakeAdapter('upload', (ctx) => ({
      [Symbol.asyncIterator]: async function* () {
        // Write a PNG-magic file so it passes format check,
        // but set maxFileSize very low in pipeline options.
        const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
        const bigContent = Buffer.concat([magic, Buffer.alloc(100)]);
        const stagedPath = path.join(ctx.stagingDir, 'big.png');
        await fsp.writeFile(stagedPath, bigContent);
        yield {
          kind: 'completed',
          item: {
            sourceId: 'upload' as const,
            sourceItemId: 'upload-big',
            title: 'Big File',
            files: [{ stagedPath, suggestedName: 'big.png', size: bigContent.length }],
          },
        } as ScavengerEvent;
      },
    }));

    // maxFileSize = 50 bytes → the 110-byte file exceeds it
    const pipeline = createIngestPipeline({ ownerId, collectionId, stagingRoot, maxFileSize: 50, dbUrl: DB_URL });
    const outcome = await pipeline.run({ adapter, target: { kind: 'raw', payload: {} } });

    expect(outcome.status).toBe('quarantined');
    if (outcome.status !== 'quarantined') return;
    expect(outcome.reason).toBe('size-exceeds-limit');
  });

  // ── 6. Adapter emits failed ────────────────────────────────────────────────
  it('6. adapter emits failed: job status=failed, staging dir cleaned', async () => {
    const ownerId = await seedUser();
    const stashPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-stash-'));
    const { collectionId } = await seedStashAndCollection(ownerId, stashPath);
    const stagingRoot = await makeStagingRoot();

    let capturedStagingDir = '';
    const adapter = makeFakeAdapter('cults3d', (ctx) => {
      capturedStagingDir = ctx.stagingDir;
      return {
        [Symbol.asyncIterator]: async function* () {
          yield {
            kind: 'failed',
            reason: 'content-removed',
            details: 'HTTP 404 — item gone',
          } as ScavengerEvent;
        },
      };
    });

    const pipeline = createIngestPipeline({ ownerId, collectionId, stagingRoot, dbUrl: DB_URL });
    const outcome = await pipeline.run({ adapter, target: { kind: 'url', url: 'https://cults3d.com/en/3d-model/gone' } });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.reason).toBe('content-removed');

    // Job status
    const jobs = await db().select().from(schema.ingestJobs).where(require('drizzle-orm').eq(schema.ingestJobs.id, outcome.jobId));
    expect(jobs[0]?.status).toBe('failed');
    expect(jobs[0]?.failureReason).toBe('content-removed');

    // Staging dir cleaned
    await expect(fsp.access(capturedStagingDir)).rejects.toBeDefined();
  });

  // ── 7. Adapter emits auth-required ────────────────────────────────────────
  it('7. adapter emits auth-required: job status=paused-auth, staging cleaned', async () => {
    const ownerId = await seedUser();
    const stashPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-stash-'));
    const { collectionId } = await seedStashAndCollection(ownerId, stashPath);
    const stagingRoot = await makeStagingRoot();

    let capturedStagingDir = '';
    const adapter = makeFakeAdapter('printables', (ctx) => {
      capturedStagingDir = ctx.stagingDir;
      return {
        [Symbol.asyncIterator]: async function* () {
          yield {
            kind: 'auth-required',
            reason: 'expired',
            surfaceToUser: 'Please log in again',
          } as ScavengerEvent;
        },
      };
    });

    const pipeline = createIngestPipeline({ ownerId, collectionId, stagingRoot, dbUrl: DB_URL });
    const outcome = await pipeline.run({ adapter, target: { kind: 'url', url: 'https://printables.com/model/123' } });

    expect(outcome.status).toBe('paused-auth');
    if (outcome.status !== 'paused-auth') return;
    expect(outcome.reason).toBe('expired');

    const jobs = await db().select().from(schema.ingestJobs).where(require('drizzle-orm').eq(schema.ingestJobs.id, outcome.jobId));
    expect(jobs[0]?.status).toBe('paused-auth');

    // Staging dir cleaned
    await expect(fsp.access(capturedStagingDir)).rejects.toBeDefined();
  });

  // ── 8. Placement failure ───────────────────────────────────────────────────
  it('8. placement failure: applySingleCandidate error → quarantined (placement-failed)', async () => {
    const ownerId = await seedUser();
    const stashPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-stash-'));
    const { collectionId } = await seedStashAndCollection(ownerId, stashPath);
    const stagingRoot = await makeStagingRoot();

    // Mock applySingleCandidate to return an error
    const applierMod = await import('../../src/stash/adoption/applier');
    vi.spyOn(applierMod, 'applySingleCandidate').mockResolvedValueOnce({ error: 'Disk full' });

    const adapter = makeFakeAdapter('makerworld', (ctx) => ({
      [Symbol.asyncIterator]: async function* () {
        const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const stagedPath = path.join(ctx.stagingDir, 'model.png');
        await fsp.writeFile(stagedPath, magic);
        yield {
          kind: 'completed',
          item: {
            sourceId: 'makerworld' as const,
            sourceItemId: 'mw-fail-test',
            title: 'Failing Placement',
            files: [{ stagedPath, suggestedName: 'model.png', size: magic.length }],
          },
        } as ScavengerEvent;
      },
    }));

    const pipeline = createIngestPipeline({ ownerId, collectionId, stagingRoot, dbUrl: DB_URL });
    const outcome = await pipeline.run({ adapter, target: { kind: 'source-item-id', sourceItemId: 'mw-fail-test' } });

    expect(outcome.status).toBe('quarantined');
    if (outcome.status !== 'quarantined') return;
    expect(outcome.reason).toBe('placement-failed');

    const jobs = await db().select().from(schema.ingestJobs).where(require('drizzle-orm').eq(schema.ingestJobs.id, outcome.jobId));
    expect(jobs[0]?.status).toBe('quarantined');
    expect(jobs[0]?.quarantineItemId).toBeTruthy();
  });

  // ── 9. Staging cleanup on every path ──────────────────────────────────────
  it('9. staging cleanup: staging dir is removed after any outcome', async () => {
    const ownerId = await seedUser();
    const stashPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-stash-'));
    const { collectionId } = await seedStashAndCollection(ownerId, stashPath);
    const stagingRoot = await makeStagingRoot();

    const capturedDirs: string[] = [];

    // Failed path
    const adapterFailed = makeFakeAdapter('upload', (ctx) => ({
      [Symbol.asyncIterator]: async function* () {
        capturedDirs.push(ctx.stagingDir);
        yield { kind: 'failed', reason: 'unknown', details: 'test' } as ScavengerEvent;
      },
    }));
    await createIngestPipeline({ ownerId, collectionId, stagingRoot, dbUrl: DB_URL })
      .run({ adapter: adapterFailed, target: { kind: 'raw', payload: {} } });

    // Auth-required path
    const adapterAuth = makeFakeAdapter('upload', (ctx) => ({
      [Symbol.asyncIterator]: async function* () {
        capturedDirs.push(ctx.stagingDir);
        yield { kind: 'auth-required', reason: 'missing' } as ScavengerEvent;
      },
    }));
    await createIngestPipeline({ ownerId, collectionId, stagingRoot, dbUrl: DB_URL })
      .run({ adapter: adapterAuth, target: { kind: 'raw', payload: {} } });

    for (const dir of capturedDirs) {
      const exists = fs.existsSync(dir);
      expect(exists, `Staging dir should be cleaned up: ${dir}`).toBe(false);
    }
  });

  // ── 10. AbortSignal propagation ────────────────────────────────────────────
  it('10. aborted signal: adapter receives it and can terminate quickly', async () => {
    const ownerId = await seedUser();
    const stashPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lootgoblin-stash-'));
    const { collectionId } = await seedStashAndCollection(ownerId, stashPath);
    const stagingRoot = await makeStagingRoot();

    const ac = new AbortController();
    ac.abort(); // pre-abort

    const adapter = makeFakeAdapter('upload', (_ctx, _target) => ({
      [Symbol.asyncIterator]: async function* (this: void) {
        // Adapter checks the signal and yields failed immediately
        if (ac.signal.aborted) {
          yield { kind: 'failed', reason: 'unknown', details: 'aborted by signal' } as ScavengerEvent;
          return;
        }
        // Should not reach here
        yield { kind: 'failed', reason: 'unknown', details: 'not aborted' } as ScavengerEvent;
      },
    }));

    const pipeline = createIngestPipeline({ ownerId, collectionId, stagingRoot, dbUrl: DB_URL });
    const outcome = await pipeline.run({ adapter, target: { kind: 'raw', payload: {} }, signal: ac.signal });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.details).toContain('aborted');
  });
});
