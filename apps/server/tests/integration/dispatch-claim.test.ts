// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration tests — POST /api/v1/dispatch/claim — V2-006a-T6
 *
 * Coverage:
 *   1. claim-success: returns full bundle; job is now 'claimed' with
 *      claim_marker = agentId; response has connection_config + credential
 *      (seeded via setCredential) + artifact.download_url.
 *   2. No reachable claimable job (no printer_reachable_via row) → { job: null }
 *      and the job row is NOT claimed.
 *   3. A claimable job for a DIFFERENT printer (no reachability for this agent)
 *      is never returned.
 *   4. Race-lost: job is pre-claimed (status='claimed' by another agent) before
 *      this call → { job: null }.
 *   5. Credential null when no forge_target_credential row exists.
 *   6. Missing / invalid API key → 401.
 *
 * DB: /tmp/lootgoblin-v2006a-t6.db (unique per T6).
 *
 * Auth strategy: mint a real courier_pairing key via mintCourierPairToken +
 * exchangeCourierPairToken (mirrors couriers-pair.test.ts / couriers-heartbeat.test.ts).
 * For the invalid-key tests, we mock authenticateCourier directly.
 *
 * Test isolation: beforeEach wipes dispatch_jobs, forge_artifacts,
 * forge_target_credentials, printer_reachable_via, printers, collections,
 * stash_roots, and user rows that are NOT the shared testUserId seeded in
 * beforeAll. The shared courier agent row is preserved.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getServerDb, schema } from '../../src/db/client';
import { bootstrapInstanceIdentity } from '../../src/identity/index';
import { mintCourierPairToken, exchangeCourierPairToken } from '../../src/forge/couriers';
import { createDispatchJob } from '../../src/forge/dispatch-jobs';
import { setCredential } from '../../src/forge/dispatch/credentials';

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

// ── courier-auth mock (used selectively to force INVALID_API_KEY) ─────────────
const mockAuthenticateCourier = vi.fn();

vi.mock('../../src/auth/courier-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/courier-auth')>();
  return {
    ...actual,
    authenticateCourier: (...args: unknown[]) => mockAuthenticateCourier(...args),
  };
});

// ── DB setup ─────────────────────────────────────────────────────────────────
const DB_PATH = '/tmp/lootgoblin-v2006a-t6.db';
const DB_URL = `file:${DB_PATH}`;
const TEST_SECRET = 'x'.repeat(32);

// Shared fixtures resolved in beforeAll.
let testApiKey = '';
let testAgentId = '';
let sharedUserId = '';

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
  await runMigrations(DB_URL);

  // Bootstrap instance identity so sign/verify work.
  await bootstrapInstanceIdentity('test-instance-t6');

  // Seed a shared user for FK requirements.
  sharedUserId = randomUUID();
  await getServerDb(DB_URL).insert(schema.user).values({
    id: sharedUserId,
    name: 'T6 Shared User',
    email: `${sharedUserId}@dispatch-claim.test`,
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
}, 30_000);

// ── Per-test cleanup ──────────────────────────────────────────────────────────

