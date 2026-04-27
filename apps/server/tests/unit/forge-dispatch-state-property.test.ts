/**
 * Property-based tests for the DispatchJob state machine — V2-005a-T3.
 *
 * Pattern adapted from materials-mix.test.ts §"Mass-conservation invariant
 * property test" (V2-007a-T5): seeded LCG random + deterministic iteration
 * loop on a real-DB fixture.
 *
 * Invariant under test:
 *   - For every transition attempted, success ⟺ the (pre-state, attempted-
 *     transition) pair is in LEGAL_TRANSITIONS.
 *   - If post-state is terminal, no further mark*() succeeds on that job.
 *   - The final state is always one of the 8 DISPATCH_JOB_STATUSES values.
 *
 * The harness picks a random transition attempt at each step and asserts the
 * outcome matches the LEGAL_TRANSITIONS table. This catches any drift
 * between the code's behaviour and the table's contents.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  createDispatchJob,
  getDispatchJob,
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
  TERMINAL_STATES,
} from '../../src/forge/dispatch-state';
import { bootstrapCentralWorker } from '../../src/forge/agent-bootstrap';
import {
  DISPATCH_JOB_STATUSES,
  type DispatchJobStatus,
} from '../../src/db/schema.forge';

const DB_PATH = '/tmp/lootgoblin-forge-dispatch-state-property.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Seeded LCG (Park-Miller minstd) — deterministic across runs
// ---------------------------------------------------------------------------

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 1;
  return () => {
    s = (s * 48271) % 2147483647;
    return (s & 0x7fffffff) / 2147483647;
  };
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)]!;
}

// ---------------------------------------------------------------------------
// Fixture (single owner + loot + printer reused across iterations)
// ---------------------------------------------------------------------------

let OWNER_ID: string;
let LOOT_ID: string;
let PRINTER_ID: string;
let AGENT_ID: string;

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);

  // Seed once. The iteration loop only inserts new dispatch_jobs rows.
  OWNER_ID = uid();
  await db().insert(schema.user).values({
    id: OWNER_ID,
    name: 'Forge Property Test User',
    email: `${OWNER_ID}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const stashRootId = uid();
  const tmpDir = await fsp.mkdtemp(path.join('/tmp', 'lootgoblin-fdp-'));
  await db().insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId: OWNER_ID,
    name: 'Property Test Root',
    path: tmpDir,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId: OWNER_ID,
    name: 'Property Test Collection',
    pathTemplate: '{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  LOOT_ID = uid();
  await db().insert(schema.loot).values({
    id: LOOT_ID,
    collectionId,
    title: 'Property Test Loot',
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  PRINTER_ID = uid();
  await db().insert(schema.printers).values({
    id: PRINTER_ID,
    ownerId: OWNER_ID,
    kind: 'fdm_klipper',
    name: 'Property Test Printer',
    connectionConfig: { url: 'http://1.2.3.4:7125', apiKey: 'x' },
    active: true,
    createdAt: new Date(),
  });

  const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
  AGENT_ID = boot.agentId;
}, 30_000);

afterEach(async () => {
  // Iteration loops insert lots of dispatch_jobs — clean between iterations
  // groups would be ideal, but we batch-clean once after the whole `it` to
  // keep noise out.
  await db().delete(schema.dispatchJobs);
});

// ---------------------------------------------------------------------------
// Transition harness — every mark* fn under one signature
// ---------------------------------------------------------------------------

type TransitionName =
  | 'markConverting'
  | 'markSlicing-from-pending'
  | 'markSlicing-from-converting'
  | 'markClaimable-from-pending'
  | 'markClaimable-from-converting'
  | 'markClaimable-from-slicing'
  | 'markClaimed'
  | 'markDispatched'
  | 'markCompleted'
  | 'markFailed'
  | 'unclaimStaleJob';

const ALL_TRANSITIONS: TransitionName[] = [
  'markConverting',
  'markSlicing-from-pending',
  'markSlicing-from-converting',
  'markClaimable-from-pending',
  'markClaimable-from-converting',
  'markClaimable-from-slicing',
  'markClaimed',
  'markDispatched',
  'markCompleted',
  'markFailed',
  'unclaimStaleJob',
];

/**
 * For a given transition name + the job's CURRENT state, return what the
 * next state would be IF the function succeeds, or `null` if the LEGAL_-
 * TRANSITIONS table says this attempt is illegal.
 */
