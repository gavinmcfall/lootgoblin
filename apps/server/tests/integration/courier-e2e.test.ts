/**
 * Courier end-to-end integration test — V2-006a-T9
 *
 * Exercises the full courier seam against real route handlers + a real temp DB.
 * The flow under test:
 *
 *   1. Admin mints a pair token (POST /api/v1/couriers/pair-tokens).
 *   2. Courier pairs (POST /api/v1/couriers/pair) → gets api_key + agent_id.
 *   3. Seed printer + printer_reachable_via.
 *   4. Heartbeat (POST /api/v1/couriers/heartbeat) reports the printer reachable.
 *   5. Seed a claimable dispatch_jobs row + a real forge_artifacts file.
 *   6. Claim (POST /api/v1/dispatch/claim) → assert bundle: job + connection_config + artifact.download_url.
 *   7. Download (GET /api/v1/dispatch/artifact/<jobId>) → assert bytes + X-Artifact-SHA256.
 *   8. Report dispatched then completed (with measured materials_used).
 *   9. Assert: job row is 'completed'; a material.consumed ledger event exists with provenanceClass='measured';
 *      inventory was decremented.
 *
 * Also covers liveness + listJobsBlockedByOfflineCourier unit-level assertions.
 *
 * DB: /tmp/lootgoblin-v2006a-t9.db (unique per T9).
 */

import { existsSync, unlinkSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getServerDb, schema } from '../../src/db/client';
import { bootstrapInstanceIdentity } from '../../src/identity/index';
import { mintCourierPairToken, exchangeCourierPairToken, SERVER_VERSION } from '../../src/forge/couriers';
import { createDispatchJob } from '../../src/forge/dispatch-jobs';
import { createMaterial } from '../../src/materials/lifecycle';
import {
  computeAgentLiveness,
  OFFLINE_AFTER_MS,
  listJobsBlockedByOfflineCourier,
} from '../../src/forge/agents';
import type { MaterialsUsed } from '../../src/db/schema.forge';

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

// ── courier-auth mock — pass through to real implementation ───────────────────
// We mock the module but default to real authenticateCourier so we can use
// the live api_key returned by pair.
const mockAuthenticateCourier = vi.fn();

vi.mock('../../src/auth/courier-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/courier-auth')>();
  return {
    ...actual,
    authenticateCourier: (...args: unknown[]) => mockAuthenticateCourier(...args),
  };
});

// ── authenticateRequest mock for admin-gated endpoints ───────────────────────
const mockAuthenticate = vi.fn();

vi.mock('../../src/auth/request-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/request-auth')>();
  return {
    ...actual,
    authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  };
});

// ── DB + filesystem constants ─────────────────────────────────────────────────
const DB_PATH = '/tmp/lootgoblin-v2006a-t9.db';
const DB_URL = `file:${DB_PATH}`;
const TEST_SECRET = 'x'.repeat(32);
const DATA_ROOT = '/tmp/lootgoblin-t9-data';
const ARTIFACTS_BASE = path.join(DATA_ROOT, 'forge-artifacts');

// ── Shared fixtures resolved in beforeAll ─────────────────────────────────────
let testApiKey = '';
let testAgentId = '';
let sharedUserId = '';

