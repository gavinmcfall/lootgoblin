/**
 * End-to-end integration test — V2-005d-c T_dc11.
 *
 * Mirrors `forge-bambu-end-to-end.test.ts` (V2-005d-b T_db4) but exercises the
 * SDCP 3.0 dispatcher (Elegoo Saturn 4 Ultra family) instead. The full chain:
 *
 *   1. POST /api/v1/forge/printers/:id/credentials → AES-GCM encrypt + store
 *      (kind='sdcp_passcode', payload={}).
 *      Note: SDCP has no protocol-level auth. The credential row exists for
 *      handler-fetch-path uniformity per the V2-005d-c plan; payload is the
 *      empty object `{}` (Zod accepts `passcode` as optional).
 *   2. Worker reads dispatch_jobs WHERE status='claimable'.
 *   3. Worker resolves DispatchHandlerRegistry → SDCP adapter.
 *   4. Adapter validates connectionConfig + reads .ctb file from disk.
 *   5. Adapter performs chunked HTTP upload (mocked HttpClient captures the
 *      multipart fields + URL).
 *   6. Adapter opens a WebSocket (mocked mqttFactory captures URL + opts) and
 *      publishes the SDCP Cmd 128 start-print message — captured topic +
 *      payload assertions verify the JSON envelope.
 *   7. Adapter touches forge_target_credentials.last_used_at.
 *   8. Worker drives dispatch_job claimable → claimed → dispatched (resting;
 *      V2-005f closes dispatched → completed via real printer status events).
 *      Per FE-L4 / FD-L4: state STOPS at 'dispatched' — completedAt remains
 *      null.
 *
 * Uploader/commander unit edge cases live in their dedicated suites. This file
 * verifies the full V2-005d-c wiring across all primitives at once.
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
import { createSdcpHandler } from '../../src/forge/dispatch/sdcp/adapter';
import type { DispatchHandler } from '../../src/forge/dispatch/handler';
import type {
  HttpClient,
  HttpResponseLike,
} from '../../src/forge/dispatch/sdcp/uploader';
import type {
  MqttClientLike,
  MqttFactory,
} from '../../src/forge/dispatch/sdcp/commander';

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

const DB_PATH = '/tmp/lootgoblin-forge-sdcp-e2e.db';
const DB_URL = `file:${DB_PATH}`;
const TEST_SECRET = 'x'.repeat(32);
const PRINTER_HOST = 'test-sdcp-printer';
const PRINTER_PORT = 3030;
const MAINBOARD_ID = 'TESTBOARDID12345';
const PRINTER_KIND = 'sdcp_elegoo_saturn_4_ultra';

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
// Mock HTTP + MQTT/WebSocket factories — capture everything the adapter sends.
// ---------------------------------------------------------------------------

interface CapturedUpload {
  url: string | null;
  fields: Record<string, string>;
  filename: string | null;
  fileSizeBytes: number | null;
}
interface CapturedMqttPublish {
  topic: string | null;
  payload: string | null;
}
interface CapturedMqttFactory {
  url: string | null;
  opts: { rejectUnauthorized: boolean } | null;
}

let capturedUpload: CapturedUpload;
let mqttPublish: CapturedMqttPublish;
let mqttConnect: CapturedMqttFactory;
let httpFetchCalls: number;
let mqttFactoryCalls: number;

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

  capturedUpload = { url: null, fields: {}, filename: null, fileSizeBytes: null };
  mqttPublish = { topic: null, payload: null };
  mqttConnect = { url: null, opts: null };
  httpFetchCalls = 0;
  mqttFactoryCalls = 0;

  // Registry isolation per test.
  getDefaultRegistry().clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'SDCP E2E User',
    email: `${id}@sdcp-e2e.test`,
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
    name: 'sdcpe2e-root',
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
    title: 'ResinCube',
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
    name: `Saturn-${id.slice(0, 8)}`,
    connectionConfig: {
      ip: PRINTER_HOST,
      mainboardId: MAINBOARD_ID,
      port: PRINTER_PORT,
      startPrint: true,
      startLayer: 0,
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

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('SDCP dispatch end-to-end — V2-005d-c T_dc11', () => {
  it('claimable job → registry → adapter → mocked HTTP+WebSocket → dispatched + last_used_at bumped', async () => {
    // 1. Bootstrap central worker.
    const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const centralAgentId = bootstrap.agentId;

    // 2. Per-test tmpdir + a tiny .ctb fixture (contents don't matter — the
    //    uploader only chunks bytes and computes MD5).
    const tmpdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sdcp-e2e-'));
    const ctbPath = path.join(tmpdir, 'resin-cube.ctb');
    const ctbBytes = Buffer.from(
      '; lootgoblin V2-005d-c-T_dc11 fake .ctb payload\n',
      'utf8',
    );
    await fsp.writeFile(ctbPath, ctbBytes);
    const sizeBytes = (await fsp.stat(ctbPath)).size;
    const sha256 = crypto.createHash('sha256').update(ctbBytes).digest('hex');

    // 3. Seed fixtures.
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId, tmpdir);
    const printerId = await seedPrinter(ownerId);
    // Make printer reachable by the central worker (T_da6 contract).
    await db().insert(schema.printerReachableVia).values({
      printerId,
      agentId: centralAgentId,
    });

    // 4. Set credentials VIA THE ROUTE (validates route accepts sdcp_passcode
    //    + payload={} despite SDCP having no protocol auth — credential row
    //    exists for handler-fetch-path uniformity per V2-005d-c plan).
    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const { POST: credPost } = await import(
      '../../src/app/api/v1/forge/printers/[id]/credentials/route'
    );
    const credRes = await credPost(
      new Request(`http://local/api/v1/forge/printers/${printerId}/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'sdcp_passcode',
          payload: {},
          label: 'e2e-test',
        }),
      }) as unknown as import('next/server').NextRequest,
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(credRes.status).toBe(201);

    // 5. Seed the dispatch_job + forge_artifacts row.
    const jobId = await seedDispatchJob({ ownerId, lootId, printerId });
    await seedArtifact({ jobId, storagePath: ctbPath, sizeBytes, sha256 });

    // 6. Build mock HTTP client. Captures the URL + multipart form fields the
    //    chunked uploader posts.
    const mockHttpClient: HttpClient = {
      fetch: vi.fn(
        async (url: string, init: RequestInit): Promise<HttpResponseLike> => {
          httpFetchCalls += 1;
          capturedUpload.url = url;
          const body = init.body;
          if (body instanceof FormData) {
            for (const [key, value] of body.entries()) {
              if (value instanceof Blob) {
                capturedUpload.filename = key === 'File' ? 'resin-cube.ctb' : null;
                capturedUpload.fileSizeBytes = value.size;
                capturedUpload.fields[key] = `<blob ${value.size}B>`;
              } else {
                capturedUpload.fields[key] = String(value);
              }
            }
          }
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => '{}',
          };
        },
      ),
    };

    // 7. Build mock WebSocket / MQTT factory. The commander expects an
    //    asynchronous `connect` event; we fire it via queueMicrotask so the
    //    `once('connect', ...)` handler is registered first inside the same
    //    Promise turn (mirrors the Bambu E2E pattern).
    const mockMqttClient: MqttClientLike = {
      publish: vi.fn(
        (
          topic: string,
          payload: string,
          _opts: object,
          cb: (err?: Error) => void,
        ) => {
          mqttPublish.topic = topic;
          mqttPublish.payload = payload;
          cb();
        },
      ),
      end: vi.fn(),
      on: vi.fn(),
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'connect') {
          queueMicrotask(() => listener());
        }
      }),
    };
    const mockMqttFactory: MqttFactory = vi.fn(
      (url: string, opts: { rejectUnauthorized: boolean }) => {
        mqttFactoryCalls += 1;
        mqttConnect.url = url;
        mqttConnect.opts = { ...opts };
        return mockMqttClient;
      },
    );

    // 8. Register the REAL SDCP handler under the per-model kind, mirroring
    //    instrumentation's wrapping pattern. Mocked factories isolate the
    //    network surface entirely.
    const handler = createSdcpHandler({
      httpClient: mockHttpClient,
      mqttFactory: mockMqttFactory,
    });
    getDefaultRegistry().register({
      kind: PRINTER_KIND,
      dispatch: handler.dispatch.bind(handler),
    } as DispatchHandler);

    // 9. Drive one tick of the worker.
    const { runOneClaimTick } = await import('../../src/workers/forge-claim-worker');
    const result = await runOneClaimTick({
      agentId: centralAgentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('ran');

    // 10. Assert dispatch_job reached 'dispatched' (the worker's resting state
    //     after a successful upload + WebSocket publish). Per FE-L4 / FD-L4:
    //     state stops at 'dispatched'; dispatched → completed is closed by
    //     V2-005f via real printer status events.
    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('dispatched');
    expect(rows[0]!.startedAt).not.toBeNull();
    expect(rows[0]!.completedAt).toBeNull();

    // 11. HTTP upload assertions — chunked uploader hit the right URL with the
    //     SDCP-required multipart fields. The fixture is small enough to fit in
    //     a single chunk, so we expect exactly one POST.
    expect(httpFetchCalls).toBeGreaterThanOrEqual(1);
    expect(capturedUpload.url).toBe(
      `http://${PRINTER_HOST}:${PRINTER_PORT}/uploadFile/upload`,
    );
    // Required SDCP form fields (T_dc3 contract).
    expect(capturedUpload.fields['S-File-MD5']).toBeDefined();
    expect(capturedUpload.fields['S-File-MD5']).toMatch(/^[0-9a-f]{32}$/);
    expect(capturedUpload.fields.Check).toBe('1'); // first/only chunk
    expect(capturedUpload.fields.Offset).toBe('0');
    expect(capturedUpload.fields.Uuid).toBeDefined();
    expect(capturedUpload.fields.TotalSize).toBe(String(sizeBytes));
    expect(capturedUpload.fields.File).toBeDefined();
    expect(capturedUpload.fileSizeBytes).toBe(sizeBytes);

    // 12. WebSocket factory + connect URL.
    expect(mqttFactoryCalls).toBe(1);
    expect(mqttConnect.url).toBe(`ws://${PRINTER_HOST}:${PRINTER_PORT}/websocket`);
    expect(mqttConnect.opts).not.toBeNull();
    expect(mqttConnect.opts!.rejectUnauthorized).toBe(false);

    // 13. WebSocket publish topic + Cmd 128 payload structure.
    expect(mockMqttClient.publish).toHaveBeenCalledTimes(1);
    expect(mqttPublish.topic).toBe(`sdcp/request/${MAINBOARD_ID}`);
    expect(mqttPublish.payload).not.toBeNull();
    const parsed = JSON.parse(mqttPublish.payload!) as {
      Id: string;
      Topic: string;
      Data: {
        Cmd: number;
        Data: { Filename: string; StartLayer: number };
        RequestID: string;
        MainboardID: string;
        TimeStamp: number;
        From: number;
      };
    };
    expect(parsed.Data.Cmd).toBe(128);
    expect(parsed.Data.Data.Filename).toBe('resin-cube.ctb');
    expect(parsed.Data.Data.StartLayer).toBe(0);
    expect(parsed.Data.MainboardID).toBe(MAINBOARD_ID);
    expect(parsed.Topic).toBe(`sdcp/request/${MAINBOARD_ID}`);
    expect(parsed.Data.From).toBe(0);

    // 14. Assert touchLastUsed bumped the credentials row. SDCP carries an
    //     empty payload but the success path still calls touch() — this is
    //     the uniform handler-fetch-path the V2-005d-c plan requires.
    const credRows = await db()
      .select()
      .from(schema.forgeTargetCredentials)
      .where(eq(schema.forgeTargetCredentials.printerId, printerId));
    expect(credRows).toHaveLength(1);
    expect(credRows[0]!.lastUsedAt).not.toBeNull();

    // 15. WebSocket cleanup — adapter must close the socket regardless of
    //     outcome (finally block in commander.ts).
    expect(mockMqttClient.end).toHaveBeenCalledTimes(1);

    // 16. Cleanup tmpdir (best-effort).
    await fsp.rm(tmpdir, { recursive: true, force: true });
  });
});
