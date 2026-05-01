/**
 * End-to-end integration test — V2-005d-c T_dc12.
 *
 * Mirrors `forge-sdcp-end-to-end.test.ts` (T_dc11) but exercises the
 * ChituNetwork TCP M-code dispatcher (Phrozen Sonic Mighty 8K + Uniformation
 * GKtwo + other locked-board ChiTu network printers). Two cases:
 *
 *   POSITIVE — encrypted CTB to Phrozen Mighty 8K. The full chain:
 *     1. POST /api/v1/forge/printers/:id/credentials → AES-GCM encrypt + store.
 *        Reuses the `sdcp_passcode` kind with payload={} for handler-fetch
 *        uniformity per V2-005d-c plan; ChituNetwork has no protocol-level
 *        auth so the row carries no secret material.
 *     2. Worker reads dispatch_jobs WHERE status='claimable'.
 *     3. Worker resolves DispatchHandlerRegistry → ChituNetwork adapter.
 *     4. Adapter validates connectionConfig + reads encrypted .ctb from disk.
 *     5. Adapter passes the encrypted-CTB magic-bytes gate (first 4 bytes
 *        match `0x12 0xfd 0x90 0xc1`).
 *     6. Adapter opens a TCP socket (mocked tcpSocketFactory captures port +
 *        host + every write) and drives M28 → chunk(s) → M29 → M6030.
 *     7. The reply-rule mock auto-acknowledges every command line + chunk
 *        frame with `ok\n` (mirrors T_dc8's auto-reply pattern), so the
 *        commander walks straight through the protocol.
 *     8. Adapter touches forge_target_credentials.last_used_at.
 *     9. Worker drives dispatch_job claimable → claimed → dispatched (resting;
 *        per FE-L4 / FD-L4 state STOPS at 'dispatched').
 *
 *   NEGATIVE — plain (unencrypted) CTB to Phrozen Mighty 8K is rejected at
 *   the magic-bytes gate BEFORE any TCP socket is opened. The job lands in
 *   `failed` with reason `target-rejected` (T_dc8 maps adapter `rejected` →
 *   schema `target-rejected` via failure-reason-map.ts) and failure_details
 *   mentions "encrypted CTB" + "Chitubox".
 *
 * Commander/adapter unit edge cases live in their dedicated suites
 * (forge-chitu-commander.test.ts + forge-chitu-adapter.test.ts). This file
 * verifies the V2-005d-c wiring across all primitives at once.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, getDb, resetDbCache, schema } from '../../src/db/client';
import { bootstrapCentralWorker } from '../../src/forge/agent-bootstrap';
import { getDefaultRegistry } from '../../src/forge/dispatch/registry';
import { createChituNetworkHandler } from '../../src/forge/dispatch/chitu-network/adapter';
import type { DispatchHandler } from '../../src/forge/dispatch/handler';
import type {
  TcpSocketLike,
  TcpSocketFactory,
} from '../../src/forge/dispatch/chitu-network/commander';

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

const DB_PATH = '/tmp/lootgoblin-forge-chitu-e2e.db';
const DB_URL = `file:${DB_PATH}`;
const TEST_SECRET = 'x'.repeat(32);
const PRINTER_HOST = 'test-chitu-printer';
const PRINTER_PORT = 3000;
const PRINTER_KIND = 'chitu_network_phrozen_sonic_mighty_8k';

const ENCRYPTED_CTB_V4_MAGIC = Buffer.from([0x12, 0xfd, 0x90, 0xc1]);
const PLAIN_CTB_V3_MAGIC = Buffer.from([0x07, 0x00, 0x00, 0x00]);

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

// ---------------------------------------------------------------------------
// Mock TCP socket — reply-rule pattern lifted from
// tests/unit/forge-chitu-adapter.test.ts. Auto-acks every write with `ok\n`
// (deferred to setImmediate so the commander has time to install its waiter
// before the printer reply lands).
// ---------------------------------------------------------------------------

interface MockTcpSocket {
  socket: TcpSocketLike;
  writes: Buffer[];
  destroyed: () => boolean;
  connectCall: () => { port: number; host: string } | null;
}

function createMockTcpSocket(opts?: {
  reply?: (write: Buffer | string) => Buffer | string | undefined;
}): MockTcpSocket {
  const writes: Buffer[] = [];
  const dataListeners: Array<(data: Buffer) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const closeListeners: Array<() => void> = [];
  const connectListenersOnce: Array<() => void> = [];
  let destroyed = false;
  let connectArgs: { port: number; host: string } | null = null;
  const reply = opts?.reply;

  const fireDataInternal = (data: Buffer | string): void => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    for (const fn of dataListeners.slice()) fn(buf);
  };

  const socket: TcpSocketLike = {
    connect: vi.fn((port: number, host: string, cb?: () => void) => {
      connectArgs = { port, host };
      // Auto-fire 'connect' on next microtask.
      queueMicrotask(() => {
        for (const fn of connectListenersOnce.splice(0, connectListenersOnce.length)) {
          fn();
        }
        if (cb) cb();
      });
    }),
    write: vi.fn((data: Buffer | string, cb?: (err?: Error) => void) => {
      writes.push(Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, 'utf8'));
      if (cb) cb(undefined);
      if (reply) {
        const r = reply(data);
        if (r !== undefined) {
          // Defer past the commander's `await writeBuf` so installWaiter has
          // run before the reply arrives.
          setImmediate(() => fireDataInternal(r));
        }
      }
    }),
    end: vi.fn(() => {}),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      if (event === 'data') dataListeners.push(listener as (d: Buffer) => void);
      else if (event === 'error') errorListeners.push(listener as (e: Error) => void);
      else if (event === 'close') closeListeners.push(listener as () => void);
    }),
    once: vi.fn((event: string, listener: (...args: any[]) => void) => {
      if (event === 'error') {
        const wrapped = (err: Error): void => {
          const idx = errorListeners.indexOf(wrapped as (e: Error) => void);
          if (idx >= 0) errorListeners.splice(idx, 1);
          (listener as (e: Error) => void)(err);
        };
        errorListeners.push(wrapped as (e: Error) => void);
      } else if (event === 'connect') {
        connectListenersOnce.push(listener as () => void);
      }
    }),
  };

  return {
    socket,
    writes,
    destroyed: () => destroyed,
    connectCall: () => connectArgs,
  };
}

const ALWAYS_OK_REPLY = (data: Buffer | string): string => {
  void data;
  return 'ok\n';
};

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${DB_PATH}${suffix}`);
    } catch {
      /* ignore */
    }
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
  resetDbCache();
  await runMigrations(DB_URL);
});

