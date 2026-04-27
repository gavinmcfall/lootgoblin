/**
 * Integration tests — Forge claim worker — V2-005a-T4.
 *
 * Coverage:
 *   runOneClaimTick:
 *     1.  No claimable jobs → 'idle'
 *     2.  Claimable printer-target + central reachable → claimed → dispatched →
 *         completed (default stub handler)
 *     3.  Claimable printer-target where central NOT in reachable_via → 'idle'
 *         (reachability filter holds the row out of the candidate set)
 *     4.  Slicer-target job → always claimed by central (no reachability check)
 *     5.  Custom dispatchHandler returns ok=false → row marked failed with
 *         the handler's reason
 *     6.  Custom dispatchHandler throws → row marked failed reason='unknown'
 *     7.  Two parallel runOneClaimTick on a single job → exactly one returns
 *         'ran', the other 'idle' (atomic-claim race-safety)
 *
 *   resetStaleClaimedJobs:
 *     8.  Job claimed by central, claimed_at = 31 min ago → reset to claimable
 *     9.  Job claimed by central, claimed_at = 5 min ago → unchanged
 *     10. Job claimed by a DIFFERENT agent → unchanged (agent identity guard)
 *
 *   startForgeClaimWorker:
 *     11. Initial recovery + first tick fire; AbortController stops the loop
 *
 *   Custom handler:
 *     12. dispatchHandler receives the right input shape
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterEach,
} from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { bootstrapCentralWorker } from '../../src/forge/agent-bootstrap';
import { createDispatchJob } from '../../src/forge/dispatch-jobs';

const DB_PATH = '/tmp/lootgoblin-forge-claim-worker.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}
function uid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Seeders
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Forge Claim Worker Test User',
    email: `${id}@forge-claim.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string): Promise<string> {
  const id = uid();
  const tmpDir = await fsp.mkdtemp(path.join('/tmp', 'lootgoblin-fcw-'));
  await db().insert(schema.stashRoots).values({
    id,
    ownerId,
    name: 'Claim Worker Test Root',
    path: tmpDir,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(ownerId: string, stashRootId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id,
    ownerId,
    name: `Claim Worker Test Collection ${id.slice(0, 8)}`,
    pathTemplate: '{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(collectionId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.loot).values({
    id,
    collectionId,
    title: `Claim Worker Loot ${id.slice(0, 8)}`,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedPrinter(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.printers).values({
    id,
    ownerId,
    kind: 'fdm_klipper',
    name: `Printer-${id.slice(0, 8)}`,
    connectionConfig: { url: 'http://1.2.3.4:7125', apiKey: 'x' },
    active: true,
    createdAt: new Date(),
  });
  return id;
}

async function seedSlicer(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.forgeSlicers).values({
    id,
    ownerId,
    kind: 'orcaslicer',
    invocationMethod: 'url-scheme',
    name: `Slicer-${id.slice(0, 8)}`,
    createdAt: new Date(),
  });
  return id;
}

async function seedReachableVia(printerId: string, agentId: string): Promise<void> {
  await db().insert(schema.printerReachableVia).values({
    printerId,
    agentId,
  });
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

interface BaseFixture {
  centralAgentId: string;
  ownerId: string;
  lootId: string;
  printerId: string;
  slicerId: string;
}

async function buildBaseFixture(): Promise<BaseFixture> {
  const ownerId = await seedUser();
  const stashRootId = await seedStashRoot(ownerId);
  const collectionId = await seedCollection(ownerId, stashRootId);
  const lootId = await seedLoot(collectionId);
  const printerId = await seedPrinter(ownerId);
  const slicerId = await seedSlicer(ownerId);
  const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
  return {
    centralAgentId: bootstrap.agentId,
    ownerId,
    lootId,
    printerId,
    slicerId,
  };
}

async function newClaimableJob(args: {
  ownerId: string;
  lootId: string;
  targetKind: 'printer' | 'slicer';
  targetId: string;
}): Promise<string> {
  const r = await createDispatchJob(
    {
      ownerId: args.ownerId,
      lootId: args.lootId,
      targetKind: args.targetKind,
      targetId: args.targetId,
      initialStatus: 'claimable',
    },
    { dbUrl: DB_URL },
  );
  if (!r.ok) throw new Error(`fixture: ${r.reason}: ${r.details ?? ''}`);
  return r.jobId;
}

// ---------------------------------------------------------------------------
// beforeAll / afterEach
// ---------------------------------------------------------------------------

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
}, 30_000);

afterEach(async () => {
  // Order matters for FK cascade.
  await db().delete(schema.dispatchJobs);
  await db().delete(schema.printerReachableVia);
  await db().delete(schema.printers);
  await db().delete(schema.forgeSlicers);
  await db().delete(schema.agents);
  await db().delete(schema.loot);
  await db().delete(schema.collections);
  await db().delete(schema.stashRoots);
  await db().delete(schema.user);
});

// ===========================================================================
// runOneClaimTick
// ===========================================================================

describe('runOneClaimTick — V2-005a-T4', () => {
  it('1. no claimable jobs → idle', async () => {
    const fx = await buildBaseFixture();
    const { runOneClaimTick } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const result = await runOneClaimTick({
      agentId: fx.centralAgentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('idle');
  });

  it('2. printer-target reachable by central → claimed → dispatched → completed', async () => {
    const fx = await buildBaseFixture();
    await seedReachableVia(fx.printerId, fx.centralAgentId);
    const jobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: fx.printerId,
    });

    const { runOneClaimTick } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const result = await runOneClaimTick({
      agentId: fx.centralAgentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('ran');

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('completed');
    expect(rows[0]!.claimMarker).toBe(fx.centralAgentId);
    expect(rows[0]!.claimedAt).not.toBeNull();
    expect(rows[0]!.startedAt).not.toBeNull();
    expect(rows[0]!.completedAt).not.toBeNull();
  });

  it('3. printer-target not in reachable_via → idle (filtered out)', async () => {
    const fx = await buildBaseFixture();
    // Auxiliary courier agent is the ONLY one in reachable_via; central is NOT.
    const courierId = await seedAuxiliaryAgent();
    await seedReachableVia(fx.printerId, courierId);
    const jobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: fx.printerId,
    });

    const { runOneClaimTick } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const result = await runOneClaimTick({
      agentId: fx.centralAgentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('idle');

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows[0]!.status).toBe('claimable');
    expect(rows[0]!.claimMarker).toBeNull();
  });

  it('4. slicer-target → always claimed by central (no reachability check)', async () => {
    const fx = await buildBaseFixture();
    // Note: NO printer_reachable_via row — slicer-target doesn't need it.
    const jobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'slicer',
      targetId: fx.slicerId,
    });

    const { runOneClaimTick } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const result = await runOneClaimTick({
      agentId: fx.centralAgentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('ran');

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows[0]!.status).toBe('completed');
  });

  it('5. handler returns ok=false → row marked failed with handler reason', async () => {
    const fx = await buildBaseFixture();
    await seedReachableVia(fx.printerId, fx.centralAgentId);
    const jobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: fx.printerId,
    });

    const { runOneClaimTick } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const result = await runOneClaimTick({
      agentId: fx.centralAgentId,
      dbUrl: DB_URL,
      dispatchHandler: async () => ({
        ok: false,
        reason: 'unreachable',
        details: 'simulated network failure',
      }),
    });
    expect(result).toBe('ran');

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.failureReason).toBe('unreachable');
    expect(rows[0]!.failureDetails).toBe('simulated network failure');
  });

  it('6. handler throws → row marked failed reason=unknown', async () => {
    const fx = await buildBaseFixture();
    await seedReachableVia(fx.printerId, fx.centralAgentId);
    const jobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: fx.printerId,
    });

    const { runOneClaimTick } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const result = await runOneClaimTick({
      agentId: fx.centralAgentId,
      dbUrl: DB_URL,
      dispatchHandler: async () => {
        throw new Error('handler boom');
      },
    });
    expect(result).toBe('errored');

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.failureReason).toBe('unknown');
    expect(rows[0]!.failureDetails).toContain('handler boom');
  });

  it('7. parallel ticks on one claimable job → exactly one ran, the other idle', async () => {
    const fx = await buildBaseFixture();
    await seedReachableVia(fx.printerId, fx.centralAgentId);
    const jobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: fx.printerId,
    });

    const { runOneClaimTick } = await import(
      '../../src/workers/forge-claim-worker'
    );
    // Slow handler to widen the race window. The first tick that wins markClaimed
    // takes the row through to completed; the loser sees status='claimed' or
    // 'completed' on its candidate fetch and returns 'idle'.
    const handler = async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true } as const;
    };
    const [a, b] = await Promise.all([
      runOneClaimTick({
        agentId: fx.centralAgentId,
        dbUrl: DB_URL,
        dispatchHandler: handler,
      }),
      runOneClaimTick({
        agentId: fx.centralAgentId,
        dbUrl: DB_URL,
        dispatchHandler: handler,
      }),
    ]);
    const outcomes = [a, b].sort();
    expect(outcomes).toEqual(['idle', 'ran']);

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows[0]!.status).toBe('completed');
  });
});

// ===========================================================================
// resetStaleClaimedJobs
// ===========================================================================

describe('resetStaleClaimedJobs — V2-005a-T4', () => {
  it('8. claimed by central 31min ago → reset to claimable', async () => {
    const fx = await buildBaseFixture();
    const jobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'slicer',
      targetId: fx.slicerId,
    });
    // Manually flip the row to claimed with a stale claimed_at.
    const stale = new Date(Date.now() - 31 * 60_000);
    await db()
      .update(schema.dispatchJobs)
      .set({
        status: 'claimed',
        claimMarker: fx.centralAgentId,
        claimedAt: stale,
      })
      .where(eq(schema.dispatchJobs.id, jobId));

    const { resetStaleClaimedJobs } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const reset = await resetStaleClaimedJobs({
      agentId: fx.centralAgentId,
      dbUrl: DB_URL,
    });
    expect(reset).toBe(1);

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows[0]!.status).toBe('claimable');
    expect(rows[0]!.claimMarker).toBeNull();
    expect(rows[0]!.claimedAt).toBeNull();
  });

  it('9. claimed by central 5min ago → unchanged (within timeout)', async () => {
    const fx = await buildBaseFixture();
    const jobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'slicer',
      targetId: fx.slicerId,
    });
    const recent = new Date(Date.now() - 5 * 60_000);
    await db()
      .update(schema.dispatchJobs)
      .set({
        status: 'claimed',
        claimMarker: fx.centralAgentId,
        claimedAt: recent,
      })
      .where(eq(schema.dispatchJobs.id, jobId));

    const { resetStaleClaimedJobs } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const reset = await resetStaleClaimedJobs({
      agentId: fx.centralAgentId,
      dbUrl: DB_URL,
    });
    expect(reset).toBe(0);

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows[0]!.status).toBe('claimed');
    expect(rows[0]!.claimMarker).toBe(fx.centralAgentId);
  });

  it('10. claimed by a different agent → unchanged (agent identity guard)', async () => {
    const fx = await buildBaseFixture();
    const courierId = await seedAuxiliaryAgent();
    const jobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'slicer',
      targetId: fx.slicerId,
    });
    const stale = new Date(Date.now() - 31 * 60_000);
    await db()
      .update(schema.dispatchJobs)
      .set({
        status: 'claimed',
        claimMarker: courierId, // <-- NOT central
        claimedAt: stale,
      })
      .where(eq(schema.dispatchJobs.id, jobId));

    const { resetStaleClaimedJobs } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const reset = await resetStaleClaimedJobs({
      agentId: fx.centralAgentId,
      dbUrl: DB_URL,
    });
    expect(reset).toBe(0);

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows[0]!.status).toBe('claimed');
    expect(rows[0]!.claimMarker).toBe(courierId);
  });
});

// ===========================================================================
// Worker loop
// ===========================================================================

describe('startForgeClaimWorker — V2-005a-T4', () => {
  it('11. start runs initial recovery + first tick; abort terminates the loop', async () => {
    const fx = await buildBaseFixture();
    await seedReachableVia(fx.printerId, fx.centralAgentId);

    // Pre-seed: stale claimed row for recovery + claimable row for first tick.
    const staleJobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'slicer',
      targetId: fx.slicerId,
    });
    await db()
      .update(schema.dispatchJobs)
      .set({
        status: 'claimed',
        claimMarker: fx.centralAgentId,
        claimedAt: new Date(Date.now() - 31 * 60_000),
      })
      .where(eq(schema.dispatchJobs.id, staleJobId));

    const dueJobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: fx.printerId,
    });

    const { startForgeClaimWorker, stopForgeClaimWorker } = await import(
      '../../src/workers/forge-claim-worker'
    );

    const abort = new AbortController();
    const startPromise = startForgeClaimWorker({
      signal: abort.signal,
      concurrency: 1,
      dbUrl: DB_URL,
    });

    // Wait long enough for recovery + at least 2 ticks (each tick handles
    // one job; POLL_BASE_MS is 1.5s). 2 jobs × ~1.6s/tick + buffer ≈ 3.5s.
    await new Promise((r) => setTimeout(r, 3_500));
    abort.abort();
    stopForgeClaimWorker();

    await Promise.race([
      startPromise,
      new Promise((r) => setTimeout(r, 2_000)),
    ]);

    // Recovery: stale row was reset to claimable on startup, then the live
    // claim loop picked it up (since it's slicer-target and central-reachable
    // by definition) and drove it to 'completed'.
    const stale = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, staleJobId));
    expect(stale[0]!.status).toBe('completed');

    // Due printer-target row should also be completed by the loop.
    const due = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, dueJobId));
    expect(due[0]!.status).toBe('completed');
  });
});

// ===========================================================================
// Custom dispatchHandler input shape
// ===========================================================================

describe('dispatchHandler input shape — V2-005a-T4', () => {
  it('12. handler receives jobId/targetKind/targetId/lootId/ownerId', async () => {
    const fx = await buildBaseFixture();
    await seedReachableVia(fx.printerId, fx.centralAgentId);
    const jobId = await newClaimableJob({
      ownerId: fx.ownerId,
      lootId: fx.lootId,
      targetKind: 'printer',
      targetId: fx.printerId,
    });

    const seen: Array<Record<string, unknown>> = [];
    const { runOneClaimTick } = await import(
      '../../src/workers/forge-claim-worker'
    );
    const result = await runOneClaimTick({
      agentId: fx.centralAgentId,
      dbUrl: DB_URL,
      dispatchHandler: async (input) => {
        seen.push({ ...input });
        return { ok: true };
      },
    });
    expect(result).toBe('ran');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      jobId,
      targetKind: 'printer',
      targetId: fx.printerId,
      lootId: fx.lootId,
      ownerId: fx.ownerId,
    });
  });
});
