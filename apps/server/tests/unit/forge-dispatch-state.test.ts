/**
 * Unit tests for the DispatchJob state machine — V2-005a-T3.
 *
 * Real-DB-on-tmpfile pattern (matches forge-agents.test.ts).
 *
 * Covers:
 *   - createDispatchJob happy paths + validation
 *   - Each per-transition function: legal source → success
 *   - Each per-transition function: illegal source → reject
 *   - markCompleted from non-`dispatched` → reject
 *   - markFailed from each non-terminal → success
 *   - markFailed from a terminal state → reject
 *   - unclaimStaleJob: stale → unclaimed; recent → no-op; wrong agent → no-op
 *   - Concurrent claim race: two parallel claims → exactly one wins
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  createDispatchJob,
  getDispatchJob,
  listDispatchJobs,
} from '../../src/forge/dispatch-jobs';
import {
  markConverting,
  markSlicing,
  markClaimable,
  markClaimed,
  markDispatched,
  markCompleted,
  markFailed,
  unclaimStaleJob,
  isLegalTransition,
  LEGAL_TRANSITIONS,
  TERMINAL_STATES,
} from '../../src/forge/dispatch-state';
import { bootstrapCentralWorker } from '../../src/forge/agent-bootstrap';
import { createAgent } from '../../src/forge/agents';
import type { DispatchJobStatus } from '../../src/db/schema.forge';

const DB_PATH = '/tmp/lootgoblin-forge-dispatch-state-unit.db';
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
    name: 'Forge Dispatch Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string): Promise<string> {
  const id = uid();
  const tmpDir = await fsp.mkdtemp(path.join('/tmp', 'lootgoblin-fd-'));
  await db().insert(schema.stashRoots).values({
    id,
    ownerId,
    name: 'Dispatch Test Root',
    path: tmpDir,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(
  ownerId: string,
  stashRootId: string,
): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id,
    ownerId,
    name: `Dispatch Test Collection ${id.slice(0, 8)}`,
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
    title: `Dispatch Test Loot ${id.slice(0, 8)}`,
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

/**
 * Seed a fully-resolvable owner+loot+printer fixture and return a job-creator
 * that returns a fresh job in the requested status (default 'pending').
 * Useful for transition tests that just need a "job in state X".
 */