afterAll(() => {
  delete process.env.LOOTGOBLIN_SECRET;
  getDefaultRegistry().clear();
});

beforeEach(async () => {
  // FK order. forge_target_credentials → printers → user; forge_artifacts →
  // dispatch_jobs → loot/printers/user.
  await db().delete(schema.forgeTargetCredentials);
  await db().delete(schema.forgeArtifacts);
  await db().delete(schema.dispatchJobs);
  await db().delete(schema.printerReachableVia);
  await db().delete(schema.printers);
  await db().delete(schema.agents);
  await db().delete(schema.loot);
  await db().delete(schema.collections);
  await db().delete(schema.stashRoots);
  await db().delete(schema.user);

  mockAuthenticate.mockReset();
  process.env.LOOTGOBLIN_SECRET = TEST_SECRET;

  // Registry isolation per test.
  getDefaultRegistry().clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Chitu E2E User',
    email: `${id}@chitu-e2e.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(ownerId: string, tmpdir: string): Promise<string> {
  const stashRootId = uid();
  await db().insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId,
    name: 'chitue2e-root',
    path: tmpdir,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `c-${collectionId.slice(0, 6)}`,
    pathTemplate: '{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootId = uid();
  await db().insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: 'ResinCubeChitu',
    tags: [],
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return lootId;
}

async function seedPrinter(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.printers).values({
    id,
    ownerId,
    kind: PRINTER_KIND,
    name: `Mighty-${id.slice(0, 8)}`,
    connectionConfig: {
      ip: PRINTER_HOST,
      port: PRINTER_PORT,
      startPrint: true,
      stageTimeoutMs: 5000,
    },
    active: true,
    createdAt: new Date(),
  });
  return id;
}

async function seedDispatchJob(args: {
  ownerId: string;
  lootId: string;
  printerId: string;
}): Promise<string> {
  const id = uid();
  await db().insert(schema.dispatchJobs).values({
    id,
    ownerId: args.ownerId,
    lootId: args.lootId,
    targetKind: 'printer',
    targetId: args.printerId,
    status: 'claimable',
    createdAt: new Date(),
  });
  return id;
}

async function seedArtifact(args: {
  jobId: string;
  storagePath: string;
  sizeBytes: number;
  sha256: string;
}): Promise<void> {
  await db().insert(schema.forgeArtifacts).values({
    id: uid(),
    dispatchJobId: args.jobId,
    kind: 'gcode',
    storagePath: args.storagePath,
    sizeBytes: args.sizeBytes,
    sha256: args.sha256,
    mimeType: 'application/octet-stream',
    metadataJson: null,
    createdAt: new Date(),
  });
}

async function setCredentialsViaRoute(args: {
  ownerId: string;
  printerId: string;
}): Promise<void> {
  mockAuthenticate.mockResolvedValueOnce(actor(args.ownerId));
  const { POST: credPost } = await import(
    '../../src/app/api/v1/forge/printers/[id]/credentials/route'
  );
  const credRes = await credPost(
    new Request(`http://local/api/v1/forge/printers/${args.printerId}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'sdcp_passcode',
        payload: {},
        label: 'e2e-test',
      }),
    }) as unknown as import('next/server').NextRequest,
    { params: Promise.resolve({ id: args.printerId }) },
  );
  expect(credRes.status).toBe(201);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChituNetwork dispatch end-to-end — V2-005d-c T_dc12', () => {
  it('positive: encrypted CTB → claimable → registry → adapter → mocked TCP → dispatched + last_used_at bumped', async () => {
    // 1. Bootstrap central worker.
    const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const centralAgentId = bootstrap.agentId;

    // 2. Per-test tmpdir + a small encrypted-CTB fixture (magic + ~2KB random
    //    payload). Sized to fit in a single 4KiB chunk so we get exactly one
    //    chunk frame to assert the trailer math against.
    const tmpdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chitu-e2e-pos-'));
    const ctbPath = path.join(tmpdir, 'resin-cube.ctb');
    const payload = crypto.randomBytes(2048);
    const ctbBytes = Buffer.concat([ENCRYPTED_CTB_V4_MAGIC, payload]);
    await fsp.writeFile(ctbPath, ctbBytes);
    const sizeBytes = (await fsp.stat(ctbPath)).size;
    const sha256 = crypto.createHash('sha256').update(ctbBytes).digest('hex');

    // 3. Seed fixtures.
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId, tmpdir);
    const printerId = await seedPrinter(ownerId);
    await db().insert(schema.printerReachableVia).values({
      printerId,
      agentId: centralAgentId,
    });

    // 4. Set credentials via the route (sdcp_passcode + payload={} — the
    //    credentials route validates `kind` against FORGE_TARGET_CREDENTIAL_KINDS
    //    only, not against printer kind, so the existing route accepts this
    //    combination unchanged. ChituNetwork has no protocol auth so the row
    //    carries no secret material; it exists for handler-fetch uniformity.).
    await setCredentialsViaRoute({ ownerId, printerId });

    // 5. Dispatch_job + forge_artifacts row.
    const jobId = await seedDispatchJob({ ownerId, lootId, printerId });
    await seedArtifact({ jobId, storagePath: ctbPath, sizeBytes, sha256 });

    // 6. Build mock TCP socket with reply-rule (auto-ack every write).
    const mockSocket = createMockTcpSocket({ reply: ALWAYS_OK_REPLY });
    const tcpFactoryFn = vi.fn(() => mockSocket.socket);
    const tcpFactory: TcpSocketFactory = tcpFactoryFn;

    // 7. Register the REAL ChituNetwork handler under the per-model kind.
    const handler = createChituNetworkHandler({
      tcpSocketFactory: tcpFactory,
    });
    getDefaultRegistry().register({
      kind: PRINTER_KIND,
      dispatch: handler.dispatch.bind(handler),
    } as DispatchHandler);

    // 8. Drive one tick of the worker.
    const { runOneClaimTick } = await import('../../src/workers/forge-claim-worker');
    const result = await runOneClaimTick({
      agentId: centralAgentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('ran');

    // 9. dispatch_job should be in 'dispatched' (NOT 'completed' — FE-L4).
    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('dispatched');
    expect(rows[0]!.startedAt).not.toBeNull();
    expect(rows[0]!.completedAt).toBeNull();

    // 10. TCP factory called exactly once.
    expect(tcpFactoryFn).toHaveBeenCalledTimes(1);
    expect(mockSocket.connectCall()).toEqual({
      port: PRINTER_PORT,
      host: PRINTER_HOST,
    });

    // 11. Captured writes — sequence + content checks.
    const writes = mockSocket.writes;
    expect(writes.length).toBeGreaterThanOrEqual(4);

    // First write: M28 <filename>\n
    expect(writes[0]!.toString('utf8')).toBe('M28 resin-cube.ctb\n');

    // Chunk frames: end with 0x83 marker. The fixture is 2052 bytes (4 magic +
    // 2048 random) — one chunk at default 4KiB chunkSize.
    const chunkFrames = writes.filter(
      (w) => w.length >= 6 && w[w.length - 1] === 0x83,
    );
    expect(chunkFrames).toHaveLength(1);

    const frame = chunkFrames[0]!;
    // payload (sizeBytes) + 6-byte trailer
    expect(frame.length).toBe(sizeBytes + 6);
    // Trailer: file_pos = 0 LE, XOR byte, 0x83 marker.
    const trailer = frame.subarray(frame.length - 6);
    expect(trailer.readUInt32LE(0)).toBe(0);
    // Verify XOR byte against payload.
    let xor = 0;
    const framePayload = frame.subarray(0, frame.length - 6);
    for (const b of framePayload) xor ^= b;
    expect(trailer[4]).toBe(xor & 0xff);
    expect(trailer[5]).toBe(0x83);
    // Frame payload begins with the encrypted-CTB magic.
    expect(framePayload.subarray(0, 4).equals(ENCRYPTED_CTB_V4_MAGIC)).toBe(true);

    // Tail commands — M29 then M6030 (startPrint=true).
    const writeStrings = writes.map((w) => w.toString('utf8'));
    expect(writeStrings).toContain('M29\n');
    expect(writeStrings).toContain('M6030 resin-cube.ctb\n');
    // M29 must come before M6030.
    const idxM29 = writeStrings.indexOf('M29\n');
    const idxStart = writeStrings.indexOf('M6030 resin-cube.ctb\n');
    expect(idxM29).toBeGreaterThan(0);
    expect(idxStart).toBeGreaterThan(idxM29);

    // 12. Socket lifecycle — destroy() called in finally.
    expect(mockSocket.destroyed()).toBe(true);

    // 13. last_used_at bumped.
    const credRows = await db()
      .select()
      .from(schema.forgeTargetCredentials)
      .where(eq(schema.forgeTargetCredentials.printerId, printerId));
    expect(credRows).toHaveLength(1);
    expect(credRows[0]!.lastUsedAt).not.toBeNull();

    // 14. Cleanup tmpdir.
    await fsp.rm(tmpdir, { recursive: true, force: true });
  });

  it('negative: plain CTB → magic-bytes gate rejects → failed (target-rejected) + TCP NOT opened', async () => {
    // Bootstrap.
    const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const centralAgentId = bootstrap.agentId;

    // Pre-write a fake PLAIN CTB v3 file (magic 07 00 00 00).
    const tmpdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chitu-e2e-neg-'));
    const ctbPath = path.join(tmpdir, 'plain-cube.ctb');
    const payload = crypto.randomBytes(2048);
    const ctbBytes = Buffer.concat([PLAIN_CTB_V3_MAGIC, payload]);
    await fsp.writeFile(ctbPath, ctbBytes);
    const sizeBytes = (await fsp.stat(ctbPath)).size;
    const sha256 = crypto.createHash('sha256').update(ctbBytes).digest('hex');

    // Seed.
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId, tmpdir);
    const printerId = await seedPrinter(ownerId);
    await db().insert(schema.printerReachableVia).values({
      printerId,
      agentId: centralAgentId,
    });
    await setCredentialsViaRoute({ ownerId, printerId });
    const jobId = await seedDispatchJob({ ownerId, lootId, printerId });
    await seedArtifact({ jobId, storagePath: ctbPath, sizeBytes, sha256 });

    // Mock TCP factory that should NEVER be called — assertion below verifies
    // the encrypted-CTB gate fires before any socket open.
    const tcpFactoryFn = vi.fn<TcpSocketFactory>(() => {
      throw new Error('TCP factory must not be called when magic-bytes gate rejects');
    });
    const tcpFactory: TcpSocketFactory = tcpFactoryFn;

    const handler = createChituNetworkHandler({
      tcpSocketFactory: tcpFactory,
    });
    getDefaultRegistry().register({
      kind: PRINTER_KIND,
      dispatch: handler.dispatch.bind(handler),
    } as DispatchHandler);

    const { runOneClaimTick } = await import('../../src/workers/forge-claim-worker');
    const result = await runOneClaimTick({
      agentId: centralAgentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('ran');

    // dispatch_job should be 'failed' with reason 'target-rejected' (the
    // failure-reason-map collapses adapter `rejected` → schema
    // `target-rejected`). failure_details should mention "encrypted CTB" +
    // "Chitubox" (T_dc8 rejection-detail string).
    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.failureReason).toBe('target-rejected');
    expect(rows[0]!.failureDetails).toMatch(/encrypted CTB/i);
    expect(rows[0]!.failureDetails).toMatch(/Chitubox/i);
    // Note: completedAt IS populated for failed jobs by the worker (it marks
    // the terminal transition timestamp regardless of success/failure).

    // TCP factory must NOT have been invoked — gate fires before commander.
    expect(tcpFactoryFn).not.toHaveBeenCalled();

    // last_used_at NOT bumped on failure (adapter only touches on success).
    const credRows = await db()
      .select()
      .from(schema.forgeTargetCredentials)
      .where(eq(schema.forgeTargetCredentials.printerId, printerId));
    expect(credRows).toHaveLength(1);
    expect(credRows[0]!.lastUsedAt).toBeNull();

    await fsp.rm(tmpdir, { recursive: true, force: true });
  });
});
