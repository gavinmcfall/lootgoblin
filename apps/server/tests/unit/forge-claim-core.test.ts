/**
 * Unit tests for V2-006a-T3 claim-core.ts
 *
 * Coverage:
 *   findClaimableCandidate:
 *     1. No claimable jobs → null
 *     2. Slicer-target claimable job → returned (no reachability check)
 *     3. Printer-target claimable job + agent in printer_reachable_via → returned
 *     4. Printer-target claimable job + agent NOT in printer_reachable_via → null
 *     5. Both slicer and printer candidates → older one wins
 *
 *   loadPrinterForJob:
 *     6. Existing printer → PrinterRow with correct fields
 *     7. Non-existent printer → null
 *
 *   loadArtifactForJob:
 *     8. Existing artifact → ArtifactRow including mimeType
 *     9. Non-existent job → null
 *     10. Artifact with null mimeType → mimeType field is null
 *
 *   buildExecutionBundle:
 *     11. Printer-target job with printer + artifact → full bundle
 *     12. Slicer-target job → printer null, credential null
 *     13. Job not found → returned with empty fields (no throw)
 *     14. connectionConfig returned as parsed object when stored as JSON string
 */

import { existsSync, unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { runMigrations, resetDbCache, getServerDb, schema } from '../../src/db/client';
import {
  findClaimableCandidate,
  loadPrinterForJob,
  loadArtifactForJob,
  buildExecutionBundle,
  type ClaimableCandidate,
  type PrinterRow,
  type ArtifactRow,
  type ExecutionBundle,
} from '../../src/forge/dispatch/claim-core';

const DB_PATH = '/tmp/lootgoblin-forge-claim-core.db';
const DB_URL = `file:${DB_PATH}`;

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
}, 30_000);

function db() {
  return getServerDb(DB_URL);
}

