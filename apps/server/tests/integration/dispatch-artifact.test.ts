// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration tests — GET /api/v1/dispatch/artifact/[jobId] — V2-006a-T7
 *
 * Coverage:
 *   1. Authorized download: 200, bytes match the file, X-Artifact-SHA256 correct,
 *      Content-Type from mime_type.
 *   2. Job claimed by a DIFFERENT agent → 403 { error: 'forbidden', reason: 'not-claimed-by-agent' }.
 *   3. Job in a non-claimed status ('claimable') → 403.
 *   4. No forge_artifacts row → 404 { error: 'not-found', reason: 'no-artifact' }.
 *   5. File missing on disk → 404 { error: 'not-found', reason: 'file-missing' }.
 *   6. Path-traversal attempt (storage_path escapes artifacts base) → 403.
 *   7. Missing API key → 401.
 *   8. Invalid API key → 401.
 *
 * DB: /tmp/lootgoblin-v2006a-t7.db (unique per T7).
 *
 * Auth strategy: mint a real courier_pairing key via mintCourierPairToken +
 * exchangeCourierPairToken. For the invalid-key tests, mock authenticateCourier.
 *
 * Artifacts root: override LOOTGOBLIN_DATA_ROOT to a /tmp subtree so the real
 * path-traversal guard works without needing /data.
 */

import { existsSync, unlinkSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getServerDb, schema } from '../../src/db/client';
import { bootstrapInstanceIdentity } from '../../src/identity/index';
import { mintCourierPairToken, exchangeCourierPairToken } from '../../src/forge/couriers';
import { createDispatchJob } from '../../src/forge/dispatch-jobs';

// ── Next.js shim ─────────────────────────────────────────────────────────────
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

// ── courier-auth mock (used selectively to force INVALID_API_KEY / null) ─────
const mockAuthenticateCourier = vi.fn();

vi.mock('../../src/auth/courier-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/courier-auth')>();
  return {
    ...actual,
    authenticateCourier: (...args: unknown[]) => mockAuthenticateCourier(...args),
  };
});

// ── DB + filesystem setup ─────────────────────────────────────────────────────
const DB_PATH = '/tmp/lootgoblin-v2006a-t7.db';
const DB_URL = `file:${DB_PATH}`;
const TEST_SECRET = 'x'.repeat(32);

// Override data root so forge-artifacts land under /tmp.
const DATA_ROOT = '/tmp/lootgoblin-t7-data';
const ARTIFACTS_BASE = path.join(DATA_ROOT, 'forge-artifacts');

// Shared fixtures resolved in beforeAll.
let testApiKey = '';
let testAgentId = '';
let sharedUserId = '';

beforeAll(async () => {
  // Clean up stale DB files.
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }

  // Set env overrides before any module imports.
  process.env.DATABASE_URL = DB_URL;
  process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
  process.env.LOOTGOBLIN_DATA_ROOT = DATA_ROOT;

  resetDbCache();
  await runMigrations(DB_URL);

  // Bootstrap instance identity so sign/verify work.
  await bootstrapInstanceIdentity('test-instance-t7');

  // Seed a shared user for FK requirements.
  sharedUserId = randomUUID();
  await getServerDb(DB_URL).insert(schema.user).values({
    id: sharedUserId,
    name: 'T7 Shared User',
    email: `${sharedUserId}@dispatch-artifact.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Mint a real courier API key.
  const mintResult = await mintCourierPairToken();
  if (!mintResult) throw new Error('mintCourierPairToken returned null');

  const exchangeResult = await exchangeCourierPairToken(mintResult.token, { dbUrl: DB_URL });
  if (!exchangeResult.ok) throw new Error(`exchangeCourierPairToken failed: ${JSON.stringify(exchangeResult)}`);

  testApiKey = exchangeResult.api_key;
  testAgentId = exchangeResult.agent_id;

  // Ensure the artifacts base dir exists.
  mkdirSync(ARTIFACTS_BASE, { recursive: true });
}, 30_000);

afterAll(() => {
  // Clean up temp data dir.
  if (existsSync(DATA_ROOT)) {
    rmSync(DATA_ROOT, { recursive: true, force: true });
  }
});

// ── Per-test cleanup ──────────────────────────────────────────────────────────
beforeEach(async () => {
  const d = getServerDb(DB_URL);
  d.delete(schema.forgeArtifacts).run();
  d.delete(schema.dispatchJobs).run();
  d.delete(schema.printerReachableVia).run();
  d.delete(schema.printers).run();
  d.delete(schema.collections).run();
  d.delete(schema.stashRoots).run();
  // Delete extra courier agents (not the one seeded by beforeAll).
  const extraAgents = await d
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.kind, 'courier'));
  for (const row of extraAgents) {
    if (row.id !== testAgentId) {
      d.delete(schema.agents).where(eq(schema.agents.id, row.id)).run();
    }
  }

  // Reset mock to passthrough (real agent lookup).
  mockAuthenticateCourier.mockImplementation(async () => ({ agentId: testAgentId }));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function db() {
  return getServerDb(DB_URL);
}

function makeReq(jobId: string, apiKey?: string): Request {
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  return new Request(`http://local/api/v1/dispatch/artifact/${jobId}`, {
    method: 'GET',
    headers,
  });
}

