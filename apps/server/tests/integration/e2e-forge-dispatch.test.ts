/**
 * End-to-end Forge dispatch tests — V2-005a-T7.
 *
 * Drives the full chain through the HTTP routes:
 *
 *   bootstrap → register printer/slicer → reachable-via → POST dispatch →
 *   runOneClaimTick → handler → completed | failed | (no-op for pending)
 *
 * Distinct from `forge-claim-worker.test.ts` (which exercises the worker
 * mechanics with direct DB writes) and from `api-v1-forge-dispatch.test.ts`
 * (which exercises the HTTP layer in isolation): this file glues the HTTP
 * layer + the worker + the state machine together to verify the
 * V2-005a contract end-to-end.
 *
 * Setup notes (gotchas from V2-003/004 e2e patterns):
 *
 *   1. `bootstrapCentralWorker` is called explicitly in `beforeAll` — the
 *      worker loop is NOT started; we drive it manually with `runOneClaimTick`.
 *      Matches the deterministic pattern from `forge-claim-worker.test.ts`.
 *
 *   2. We `vi.mock('next/server')` so route imports work without a real
 *      Next.js runtime, and `vi.mock('@/auth/request-auth')` so test fixtures
 *      can stub the actor per request.
 *
 *   3. DB cleanup in `beforeEach` respects FK order: dispatch_jobs → ACL
 *      tables → reachable-via → printers/slicers → agents → loot. The agents
 *      table gets re-bootstrapped at the top of each test that needs it
 *      (since `afterEach` wipes it).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import { bootstrapCentralWorker } from '../../src/forge/agent-bootstrap';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

const mockAuthenticate = vi.fn();
vi.mock('../../src/auth/request-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/request-auth')>();
  return {
    ...actual,
    authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  };
});

const DB_PATH = '/tmp/lootgoblin-e2e-forge-dispatch.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}
function uid(): string {
  return crypto.randomUUID();
}
function actor(userId: string, role: 'admin' | 'user' = 'user') {
  return { id: userId, role, source: 'session' as const };
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      await fsp.unlink(`${DB_PATH}${suffix}`);
    } catch {
      /* ignore */
    }
  }
  process.env.DATABASE_URL = DB_URL;
  resetDbCache();
  await runMigrations(DB_URL);
});

beforeEach(async () => {
  // Order matters for FK cascade.
  await db().delete(schema.dispatchJobs);
  await db().delete(schema.printerReachableVia);
  await db().delete(schema.printerAcls);
  await db().delete(schema.slicerAcls);
  await db().delete(schema.printers);
  await db().delete(schema.forgeSlicers);
  await db().delete(schema.agents);
  await db().delete(schema.lootFiles);
  await db().delete(schema.loot);
  await db().delete(schema.collections);
  await db().delete(schema.stashRoots);
  await db().delete(schema.user);
  mockAuthenticate.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers — seeding + HTTP request builders
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'E2E Forge User',
    email: `${id}@e2e-forge.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLootWithFile(
  ownerId: string,
  format: string,
  filePath?: string,
): Promise<{ lootId: string; lootFileId: string }> {
  const rootId = uid();
  await db().insert(schema.stashRoots).values({
    id: rootId,
    ownerId,
    name: 'root',
    path: `/tmp/forge-e2e-${rootId.slice(0, 8)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `c-${collectionId.slice(0, 6)}`,
    pathTemplate: '{title|slug}',
    stashRootId: rootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootId = uid();
  await db().insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: `model ${lootId.slice(0, 6)}`,
    tags: [],
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootFileId = uid();
  await db().insert(schema.lootFiles).values({
    id: lootFileId,
    lootId,
    path: filePath ?? `model.${format}`,
    format,
    size: 1024,
    hash: `sha256-${lootFileId}`,
    origin: 'manual',
    createdAt: new Date(),
  });
  return { lootId, lootFileId };
}

async function seedAuxiliaryAgent(): Promise<string> {
  const id = uid();
  await db().insert(schema.agents).values({
    id,
    kind: 'courier',
    pairCredentialRef: null,
    lastSeenAt: null,
    reachableLanHint: null,
    createdAt: new Date(),
  });
  return id;
}

function jsonReq(
  url: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): import('next/server').NextRequest {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(url, init) as unknown as import('next/server').NextRequest;
}

async function postPrinter(opts: {
  ownerId: string;
  body: { kind: string; name: string; connectionConfig: Record<string, unknown>; reachable_via?: string[] };
}): Promise<{ status: number; body: { printer: { id: string; ownerId: string; kind: string } } }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const { POST } = await import('../../src/app/api/v1/forge/printers/route');
  const res = await POST(jsonReq('http://local/api/v1/forge/printers', 'POST', opts.body));
  return { status: res.status, body: await res.json() };
}

async function postSlicer(opts: {
  ownerId: string;
  body: { kind: string; name: string; invocationMethod: string };
}): Promise<{ status: number; body: { slicer: { id: string; ownerId: string; kind: string } } }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const { POST } = await import('../../src/app/api/v1/forge/slicers/route');
  const res = await POST(jsonReq('http://local/api/v1/forge/slicers', 'POST', opts.body));
  return { status: res.status, body: await res.json() };
}

