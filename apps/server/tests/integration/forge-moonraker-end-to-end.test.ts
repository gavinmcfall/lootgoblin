/**
 * End-to-end integration test — V2-005d-a T_da7.
 *
 * Exercises the FULL Moonraker dispatch chain with msw mocking the printer:
 *
 *   1. POST /api/v1/forge/printers/:id/credentials  → AES-GCM encrypt + store
 *   2. Worker reads dispatch_jobs WHERE status='claimable'
 *   3. Worker resolves DispatchHandlerRegistry → Moonraker adapter
 *   4. Adapter decrypts credential + builds multipart upload
 *   5. msw intercepts http://test-printer:7125/server/files/upload
 *      and asserts the X-Api-Key header + form fields are correct
 *   6. Adapter touches forge_target_credentials.last_used_at
 *   7. Worker drives dispatch_job claimable → claimed → dispatched → completed
 *
 * This is a single integration test (T_da7's "single test" brief). The other
 * adapter unit/edge cases live in `forge-moonraker-adapter.test.ts`; the
 * worker mechanics live in `forge-claim-worker.test.ts`. This file's purpose
 * is to verify the wiring across all the V2-005d-a primitives at once.
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
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

import { runMigrations, getDb, resetDbCache, schema } from '../../src/db/client';
import { bootstrapCentralWorker } from '../../src/forge/agent-bootstrap';
import { getDefaultRegistry } from '../../src/forge/dispatch/registry';
import { createMoonrakerHandler } from '../../src/forge/dispatch/moonraker/adapter';

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

const DB_PATH = '/tmp/lootgoblin-forge-moonraker-e2e.db';
const DB_URL = `file:${DB_PATH}`;
const TEST_SECRET = 'x'.repeat(32);
const TEST_API_KEY = 'e2e-test-key-12345';
const PRINTER_HOST = 'test-printer';
const PRINTER_PORT = 7125;
const UPLOAD_URL = `http://${PRINTER_HOST}:${PRINTER_PORT}/server/files/upload`;

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

interface CapturedRequest {
  apiKey: string | null;
  formFields: Record<string, string>;
  filename: string | null;
}
let captured: CapturedRequest;

const server = setupServer();

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
  server.listen({ onUnhandledRequest: 'error' });
});

afterAll(() => {
  server.close();
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

  captured = { apiKey: null, formFields: {}, filename: null };

  // Registry isolation per test.
  getDefaultRegistry().clear();
});

afterEach(() => {
  server.resetHandlers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Moonraker E2E User',
    email: `${id}@moonraker-e2e.test`,
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
    name: 'mwe2e-root',
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
    title: 'Cube',
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
    kind: 'fdm_klipper',
    name: `Voron-${id.slice(0, 8)}`,
    connectionConfig: {
      host: PRINTER_HOST,
      port: PRINTER_PORT,
      scheme: 'http',
      startPrint: true,
      requiresAuth: true,
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
    mimeType: 'text/x.gcode',
    metadataJson: null,
    createdAt: new Date(),
  });
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('Moonraker dispatch end-to-end — V2-005d-a T_da7', () => {
  it('claimable job → registry → adapter → msw upload → completed + last_used_at bumped', async () => {
    // 1. Bootstrap central worker.
    const bootstrap = await bootstrapCentralWorker({ dbUrl: DB_URL });
    const centralAgentId = bootstrap.agentId;

    // 2. Create per-test tmpdir + tiny gcode artifact on disk.
    const tmpdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'moonraker-e2e-'));
    const gcodePath = path.join(tmpdir, 'cube.gcode');
    const gcodeContent = '; lootgoblin V2-005d-a end-to-end\nG28\nM84\n';
    await fsp.writeFile(gcodePath, gcodeContent);
    const sizeBytes = (await fsp.stat(gcodePath)).size;
    const sha256 = crypto
      .createHash('sha256')
      .update(gcodeContent)
      .digest('hex');

    // 3. Seed fixtures.
    const ownerId = await seedUser();
    const lootId = await seedLoot(ownerId, tmpdir);
    const printerId = await seedPrinter(ownerId);
    // Make printer reachable by the central worker (T_da6 contract).
    await db().insert(schema.printerReachableVia).values({
      printerId,
      agentId: centralAgentId,
    });

    // 4. Set credentials VIA THE ROUTE (validates route + envelope crypto).
    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const { POST: credPost } = await import(
      '../../src/app/api/v1/forge/printers/[id]/credentials/route'
    );
    const credRes = await credPost(
      new Request(`http://local/api/v1/forge/printers/${printerId}/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'moonraker_api_key',
          payload: { apiKey: TEST_API_KEY },
          label: 'e2e-test',
        }),
      }) as unknown as import('next/server').NextRequest,
      { params: Promise.resolve({ id: printerId }) },
    );
    expect(credRes.status).toBe(201);

    // 5. Seed the dispatch_job + forge_artifacts row.
    const jobId = await seedDispatchJob({ ownerId, lootId, printerId });
    await seedArtifact({ jobId, storagePath: gcodePath, sizeBytes, sha256 });

    // 6. Register the REAL Moonraker handler.
    getDefaultRegistry().register(createMoonrakerHandler());

    // 7. Wire msw to mock Moonraker. Capture the request for assertions.
    let hits = 0;
    server.use(
      http.post(UPLOAD_URL, async ({ request }) => {
        hits += 1;
        captured.apiKey = request.headers.get('X-Api-Key');
        const fd = await request.formData();
        for (const [key, value] of fd.entries()) {
          if (value instanceof File) {
            captured.filename = value.name;
            captured.formFields[key] = `<file ${value.size}B>`;
          } else {
            captured.formFields[key] = value;
          }
        }
        return HttpResponse.json(
          {
            result: { item: { path: 'cube.gcode' }, action: 'create_file' },
          },
          { status: 201 },
        );
      }),
    );

    // 8. Drive one tick of the worker.
    const { runOneClaimTick } = await import('../../src/workers/forge-claim-worker');
    const result = await runOneClaimTick({
      agentId: centralAgentId,
      dbUrl: DB_URL,
    });
    expect(result).toBe('ran');

    // 9. Assert dispatch_job reached the worker's terminal success state.
    // The worker drives claimable → claimed → dispatched → completed when the
    // handler returns kind:'success' (V2-005a-T4 + T_da6 wiring). The plan
    // brief calls out 'dispatched' as the next-stage stop, but the live worker
    // closes the loop to 'completed' until V2-005f swaps that out.
    const rows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('completed');
    expect(rows[0]!.startedAt).not.toBeNull();
    expect(rows[0]!.completedAt).not.toBeNull();

    // 10. Assert msw was hit exactly once with the right header + form fields.
    expect(hits).toBe(1);
    expect(captured.apiKey).toBe(TEST_API_KEY);
    expect(captured.formFields.root).toBe('gcodes');
    expect(captured.formFields.path).toBe('');
    expect(captured.formFields.print).toBe('true');
    expect(captured.filename).toBe('cube.gcode');

    // 11. Assert touchLastUsed bumped the credentials row.
    const credRows = await db()
      .select()
      .from(schema.forgeTargetCredentials)
      .where(eq(schema.forgeTargetCredentials.printerId, printerId));
    expect(credRows).toHaveLength(1);
    expect(credRows[0]!.lastUsedAt).not.toBeNull();

    // 12. Cleanup tmpdir (best-effort).
    await fsp.rm(tmpdir, { recursive: true, force: true });
  });
});
