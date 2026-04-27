/**
 * Integration test — V2-005c end-to-end smoke — T_c10.
 *
 * Exercises the full V2-005c install → slice → claim chain:
 *
 *   1. POST /api/v1/forge/tools/prusaslicer/install
 *      with mocked installer deps (no real GitHub fetch / AppImage download).
 *      Poll until install_status='ready'.
 *   2. Seed slicer_profiles + printer + loot + a 'slicing' dispatch_jobs row
 *      (skipping the converter path — converter tests already cover that
 *      side of the pipeline).
 *   3. Run runOneSlicerTick directly with a stubbed `run` so PrusaSlicer
 *      "succeeds" + emits a fake gcode file.
 *   4. Assert: dispatch_job → claimable, forge_artifacts row exists, the
 *      gcode is on disk under <DATA_ROOT>/forge-artifacts/<jobId>/.
 *
 * Mock everything aggressively — the goal is to verify the modules wire
 * together, not exercise real binaries.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import { setInstallerDeps } from '../../src/forge/slicer/route-helpers';
import type { RunCommand } from '../../src/forge/converter/run-command';

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
  const actual = await importOriginal<
    typeof import('../../src/auth/request-auth')
  >();
  return {
    ...actual,
    authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  };
});

const DB_PATH = '/tmp/lootgoblin-forge-slicer-e2e.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}
function uid(): string {
  return crypto.randomUUID();
}
function actor(userId: string, role: 'admin' | 'user' = 'admin') {
  return { id: userId, role, source: 'session' as const };
}

let toolsRoot: string;
let dataRoot: string;

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  process.env.DATABASE_URL = DB_URL;
  resetDbCache();
  await runMigrations(DB_URL);
});

afterAll(() => {
  setInstallerDeps(null);
  delete process.env.LOOTGOBLIN_DATA_ROOT;
  delete process.env.FORGE_TOOLS_ROOT;
  if (toolsRoot) {
    try {
      fs.rmSync(toolsRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  if (dataRoot) {
    try {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

beforeEach(async () => {
  toolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tools-e2e-'));
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-data-e2e-'));
  process.env.FORGE_TOOLS_ROOT = toolsRoot;
  process.env.LOOTGOBLIN_DATA_ROOT = dataRoot;
  delete process.env.FORGE_DISABLE_SLICING;
  // Order matters for FK cascade.
  await db().delete(schema.forgeArtifacts);
  await db().delete(schema.forgeSlicerProfileMaterializations);
  await db().delete(schema.forgeSlicerInstalls);
  await db().delete(schema.dispatchJobs);
  await db().delete(schema.printers);
  await db().delete(schema.slicerProfiles);
  await db().delete(schema.lootFiles);
  await db().delete(schema.loot);
  await db().delete(schema.collections);
  await db().delete(schema.stashRoots);
  await db().delete(schema.user);
  mockAuthenticate.mockReset();
  setInstallerDeps(null);
});

function makePost(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'POST' }) as unknown as import('next/server').NextRequest;
}

describe('V2-005c end-to-end — install → slice → claim', () => {
  it('drives a slicing job to claimable using a mocked install + slicer stub', async () => {
    // ---------------------------------------------------------------------
    // STEP 1 — User + admin actor
    // ---------------------------------------------------------------------
    const adminId = uid();
    await db().insert(schema.user).values({
      id: adminId,
      name: 'E2E Admin',
      email: `${adminId}@e2e.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // ---------------------------------------------------------------------
    // STEP 2 — Mocked install via POST /api/v1/forge/tools/prusaslicer/install
    // ---------------------------------------------------------------------
    const assetBytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]); // ELF magic
    const sha = crypto.createHash('sha256').update(assetBytes).digest('hex');
    const mockHttp = {
      fetchJson: vi.fn().mockResolvedValue({
        tag_name: 'v2.9.1',
        assets: [
          {
            name: 'PrusaSlicer-linux-x64.AppImage',
            browser_download_url: 'https://example/asset',
            size: assetBytes.byteLength,
          },
          {
            name: 'SHA256SUMS',
            browser_download_url: 'https://example/sums',
            size: 100,
          },
        ],
      }),
      fetchText: vi
        .fn()
        .mockResolvedValue(`${sha}  PrusaSlicer-linux-x64.AppImage\n`),
      fetchBytes: vi.fn().mockResolvedValue(assetBytes),
    };
    const mockRun = vi.fn();
    setInstallerDeps({ http: mockHttp as never, run: mockRun as never });

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(
      '../../src/app/api/v1/forge/tools/[slicer]/install/route'
    );
    const installRes = await POST(
      makePost('http://local/api/v1/forge/tools/prusaslicer/install'),
      { params: Promise.resolve({ slicer: 'prusaslicer' }) },
    );
    expect(installRes.status).toBe(202);

    // Poll until the install row reaches 'ready' (or fail the test if it
    // ends up 'failed' instead).
    const deadline = Date.now() + 5_000;
    let installRow: typeof schema.forgeSlicerInstalls.$inferSelect | undefined;
    while (Date.now() < deadline) {
      const rows = await db()
        .select()
        .from(schema.forgeSlicerInstalls)
        .where(eq(schema.forgeSlicerInstalls.slicerKind, 'prusaslicer'));
      if (
        rows.length > 0 &&
        (rows[0]!.installStatus === 'ready' || rows[0]!.installStatus === 'failed')
      ) {
        installRow = rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(installRow).toBeDefined();
    expect(installRow!.installStatus).toBe('ready');
    expect(installRow!.binaryPath).toBeTruthy();

    // ---------------------------------------------------------------------
    // STEP 3 — Seed slicer_profile + printer + loot + slicing dispatch_job
    // ---------------------------------------------------------------------
    const stashRootPath = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'lg-fsw-e2e-root-'),
    );
    const stashRootId = uid();
    await db().insert(schema.stashRoots).values({
      id: stashRootId,
      ownerId: adminId,
      name: 'E2E Root',
      path: stashRootPath,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const collectionId = uid();
    await db().insert(schema.collections).values({
      id: collectionId,
      ownerId: adminId,
      name: 'e2e collection',
      pathTemplate: '{title|slug}',
      stashRootId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const lootId = uid();
    await db().insert(schema.loot).values({
      id: lootId,
      collectionId,
      title: 'cube',
      tags: [],
      fileMissing: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const stlPath = path.join(stashRootPath, 'cube.stl');
    await fsp.writeFile(stlPath, 'solid cube\nendsolid\n');
    const lootFileId = uid();
    await db().insert(schema.lootFiles).values({
      id: lootFileId,
      lootId,
      path: 'cube.stl',
      format: 'stl',
      size: 20,
      hash: 'sha256-fixture-cube',
      origin: 'manual',
      createdAt: new Date(),
    });

    const profileId = uid();
    await db().insert(schema.slicerProfiles).values({
      id: profileId,
      ownerId: adminId,
      name: 'E2E profile',
      slicerKind: 'prusaslicer',
      printerKind: 'fdm_klipper',
      materialKind: 'pla',
      settingsPayload: { layer_height: 0.2 },
      opaqueUnsupported: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const printerId = uid();
    await db().insert(schema.printers).values({
      id: printerId,
      ownerId: adminId,
      kind: 'fdm_klipper',
      name: 'Voron 2.4',
      connectionConfig: { url: 'http://192.168.1.50:7125', apiKey: 'k' },
      active: true,
      createdAt: new Date(),
    });

    const jobId = uid();
    await db().insert(schema.dispatchJobs).values({
      id: jobId,
      ownerId: adminId,
      lootId,
      targetKind: 'printer',
      targetId: printerId,
      status: 'slicing',
      createdAt: new Date(),
    });

    // ---------------------------------------------------------------------
    // STEP 4 — Drive runOneSlicerTick with a stubbed `run` that simulates
    // PrusaSlicer success.
    // ---------------------------------------------------------------------
    const slicerStub: RunCommand = async (cmd, args) => {
      const outIdx = args.indexOf('--output');
      const outDir = args[outIdx + 1]!;
      const outPath = path.join(outDir, 'cube.gcode');
      await fsp.mkdir(outDir, { recursive: true });
      await fsp.writeFile(outPath, 'M104 S210\nG28\nM84\n');
      return {
        stdout: [
          ';estimated printing time = 45m 0s',
          ';filament used [g] = 5.5',
          ';num_layers = 30',
        ].join('\n'),
        stderr: '',
        code: 0,
      };
    };

    const { runOneSlicerTick } = await import(
      '../../src/workers/forge-slicer-worker'
    );
    const counts = await runOneSlicerTick({ run: slicerStub, dbUrl: DB_URL });
    expect(counts).toEqual({ jobsProcessed: 1, jobsFailed: 0, jobsSkipped: 0 });

    // ---------------------------------------------------------------------
    // STEP 5 — Assert end-state
    // ---------------------------------------------------------------------
    const jobRows = await db()
      .select()
      .from(schema.dispatchJobs)
      .where(eq(schema.dispatchJobs.id, jobId));
    expect(jobRows[0]!.status).toBe('claimable');
    expect(jobRows[0]!.failureReason).toBeNull();

    const artifacts = await db()
      .select()
      .from(schema.forgeArtifacts)
      .where(eq(schema.forgeArtifacts.dispatchJobId, jobId));
    expect(artifacts).toHaveLength(1);
    const art = artifacts[0]!;
    expect(art.kind).toBe('gcode');
    expect(art.storagePath.startsWith(path.join(dataRoot, 'forge-artifacts', jobId))).toBe(true);
    expect(fs.existsSync(art.storagePath)).toBe(true);
    expect(art.sha256).toMatch(/^[0-9a-f]{64}$/);
    const meta = JSON.parse(art.metadataJson!);
    expect(meta.slicerKind).toBe('prusaslicer');
    expect(meta.estimatedPrintTimeSeconds).toBe(45 * 60);
  });
});
