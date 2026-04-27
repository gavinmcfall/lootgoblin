/**
 * Integration tests for the Forge schema — V2-005a-T1
 *
 * Real SQLite DB at /tmp/lootgoblin-t1-forge.db
 *
 * Coverage:
 *   1. Migration applies cleanly to a fresh DB (7 new tables exist).
 *   2. Insert a printer with each FORGE_PRINTER_KINDS value.
 *   3. Insert a forge_slicer with each SLICER_INVOCATION_METHODS value.
 *   4. Insert agents (central_worker + courier).
 *   5. Insert printer_reachable_via row linking printer + agent.
 *   6. Insert printer_acl with each ACL_LEVELS value.
 *   7. Insert dispatch_job with each DISPATCH_JOB_STATUSES value.
 *   8. JSON round-trip on connection_config.
 *   9. FK enforcement: dispatch_job referencing nonexistent loot fails.
 *  10. FK enforcement: printer_reachable_via referencing nonexistent agent fails.
 *  11. Cascade: delete user → owner's printers / forge_slicers / printer_acls /
 *      slicer_acls / dispatch_jobs go away (agents are NOT user-owned).
 *  12. Cascade: delete printer → printer_acls + printer_reachable_via go away.
 *  13. Cascade: delete loot → dispatch_jobs referencing it go away.
 *  14. Set-null: delete agent → dispatch_jobs.claim_marker becomes NULL
 *      (history preserved).
 *  15. Set-null: delete loot_file referenced as converted_file_id →
 *      dispatch_job.converted_file_id becomes NULL.
 *  16. Expected indexes are present (PRAGMA-style query against sqlite_master).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  FORGE_PRINTER_KINDS,
  FORGE_SLICER_KINDS,
  SLICER_INVOCATION_METHODS,
  ACL_LEVELS,
  AGENT_KINDS,
  DISPATCH_JOB_STATUSES,
  isForgePrinterKind,
  isForgeSlicerKind,
  isAclLevel,
  isAgentKind,
  isDispatchJobStatus,
} from '../../src/forge/types';

const DB_PATH = '/tmp/lootgoblin-t1-forge.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

function now(): Date {
  return new Date();
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

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Forge Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

/**
 * Builds the stash chain (root → collection → loot) so dispatch_jobs +
 * loot_files have a real loot to FK to.
 */
async function seedLoot(ownerId: string): Promise<string> {
  const rootId = uid();
  await db().insert(schema.stashRoots).values({
    id: rootId,
    ownerId,
    name: 'Forge Root',
    path: '/tmp/forge-test-root',
  });

  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `Forge Collection ${collectionId.slice(0, 8)}`,
    pathTemplate: '{title|slug}',
    stashRootId: rootId,
  });

  const lootId = uid();
  await db().insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: 'Test Bench',
  });
  return lootId;
}

async function seedLootFile(lootId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.lootFiles).values({
    id,
    lootId,
    path: `Forge Collection/test-bench/${id.slice(0, 8)}.gcode`,
    format: 'gcode',
    size: 1024,
    hash: crypto.randomBytes(32).toString('hex'),
    origin: 'manual',
  });
  return id;
}

async function seedAgent(opts?: { kind?: string }): Promise<string> {
  const id = uid();
  await db().insert(schema.agents).values({
    id,
    kind: opts?.kind ?? 'central_worker',
  });
  return id;
}

async function seedPrinter(opts: {
  ownerId: string;
  kind?: string;
  config?: Record<string, unknown>;
}): Promise<string> {
  const id = uid();
  await db().insert(schema.printers).values({
    id,
    ownerId: opts.ownerId,
    kind: opts.kind ?? 'fdm_klipper',
    name: `Printer ${id.slice(0, 8)}`,
    connectionConfig: opts.config ?? { url: 'http://10.0.0.5:7125' },
  });
  return id;
}