beforeEach(async () => {
  const d = getServerDb(DB_URL);
  // FK order: dispatch_jobs → forge_artifacts, target_credentials → printers → user
  //           printer_reachable_via → printers + agents
  // The agents table keeps testAgentId; we only delete extra courier agents
  // inserted by individual tests by deleting non-testAgentId courier agents.
  d.delete(schema.forgeArtifacts).run();
  d.delete(schema.dispatchJobs).run();
  d.delete(schema.forgeTargetCredentials).run();
  d.delete(schema.printerReachableVia).run();
  d.delete(schema.printers).run();
  d.delete(schema.collections).run();
  d.delete(schema.stashRoots).run();
  // Delete extra courier agents (not the one seeded by beforeAll).
  // Use raw eq — testAgentId is captured by closure.
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

function makeReq(apiKey?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return new Request('http://local/api/v1/dispatch/claim', {
    method: 'POST',
    headers,
  });
}

async function seedStashRoot(): Promise<string> {
  const id = randomUUID();
  await db().insert(schema.stashRoots).values({
    id,
    ownerId: sharedUserId,
    name: 'T6 Test Root',
    path: '/tmp/t6-stash',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(stashRootId: string): Promise<string> {
  const id = randomUUID();
  await db().insert(schema.collections).values({
    id,
    ownerId: sharedUserId,
    name: `T6 Collection ${id.slice(0, 8)}`,
    pathTemplate: '{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(collectionId: string): Promise<string> {
  const id = randomUUID();
  await db().insert(schema.loot).values({
    id,
    collectionId,
    title: `T6 Loot ${id.slice(0, 8)}`,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedPrinter(): Promise<string> {
  const id = randomUUID();
  await db().insert(schema.printers).values({
    id,
    ownerId: sharedUserId,
    kind: 'fdm_klipper',
    name: `T6 Printer ${id.slice(0, 8)}`,
    connectionConfig: { url: 'http://10.0.0.42:7125', apiKey: 'k-test' },
    active: true,
    createdAt: new Date(),
  });
  return id;
}

async function seedReachableVia(printerId: string, agentId: string): Promise<void> {
  await db().insert(schema.printerReachableVia).values({
    printerId,
    agentId,
    reachableStatus: 'reachable',
    lastCheckedAt: new Date(),
    detail: null,
  });
}

async function seedArtifact(jobId: string): Promise<void> {
  await db().insert(schema.forgeArtifacts).values({
    id: randomUUID(),
    dispatchJobId: jobId,
    kind: 'gcode',
    storagePath: `/tmp/lootgoblin-t6-artifact-${jobId}.gcode`,
    sizeBytes: 2048,
    sha256: 'b'.repeat(64),
    mimeType: 'text/x.gcode',
    metadataJson: null,
    createdAt: new Date(),
  });
}

async function seedLootFixture(): Promise<{ lootId: string }> {
  const stashRootId = await seedStashRoot();
  const collectionId = await seedCollection(stashRootId);
  const lootId = await seedLoot(collectionId);
  return { lootId };
}

async function seedClaimableJob(lootId: string, targetId: string): Promise<string> {
  const r = await createDispatchJob(
    {
      ownerId: sharedUserId,
      lootId,
      targetKind: 'printer',
      targetId,
      initialStatus: 'claimable',
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`seedClaimableJob: ${r.reason}`);
  return r.jobId;
}

// Import the route lazily (after mocks are registered).
const getRoute = () =>
  import('../../src/app/api/v1/dispatch/claim/route').then((m) => m.POST);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/dispatch/claim', () => {
  it('1. claim-success: returns full bundle; job row is claimed; credential + artifact present', async () => {
    const { lootId } = await seedLootFixture();
    const printerId = await seedPrinter();
    await seedReachableVia(printerId, testAgentId);

    const jobId = await seedClaimableJob(lootId, printerId);
    await seedArtifact(jobId);

    // Seed a credential for the printer.
    setCredential({
      printerId,
      kind: 'moonraker_api_key',
      payload: { apiKey: 'test-moonraker-key' },
      dbUrl: DB_URL,
      secret: TEST_SECRET,
    });

    const POST = await getRoute();
    const res = await POST(makeReq(testApiKey) as any);
    expect(res.status).toBe(200);

    const body = await res.json();

    // Job field.
    expect(body.job).not.toBeNull();
    expect(body.job.id).toBe(jobId);
    expect(body.job.target_kind).toBe('printer');
    expect(body.job.target_id).toBe(printerId);
    expect(body.job.loot_id).toBe(lootId);
    expect(body.job.owner_id).toBe(sharedUserId);

    // Printer field.
    expect(body.printer).not.toBeNull();
    expect(body.printer.id).toBe(printerId);
    expect(body.printer.kind).toBe('fdm_klipper');
    expect(body.printer.connection_config).toMatchObject({ url: 'http://10.0.0.42:7125' });

    // Credential field (decrypted payload sent to Courier).
    expect(body.credential).not.toBeNull();
    expect(body.credential.kind).toBe('moonraker_api_key');
    expect(body.credential.payload).toMatchObject({ apiKey: 'test-moonraker-key' });

    // Artifact field.
    expect(body.artifact).not.toBeNull();
    expect(body.artifact.job_id).toBe(jobId);
    expect(body.artifact.size_bytes).toBe(2048);
    expect(body.artifact.sha256).toBe('b'.repeat(64));
    expect(body.artifact.mime_type).toBe('text/x.gcode');
    // T7 download URL — storagePath must NOT appear.
    expect(body.artifact.download_url).toBe(`/api/v1/dispatch/artifact/${jobId}`);
    expect(body.artifact.storage_path).toBeUndefined();

    // Job row must now be 'claimed' with this agent as claim_marker.
    const rows = await db()
      .select({ status: schema.dispatchJobs.status, claimMarker: schema.dispatchJobs.claimMarker })
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId))
      .limit(1);
    expect(rows[0]?.status).toBe('claimed');
    expect(rows[0]?.claimMarker).toBe(testAgentId);
  });

  it('2. no reachable_via row → { job: null } and job is NOT claimed', async () => {
    const { lootId } = await seedLootFixture();
    const printerId = await seedPrinter();
    // Deliberately do NOT insert a printer_reachable_via row.
    const jobId = await seedClaimableJob(lootId, printerId);
    await seedArtifact(jobId);

    const POST = await getRoute();
    const res = await POST(makeReq(testApiKey) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job).toBeNull();

    // Job row must still be 'claimable'.
    const rows = await db()
      .select({ status: schema.dispatchJobs.status })
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId))
      .limit(1);
    expect(rows[0]?.status).toBe('claimable');
  });

  it('3. claimable job for a printer not reachable by this agent is never returned', async () => {
    const { lootId } = await seedLootFixture();
    const printerId = await seedPrinter();

    // Build a second courier agent — NOT testAgentId.
    const otherAgentId = randomUUID();
    await db().insert(schema.agents).values({
      id: otherAgentId,
      kind: 'courier',
      pairCredentialRef: null,
      lastSeenAt: null,
      reachableLanHint: null,
      createdAt: new Date(),
    });

    // Printer is only reachable by the OTHER agent.
    await seedReachableVia(printerId, otherAgentId);

    const jobId = await seedClaimableJob(lootId, printerId);

    // testAgentId should NOT see this job.
    const POST = await getRoute();
    const res = await POST(makeReq(testApiKey) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job).toBeNull();

    // Job remains unclaimed.
    const rows = await db()
      .select({ status: schema.dispatchJobs.status })
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId))
      .limit(1);
    expect(rows[0]?.status).toBe('claimable');
  });

  it('4. race-lost: job already claimed by another agent → { job: null }', async () => {
    const { lootId } = await seedLootFixture();
    const printerId = await seedPrinter();
    await seedReachableVia(printerId, testAgentId);

    const jobId = await seedClaimableJob(lootId, printerId);
    await seedArtifact(jobId);

    // Seed a second agent to act as the racer.
    const racerAgentId = randomUUID();
    await db().insert(schema.agents).values({
      id: racerAgentId,
      kind: 'courier',
      pairCredentialRef: null,
      lastSeenAt: null,
      reachableLanHint: null,
      createdAt: new Date(),
    });

    // Pre-claim the job with the racer to simulate losing the race.
    db()
      .update(schema.dispatchJobs)
      .set({ status: 'claimed', claimMarker: racerAgentId, claimedAt: new Date() })
      .where(eq(schema.dispatchJobs.id, jobId))
      .run();

    const POST = await getRoute();
    const res = await POST(makeReq(testApiKey) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job).toBeNull();

    // Claim_marker must still be the racer, not testAgentId.
    const rows = await db()
      .select({ claimMarker: schema.dispatchJobs.claimMarker })
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId))
      .limit(1);
    expect(rows[0]?.claimMarker).toBe(racerAgentId);
  });

  it('5. credential null when no forge_target_credential row exists', async () => {
    const { lootId } = await seedLootFixture();
    const printerId = await seedPrinter();
    await seedReachableVia(printerId, testAgentId);

    const jobId = await seedClaimableJob(lootId, printerId);
    await seedArtifact(jobId);
    // Intentionally NO setCredential call.

    const POST = await getRoute();
    const res = await POST(makeReq(testApiKey) as any);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.job).not.toBeNull();
    expect(body.job.id).toBe(jobId);
    expect(body.credential).toBeNull();
    expect(body.artifact).not.toBeNull();
  });

  it('6. missing API key → 401', async () => {
    mockAuthenticateCourier.mockImplementation(async () => null);

    const POST = await getRoute();
    const res = await POST(makeReq() as any); // no x-api-key
    expect(res.status).toBe(401);
  });

  it('6b. invalid API key → 401', async () => {
    const { INVALID_API_KEY } = await import('../../src/auth/courier-auth');
    mockAuthenticateCourier.mockImplementation(async () => INVALID_API_KEY);

    const POST = await getRoute();
    const res = await POST(makeReq('bad-key') as any);
    expect(res.status).toBe(401);
  });
});