async function postReachableVia(opts: {
  adminId: string;
  printerId: string;
  agentId: string;
}): Promise<{ status: number; body: unknown }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.adminId, 'admin'));
  const { POST } = await import(
    '../../src/app/api/v1/forge/printers/[id]/reachable-via/route'
  );
  const res = await POST(
    jsonReq(
      `http://local/api/v1/forge/printers/${opts.printerId}/reachable-via`,
      'POST',
      { agentId: opts.agentId },
    ),
    { params: Promise.resolve({ id: opts.printerId }) },
  );
  return { status: res.status, body: await res.json() };
}

async function postDispatch(opts: {
  ownerId: string;
  body: { lootId: string; targetKind: 'printer' | 'slicer'; targetId: string };
}): Promise<{ status: number; body: { jobId?: string; status?: string; job?: { id: string }; error?: string; message?: string } }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const { POST } = await import('../../src/app/api/v1/forge/dispatch/route');
  const res = await POST(jsonReq('http://local/api/v1/forge/dispatch', 'POST', opts.body));
  return { status: res.status, body: await res.json() };
}

async function getDispatchRow(jobId: string) {
  const rows = await db()
    .select()
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.id, jobId));
  return rows[0]!;
}

// ===========================================================================
// Test scenarios
// ===========================================================================

