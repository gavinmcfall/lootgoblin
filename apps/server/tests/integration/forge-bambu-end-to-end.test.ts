/**
 * End-to-end integration test — V2-005d-b T_db4.
 *
 * Mirrors `forge-octoprint-end-to-end.test.ts` (V2-005d-d T_dd2) but exercises
 * the Bambu LAN dispatcher instead. The full chain:
 *
 *   1. POST /api/v1/forge/printers/:id/credentials → AES-GCM encrypt + store
 *      (kind='bambu_lan', payload={ accessCode, serial })
 *   2. Worker reads dispatch_jobs WHERE status='claimable'
 *   3. Worker resolves DispatchHandlerRegistry → Bambu adapter (bambu_h2c kind)
 *   4. Adapter decrypts credential + extracts AMS metadata from .gcode.3mf
 *   5. Adapter performs FTPS upload (mocked basic-ftp factory captures
 *      access opts + uploadFrom call)
 *   6. Adapter publishes MQTT print command (mocked mqtt factory captures
 *      url + opts + topic + payload)
 *   7. Adapter touches forge_target_credentials.last_used_at
 *   8. Worker drives dispatch_job claimable → claimed → dispatched (resting;
 *      V2-005f closes dispatched → completed via real printer status events).
 *      Per FE-L4 / FD-L4: state STOPS at 'dispatched' — completedAt remains null.
 *
 * Adapter unit/edge cases live in `forge-bambu-lan-adapter.test.ts`. AMS
 * extractor coverage lives in `forge-bambu-ams-extractor.test.ts`. This file
 * verifies the full V2-005d-b wiring across all primitives at once — including
 * the real T_db2 AMS extractor parsing a programmatically-built fixture.
 *
 * Logging audit: this test does NOT assert that `accessCode` is absent from
 * logs, but does ensure no captured assertion ever inspects log output for
 * the secret. The adapter's logging policy (T_db3) is enforced by code review
 * and the dedicated unit suite.
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
import JSZip from 'jszip';

import { runMigrations, getDb, resetDbCache, schema } from '../../src/db/client';
import { bootstrapCentralWorker } from '../../src/forge/agent-bootstrap';
import { getDefaultRegistry } from '../../src/forge/dispatch/registry';
import { createBambuLanHandler } from '../../src/forge/dispatch/bambu/adapter';
import type { DispatchHandler } from '../../src/forge/dispatch/handler';

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

const DB_PATH = '/tmp/lootgoblin-forge-bambu-e2e.db';
const DB_URL = `file:${DB_PATH}`;
const TEST_SECRET = 'x'.repeat(32);
const TEST_ACCESS_CODE = 'TESTCODE12345678';
const TEST_SERIAL = 'TEST123SERIAL';
const PRINTER_HOST = 'test-bambu';
const PRINTER_MQTT_PORT = 8883;
const PRINTER_FTP_PORT = 990;
const PRINTER_KIND = 'bambu_h2c';

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
// Mock MQTT + FTP factories — capture everything the adapter sends.
// ---------------------------------------------------------------------------

interface CapturedMqttPublish {
  topic: string | null;
  payload: string | null;
}
interface CapturedMqttFactory {
  url: string | null;
  opts:
    | {
        username: string;
        password: string;
        clientId: string;
        rejectUnauthorized: boolean;
      }
    | null;
}
interface CapturedFtpAccess {
  host: string | null;
  port: number | null;
  user: string | null;
  password: string | null;
  secure: string | null;
  rejectUnauthorized: boolean | null;
}
interface CapturedFtpUpload {
  src: string | null;
  dest: string | null;
}

let mqttPublish: CapturedMqttPublish;
let mqttConnect: CapturedMqttFactory;
let ftpAccess: CapturedFtpAccess;
let ftpUpload: CapturedFtpUpload;
let mqttFactoryCalls: number;
let ftpFactoryCalls: number;

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

  mqttPublish = { topic: null, payload: null };
  mqttConnect = { url: null, opts: null };
  ftpAccess = {
    host: null,
    port: null,
    user: null,
    password: null,
    secure: null,
    rejectUnauthorized: null,
  };
  ftpUpload = { src: null, dest: null };
  mqttFactoryCalls = 0;
  ftpFactoryCalls = 0;

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
    name: 'Bambu E2E User',
    email: `${id}@bambu-e2e.test`,
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
    name: 'bambue2e-root',
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
    title: 'BambuCube',
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
    name: `Bambu-${id.slice(0, 8)}`,
    connectionConfig: {
      ip: PRINTER_HOST,
      mqttPort: PRINTER_MQTT_PORT,
      ftpPort: PRINTER_FTP_PORT,
      startPrint: true,
      forceAmsDisabled: false,
      plateIndex: 1,
      bedType: 'auto',
      bedLevelling: true,
      flowCalibration: true,
      vibrationCalibration: true,
      layerInspect: false,
      timelapse: false,
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
    mimeType: 'application/vnd.bambulab.threemf',
    metadataJson: null,
    createdAt: new Date(),
  });
}

/**
 * Build a real `.gcode.3mf` ZIP archive containing a valid 4-color AMS
 * `Metadata/slice_info.config`. The real T_db2 extractor will parse this in
 * the test, so the assertions on `print.use_ams` and `print.ams_mapping`
 * exercise the genuine extraction path — not a mock.
 */
