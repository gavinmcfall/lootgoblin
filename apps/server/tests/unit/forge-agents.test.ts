/**
 * Unit tests for Forge Agent CRUD — V2-005a-T2.
 *
 * Real-DB-on-tmpfile pattern.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  createAgent,
  updateAgent,
  deleteAgent,
  getAgent,
  listAgents,
  recordHeartbeat,
} from '../../src/forge/agents';
import { bootstrapCentralWorker } from '../../src/forge/agent-bootstrap';

const DB_PATH = '/tmp/lootgoblin-forge-agents-unit.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Forge Test User',
    email: `${id}@test.example`,
    emailVerified: false,
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
  // Clear all forge state. Order matters for FKs.
  await db().delete(schema.printerReachableVia);
  await db().delete(schema.printers);
  await db().delete(schema.agents);
  // Users are not strictly necessary to clear but keeps the DB lean.
  await db().delete(schema.user);
});

// ---------------------------------------------------------------------------
// createAgent
// ---------------------------------------------------------------------------

describe('createAgent', () => {
  it('happy path — creates a courier with all fields', async () => {
    const result = await createAgent(
      {
        kind: 'courier',
        pairCredentialRef: 'api-key-id-123',
        reachableLanHint: "On Gavin's home server",
      },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await getAgent({ id: result.agentId }, { dbUrl: DB_URL });
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('courier');
    expect(row!.pairCredentialRef).toBe('api-key-id-123');
    expect(row!.reachableLanHint).toBe("On Gavin's home server");
  });

  it('rejects invalid kind', async () => {
    const result = await createAgent(
      { kind: 'wizard' as never },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-kind');
  });

  it('rejects central_worker creation (bootstrap-only)', async () => {
    const result = await createAgent(
      { kind: 'central_worker' },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('central-worker-via-bootstrap');
  });

  it('idempotent re-create — same id + same body returns existing agent', async () => {
    const id = uid();
    const first = await createAgent(
      { kind: 'courier', id, reachableLanHint: 'home' },
      { dbUrl: DB_URL },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await createAgent(
      { kind: 'courier', id, reachableLanHint: 'home' },
      { dbUrl: DB_URL },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.agentId).toBe(first.agentId);

    const rows = await db().select().from(schema.agents).where(eq(schema.agents.id, id));
    expect(rows).toHaveLength(1);
  });

  it('id-conflict — same id + different body rejects', async () => {
    const id = uid();
    const first = await createAgent(
      { kind: 'courier', id, reachableLanHint: 'home' },
      { dbUrl: DB_URL },
    );
    expect(first.ok).toBe(true);

    const second = await createAgent(
      { kind: 'courier', id, reachableLanHint: 'WORK' },
      { dbUrl: DB_URL },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('id-conflict');
  });
});

// ---------------------------------------------------------------------------
// updateAgent
// ---------------------------------------------------------------------------

describe('updateAgent', () => {
  it('happy path — changes reachableLanHint', async () => {
    const created = await createAgent(
      { kind: 'courier', reachableLanHint: 'old' },
      { dbUrl: DB_URL },
    );
    if (!created.ok) throw new Error('precondition');

    const result = await updateAgent(
      { id: created.agentId, reachableLanHint: 'new' },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(true);

    const row = await getAgent({ id: created.agentId }, { dbUrl: DB_URL });
    expect(row!.reachableLanHint).toBe('new');
  });

  it('explicit null clears reachableLanHint', async () => {
    const created = await createAgent(
      { kind: 'courier', reachableLanHint: 'old' },
      { dbUrl: DB_URL },
    );
    if (!created.ok) throw new Error('precondition');

    await updateAgent(
      { id: created.agentId, reachableLanHint: null },
      { dbUrl: DB_URL },
    );
    const row = await getAgent({ id: created.agentId }, { dbUrl: DB_URL });
    expect(row!.reachableLanHint).toBeNull();
  });

  it('not-found on missing id', async () => {
    const result = await updateAgent(
      { id: 'nonexistent', reachableLanHint: 'x' },
      { dbUrl: DB_URL },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-found');
  });
});

// ---------------------------------------------------------------------------
// deleteAgent
// ---------------------------------------------------------------------------

describe('deleteAgent', () => {
  it('happy path — deletes a courier', async () => {
    const created = await createAgent({ kind: 'courier' }, { dbUrl: DB_URL });
    if (!created.ok) throw new Error('precondition');

    const result = await deleteAgent({ id: created.agentId }, { dbUrl: DB_URL });
    expect(result.ok).toBe(true);

    const row = await getAgent({ id: created.agentId }, { dbUrl: DB_URL });
    expect(row).toBeNull();
  });

  it('rejects deletion when agent has reachable printers', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId);
    const created = await createAgent({ kind: 'courier' }, { dbUrl: DB_URL });
    if (!created.ok) throw new Error('precondition');

    await db().insert(schema.printerReachableVia).values({
      printerId,
      agentId: created.agentId,
    });

    const result = await deleteAgent({ id: created.agentId }, { dbUrl: DB_URL });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('agent-has-reachable-printers');
  });

  it('rejects deletion of the last central_worker', async () => {
    const boot = await bootstrapCentralWorker({ dbUrl: DB_URL });
    expect(boot.created).toBe(true);

    const result = await deleteAgent({ id: boot.agentId }, { dbUrl: DB_URL });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('cannot-delete-bootstrap-agent');
  });

  it('not-found on missing id', async () => {
    const result = await deleteAgent({ id: 'nonexistent' }, { dbUrl: DB_URL });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-found');
  });
});

// ---------------------------------------------------------------------------
// listAgents
// ---------------------------------------------------------------------------

describe('listAgents', () => {
  it('pagination — returns nextCursor when more rows exist', async () => {
    // Create 5 couriers; page-size 2 → 3 pages.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await createAgent({ kind: 'courier' }, { dbUrl: DB_URL });
      if (!r.ok) throw new Error('precondition');
      ids.push(r.agentId);
    }

    const page1 = await listAgents({ limit: 2 }, { dbUrl: DB_URL });
    expect(page1.agents).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await listAgents(
      { limit: 2, cursor: page1.nextCursor },
      { dbUrl: DB_URL },
    );
    expect(page2.agents).toHaveLength(2);

    const page3 = await listAgents(
      { limit: 2, cursor: page2.nextCursor },
      { dbUrl: DB_URL },
    );
    expect(page3.agents).toHaveLength(1);
    expect(page3.nextCursor).toBeUndefined();
  });

  it('filter by kind', async () => {
    await bootstrapCentralWorker({ dbUrl: DB_URL });
    await createAgent({ kind: 'courier' }, { dbUrl: DB_URL });
    await createAgent({ kind: 'courier' }, { dbUrl: DB_URL });

    const couriers = await listAgents({ kind: 'courier' }, { dbUrl: DB_URL });
    expect(couriers.agents).toHaveLength(2);
    expect(couriers.agents.every((a) => a.kind === 'courier')).toBe(true);

    const centrals = await listAgents({ kind: 'central_worker' }, { dbUrl: DB_URL });
    expect(centrals.agents).toHaveLength(1);
    expect(centrals.agents[0]!.kind).toBe('central_worker');
  });
});

// ---------------------------------------------------------------------------
// recordHeartbeat
// ---------------------------------------------------------------------------

describe('recordHeartbeat', () => {
  it('updates last_seen_at; idempotent — repeated calls bump the timestamp', async () => {
    const created = await createAgent({ kind: 'courier' }, { dbUrl: DB_URL });
    if (!created.ok) throw new Error('precondition');

    const t1 = new Date(2026, 0, 1, 12, 0, 0);
    const t2 = new Date(2026, 0, 1, 12, 0, 5);

    const r1 = await recordHeartbeat({ id: created.agentId }, { dbUrl: DB_URL, now: t1 });
    expect(r1.ok).toBe(true);
    let row = await getAgent({ id: created.agentId }, { dbUrl: DB_URL });
    expect(row!.lastSeenAt!.getTime()).toBe(t1.getTime());

    const r2 = await recordHeartbeat({ id: created.agentId }, { dbUrl: DB_URL, now: t2 });
    expect(r2.ok).toBe(true);
    row = await getAgent({ id: created.agentId }, { dbUrl: DB_URL });
    expect(row!.lastSeenAt!.getTime()).toBe(t2.getTime());
  });

  it('not-found on unknown agent id', async () => {
    const result = await recordHeartbeat({ id: 'nonexistent' }, { dbUrl: DB_URL });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-found');
  });
});