function uid() {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Claim Core Test User',
    email: `${id}@claim-core.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedAgent(kind = 'central_worker'): Promise<string> {
  const id = uid();
  db().insert(schema.agents).values({ id, kind }).run();
  return id;
}

async function seedPrinter(ownerId: string, kind = 'fdm_klipper'): Promise<string> {
  const id = uid();
  db()
    .insert(schema.printers)
    .values({
      id,
      ownerId,
      kind,
      name: `Printer ${id.slice(0, 8)}`,
      connectionConfig: { url: 'http://10.0.0.2:7125', apiKey: 'test-key' },
    })
    .run();
  return id;
}

async function seedSlicer(ownerId: string): Promise<string> {
  const id = uid();
  db()
    .insert(schema.forgeSlicers)
    .values({
      id,
      ownerId,
      kind: 'orcaslicer',
      invocationMethod: 'url-scheme',
      name: `Slicer ${id.slice(0, 8)}`,
    })
    .run();
  return id;
}

async function seedStashRoot(ownerId: string): Promise<string> {
  const id = uid();
  db()
    .insert(schema.stashRoots)
    .values({
      id,
      ownerId,
      name: 'Test Root',
      path: '/tmp/test-stash',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return id;
}

async function seedCollection(ownerId: string, stashRootId: string): Promise<string> {
  const id = uid();
  db()
    .insert(schema.collections)
    .values({
      id,
      ownerId,
      stashRootId,
      name: `Col ${id.slice(0, 8)}`,
      pathTemplate: '{title|slug}',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return id;
}

async function seedLoot(collectionId: string): Promise<string> {
  const id = uid();
  db()
    .insert(schema.loot)
    .values({
      id,
      collectionId,
      title: `Loot ${id.slice(0, 8)}`,
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return id;
}

async function seedDispatchJob(
  ownerId: string,
  lootId: string,
  targetKind: 'printer' | 'slicer',
  targetId: string,
  status: string = 'claimable',
  createdAt?: Date,
): Promise<string> {
  const id = uid();
  db()
    .insert(schema.dispatchJobs)
    .values({
      id,
      ownerId,
      lootId,
      targetKind,
      targetId,
      status,
      ...(createdAt ? { createdAt } : {}),
    })
    .run();
  return id;
}

async function seedArtifact(
  dispatchJobId: string,
  overrides: Partial<{
    storagePath: string;
    sizeBytes: number;
    sha256: string;
    mimeType: string | null;
    kind: string;
  }> = {},
): Promise<string> {
  const id = uid();
  db()
    .insert(schema.forgeArtifacts)
    .values({
      id,
      dispatchJobId,
      kind: overrides.kind ?? 'gcode',
      storagePath: overrides.storagePath ?? `/tmp/artifact-${id}.gcode`,
      sizeBytes: overrides.sizeBytes ?? 1024,
      sha256: overrides.sha256 ?? 'abc123',
      mimeType: overrides.mimeType !== undefined ? overrides.mimeType : 'application/octet-stream',
    })
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findClaimableCandidate', () => {
  // Clear dispatch_jobs between tests to prevent cross-test pollution.
  // The dispatch_jobs table accumulates rows from previous tests which can
  // cause tests that expect null to see leftover slicer-target rows (which
  // bypass the reachability filter).
  beforeEach(() => {
    db().delete(schema.dispatchJobs).run();
  });

  it('1. no claimable jobs → null', async () => {
    const agentId = await seedAgent();
    const result = await findClaimableCandidate(agentId, DB_URL);
    expect(result).toBeNull();
  });

  it('2. slicer-target claimable job → returned regardless of reachability', async () => {
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);
    const lootId = await seedLoot(colId);
    const slicerId = await seedSlicer(ownerId);
    const agentId = await seedAgent();

    await seedDispatchJob(ownerId, lootId, 'slicer', slicerId);

    const result = await findClaimableCandidate(agentId, DB_URL);
    expect(result).not.toBeNull();
    expect(result!.targetKind).toBe('slicer');
    expect(result!.targetId).toBe(slicerId);
    expect(result!.ownerId).toBe(ownerId);
    expect(result!.lootId).toBe(lootId);
  });

  it('3. printer-target + agent in printer_reachable_via → returned', async () => {
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);
    const lootId = await seedLoot(colId);
    const printerId = await seedPrinter(ownerId);
    const agentId = await seedAgent();

    db().insert(schema.printerReachableVia).values({ printerId, agentId }).run();
    await seedDispatchJob(ownerId, lootId, 'printer', printerId);

    const result = await findClaimableCandidate(agentId, DB_URL);
    expect(result).not.toBeNull();
    expect(result!.targetKind).toBe('printer');
    expect(result!.targetId).toBe(printerId);
  });

  it('4. printer-target + agent NOT in printer_reachable_via → null', async () => {
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);
    const lootId = await seedLoot(colId);
    const printerId = await seedPrinter(ownerId);
    const agentId = await seedAgent(); // no reachable_via row

    await seedDispatchJob(ownerId, lootId, 'printer', printerId);

    const result = await findClaimableCandidate(agentId, DB_URL);
    expect(result).toBeNull();
  });

  it('5. slicer and printer candidates — older createdAt wins', async () => {
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);
    const lootId = await seedLoot(colId);
    const printerId = await seedPrinter(ownerId);
    const slicerId = await seedSlicer(ownerId);
    const agentId = await seedAgent();

    db().insert(schema.printerReachableVia).values({ printerId, agentId }).run();

    // Create printer job first (older)
    const olderDate = new Date(Date.now() - 60_000);
    const newerDate = new Date();

    const printerJobId = await seedDispatchJob(ownerId, lootId, 'printer', printerId, 'claimable', olderDate);
    await seedDispatchJob(ownerId, lootId, 'slicer', slicerId, 'claimable', newerDate);

    const result = await findClaimableCandidate(agentId, DB_URL);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(printerJobId);
    expect(result!.targetKind).toBe('printer');
  });
});

describe('loadPrinterForJob', () => {
  it('6. existing printer → PrinterRow with correct fields', async () => {
    const ownerId = await seedUser();
    const printerId = await seedPrinter(ownerId, 'fdm_klipper');

    const result = await loadPrinterForJob(printerId, DB_URL);
    expect(result).not.toBeNull();
    const row = result as PrinterRow;
    expect(row.id).toBe(printerId);
    expect(row.ownerId).toBe(ownerId);
    expect(row.kind).toBe('fdm_klipper');
    expect(row.connectionConfig).toBeTruthy();
  });

  it('7. non-existent printer → null', async () => {
    const result = await loadPrinterForJob('nonexistent-id', DB_URL);
    expect(result).toBeNull();
  });
});

describe('loadArtifactForJob', () => {
  it('8. existing artifact → ArtifactRow including mimeType', async () => {
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);
    const lootId = await seedLoot(colId);
    const slicerId = await seedSlicer(ownerId);
    const jobId = await seedDispatchJob(ownerId, lootId, 'slicer', slicerId);

    await seedArtifact(jobId, {
      storagePath: '/tmp/test.gcode',
      sizeBytes: 2048,
      sha256: 'deadbeef',
      mimeType: 'text/x.gcode',
    });

    const result = await loadArtifactForJob(jobId, DB_URL);
    expect(result).not.toBeNull();
    const row = result as ArtifactRow;
    expect(row.storagePath).toBe('/tmp/test.gcode');
    expect(row.sizeBytes).toBe(2048);
    expect(row.sha256).toBe('deadbeef');
    expect(row.mimeType).toBe('text/x.gcode');
  });

  it('9. non-existent job → null', async () => {
    const result = await loadArtifactForJob('nonexistent-job-id', DB_URL);
    expect(result).toBeNull();
  });

  it('10. artifact with null mimeType → mimeType field is null', async () => {
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);
    const lootId = await seedLoot(colId);
    const slicerId = await seedSlicer(ownerId);
    const jobId = await seedDispatchJob(ownerId, lootId, 'slicer', slicerId);

    await seedArtifact(jobId, { mimeType: null });

    const result = await loadArtifactForJob(jobId, DB_URL);
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBeNull();
  });
});

describe('buildExecutionBundle', () => {
  it('11. printer-target job with printer + artifact → full bundle shape', async () => {
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);
    const lootId = await seedLoot(colId);
    const printerId = await seedPrinter(ownerId, 'fdm_klipper');
    const jobId = await seedDispatchJob(ownerId, lootId, 'printer', printerId);

    await seedArtifact(jobId, {
      storagePath: '/tmp/bundle-test.gcode',
      sizeBytes: 4096,
      sha256: 'bundlehash',
      mimeType: 'application/octet-stream',
    });

    // Set the env var for LOOTGOBLIN_SECRET so getCredential doesn't throw
    // (no credential row exists — it will return null gracefully).
    process.env.LOOTGOBLIN_SECRET = 'this-is-a-32-char-secret-for-test!';

    const bundle = await buildExecutionBundle(jobId, DB_URL);
    const b = bundle as ExecutionBundle;

    // job shape
    expect(b.job.id).toBe(jobId);
    expect(b.job.ownerId).toBe(ownerId);
    expect(b.job.lootId).toBe(lootId);
    expect(b.job.targetKind).toBe('printer');
    expect(b.job.targetId).toBe(printerId);

    // printer shape
    expect(b.printer).not.toBeNull();
    expect(b.printer!.id).toBe(printerId);
    expect(b.printer!.kind).toBe('fdm_klipper');
    expect(typeof b.printer!.connectionConfig).toBe('object');
    expect(b.printer!.connectionConfig).toMatchObject({ url: 'http://10.0.0.2:7125' });

    // credential — no row seeded, should be null
    expect(b.credential).toBeNull();

    // artifact shape
    expect(b.artifact).not.toBeNull();
    expect(b.artifact!.jobId).toBe(jobId);
    expect(b.artifact!.storagePath).toBe('/tmp/bundle-test.gcode');
    expect(b.artifact!.sizeBytes).toBe(4096);
    expect(b.artifact!.sha256).toBe('bundlehash');
    expect(b.artifact!.mimeType).toBe('application/octet-stream');
  });

  it('12. slicer-target job → printer null, credential null', async () => {
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);
    const lootId = await seedLoot(colId);
    const slicerId = await seedSlicer(ownerId);
    const jobId = await seedDispatchJob(ownerId, lootId, 'slicer', slicerId);

    process.env.LOOTGOBLIN_SECRET = 'this-is-a-32-char-secret-for-test!';

    const bundle = await buildExecutionBundle(jobId, DB_URL);
    expect(bundle).not.toBeNull();
    expect(bundle!.job.targetKind).toBe('slicer');
    expect(bundle!.printer).toBeNull();
    expect(bundle!.credential).toBeNull();
    expect(bundle!.artifact).toBeNull();
  });

  it('13. job not found → null (no throw, distinguishable from incomplete bundle)', async () => {
    process.env.LOOTGOBLIN_SECRET = 'this-is-a-32-char-secret-for-test!';

    const bundle = await buildExecutionBundle('no-such-job', DB_URL);
    expect(bundle).toBeNull();
  });

  it('14. connectionConfig parsed as object even if underlying driver returns JSON string', async () => {
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);
    const lootId = await seedLoot(colId);

    // Seed printer with JSON string connectionConfig directly via SQLite raw
    // to simulate the defensive parse path.
    const printerId = uid();
    const jsonStr = JSON.stringify({ url: 'http://10.0.0.3:7125', apiKey: 'raw-test' });
    (db() as unknown as { $client: { exec: (s: string) => void } }).$client.exec(
      `INSERT INTO printers (id, owner_id, kind, name, connection_config, active, created_at)
       VALUES ('${printerId}', '${ownerId}', 'fdm_klipper', 'Raw JSON Printer', '${jsonStr}', 1, ${Date.now()})`,
    );

    const jobId = await seedDispatchJob(ownerId, lootId, 'printer', printerId);

    process.env.LOOTGOBLIN_SECRET = 'this-is-a-32-char-secret-for-test!';

    const bundle = await buildExecutionBundle(jobId, DB_URL);
    expect(bundle).not.toBeNull();
    expect(bundle!.printer).not.toBeNull();
    // Whether or not the driver returns string or object, connectionConfig
    // must always be a plain object after buildExecutionBundle.
    expect(typeof bundle!.printer!.connectionConfig).toBe('object');
    expect(bundle!.printer!.connectionConfig).toMatchObject({ url: 'http://10.0.0.3:7125' });
  });
});