async function buildAmsFixture(filepath: string): Promise<{
  sizeBytes: number;
  sha256: string;
}> {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <filament id="0" type="PLA" color="#FF0000"/>
    <filament id="1" type="PLA" color="#00FF00"/>
    <filament id="2" type="PLA" color="#0000FF"/>
    <filament id="3" type="PLA" color="#FFFFFF"/>
  </plate>
</config>`;
  const zip = new JSZip();
  zip.file('Metadata/slice_info.config', xml);
  zip.file('Metadata/plate_1.gcode', '; lootgoblin V2-005d-b end-to-end\nG28\nM84\n');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  await fsp.writeFile(filepath, buf);
  const sizeBytes = (await fsp.stat(filepath)).size;
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { sizeBytes, sha256 };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('Bambu LAN dispatch end-to-end — V2-005d-b T_db4', () => {
  it('claimable job → registry → adapter → mocked FTPS+MQTT → dispatched + last_used_at bumped', async () => {
    // 1. Bootstrap central worker.
    const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const centralAgentId = bootstrap.agentId;

    // 2. Create per-test tmpdir + a real .gcode.3mf fixture (4-color AMS).
    const tmpdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bambu-e2e-'));
    const fixturePath = path.join(tmpdir, 'multi-color.gcode.3mf');
    const { sizeBytes, sha256 } = await buildAmsFixture(fixturePath);

    // 3. Seed fixtures.
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId, tmpdir);
    const printerId = await seedPrinter(ownerId);
    // Make printer reachable by the central worker (T_da6 contract).
    await db().insert(schema.printerReachableVia).values({
      printerId,
      agentId: centralAgentId,
    });

    // 4. Set credentials VIA THE ROUTE (validates route accepts bambu_lan +
    //    envelope crypto round-trips through DB).
    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const { POST: credPost } = await import(
      '../../src/app/api/v1/forge/printers/[id]/credentials/route'
    );
    const credRes = await credPost(
      new Request(`http://local/api/v1/forge/printers/${printerId}/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'bambu_lan',
          payload: { accessCode: TEST_ACCESS_CODE, serial: TEST_SERIAL },
          label: 'e2e-test',
        }),
      }) as unknown as import('next/server').NextRequest,
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(credRes.status).toBe(201);

    // 5. Seed the dispatch_job + forge_artifacts row.
    const jobId = await seedDispatchJob({ ownerId, lootId, printerId });
    await seedArtifact({ jobId, storagePath: fixturePath, sizeBytes, sha256 });

    // 6. Build mock FTP + MQTT factories. The adapter exercises the REAL
    //    AMS extractor (T_db2) against the fixture above.
    const mockFtpClient = {
      access: vi.fn(
        async (opts: {
          host: string;
          port: number;
          user: string;
          password: string;
          secure: 'implicit';
          secureOptions: { rejectUnauthorized: boolean; checkServerIdentity: () => null | Error };
        }) => {
          ftpAccess.host = opts.host;
          ftpAccess.port = opts.port;
          ftpAccess.user = opts.user;
          ftpAccess.password = opts.password;
          ftpAccess.secure = opts.secure;
          ftpAccess.rejectUnauthorized = opts.secureOptions.rejectUnauthorized;
        },
      ),
      uploadFrom: vi.fn(async (src: string, dest: string) => {
        ftpUpload.src = src;
        ftpUpload.dest = dest;
      }),
      close: vi.fn(),
    };
    const mockFtpFactory = vi.fn(() => {
      ftpFactoryCalls += 1;
      return mockFtpClient;
    });

    const mockMqttClient = {
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
          // Fire `connect` asynchronously so the adapter has time to wire
          // up the publish callback path inside the same Promise.
          queueMicrotask(() => listener());
        }
      }),
    };
    const mockMqttFactory = vi.fn(
      (
        url: string,
        opts: { username: string; password: string; clientId: string; rejectUnauthorized: boolean },
      ) => {
        mqttFactoryCalls += 1;
        mqttConnect.url = url;
        mqttConnect.opts = { ...opts };
        return mockMqttClient;
      },
    );

    // 7. Register the REAL Bambu handler under the per-model kind, mirroring
    //    instrumentation's wrapping pattern. Mocked factories isolate the
    //    network surface; the AMS extractor remains real.
    const handler = createBambuLanHandler({
      mqttFactory: mockMqttFactory,
      ftpFactory: mockFtpFactory,
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

    // 9. Assert dispatch_job reached 'dispatched' (the worker's resting state
    //    after a successful upload + MQTT publish). Per FE-L4 / FD-L4: state
    //    stops at 'dispatched'; dispatched → completed is closed by V2-005f
    //    via real printer status events.
    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('dispatched');
    expect(rows[0]!.startedAt).not.toBeNull();
    expect(rows[0]!.completedAt).toBeNull();

    // 10. FTP factory + access + upload assertions.
    expect(ftpFactoryCalls).toBe(1);
    expect(mockFtpClient.access).toHaveBeenCalledTimes(1);
    expect(ftpAccess.host).toBe(PRINTER_HOST);
    expect(ftpAccess.port).toBe(PRINTER_FTP_PORT);
    expect(ftpAccess.user).toBe('bblp');
    expect(ftpAccess.password).toBe(TEST_ACCESS_CODE);
    expect(ftpAccess.secure).toBe('implicit');
    expect(ftpAccess.rejectUnauthorized).toBe(false);
    expect(mockFtpClient.uploadFrom).toHaveBeenCalledTimes(1);
    expect(ftpUpload.src).toBe(fixturePath);
    expect(ftpUpload.dest).toBe('/cache/multi-color.gcode.3mf');
    expect(mockFtpClient.close).toHaveBeenCalledTimes(1);

    // 11. MQTT factory + connect opts.
    expect(mqttFactoryCalls).toBe(1);
    expect(mqttConnect.url).toBe(`mqtts://${PRINTER_HOST}:${PRINTER_MQTT_PORT}`);
    expect(mqttConnect.opts).not.toBeNull();
    expect(mqttConnect.opts!.username).toBe('bblp');
    expect(mqttConnect.opts!.password).toBe(TEST_ACCESS_CODE);
    expect(mqttConnect.opts!.rejectUnauthorized).toBe(false);
    expect(mqttConnect.opts!.clientId).toMatch(/^lootgoblin-/);

    // 12. MQTT publish topic + payload structure (real AMS extractor output).
    expect(mockMqttClient.publish).toHaveBeenCalledTimes(1);
    expect(mqttPublish.topic).toBe(`device/${TEST_SERIAL}/request`);
    expect(mqttPublish.payload).not.toBeNull();
    const parsed = JSON.parse(mqttPublish.payload!) as {
      print: {
        command: string;
        url: string;
        use_ams: boolean;
        ams_mapping: number[];
        bed_type: string;
        timelapse: boolean;
        subtask_name: string;
      };
    };
    expect(parsed.print.command).toBe('project_file');
    expect(parsed.print.url).toBe('ftp:///cache/multi-color.gcode.3mf');
    // 4-color fixture → real T_db2 extractor returns useAms=true with [0,1,2,3].
    expect(parsed.print.use_ams).toBe(true);
    expect(parsed.print.ams_mapping).toEqual([0, 1, 2, 3]);
    expect(parsed.print.bed_type).toBe('auto');
    expect(parsed.print.timelapse).toBe(false);
    expect(parsed.print.subtask_name).toBe('multi-color');

    // 13. Assert touchLastUsed bumped the credentials row.
    const credRows = await db()
      .select()
      .from(schema.forgeTargetCredentials)
      .where(eq(schema.forgeTargetCredentials.printerId, printerId));
    expect(credRows).toHaveLength(1);
    expect(credRows[0]!.lastUsedAt).not.toBeNull();

    // 14. Cleanup tmpdir (best-effort).
    await fsp.rm(tmpdir, { recursive: true, force: true });
  });
});