async function buildDispatchFixture(): Promise<{
  ownerId: string;
  lootId: string;
  printerId: string;
  slicerId: string;
  newJob: (initialStatus?: DispatchJobStatus) => Promise<string>;
}> {
  const ownerId = await seedUser();
  const stashRootId = await seedStashRoot(ownerId);
  const collectionId = await seedCollection(ownerId, stashRootId);
  const lootId = await seedLoot(collectionId);
  const printerId = await seedPrinter(ownerId);
  const slicerId = await seedSlicer(ownerId);
  return {
    ownerId,
    lootId,
    printerId,
    slicerId,
    async newJob(initialStatus = 'pending') {
      const r = await createDispatchJob(
        {
          ownerId,
          lootId,
          targetKind: 'printer',
          targetId: printerId,
          initialStatus,
        },
        { dbUrl: DB_URL },
      );
      if (!r.ok) throw new Error(`fixture: ${r.reason}: ${r.details ?? ''}`);
      return r.jobId;
    },
  };
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
  // Order matters for FK cascade. dispatch_jobs first; loot/printers/etc.
  // reference back into the fixture chain.
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
// State graph constant
// ===========================================================================

describe('LEGAL_TRANSITIONS / isLegalTransition', () => {
  it('lists exactly 8 source states + 2 terminals', () => {
    expect(LEGAL_TRANSITIONS.size).toBe(8);
    expect(LEGAL_TRANSITIONS.get('completed')!.size).toBe(0);
    expect(LEGAL_TRANSITIONS.get('failed')!.size).toBe(0);
    expect(TERMINAL_STATES.has('completed')).toBe(true);
    expect(TERMINAL_STATES.has('failed')).toBe(true);
  });

  it('isLegalTransition matches plan §"State machine"', () => {
    expect(isLegalTransition('pending', 'converting')).toBe(true);
    expect(isLegalTransition('pending', 'slicing')).toBe(true);
    expect(isLegalTransition('pending', 'claimable')).toBe(true);
    expect(isLegalTransition('pending', 'failed')).toBe(true);
    expect(isLegalTransition('pending', 'claimed')).toBe(false);

    expect(isLegalTransition('claimed', 'dispatched')).toBe(true);
    expect(isLegalTransition('claimed', 'claimable')).toBe(true);
    expect(isLegalTransition('claimed', 'failed')).toBe(true);
    expect(isLegalTransition('claimed', 'completed')).toBe(false);

    expect(isLegalTransition('dispatched', 'completed')).toBe(true);
    expect(isLegalTransition('dispatched', 'failed')).toBe(true);

    // Terminals: nothing escapes.
    expect(isLegalTransition('completed', 'failed')).toBe(false);
    expect(isLegalTransition('failed', 'completed')).toBe(false);
  });
});

// ===========================================================================
// createDispatchJob
// ===========================================================================

describe('createDispatchJob', () => {
  it('happy path — printer target', async () => {
    const fx = await buildDispatchFixture();
    const r = await createDispatchJob(
      {
        ownerId: fx.ownerId,
        lootId: fx.lootId,
        targetKind: 'printer',
        targetId: fx.printerId,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await getDispatchJob({ id: r.jobId }, { dbUrl: DB_URL });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
    expect(row!.targetKind).toBe('printer');
    expect(row!.targetId).toBe(fx.printerId);
  });

  it('happy path — slicer target', async () => {
    const fx = await buildDispatchFixture();
    const r = await createDispatchJob(
      {
        ownerId: fx.ownerId,
        lootId: fx.lootId,
        targetKind: 'slicer',
        targetId: fx.slicerId,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await getDispatchJob({ id: r.jobId }, { dbUrl: DB_URL });
    expect(row!.targetKind).toBe('slicer');
  });

  it('happy path — initialStatus=claimable skips preprocessing', async () => {
    const fx = await buildDispatchFixture();
    const r = await createDispatchJob(
      {
        ownerId: fx.ownerId,
        lootId: fx.lootId,
        targetKind: 'slicer',
        targetId: fx.slicerId,
        initialStatus: 'claimable',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await getDispatchJob({ id: r.jobId }, { dbUrl: DB_URL });
    expect(row!.status).toBe('claimable');
  });

  it('rejects invalid targetKind', async () => {
    const fx = await buildDispatchFixture();
    const r = await createDispatchJob(
      {
        ownerId: fx.ownerId,
        lootId: fx.lootId,
        targetKind: 'cloud' as never,
        targetId: fx.printerId,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-target-kind');
  });

  it('rejects invalid initialStatus', async () => {
    const fx = await buildDispatchFixture();
    const r = await createDispatchJob(
      {
        ownerId: fx.ownerId,
        lootId: fx.lootId,
        targetKind: 'printer',
        targetId: fx.printerId,
        initialStatus: 'wat' as never,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-status');
  });

  it('rejects nonexistent loot', async () => {
    const fx = await buildDispatchFixture();
    const r = await createDispatchJob(
      {
        ownerId: fx.ownerId,
        lootId: 'missing-loot-id',
        targetKind: 'printer',
        targetId: fx.printerId,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('loot-not-found');
  });

  it('rejects nonexistent printer target', async () => {
    const fx = await buildDispatchFixture();
    const r = await createDispatchJob(
      {
        ownerId: fx.ownerId,
        lootId: fx.lootId,
        targetKind: 'printer',
        targetId: 'missing-printer-id',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('target-not-found');
  });

  it('rejects nonexistent slicer target', async () => {
    const fx = await buildDispatchFixture();
    const r = await createDispatchJob(
      {
        ownerId: fx.ownerId,
        lootId: fx.lootId,
        targetKind: 'slicer',
        targetId: 'missing-slicer-id',
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('target-not-found');
  });

  it('cross-owner loot collapses to loot-not-found (no existence leak)', async () => {
    const fxA = await buildDispatchFixture();
    const fxB = await buildDispatchFixture();
    // user B tries to dispatch user A's loot via user B's printer.
    const r = await createDispatchJob(
      {
        ownerId: fxB.ownerId,
        lootId: fxA.lootId,
        targetKind: 'printer',
        targetId: fxB.printerId,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('loot-not-found');
  });

  it('cross-owner printer collapses to target-not-found', async () => {
    const fxA = await buildDispatchFixture();
    const fxB = await buildDispatchFixture();
    const r = await createDispatchJob(
      {
        ownerId: fxA.ownerId,
        lootId: fxA.lootId,
        targetKind: 'printer',
        targetId: fxB.printerId,
      },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('target-not-found');
  });
});

// ===========================================================================
// listDispatchJobs (read API)
// ===========================================================================

describe('listDispatchJobs', () => {
  it('filters by owner + status; paginates by id', async () => {
    const fx = await buildDispatchFixture();
    // 3 pending, 1 claimable.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await fx.newJob('pending'));
    ids.push(await fx.newJob('claimable'));

    const all = await listDispatchJobs({ ownerId: fx.ownerId }, { dbUrl: DB_URL });
    expect(all.jobs).toHaveLength(4);

    const pending = await listDispatchJobs(
      { ownerId: fx.ownerId, status: 'pending' },
      { dbUrl: DB_URL },
    );
    expect(pending.jobs).toHaveLength(3);
    expect(pending.jobs.every((j) => j.status === 'pending')).toBe(true);

    const page1 = await listDispatchJobs(
      { ownerId: fx.ownerId, limit: 2 },
      { dbUrl: DB_URL },
    );
    expect(page1.jobs).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await listDispatchJobs(
      { ownerId: fx.ownerId, limit: 2, cursor: page1.nextCursor },
      { dbUrl: DB_URL },
    );
    expect(page2.jobs).toHaveLength(2);
    expect(page2.nextCursor).toBeUndefined();
  });
});

// ===========================================================================
// markConverting
// ===========================================================================

describe('markConverting', () => {
  it('legal: pending → converting', async () => {
    const fx = await buildDispatchFixture();
    const id = await fx.newJob('pending');
    const r = await markConverting({ jobId: id }, { dbUrl: DB_URL });
    expect(r.ok).toBe(true);
    expect((await getDispatchJob({ id }, { dbUrl: DB_URL }))!.status).toBe('converting');
  });

  it('illegal: claimable → converting → wrong-state', async () => {
    const fx = await buildDispatchFixture();
    const id = await fx.newJob('claimable');
    const r = await markConverting({ jobId: id }, { dbUrl: DB_URL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('wrong-state');
    expect(r.currentState).toBe('claimable');
  });

  it('not-found: missing jobId', async () => {
    const r = await markConverting({ jobId: 'missing' }, { dbUrl: DB_URL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not-found');
  });
});

// ===========================================================================
// markSlicing
// ===========================================================================

describe('markSlicing', () => {
  it('legal: pending → slicing', async () => {
    const fx = await buildDispatchFixture();
    const id = await fx.newJob('pending');
    const r = await markSlicing({ jobId: id, from: 'pending' }, { dbUrl: DB_URL });
    expect(r.ok).toBe(true);
    expect((await getDispatchJob({ id }, { dbUrl: DB_URL }))!.status).toBe('slicing');
  });

  it('legal: converting → slicing', async () => {
    const fx = await buildDispatchFixture();
    const id = await fx.newJob('pending');
    await markConverting({ jobId: id }, { dbUrl: DB_URL });
    const r = await markSlicing({ jobId: id, from: 'converting' }, { dbUrl: DB_URL });
    expect(r.ok).toBe(true);
  });

  it('illegal source state: claimable → slicing → wrong-state', async () => {
    const fx = await buildDispatchFixture();
    const id = await fx.newJob('claimable');
    const r = await markSlicing({ jobId: id, from: 'pending' }, { dbUrl: DB_URL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('wrong-state');
    expect(r.currentState).toBe('claimable');
  });

  it('invalid-arg on bad `from`', async () => {
    const fx = await buildDispatchFixture();
    const id = await fx.newJob('pending');
    const r = await markSlicing(
      { jobId: id, from: 'claimed' as never },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-arg');
  });
});

// ===========================================================================
// markClaimable
// ===========================================================================

describe('markClaimable', () => {
  it('legal: pending → claimable (no preprocessing path)', async () => {
    const fx = await buildDispatchFixture();
    const id = await fx.newJob('pending');
    const r = await markClaimable({ jobId: id, from: 'pending' }, { dbUrl: DB_URL });
    expect(r.ok).toBe(true);
  });

  it('legal: converting → claimable', async () => {
    const fx = await buildDispatchFixture();
    const id = await fx.newJob('pending');
    await markConverting({ jobId: id }, { dbUrl: DB_URL });
    const r = await markClaimable({ jobId: id, from: 'converting' }, { dbUrl: DB_URL });
    expect(r.ok).toBe(true);
  });

  it('legal: slicing → claimable', async () => {
    const fx = await buildDispatchFixture();
    const id = await fx.newJob('pending');
    await markSlicing({ jobId: id, from: 'pending' }, { dbUrl: DB_URL });
    const r = await markClaimable({ jobId: id, from: 'slicing' }, { dbUrl: DB_URL });
    expect(r.ok).toBe(true);
  });

  it('illegal: claimed → claimable (via this fn) → wrong-state (use unclaimStaleJob instead)', async () => {
    const fx = await buildDispatchFixture();
    const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const id = await fx.newJob('claimable');
    await markClaimed({ jobId: id, agentId: boot.agentId }, { dbUrl: DB_URL });
    const r = await markClaimable({ jobId: id, from: 'pending' }, { dbUrl: DB_URL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('wrong-state');
  });
});

// ===========================================================================
// markClaimed
// ===========================================================================

describe('markClaimed', () => {
  it('legal: claimable → claimed; stamps claim_marker + claimed_at', async () => {
    const fx = await buildDispatchFixture();
    const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const id = await fx.newJob('claimable');
    const t = new Date(2026, 0, 1, 12, 0, 0);

    const r = await markClaimed(
      { jobId: id, agentId: boot.agentId },
      { dbUrl: DB_URL, now: t },
    );
    expect(r.ok).toBe(true);

    const row = await getDispatchJob({ id }, { dbUrl: DB_URL });
    expect(row!.status).toBe('claimed');
    expect(row!.claimMarker).toBe(boot.agentId);
    expect(row!.claimedAt!.getTime()).toBe(t.getTime());
  });

  it('illegal: pending → claimed → wrong-state', async () => {
    const fx = await buildDispatchFixture();
    const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const id = await fx.newJob('pending');
    const r = await markClaimed(
      { jobId: id, agentId: boot.agentId },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('wrong-state');
    expect(r.currentState).toBe('pending');
  });

  it('concurrent claim race: exactly one of two parallel claims wins', async () => {
    const fx = await buildDispatchFixture();
    const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const c2 = await createAgent({ kind: 'courier' }, { dbUrl: DB_URL });
    if (!c2.ok) throw new Error('precondition');

    const id = await fx.newJob('claimable');

    const [r1, r2] = await Promise.all([
      markClaimed({ jobId: id, agentId: boot.agentId }, { dbUrl: DB_URL }),
      markClaimed({ jobId: id, agentId: c2.agentId }, { dbUrl: DB_URL }),
    ]);

    const winners = [r1, r2].filter((r) => r.ok).length;
    const losers = [r1, r2].filter((r) => !r.ok);
    expect(winners).toBe(1);
    expect(losers).toHaveLength(1);
    // The loser sees the winner's terminal state in currentState.
    const loser = losers[0]!;
    if (loser.ok) return;
    expect(loser.reason).toBe('wrong-state');
    expect(loser.currentState).toBe('claimed');
  });
});

// ===========================================================================
// markDispatched
// ===========================================================================

describe('markDispatched', () => {
  it('legal: claimed → dispatched; stamps started_at', async () => {
    const fx = await buildDispatchFixture();
    const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const id = await fx.newJob('claimable');
    await markClaimed({ jobId: id, agentId: boot.agentId }, { dbUrl: DB_URL });

    const t = new Date(2026, 0, 2, 9, 0, 0);
    const r = await markDispatched({ jobId: id }, { dbUrl: DB_URL, now: t });
    expect(r.ok).toBe(true);

    const row = await getDispatchJob({ id }, { dbUrl: DB_URL });
    expect(row!.status).toBe('dispatched');
    expect(row!.startedAt!.getTime()).toBe(t.getTime());
  });

  it('illegal: claimable → dispatched → wrong-state', async () => {
    const fx = await buildDispatchFixture();
    const id = await fx.newJob('claimable');
    const r = await markDispatched({ jobId: id }, { dbUrl: DB_URL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('wrong-state');
    expect(r.currentState).toBe('claimable');
  });
});

// ===========================================================================
// markCompleted
// ===========================================================================

describe('markCompleted', () => {
  it('legal: dispatched → completed; stamps completed_at', async () => {
    const fx = await buildDispatchFixture();
    const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const id = await fx.newJob('claimable');
    await markClaimed({ jobId: id, agentId: boot.agentId }, { dbUrl: DB_URL });
    await markDispatched({ jobId: id }, { dbUrl: DB_URL });

    const t = new Date(2026, 0, 2, 10, 0, 0);
    const r = await markCompleted({ jobId: id }, { dbUrl: DB_URL, now: t });
    expect(r.ok).toBe(true);

    const row = await getDispatchJob({ id }, { dbUrl: DB_URL });
    expect(row!.status).toBe('completed');
    expect(row!.completedAt!.getTime()).toBe(t.getTime());
  });

  it('illegal: claimed → completed → wrong-state', async () => {
    const fx = await buildDispatchFixture();
    const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const id = await fx.newJob('claimable');
    await markClaimed({ jobId: id, agentId: boot.agentId }, { dbUrl: DB_URL });
    const r = await markCompleted({ jobId: id }, { dbUrl: DB_URL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('wrong-state');
    expect(r.currentState).toBe('claimed');
  });

  it('not idempotent: completed → completed → wrong-state', async () => {
    const fx = await buildDispatchFixture();
    const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const id = await fx.newJob('claimable');
    await markClaimed({ jobId: id, agentId: boot.agentId }, { dbUrl: DB_URL });
    await markDispatched({ jobId: id }, { dbUrl: DB_URL });
    await markCompleted({ jobId: id }, { dbUrl: DB_URL });

    const r = await markCompleted({ jobId: id }, { dbUrl: DB_URL });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('wrong-state');
    expect(r.currentState).toBe('completed');
  });
});

// ===========================================================================
// markFailed
// ===========================================================================

describe('markFailed', () => {
  const NON_TERMINALS: DispatchJobStatus[] = [
    'pending',
    'converting',
    'slicing',
    'claimable',
    'claimed',
    'dispatched',
  ];

  for (const src of NON_TERMINALS) {
    it(`legal: ${src} → failed; stamps reason + completed_at`, async () => {
      const fx = await buildDispatchFixture();
      let id: string;
      // We can't directly seed every status via initialStatus (DispatchJobStatus
      // schema accepts any of them, but the createDispatchJob path is the canonical
      // entry). To minimise wiring, drive each into the right status:
      switch (src) {
        case 'pending':
          id = await fx.newJob('pending');
          break;
        case 'converting':
          id = await fx.newJob('pending');
          await markConverting({ jobId: id }, { dbUrl: DB_URL });
          break;
        case 'slicing':
          id = await fx.newJob('pending');
          await markSlicing({ jobId: id, from: 'pending' }, { dbUrl: DB_URL });
          break;
        case 'claimable':
          id = await fx.newJob('claimable');
          break;
        case 'claimed': {
          const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
          id = await fx.newJob('claimable');
          await markClaimed({ jobId: id, agentId: boot.agentId }, { dbUrl: DB_URL });
          break;
        }
        case 'dispatched': {
          const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
          id = await fx.newJob('claimable');
          await markClaimed({ jobId: id, agentId: boot.agentId }, { dbUrl: DB_URL });
          await markDispatched({ jobId: id }, { dbUrl: DB_URL });
          break;
        }
        default:
          throw new Error(`unhandled ${src}`);
      }

      const t = new Date(2026, 5, 1);
      const r = await markFailed(
        { jobId: id, reason: 'unknown', details: 'test' },
        { dbUrl: DB_URL, now: t },
      );
      expect(r.ok).toBe(true);
      const row = await getDispatchJob({ id }, { dbUrl: DB_URL });
      expect(row!.status).toBe('failed');
      expect(row!.failureReason).toBe('unknown');
      expect(row!.failureDetails).toBe('test');
      expect(row!.completedAt!.getTime()).toBe(t.getTime());
    });
  }

  it('rejects invalid failure reason', async () => {
    const fx = await buildDispatchFixture();
    const id = await fx.newJob('pending');
    const r = await markFailed(
      { jobId: id, reason: 'bogus' as never },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-arg');
  });

  it('rejects from terminal `completed`', async () => {
    const fx = await buildDispatchFixture();
    const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const id = await fx.newJob('claimable');
    await markClaimed({ jobId: id, agentId: boot.agentId }, { dbUrl: DB_URL });
    await markDispatched({ jobId: id }, { dbUrl: DB_URL });
    await markCompleted({ jobId: id }, { dbUrl: DB_URL });

    const r = await markFailed(
      { jobId: id, reason: 'unknown' },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('wrong-state');
    expect(r.currentState).toBe('completed');
  });

  it('rejects from terminal `failed` (no double-fail)', async () => {
    const fx = await buildDispatchFixture();
    const id = await fx.newJob('pending');
    await markFailed({ jobId: id, reason: 'unknown' }, { dbUrl: DB_URL });

    const r = await markFailed(
      { jobId: id, reason: 'unknown' },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('wrong-state');
    expect(r.currentState).toBe('failed');
  });
});

// ===========================================================================
// unclaimStaleJob
// ===========================================================================

describe('unclaimStaleJob', () => {
  it('stale claim → unclaimed (status=claimable, claim_marker=null)', async () => {
    const fx = await buildDispatchFixture();
    const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const id = await fx.newJob('claimable');
    const claimedAt = new Date(2026, 0, 1, 12, 0, 0);
    await markClaimed(
      { jobId: id, agentId: boot.agentId },
      { dbUrl: DB_URL, now: claimedAt },
    );

    const now = new Date(2026, 0, 1, 12, 5, 0); // 5 min later
    const r = await unclaimStaleJob(
      { jobId: id, agentId: boot.agentId, claimTimeoutMs: 60_000 },
      { dbUrl: DB_URL, now },
    );
    expect(r.ok).toBe(true);

    const row = await getDispatchJob({ id }, { dbUrl: DB_URL });
    expect(row!.status).toBe('claimable');
    expect(row!.claimMarker).toBeNull();
    expect(row!.claimedAt).toBeNull();
  });

  it('recent claim (within timeout) → no-op', async () => {
    const fx = await buildDispatchFixture();
    const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const id = await fx.newJob('claimable');
    const claimedAt = new Date(2026, 0, 1, 12, 0, 0);
    await markClaimed(
      { jobId: id, agentId: boot.agentId },
      { dbUrl: DB_URL, now: claimedAt },
    );

    const now = new Date(2026, 0, 1, 12, 0, 30); // 30s later, well under 60s timeout
    const r = await unclaimStaleJob(
      { jobId: id, agentId: boot.agentId, claimTimeoutMs: 60_000 },
      { dbUrl: DB_URL, now },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Distinguishable as wrong-state with currentState=claimed.
    expect(r.reason).toBe('wrong-state');
    expect(r.currentState).toBe('claimed');

    // Row left alone.
    const row = await getDispatchJob({ id }, { dbUrl: DB_URL });
    expect(row!.status).toBe('claimed');
    expect(row!.claimMarker).toBe(boot.agentId);
  });

  it('stale claim by DIFFERENT agent → no-op (only the same agent can recover)', async () => {
    const fx = await buildDispatchFixture();
    const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const c2 = await createAgent({ kind: 'courier' }, { dbUrl: DB_URL });
    if (!c2.ok) throw new Error('precondition');

    const id = await fx.newJob('claimable');
    const claimedAt = new Date(2026, 0, 1, 12, 0, 0);
    await markClaimed(
      { jobId: id, agentId: boot.agentId },
      { dbUrl: DB_URL, now: claimedAt },
    );

    const now = new Date(2026, 0, 1, 12, 5, 0);
    // courier 2 tries to recover the central worker's claim → no-op.
    const r = await unclaimStaleJob(
      { jobId: id, agentId: c2.agentId, claimTimeoutMs: 60_000 },
      { dbUrl: DB_URL, now },
    );
    expect(r.ok).toBe(false);

    const row = await getDispatchJob({ id }, { dbUrl: DB_URL });
    expect(row!.status).toBe('claimed');
    expect(row!.claimMarker).toBe(boot.agentId);
  });

  it('not-found on missing job', async () => {
    const r = await unclaimStaleJob(
      { jobId: 'missing', agentId: 'whatever', claimTimeoutMs: 60_000 },
      { dbUrl: DB_URL },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not-found');
  });
});