describe('e2e Forge dispatch — V2-005a-T7', () => {
  it('1. full bootstrap → dispatch happy path (slicer-target, native STL → orcaslicer)', async () => {
    const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const ownerId = await seedUser();
    const { lootId } = await seedLootWithFile(ownerId, 'stl');

    // Register OrcaSlicer via HTTP.
    const slicer = await postSlicer({
      ownerId,
      body: { kind: 'orcaslicer', name: 'orca-1', invocationMethod: 'url-scheme' },
    });
    expect(slicer.status).toBe(201);
    const slicerId = slicer.body.slicer.id;

    // POST dispatch — STL is native to OrcaSlicer per matrix → claimable.
    const dispatchRes = await postDispatch({
      ownerId,
      body: { lootId, targetKind: 'slicer', targetId: slicerId },
    });
    expect(dispatchRes.status).toBe(201);
    expect(dispatchRes.body.status).toBe('claimable');
    const jobId = dispatchRes.body.jobId!;

    // Drive the worker via a custom handler that records the input.
    let received: unknown = null;
    const { runOneClaimTick } = await import('../../src/workers/forge-claim-worker');
    const result = await runOneClaimTick({
      agentId: bootstrap.agentId,
      dbUrl: DB_URL,
      dispatchHandler: async (input) => {
        received = input;
        return { ok: true };
      },
    });
    expect(result).toBe('ran');

    // Final state: completed.
    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('completed');
    expect(row.claimMarker).toBe(bootstrap.agentId);
    expect(row.claimedAt).not.toBeNull();
    expect(row.startedAt).not.toBeNull();
    expect(row.completedAt).not.toBeNull();

    // Handler received the right input shape.
    expect(received).toEqual({
      jobId,
      targetKind: 'slicer',
      targetId: slicerId,
      lootId,
      ownerId,
    });
  });

  it('2. full bootstrap → dispatch happy path (printer-target, native gcode → fdm_klipper)', async () => {
    const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const adminId = await seedUser();
    const ownerId = await seedUser();
    const { lootId } = await seedLootWithFile(ownerId, 'gcode');

    // Register a Klipper printer via HTTP. Default reachable_via wires the
    // central worker; we still call POST /reachable-via explicitly below per
    // the test scenario, even though it ends up being an idempotent no-op.
    const printer = await postPrinter({
      ownerId,
      body: {
        kind: 'fdm_klipper',
        name: 'voron',
        connectionConfig: { url: 'http://1.2.3.4:7125', apiKey: 'k' },
      },
    });
    expect(printer.status).toBe(201);
    const printerId = printer.body.printer.id;

    // Admin binds central reachability (idempotent — already wired by default).
    const rv = await postReachableVia({
      adminId,
      printerId,
      agentId: bootstrap.agentId,
    });
    // 200 on idempotent re-add OR 201 if it somehow wasn't pre-wired.
    expect([200, 201]).toContain(rv.status);

    const dispatchRes = await postDispatch({
      ownerId,
      body: { lootId, targetKind: 'printer', targetId: printerId },
    });
    expect(dispatchRes.status).toBe(201);
    // gcode is native to fdm_klipper → claimable straight away.
    expect(dispatchRes.body.status).toBe('claimable');
    const jobId = dispatchRes.body.jobId!;

    const { runOneClaimTick } = await import('../../src/workers/forge-claim-worker');
    const result = await runOneClaimTick({
      agentId: bootstrap.agentId,
      dbUrl: DB_URL,
      dispatchHandler: async () => ({ ok: true }),
    });
    expect(result).toBe('ran');

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('completed');
  });

  it('3. conversion-required dispatch sits in pending (V2-005b not yet implemented)', async () => {
    const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const adminId = await seedUser();
    const ownerId = await seedUser();
    const { lootId } = await seedLootWithFile(ownerId, 'stl');

    const printer = await postPrinter({
      ownerId,
      body: {
        kind: 'fdm_klipper',
        name: 'voron',
        connectionConfig: { url: 'http://1.2.3.4:7125', apiKey: 'k' },
      },
    });
    const printerId = printer.body.printer.id;

    const rv = await postReachableVia({
      adminId,
      printerId,
      agentId: bootstrap.agentId,
    });
    expect([200, 201]).toContain(rv.status);

    const dispatchRes = await postDispatch({
      ownerId,
      body: { lootId, targetKind: 'printer', targetId: printerId },
    });
    expect(dispatchRes.status).toBe(201);
    // STL → fdm_klipper is conversion-required (STL needs slicing to gcode).
    expect(dispatchRes.body.status).toBe('pending');
    const jobId = dispatchRes.body.jobId!;

    // Worker tick should be a no-op — pending isn't claimable.
    const { runOneClaimTick } = await import('../../src/workers/forge-claim-worker');
    const result = await runOneClaimTick({
      agentId: bootstrap.agentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('idle');

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('pending');
    expect(row.claimMarker).toBeNull();
  });

  it('4. unsupported format rejected at create time, no dispatch_jobs row inserted', async () => {
    await bootstrapCentralWorker({ dbUrl: DB_URL });
    const ownerId = await seedUser();
    const { lootId } = await seedLootWithFile(ownerId, 'jpeg', 'cover.jpeg');

    const slicer = await postSlicer({
      ownerId,
      body: { kind: 'orcaslicer', name: 'orca', invocationMethod: 'url-scheme' },
    });
    const slicerId = slicer.body.slicer.id;

    const dispatchRes = await postDispatch({
      ownerId,
      body: { lootId, targetKind: 'slicer', targetId: slicerId },
    });
    expect(dispatchRes.status).toBe(422);
    expect(dispatchRes.body.error).toBe('unsupported-format');

    // No dispatch_jobs row should exist.
    const rows = await db().select().from(schema.dispatchJobs);
    expect(rows).toHaveLength(0);
  });

  it('5. cross-agent reachability — printer NOT reachable by central → claim worker skips', async () => {
    const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const ownerId = await seedUser();
    const { lootId } = await seedLootWithFile(ownerId, 'gcode');

    // Register printer with explicit reachable_via = [courier] (NOT central).
    const courierId = await seedAuxiliaryAgent();
    const printer = await postPrinter({
      ownerId,
      body: {
        kind: 'fdm_klipper',
        name: 'remote-voron',
        connectionConfig: { url: 'http://1.2.3.4:7125', apiKey: 'k' },
        reachable_via: [courierId],
      },
    });
    expect(printer.status).toBe(201);
    const printerId = printer.body.printer.id;

    const dispatchRes = await postDispatch({
      ownerId,
      body: { lootId, targetKind: 'printer', targetId: printerId },
    });
    expect(dispatchRes.status).toBe(201);
    // gcode → fdm_klipper is native, so the route flips initial status to
    // 'claimable' even though central can't reach the printer. The reachability
    // gate is enforced in the WORKER, not the route.
    expect(dispatchRes.body.status).toBe('claimable');
    const jobId = dispatchRes.body.jobId!;

    const { runOneClaimTick } = await import('../../src/workers/forge-claim-worker');
    const result = await runOneClaimTick({
      agentId: bootstrap.agentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('idle');

    // Row stays in 'claimable' — waiting for a courier that doesn't exist yet.
    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('claimable');
    expect(row.claimMarker).toBeNull();
  });

  it('6. stale-recovery on worker startup re-claims and completes the job', async () => {
    const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const ownerId = await seedUser();
    const { lootId } = await seedLootWithFile(ownerId, 'stl');

    const slicer = await postSlicer({
      ownerId,
      body: { kind: 'orcaslicer', name: 'orca', invocationMethod: 'url-scheme' },
    });
    const slicerId = slicer.body.slicer.id;

    const dispatchRes = await postDispatch({
      ownerId,
      body: { lootId, targetKind: 'slicer', targetId: slicerId },
    });
    const jobId = dispatchRes.body.jobId!;

    // Pre-seed: flip the row to 'claimed' with a stale claimed_at (31 min ago).
    const stale = new Date(Date.now() - 31 * 60_000);
    await db()
      .update(schema.dispatchJobs)
      .set({
        status: 'claimed',
        claimMarker: bootstrap.agentId,
        claimedAt: stale,
      })
      .where(eq(schema.dispatchJobs.id, jobId));

    const { resetStaleClaimedJobs, runOneClaimTick } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const reset = await resetStaleClaimedJobs({
      agentId: bootstrap.agentId,
      dbUrl: DB_URL,
    });
    expect(reset).toBe(1);

    // Row was reset to 'claimable'.
    const afterReset = await getDispatchRow(jobId);
    expect(afterReset.status).toBe('claimable');
    expect(afterReset.claimMarker).toBeNull();

    // One tick re-claims and completes via the default stub.
    const result = await runOneClaimTick({
      agentId: bootstrap.agentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('ran');

    const final = await getDispatchRow(jobId);
    expect(final.status).toBe('completed');
  });

  it('7. custom dispatch-handler failure marks job failed with reason + details', async () => {
    const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const ownerId = await seedUser();
    const { lootId } = await seedLootWithFile(ownerId, 'stl');

    const slicer = await postSlicer({
      ownerId,
      body: { kind: 'orcaslicer', name: 'orca', invocationMethod: 'url-scheme' },
    });
    const slicerId = slicer.body.slicer.id;

    const dispatchRes = await postDispatch({
      ownerId,
      body: { lootId, targetKind: 'slicer', targetId: slicerId },
    });
    expect(dispatchRes.status).toBe(201);
    expect(dispatchRes.body.status).toBe('claimable');
    const jobId = dispatchRes.body.jobId!;

    const { runOneClaimTick } = await import('../../src/workers/forge-claim-worker');
    const result = await runOneClaimTick({
      agentId: bootstrap.agentId,
      dbUrl: DB_URL,
      dispatchHandler: async () => ({
        ok: false,
        reason: 'unreachable',
        details: 'simulated network error',
      }),
    });
    // 'ran' — the row reached a terminal state (failed), even though the
    // handler reported ok:false. 'errored' is reserved for handler throws.
    expect(result).toBe('ran');

    const row = await getDispatchRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('unreachable');
    expect(row.failureDetails).toBe('simulated network error');
  });
});