function expectedNext(
  name: TransitionName,
  current: DispatchJobStatus,
): DispatchJobStatus | null {
  switch (name) {
    case 'markConverting':
      return current === 'pending' && isLegalTransition(current, 'converting')
        ? 'converting'
        : null;
    case 'markSlicing-from-pending':
      return current === 'pending' && isLegalTransition(current, 'slicing')
        ? 'slicing'
        : null;
    case 'markSlicing-from-converting':
      return current === 'converting' && isLegalTransition(current, 'slicing')
        ? 'slicing'
        : null;
    case 'markClaimable-from-pending':
      return current === 'pending' && isLegalTransition(current, 'claimable')
        ? 'claimable'
        : null;
    case 'markClaimable-from-converting':
      return current === 'converting' && isLegalTransition(current, 'claimable')
        ? 'claimable'
        : null;
    case 'markClaimable-from-slicing':
      return current === 'slicing' && isLegalTransition(current, 'claimable')
        ? 'claimable'
        : null;
    case 'markClaimed':
      return current === 'claimable' && isLegalTransition(current, 'claimed')
        ? 'claimed'
        : null;
    case 'markDispatched':
      return current === 'claimed' && isLegalTransition(current, 'dispatched')
        ? 'dispatched'
        : null;
    case 'markCompleted':
      return current === 'dispatched' && isLegalTransition(current, 'completed')
        ? 'completed'
        : null;
    case 'markFailed':
      // Legal from any non-terminal.
      return !TERMINAL_STATES.has(current) ? 'failed' : null;
    case 'unclaimStaleJob':
      // Only legal from `claimed` AND with the right agent + age. The harness
      // always uses AGENT_ID + a `now` far past the claimed_at, so when the
      // current state is `claimed` the call should succeed.
      return current === 'claimed' && isLegalTransition(current, 'claimable')
        ? 'claimable'
        : null;
  }
}

async function applyTransition(
  name: TransitionName,
  jobId: string,
  now: Date,
): Promise<{ ok: true } | { ok: false }> {
  switch (name) {
    case 'markConverting':
      return markConverting({ jobId }, { dbUrl: DB_URL });
    case 'markSlicing-from-pending':
      return markSlicing({ jobId, from: 'pending' }, { dbUrl: DB_URL });
    case 'markSlicing-from-converting':
      return markSlicing({ jobId, from: 'converting' }, { dbUrl: DB_URL });
    case 'markClaimable-from-pending':
      return markClaimable({ jobId, from: 'pending' }, { dbUrl: DB_URL });
    case 'markClaimable-from-converting':
      return markClaimable({ jobId, from: 'converting' }, { dbUrl: DB_URL });
    case 'markClaimable-from-slicing':
      return markClaimable({ jobId, from: 'slicing' }, { dbUrl: DB_URL });
    case 'markClaimed':
      return markClaimed(
        { jobId, agentId: AGENT_ID },
        { dbUrl: DB_URL, now },
      );
    case 'markDispatched':
      return markDispatched({ jobId }, { dbUrl: DB_URL, now });
    case 'markCompleted':
      return markCompleted({ jobId }, { dbUrl: DB_URL, now });
    case 'markFailed':
      return markFailed(
        { jobId, reason: 'unknown', details: 'property test' },
        { dbUrl: DB_URL, now },
      );
    case 'unclaimStaleJob':
      // Force "stale" by passing claimTimeoutMs=0 — any claim is "older than 0ms".
      return unclaimStaleJob(
        { jobId, agentId: AGENT_ID, claimTimeoutMs: 0 },
        { dbUrl: DB_URL, now: new Date(now.getTime() + 60_000) },
      );
  }
}

async function currentStatus(jobId: string): Promise<DispatchJobStatus> {
  const row = await getDispatchJob({ id: jobId }, { dbUrl: DB_URL });
  if (!row) throw new Error(`row missing: ${jobId}`);
  return row.status as DispatchJobStatus;
}

// ---------------------------------------------------------------------------
// The property test
// ---------------------------------------------------------------------------