async function seedForgeSlicer(opts: {
  ownerId: string;
  kind?: string;
  invocationMethod?: string;
}): Promise<string> {
  const id = uid();
  await db().insert(schema.forgeSlicers).values({
    id,
    ownerId: opts.ownerId,
    kind: opts.kind ?? 'orcaslicer',
    invocationMethod: opts.invocationMethod ?? 'url-scheme',
    name: `Slicer ${id.slice(0, 8)}`,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V2-005a-T1 forge schema migration', () => {
  it('1. migrations applied — all new tables exist', () => {
    const sqlite = (
      db() as unknown as {
        $client: { prepare: (s: string) => { all: () => Array<{ name: string }> } };
      }
    ).$client;
    const expected = [
      'agents',
      'dispatch_jobs',
      'forge_slicers',
      'printer_acls',
      'printer_reachable_via',
      'printers',
      'slicer_acls',
    ];
    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${expected
          .map((n) => `'${n}'`)
          .join(',')})`,
      )
      .all();
    expect(tables.map((t) => t.name).sort()).toEqual(expected);
  });

  it('2. accepts a printer with each FORGE_PRINTER_KINDS value', async () => {
    const ownerId = await seedUser();
    for (const kind of FORGE_PRINTER_KINDS) {
      expect(isForgePrinterKind(kind)).toBe(true);
      await seedPrinter({ ownerId, kind });
    }
    const rows = await db()
      .select()
      .from(schema.printers)
      .where(eq(schema.printers.ownerId, ownerId));
    expect(rows.length).toBe(FORGE_PRINTER_KINDS.length);
    expect(rows.every((r) => r.active === true)).toBe(true);
  });

  it('3. accepts a forge_slicer with each SLICER_INVOCATION_METHODS value', async () => {
    const ownerId = await seedUser();
    // Pair each invocation method with a slicer kind for variety.
    const pairs = SLICER_INVOCATION_METHODS.map((m, i) => ({
      method: m,
      kind: FORGE_SLICER_KINDS[i % FORGE_SLICER_KINDS.length],
    }));
    for (const p of pairs) {
      expect(isForgeSlicerKind(p.kind)).toBe(true);
      await seedForgeSlicer({ ownerId, kind: p.kind, invocationMethod: p.method });
    }
    const rows = await db()
      .select()
      .from(schema.forgeSlicers)
      .where(eq(schema.forgeSlicers.ownerId, ownerId));
    expect(rows.length).toBe(SLICER_INVOCATION_METHODS.length);
  });

  it('4. accepts agents with each AGENT_KINDS value', async () => {
    const ids: string[] = [];
    for (const kind of AGENT_KINDS) {
      expect(isAgentKind(kind)).toBe(true);
      ids.push(await seedAgent({ kind }));
    }
    const rows = await db().select().from(schema.agents);
    expect(rows.length).toBeGreaterThanOrEqual(ids.length);
    const seenKinds = new Set(rows.filter((r) => ids.includes(r.id)).map((r) => r.kind));
    for (const kind of AGENT_KINDS) {
      expect(seenKinds.has(kind)).toBe(true);
    }
  });

  it('5. printer_reachable_via links printer + agent', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter({ ownerId });
    const agentId = await seedAgent();

    await db().insert(schema.printerReachableVia).values({ printerId, agentId });

    const rows = await db()
      .select()
      .from(schema.printerReachableVia)
      .where(eq(schema.printerReachableVia.printerId, printerId));
    expect(rows.length).toBe(1);
    expect(rows[0]?.agentId).toBe(agentId);
  });

  it('6. printer_acl accepts each ACL_LEVELS value', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter({ ownerId });

    for (const level of ACL_LEVELS) {
      expect(isAclLevel(level)).toBe(true);
      const granteeId = await seedUser();
      await db().insert(schema.printerAcls).values({
        id: uid(),
        printerId,
        userId: granteeId,
        level,
      });
    }
    const rows = await db()
      .select()
      .from(schema.printerAcls)
      .where(eq(schema.printerAcls.printerId, printerId));
    expect(rows.length).toBe(ACL_LEVELS.length);
    expect(rows.map((r) => r.level).sort()).toEqual([...ACL_LEVELS].sort());
  });

  it('7. dispatch_job accepts each DISPATCH_JOB_STATUSES value', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const printerId = await seedPrinter({ ownerId });

    for (const status of DISPATCH_JOB_STATUSES) {
      expect(isDispatchJobStatus(status)).toBe(true);
      await db().insert(schema.dispatchJobs).values({
        id: uid(),
        ownerId,
        lootId,
        targetKind: 'printer',
        targetId: printerId,
        status,
      });
    }
    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.ownerId, ownerId));
    expect(rows.length).toBe(DISPATCH_JOB_STATUSES.length);
  });

  it('8. connection_config JSON round-trips deep-equal', async () => {
    const ownerId = await seedUser();
    const config = {
      ip: '10.0.0.7',
      accessCode: 'abcd1234',
      serial: '01S00C123456',
      tls: { enabled: true, fingerprint: 'sha256:deadbeef' },
      tags: ['primary', 'lan-only'],
    };
    const printerId = await seedPrinter({ ownerId, kind: 'fdm_bambu_lan', config });
    const row = (
      await db().select().from(schema.printers).where(eq(schema.printers.id, printerId))
    )[0];
    expect(row?.connectionConfig).toEqual(config);
  });

  it('9. FK enforcement: dispatch_job referencing nonexistent loot fails', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter({ ownerId });

    let threw = false;
    try {
      await db().insert(schema.dispatchJobs).values({
        id: uid(),
        ownerId,
        lootId: 'no-such-loot',
        targetKind: 'printer',
        targetId: printerId,
        status: 'pending',
      });
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/FOREIGN KEY|foreign key/i);
    }
    expect(threw).toBe(true);
  });

  it('10. FK enforcement: printer_reachable_via referencing nonexistent agent fails', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter({ ownerId });

    let threw = false;
    try {
      await db().insert(schema.printerReachableVia).values({
        printerId,
        agentId: 'no-such-agent',
      });
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/FOREIGN KEY|foreign key/i);
    }
    expect(threw).toBe(true);
  });

  it('11. cascade: delete user → printers + slicers + ACLs + dispatch_jobs go away (agents survive)', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const printerId = await seedPrinter({ ownerId });
    const slicerId = await seedForgeSlicer({ ownerId });
    const agentId = await seedAgent({ kind: 'courier' });

    // Owner-scoped ACL grants on the owner's own printer/slicer (FK to user is
    // what we're verifying — the level itself isn't load-bearing here).
    await db().insert(schema.printerAcls).values({
      id: uid(),
      printerId,
      userId: ownerId,
      level: 'admin',
    });
    await db().insert(schema.slicerAcls).values({
      id: uid(),
      slicerId,
      userId: ownerId,
      level: 'admin',
    });
    await db().insert(schema.dispatchJobs).values({
      id: uid(),
      ownerId,
      lootId,
      targetKind: 'printer',
      targetId: printerId,
      status: 'pending',
    });

    // Sanity
    expect(
      (
        await db()
          .select()
          .from(schema.printers)
          .where(eq(schema.printers.ownerId, ownerId))
      ).length,
    ).toBe(1);

    await db().delete(schema.user).where(eq(schema.user.id, ownerId));

    expect(
      (
        await db()
          .select()
          .from(schema.printers)
          .where(eq(schema.printers.ownerId, ownerId))
      ).length,
    ).toBe(0);
    expect(
      (
        await db()
          .select()
          .from(schema.forgeSlicers)
          .where(eq(schema.forgeSlicers.ownerId, ownerId))
      ).length,
    ).toBe(0);
    expect(
      (
        await db()
          .select()
          .from(schema.printerAcls)
          .where(eq(schema.printerAcls.userId, ownerId))
      ).length,
    ).toBe(0);
    expect(
      (
        await db()
          .select()
          .from(schema.slicerAcls)
          .where(eq(schema.slicerAcls.userId, ownerId))
      ).length,
    ).toBe(0);
    expect(
      (
        await db()
          .select()
          .from(schema.dispatchJobs)
          .where(eq(schema.dispatchJobs.ownerId, ownerId))
      ).length,
    ).toBe(0);

    // Agents are instance-scoped; deleting the user does NOT remove them.
    expect(
      (await db().select().from(schema.agents).where(eq(schema.agents.id, agentId))).length,
    ).toBe(1);
  });

  it('12. cascade: delete printer → printer_acls + printer_reachable_via go away', async () => {
    const ownerId = await seedUser();
    const granteeId = await seedUser();
    const printerId = await seedPrinter({ ownerId });
    const agentId = await seedAgent();

    await db().insert(schema.printerAcls).values({
      id: uid(),
      printerId,
      userId: granteeId,
      level: 'push',
    });
    await db().insert(schema.printerReachableVia).values({ printerId, agentId });

    // Sanity
    expect(
      (
        await db()
          .select()
          .from(schema.printerAcls)
          .where(eq(schema.printerAcls.printerId, printerId))
      ).length,
    ).toBe(1);
    expect(
      (
        await db()
          .select()
          .from(schema.printerReachableVia)
          .where(eq(schema.printerReachableVia.printerId, printerId))
      ).length,
    ).toBe(1);

    await db().delete(schema.printers).where(eq(schema.printers.id, printerId));

    expect(
      (
        await db()
          .select()
          .from(schema.printerAcls)
          .where(eq(schema.printerAcls.printerId, printerId))
      ).length,
    ).toBe(0);
    expect(
      (
        await db()
          .select()
          .from(schema.printerReachableVia)
          .where(eq(schema.printerReachableVia.printerId, printerId))
      ).length,
    ).toBe(0);

    // Agent + grantee survive.
    expect(
      (await db().select().from(schema.agents).where(eq(schema.agents.id, agentId))).length,
    ).toBe(1);
    expect(
      (await db().select().from(schema.user).where(eq(schema.user.id, granteeId))).length,
    ).toBe(1);
  });

  it('13. cascade: delete loot → dispatch_jobs referencing it go away', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const printerId = await seedPrinter({ ownerId });

    const jobId = uid();
    await db().insert(schema.dispatchJobs).values({
      id: jobId,
      ownerId,
      lootId,
      targetKind: 'printer',
      targetId: printerId,
      status: 'pending',
    });

    expect(
      (
        await db()
          .select()
          .from(schema.dispatchJobs)
          .where(eq(schema.dispatchJobs.id, jobId))
      ).length,
    ).toBe(1);

    await db().delete(schema.loot).where(eq(schema.loot.id, lootId));

    expect(
      (
        await db()
          .select()
          .from(schema.dispatchJobs)
          .where(eq(schema.dispatchJobs.id, jobId))
      ).length,
    ).toBe(0);
  });

  it('14. set-null: delete agent → dispatch_jobs.claim_marker becomes NULL (history preserved)', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const printerId = await seedPrinter({ ownerId });
    const agentId = await seedAgent({ kind: 'courier' });

    const jobId = uid();
    await db().insert(schema.dispatchJobs).values({
      id: jobId,
      ownerId,
      lootId,
      targetKind: 'printer',
      targetId: printerId,
      status: 'claimed',
      claimMarker: agentId,
      claimedAt: now(),
    });

    await db().delete(schema.agents).where(eq(schema.agents.id, agentId));

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows.length).toBe(1); // history preserved
    expect(rows[0]?.claimMarker).toBeNull();
  });

  it('15. set-null: delete loot_file → dispatch_job.converted_file_id becomes NULL', async () => {
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId);
    const printerId = await seedPrinter({ ownerId });
    const fileId = await seedLootFile(lootId);

    const jobId = uid();
    await db().insert(schema.dispatchJobs).values({
      id: jobId,
      ownerId,
      lootId,
      targetKind: 'printer',
      targetId: printerId,
      status: 'converting',
      convertedFileId: fileId,
    });

    await db().delete(schema.lootFiles).where(eq(schema.lootFiles.id, fileId));

    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows.length).toBe(1);
    expect(rows[0]?.convertedFileId).toBeNull();
  });

  it('16. expected indexes are present', () => {
    const sqlite = (
      db() as unknown as {
        $client: {
          prepare: (s: string) => { all: () => Array<{ name: string }> };
        };
      }
    ).$client;
    const idxFor = (table: string): string[] =>
      sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${table}'`)
        .all()
        .map((r) => r.name);

    expect(idxFor('agents')).toEqual(
      expect.arrayContaining(['agents_kind_idx', 'agents_last_seen_idx']),
    );
    expect(idxFor('printers')).toEqual(
      expect.arrayContaining([
        'printers_owner_idx',
        'printers_owner_active_idx',
        'printers_kind_idx',
      ]),
    );
    expect(idxFor('printer_reachable_via')).toEqual(
      expect.arrayContaining([
        'printer_reachable_via_pk',
        'printer_reachable_via_agent_idx',
      ]),
    );
    expect(idxFor('forge_slicers')).toEqual(
      expect.arrayContaining(['forge_slicers_owner_idx', 'forge_slicers_kind_idx']),
    );
    expect(idxFor('printer_acls')).toEqual(
      expect.arrayContaining(['printer_acls_printer_user_idx', 'printer_acls_user_idx']),
    );
    expect(idxFor('slicer_acls')).toEqual(
      expect.arrayContaining(['slicer_acls_slicer_user_idx', 'slicer_acls_user_idx']),
    );
    expect(idxFor('dispatch_jobs')).toEqual(
      expect.arrayContaining([
        'dispatch_jobs_owner_idx',
        'dispatch_jobs_status_idx',
        'dispatch_jobs_claim_marker_idx',
        'dispatch_jobs_loot_idx',
        'dispatch_jobs_target_idx',
      ]),
    );
  });
});