async function seedLootFixture(): Promise<string> {
  const stashRootId = randomUUID();
  await db().insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId: sharedUserId,
    name: 'T7 Test Root',
    path: '/tmp/t7-stash',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = randomUUID();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId: sharedUserId,
    name: `T7 Collection ${collectionId.slice(0, 8)}`,
    pathTemplate: '{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootId = randomUUID();
  await db().insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: `T7 Loot ${lootId.slice(0, 8)}`,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return lootId;
}

async function seedPrinter(): Promise<string> {
  const id = randomUUID();
  await db().insert(schema.printers).values({
    id,
    ownerId: sharedUserId,
    kind: 'fdm_klipper',
    name: `T7 Printer ${id.slice(0, 8)}`,
    connectionConfig: { url: 'http://10.0.0.42:7125', apiKey: 'k-test' },
    active: true,
    createdAt: new Date(),
  });
  return id;
}

async function seedClaimedJob(
  lootId: string,
  printerId: string,
  status: string,
  claimMarker: string | null,
): Promise<string> {
  const r = await createDispatchJob(
    {
      ownerId: sharedUserId,
      lootId,
      targetKind: 'printer',
      targetId: printerId,
      initialStatus: 'claimable',
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`seedClaimedJob: ${r.reason}`);
  const jobId = r.jobId;
  // Directly set the status and claimMarker we want for the test scenario.
  db()
    .update(schema.dispatchJobs)
    .set({ status, claimMarker, claimedAt: claimMarker ? new Date() : null })
    .where(eq(schema.dispatchJobs.id, jobId))
    .run();
  return jobId;
}

/**
 * Create a real temp file under ARTIFACTS_BASE and seed a forge_artifacts row.
 * Returns { jobId, filePath, fileContent, sha256 }.
 */
async function seedArtifactFile(jobId: string): Promise<{
  filePath: string;
  fileContent: Buffer;
  sha256: string;
}> {
  const jobDir = path.join(ARTIFACTS_BASE, jobId);
  mkdirSync(jobDir, { recursive: true });
  const filePath = path.join(jobDir, 'output.gcode');
  const fileContent = Buffer.from(`; gcode for job ${jobId}\nG28\nG1 X10\n`);
  writeFileSync(filePath, fileContent);
  const sha256 = createHash('sha256').update(fileContent).digest('hex');

  await db().insert(schema.forgeArtifacts).values({
    id: randomUUID(),
    dispatchJobId: jobId,
    kind: 'gcode',
    storagePath: filePath,
    sizeBytes: fileContent.length,
    sha256,
    mimeType: 'text/x.gcode',
    metadataJson: null,
    createdAt: new Date(),
  });

  return { filePath, fileContent, sha256 };
}

// Import the route lazily (after mocks are registered).
const getRoute = () =>
  import('../../src/app/api/v1/dispatch/artifact/[jobId]/route').then((m) => m.GET);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/dispatch/artifact/[jobId]', () => {
  it('1. authorized download: 200, bytes match, X-Artifact-SHA256 correct, Content-Type from mime_type', async () => {
    const lootId = await seedLootFixture();
    const printerId = await seedPrinter();
    const jobId = await seedClaimedJob(lootId, printerId, 'claimed', testAgentId);
    const { fileContent, sha256 } = await seedArtifactFile(jobId);

    const GET = await getRoute();
    const res = await GET(
      makeReq(jobId, testApiKey) as any,
      { params: Promise.resolve({ jobId }) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/x.gcode');
    expect(res.headers.get('x-artifact-sha256')).toBe(sha256);
    // Content-Length must be present.
    expect(res.headers.get('content-length')).toBe(String(fileContent.length));

    // Body bytes must match the file exactly.
    const bodyBuf = Buffer.from(await res.arrayBuffer());
    expect(bodyBuf.equals(fileContent)).toBe(true);
  });

  it('1b. authorized download works when job status is dispatched', async () => {
    const lootId = await seedLootFixture();
    const printerId = await seedPrinter();
    const jobId = await seedClaimedJob(lootId, printerId, 'dispatched', testAgentId);
    const { fileContent } = await seedArtifactFile(jobId);

    const GET = await getRoute();
    const res = await GET(
      makeReq(jobId, testApiKey) as any,
      { params: Promise.resolve({ jobId }) },
    );
    expect(res.status).toBe(200);
    const bodyBuf = Buffer.from(await res.arrayBuffer());
    expect(bodyBuf.equals(fileContent)).toBe(true);
  });

  it('2. job claimed by a DIFFERENT agent → 403 not-claimed-by-agent', async () => {
    const lootId = await seedLootFixture();
    const printerId = await seedPrinter();

    // Create a second agent as the "other" holder.
    const otherAgentId = randomUUID();
    await db().insert(schema.agents).values({
      id: otherAgentId,
      kind: 'courier',
      pairCredentialRef: null,
      lastSeenAt: null,
      reachableLanHint: null,
      createdAt: new Date(),
    });

    const jobId = await seedClaimedJob(lootId, printerId, 'claimed', otherAgentId);
    await seedArtifactFile(jobId);

    const GET = await getRoute();
    const res = await GET(
      makeReq(jobId, testApiKey) as any,
      { params: Promise.resolve({ jobId }) },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
    expect(body.reason).toBe('not-claimed-by-agent');
  });

  it('3. job in non-claimed status (claimable) → 403 not-claimed-by-agent', async () => {
    const lootId = await seedLootFixture();
    const printerId = await seedPrinter();
    // claimable means no claimMarker.
    const jobId = await seedClaimedJob(lootId, printerId, 'claimable', null);
    await seedArtifactFile(jobId);

    const GET = await getRoute();
    const res = await GET(
      makeReq(jobId, testApiKey) as any,
      { params: Promise.resolve({ jobId }) },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
    expect(body.reason).toBe('not-claimed-by-agent');
  });

  it('4. no forge_artifacts row → 404 no-artifact', async () => {
    const lootId = await seedLootFixture();
    const printerId = await seedPrinter();
    const jobId = await seedClaimedJob(lootId, printerId, 'claimed', testAgentId);
    // Intentionally NO seedArtifactFile.

    const GET = await getRoute();
    const res = await GET(
      makeReq(jobId, testApiKey) as any,
      { params: Promise.resolve({ jobId }) },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not-found');
    expect(body.reason).toBe('no-artifact');
  });

  it('5. file missing on disk → 404 file-missing', async () => {
    const lootId = await seedLootFixture();
    const printerId = await seedPrinter();
    const jobId = await seedClaimedJob(lootId, printerId, 'claimed', testAgentId);

    // Seed the DB row but point it to a non-existent file.
    const fakePath = path.join(ARTIFACTS_BASE, jobId, 'nonexistent.gcode');
    mkdirSync(path.dirname(fakePath), { recursive: true });
    await db().insert(schema.forgeArtifacts).values({
      id: randomUUID(),
      dispatchJobId: jobId,
      kind: 'gcode',
      storagePath: fakePath,
      sizeBytes: 100,
      sha256: 'a'.repeat(64),
      mimeType: 'text/x.gcode',
      metadataJson: null,
      createdAt: new Date(),
    });

    const GET = await getRoute();
    const res = await GET(
      makeReq(jobId, testApiKey) as any,
      { params: Promise.resolve({ jobId }) },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not-found');
    expect(body.reason).toBe('file-missing');
  });

  it('6. path-traversal attempt → 403', async () => {
    const lootId = await seedLootFixture();
    const printerId = await seedPrinter();
    const jobId = await seedClaimedJob(lootId, printerId, 'claimed', testAgentId);

    // Seed a storage_path that resolves OUTSIDE the artifacts base via `..`.
    // The route must reject this without reading the file.
    const escapingPath = path.join(ARTIFACTS_BASE, '..', '..', 'etc', 'passwd');
    await db().insert(schema.forgeArtifacts).values({
      id: randomUUID(),
      dispatchJobId: jobId,
      kind: 'gcode',
      storagePath: escapingPath,
      sizeBytes: 0,
      sha256: 'b'.repeat(64),
      mimeType: 'text/x.gcode',
      metadataJson: null,
      createdAt: new Date(),
    });

    const GET = await getRoute();
    const res = await GET(
      makeReq(jobId, testApiKey) as any,
      { params: Promise.resolve({ jobId }) },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
  });

  it('7. missing API key → 401', async () => {
    mockAuthenticateCourier.mockImplementation(async () => null);

    const jobId = randomUUID();
    const GET = await getRoute();
    const res = await GET(
      makeReq(jobId) as any,
      { params: Promise.resolve({ jobId }) },
    );

    expect(res.status).toBe(401);
  });

  it('8. invalid API key → 401', async () => {
    const { INVALID_API_KEY } = await import('../../src/auth/courier-auth');
    mockAuthenticateCourier.mockImplementation(async () => INVALID_API_KEY);

    const jobId = randomUUID();
    const GET = await getRoute();
    const res = await GET(
      makeReq(jobId, 'bad-key') as any,
      { params: Promise.resolve({ jobId }) },
    );

    expect(res.status).toBe(401);
  });
});