describe('DispatchJob state machine — property tests', () => {
  it('30 iterations: every transition outcome matches LEGAL_TRANSITIONS; terminals are sticky', async () => {
    const rand = seededRandom(0xf0e3a17);

    for (let iter = 0; iter < 30; iter++) {
      // Fresh job each iteration (status='pending').
      const created = await createDispatchJob(
        {
          ownerId: OWNER_ID,
          lootId: LOOT_ID,
          targetKind: 'printer',
          targetId: PRINTER_ID,
        },
        { dbUrl: DB_URL },
      );
      if (!created.ok) throw new Error(`fixture: ${created.reason}`);
      const id = created.jobId;

      const sequenceLength = 3 + Math.floor(rand() * 6); // 3..8
      let baseTime = new Date(2026, 0, 1, 12, 0, 0).getTime();

      for (let step = 0; step < sequenceLength; step++) {
        const pre = await currentStatus(id);
        const attempt = pick(rand, ALL_TRANSITIONS);

        // Step time forward so claim_at < now-cutoff stays true for stale-recovery.
        baseTime += 1000;
        const now = new Date(baseTime);

        const expected = expectedNext(attempt, pre);
        const result = await applyTransition(attempt, id, now);
        const post = await currentStatus(id);

        if (expected === null) {
          // Illegal attempt: function must reject AND state must not change.
          expect(
            result.ok,
            `iter=${iter} step=${step} attempt=${attempt} pre=${pre}: expected reject, got ok`,
          ).toBe(false);
          expect(
            post,
            `iter=${iter} step=${step} attempt=${attempt} pre=${pre}: state should be unchanged`,
          ).toBe(pre);
        } else {
          // Legal attempt: function must succeed AND state must equal expected.
          expect(
            result.ok,
            `iter=${iter} step=${step} attempt=${attempt} pre=${pre} expected=${expected}: should succeed`,
          ).toBe(true);
          expect(
            post,
            `iter=${iter} step=${step} attempt=${attempt}: state should be ${expected}`,
          ).toBe(expected);
        }

        // Terminal-stickiness: if we're in a terminal state, no further legal
        // transition exists from here. The next loop iteration will assert
        // that property by attempting random transitions and seeing them all
        // fail.
        if (TERMINAL_STATES.has(post)) {
          // Stop early — every remaining attempt should reject; we've already
          // validated that path through `expectedNext` above. We continue so
          // the test exercises terminal-stickiness end-to-end.
        }
      }

      const final = await currentStatus(id);
      expect(
        (DISPATCH_JOB_STATUSES as readonly string[]).includes(final),
        `iter=${iter}: final state should be one of DISPATCH_JOB_STATUSES`,
      ).toBe(true);
    }
  }, 60_000);

  it('terminal stickiness: once `completed`, every transition rejects', async () => {
    // Drive a job to `completed` then attack with all transitions.
    const created = await createDispatchJob(
      {
        ownerId: OWNER_ID,
        lootId: LOOT_ID,
        targetKind: 'printer',
        targetId: PRINTER_ID,
        initialStatus: 'claimable',
      },
      { dbUrl: DB_URL },
    );
    if (!created.ok) throw new Error(`fixture: ${created.reason}`);
    const id = created.jobId;
    await markClaimed({ jobId: id, agentId: AGENT_ID }, { dbUrl: DB_URL });
    await markDispatched({ jobId: id }, { dbUrl: DB_URL });
    await markCompleted({ jobId: id }, { dbUrl: DB_URL });

    expect(await currentStatus(id)).toBe('completed');

    for (const attempt of ALL_TRANSITIONS) {
      const r = await applyTransition(attempt, id, new Date());
      expect(r.ok, `${attempt} from completed should reject`).toBe(false);
      expect(await currentStatus(id)).toBe('completed');
    }
  });

  it('terminal stickiness: once `failed`, every transition rejects', async () => {
    const created = await createDispatchJob(
      {
        ownerId: OWNER_ID,
        lootId: LOOT_ID,
        targetKind: 'printer',
        targetId: PRINTER_ID,
      },
      { dbUrl: DB_URL },
    );
    if (!created.ok) throw new Error(`fixture: ${created.reason}`);
    const id = created.jobId;
    await markFailed({ jobId: id, reason: 'unknown' }, { dbUrl: DB_URL });

    expect(await currentStatus(id)).toBe('failed');

    for (const attempt of ALL_TRANSITIONS) {
      const r = await applyTransition(attempt, id, new Date());
      expect(r.ok, `${attempt} from failed should reject`).toBe(false);
      expect(await currentStatus(id)).toBe('failed');
    }
  });
});