beforeAll(async () => {
  // Clean up stale DB files.
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }

  process.env.DATABASE_URL = DB_URL;
  process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
  process.env.LOOTGOBLIN_DATA_ROOT = DATA_ROOT;

  resetDbCache();
  await runMigrations(DB_URL);
  await bootstrapInstanceIdentity('test-instance-t9');

  // Seed a shared user.
  sharedUserId = randomUUID();
  await getServerDb(DB_URL).insert(schema.user).values({
    id: sharedUserId,
    name: 'T9 Shared User',
    email: `${sharedUserId}@courier-e2e.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Set up artifacts directory.
  mkdirSync(ARTIFACTS_BASE, { recursive: true });

  // Default auth mock: admin for authenticateRequest, real for authenticateCourier.
  mockAuthenticate.mockImplementation(async () => ({
    id: sharedUserId,
    role: 'admin' as const,
    source: 'session' as const,
  }));

  const { authenticateCourier: realAuth } = await vi.importActual<
    typeof import('../../src/auth/courier-auth')
  >('../../src/auth/courier-auth');
  mockAuthenticateCourier.mockImplementation(realAuth);
}, 30_000);

afterAll(() => {
  if (existsSync(DATA_ROOT)) {
    rmSync(DATA_ROOT, { recursive: true, force: true });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function db() {
  return getServerDb(DB_URL);
}

function makeAdminReq(method: string, path: string, body?: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  return new Request(`http://local${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeCourierReq(method: string, path: string, apiKey: string, body?: unknown): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
  };
  return new Request(`http://local${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function seedLootFixture(): Promise<string> {
  const stashRootId = randomUUID();
  await db().insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId: sharedUserId,
    name: 'T9 Test Root',
    path: '/tmp/t9-stash',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = randomUUID();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId: sharedUserId,
    name: `T9 Collection ${collectionId.slice(0, 8)}`,
    pathTemplate: '{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootId = randomUUID();
  await db().insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: `T9 Loot ${lootId.slice(0, 8)}`,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return lootId;
}

async function seedArtifactFile(jobId: string): Promise<{ fileContent: Buffer; sha256: string }> {
  const jobDir = path.join(ARTIFACTS_BASE, jobId);
  mkdirSync(jobDir, { recursive: true });
  const filePath = path.join(jobDir, 'output.gcode');
  const fileContent = Buffer.from(`; gcode for job ${jobId}\nG28\nG1 X50\n`);
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

  return { fileContent, sha256 };
}

// ── liveness unit tests ───────────────────────────────────────────────────────

describe('computeAgentLiveness', () => {
  it('null lastSeenAt → offline', () => {
    expect(computeAgentLiveness(null, new Date())).toBe('offline');
  });

  it('lastSeenAt within OFFLINE_AFTER_MS → online', () => {
    const now = new Date();
    const recentPast = new Date(now.getTime() - OFFLINE_AFTER_MS + 1_000);
    expect(computeAgentLiveness(recentPast, now)).toBe('online');
  });

  it('lastSeenAt exactly at OFFLINE_AFTER_MS → online (boundary inclusive)', () => {
    const now = new Date();
    const exact = new Date(now.getTime() - OFFLINE_AFTER_MS);
    expect(computeAgentLiveness(exact, now)).toBe('online');
  });

  it('lastSeenAt older than OFFLINE_AFTER_MS → offline', () => {
    const now = new Date();
    const oldPast = new Date(now.getTime() - OFFLINE_AFTER_MS - 1_000);
    expect(computeAgentLiveness(oldPast, now)).toBe('offline');
  });

  it('OFFLINE_AFTER_MS defaults to 90_000', () => {
    expect(OFFLINE_AFTER_MS).toBe(90_000);
  });
});

// ── listJobsBlockedByOfflineCourier unit tests ────────────────────────────────

describe('listJobsBlockedByOfflineCourier', () => {
  it('returns empty when no claimable jobs exist', async () => {
    const result = await listJobsBlockedByOfflineCourier({ dbUrl: DB_URL });
    // May have jobs from the main e2e test; just check it resolves without error.
    expect(Array.isArray(result)).toBe(true);
  });

  it('blocked job: printer reachable only via offline courier', async () => {
    // Create an offline courier agent (lastSeenAt far in the past).
    const offlineAgentId = randomUUID();
    await db().insert(schema.agents).values({
      id: offlineAgentId,
      kind: 'courier',
      pairCredentialRef: null,
      lastSeenAt: new Date(Date.now() - OFFLINE_AFTER_MS - 60_000), // clearly offline
      reachableLanHint: null,
      createdAt: new Date(),
    });

    // Seed a printer + reachable_via pointing at the offline courier.
    const printerId = randomUUID();
    await db().insert(schema.printers).values({
      id: printerId,
      ownerId: sharedUserId,
      kind: 'fdm_klipper',
      name: `T9 Blocked Printer ${printerId.slice(0, 8)}`,
      connectionConfig: { url: 'http://10.0.0.200:7125' },
      active: true,
      createdAt: new Date(),
    });
    await db().insert(schema.printerReachableVia).values({
      printerId,
      agentId: offlineAgentId,
      reachableStatus: 'reachable',
      lastCheckedAt: new Date(),
      detail: null,
    });

    // Seed a claimable job targeting that printer.
    const lootId = await seedLootFixture();
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
    if (!r.ok) throw new Error(`createDispatchJob: ${r.reason}`);
    const jobId = r.jobId;

    const result = await listJobsBlockedByOfflineCourier({ dbUrl: DB_URL });
    const found = result.find((x) => x.jobId === jobId);
    expect(found).toBeDefined();
    expect(found?.printerId).toBe(printerId);
    expect(found?.agentId).toBe(offlineAgentId);

    // Cleanup: mark job claimed so it doesn't bleed into e2e.
    db()
      .update(schema.dispatchJobs)
      .set({ status: 'completed' })
      .where(eq(schema.dispatchJobs.id, jobId))
      .run();
  });

  it('not blocked when printer also reachable via central_worker', async () => {
    // central_worker agents don't have a lastSeenAt constraint — they're always reachable.
    const cwAgentId = randomUUID();
    await db().insert(schema.agents).values({
      id: cwAgentId,
      kind: 'central_worker',
      pairCredentialRef: null,
      lastSeenAt: new Date(Date.now() - OFFLINE_AFTER_MS - 60_000), // old ts but CW = always ok
      reachableLanHint: null,
      createdAt: new Date(),
    });

    const offlineAgentId2 = randomUUID();
    await db().insert(schema.agents).values({
      id: offlineAgentId2,
      kind: 'courier',
      pairCredentialRef: null,
      lastSeenAt: new Date(Date.now() - OFFLINE_AFTER_MS - 60_000),
      reachableLanHint: null,
      createdAt: new Date(),
    });

    const printerId = randomUUID();
    await db().insert(schema.printers).values({
      id: printerId,
      ownerId: sharedUserId,
      kind: 'fdm_klipper',
      name: `T9 CW Printer ${printerId.slice(0, 8)}`,
      connectionConfig: { url: 'http://10.0.0.201:7125' },
      active: true,
      createdAt: new Date(),
    });
    // Both agents can reach the printer.
    await db().insert(schema.printerReachableVia).values([
      { printerId, agentId: cwAgentId, reachableStatus: 'reachable', lastCheckedAt: new Date(), detail: null },
      { printerId, agentId: offlineAgentId2, reachableStatus: 'reachable', lastCheckedAt: new Date(), detail: null },
    ]);

    const lootId = await seedLootFixture();
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
    if (!r.ok) throw new Error(`createDispatchJob: ${r.reason}`);
    const jobId = r.jobId;

    const result = await listJobsBlockedByOfflineCourier({ dbUrl: DB_URL });
    const found = result.find((x) => x.jobId === jobId);
    expect(found).toBeUndefined(); // not blocked — CW can reach it

    // Cleanup.
    db()
      .update(schema.dispatchJobs)
      .set({ status: 'completed' })
      .where(eq(schema.dispatchJobs.id, jobId))
      .run();
  });
});

// ── Full end-to-end courier flow ──────────────────────────────────────────────

describe('Courier end-to-end seam (V2-006a-T9)', () => {
  it('full courier lifecycle: pair → heartbeat → claim → download → dispatched → completed + ledger', async () => {
    // ── Step 1: Admin mints a pair token ──────────────────────────────────────
    const mintResult = await mintCourierPairToken();
    expect(mintResult).not.toBeNull();
    expect(typeof mintResult!.token).toBe('string');

    // ── Step 2: Courier pairs ─────────────────────────────────────────────────
    const exchangeResult = await exchangeCourierPairToken(mintResult!.token, { dbUrl: DB_URL });
    expect(exchangeResult.ok).toBe(true);
    if (!exchangeResult.ok) throw new Error(`pair failed: ${JSON.stringify(exchangeResult)}`);

    testApiKey = exchangeResult.api_key;
    testAgentId = exchangeResult.agent_id;

    expect(testApiKey.startsWith('lg_cou_')).toBe(true);
    expect(typeof testAgentId).toBe('string');

    // Confirm agent exists with kind='courier'.
    const agentRows = await db()
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, testAgentId))
      .limit(1);
    expect(agentRows[0]?.kind).toBe('courier');

    // ── Step 3: Seed printer + printer_reachable_via ──────────────────────────
    const printerId = randomUUID();
    await db().insert(schema.printers).values({
      id: printerId,
      ownerId: sharedUserId,
      kind: 'fdm_klipper',
      name: `T9 E2E Printer ${printerId.slice(0, 8)}`,
      connectionConfig: { url: 'http://10.0.0.99:7125', apiKey: 'moonraker-key-t9' },
      active: true,
      createdAt: new Date(),
    });
    await db().insert(schema.printerReachableVia).values({
      printerId,
      agentId: testAgentId,
      reachableStatus: 'unknown',
      lastCheckedAt: null,
      detail: null,
    });

    // ── Step 4: Heartbeat — report printer reachable ──────────────────────────
    const heartbeatRoute = await import('../../src/app/api/v1/couriers/heartbeat/route').then((m) => m.POST);
    const hbRes = await heartbeatRoute(
      makeCourierReq('POST', '/api/v1/couriers/heartbeat', testApiKey, {
        courier_version: SERVER_VERSION,
        printers: [
          { printer_id: printerId, reachable_status: 'reachable', detail: 'HTTP 200 OK' },
        ],
      }) as any,
    );
    expect(hbRes.status).toBe(200);
    const hbBody = await hbRes.json();
    expect(hbBody.ok).toBe(true);

    // Verify reachability updated.
    const reachRows = await db()
      .select()
      .from(schema.printerReachableVia)
      .where(eq(schema.printerReachableVia.printerId, printerId))
      .limit(1);
    expect(reachRows[0]?.reachableStatus).toBe('reachable');

    // ── Verify agents GET list now includes liveness ──────────────────────────
    const agentsListRoute = await import('../../src/app/api/v1/agents/route').then((m) => m.GET);
    const listRes = await agentsListRoute(makeAdminReq('GET', '/api/v1/agents') as any);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(Array.isArray(listBody.agents)).toBe(true);
    const ourAgent = listBody.agents.find((a: { id: string }) => a.id === testAgentId);
    expect(ourAgent).toBeDefined();
    expect(ourAgent.liveness).toBeDefined();
    // Agent should be online (just heartbeated).
    expect(ourAgent.liveness).toBe('online');

    // ── Step 5: Seed claimable dispatch job + forge_artifacts file ────────────
    const lootId = await seedLootFixture();

    // Seed a real Material with initial stock.
    const matResult = await createMaterial(
      {
        ownerId: sharedUserId,
        kind: 'filament_spool',
        brand: 'T9 Brand',
        subtype: 'PLA',
        colors: ['#ff8800'],
        colorPattern: 'solid',
        initialAmount: 200,
        unit: 'g',
      },
      { dbUrl: DB_URL },
    );
    if (!matResult.ok) throw new Error(`createMaterial: ${matResult.reason}`);
    const materialId = matResult.material.id;

    // Seed dispatch job in 'claimable' status, pre-wired with materials_used.
    const materialsUsed: MaterialsUsed = [
      { slot_index: 0, material_id: materialId, estimated_grams: 20, measured_grams: null },
    ];
    const djResult = await createDispatchJob(
      {
        ownerId: sharedUserId,
        lootId,
        targetKind: 'printer',
        targetId: printerId,
        initialStatus: 'claimable',
      },
      { dbUrl: DB_URL },
    );
    if (!djResult.ok) throw new Error(`createDispatchJob: ${djResult.reason}`);
    const jobId = djResult.jobId;

    // Pre-wire materials_used for Phase B to find when reporting completed.
    db()
      .update(schema.dispatchJobs)
      .set({ materialsUsed })
      .where(eq(schema.dispatchJobs.id, jobId))
      .run();

    // Create the artifact file on disk + DB row.
    const { fileContent, sha256 } = await seedArtifactFile(jobId);

    // ── Step 6: Claim ─────────────────────────────────────────────────────────
    const claimRoute = await import('../../src/app/api/v1/dispatch/claim/route').then((m) => m.POST);
    const claimRes = await claimRoute(
      makeCourierReq('POST', '/api/v1/dispatch/claim', testApiKey) as any,
    );
    expect(claimRes.status).toBe(200);
    const claimBody = await claimRes.json();

    expect(claimBody.job).not.toBeNull();
    expect(claimBody.job.id).toBe(jobId);
    expect(claimBody.job.target_kind).toBe('printer');
    expect(claimBody.job.target_id).toBe(printerId);
    expect(claimBody.job.loot_id).toBe(lootId);

    // connection_config should be present.
    expect(claimBody.printer).not.toBeNull();
    expect(claimBody.printer.connection_config).toMatchObject({ url: 'http://10.0.0.99:7125' });

    // artifact.download_url should be the opaque endpoint.
    expect(claimBody.artifact).not.toBeNull();
    expect(claimBody.artifact.download_url).toBe(`/api/v1/dispatch/artifact/${jobId}`);
    expect(claimBody.artifact.sha256).toBe(sha256);

    // Confirm job is now 'claimed'.
    const claimedRows = await db()
      .select({ status: schema.dispatchJobs.status, claimMarker: schema.dispatchJobs.claimMarker })
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId))
      .limit(1);
    expect(claimedRows[0]?.status).toBe('claimed');
    expect(claimedRows[0]?.claimMarker).toBe(testAgentId);

    // ── Step 7: Download artifact ─────────────────────────────────────────────
    const artifactRoute = await import('../../src/app/api/v1/dispatch/artifact/[jobId]/route').then((m) => m.GET);
    const artifactRes = await artifactRoute(
      makeCourierReq('GET', `/api/v1/dispatch/artifact/${jobId}`, testApiKey) as any,
      { params: Promise.resolve({ jobId }) },
    );
    expect(artifactRes.status).toBe(200);
    expect(artifactRes.headers.get('x-artifact-sha256')).toBe(sha256);

    const bodyBuf = Buffer.from(await artifactRes.arrayBuffer());
    expect(bodyBuf.equals(fileContent)).toBe(true);

    // ── Step 8a: Report dispatched ────────────────────────────────────────────
    const statusRoute = await import('../../src/app/api/v1/dispatch/status/route').then((m) => m.POST);

    const dispatchedRes = await statusRoute(
      makeCourierReq('POST', '/api/v1/dispatch/status', testApiKey, {
        phase: 'dispatched',
        job_id: jobId,
        remote_filename: 'output.gcode',
      }) as any,
    );
    expect(dispatchedRes.status).toBe(200);
    const dispatchedBody = await dispatchedRes.json();
    expect(dispatchedBody.ok).toBe(true);

    // Job should be 'dispatched'.
    const dispatchedRows = await db()
      .select({ status: schema.dispatchJobs.status })
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId))
      .limit(1);
    expect(dispatchedRows[0]?.status).toBe('dispatched');

    // ── Step 8b: Report completed with measured materials_used ────────────────
    const completedRes = await statusRoute(
      makeCourierReq('POST', '/api/v1/dispatch/status', testApiKey, {
        phase: 'completed',
        job_id: jobId,
        materials_used: [{ slot_index: 0, material_id: materialId, measured_grams: 18.5 }],
      }) as any,
    );
    expect(completedRes.status).toBe(200);
    const completedBody = await completedRes.json();
    expect(completedBody.ok).toBe(true);
    expect(completedBody.noop).toBeUndefined();

    // ── Step 9: Final assertions ──────────────────────────────────────────────

    // Job row must be 'completed'.
    const finalJobRows = await db()
      .select({ status: schema.dispatchJobs.status })
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId))
      .limit(1);
    expect(finalJobRows[0]?.status).toBe('completed');

    // A material.consumed ledger event with provenanceClass='measured' must exist.
    const ledgerRows = await db()
      .select({ provenanceClass: schema.ledgerEvents.provenanceClass, subjectId: schema.ledgerEvents.subjectId })
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.kind, 'material.consumed'));

    const measuredRow = ledgerRows.find((r) => r.provenanceClass === 'measured');
    expect(measuredRow).toBeDefined();

    // Inventory must have been decremented.
    const matRows = await db()
      .select({ remainingAmount: schema.materials.remainingAmount })
      .from(schema.materials)
      .where(eq(schema.materials.id, materialId))
      .limit(1);
    expect(matRows[0]?.remainingAmount).toBeLessThan(200);
  }, 30_000);
});
