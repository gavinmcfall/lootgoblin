/**
 * Integration tests — /api/v1/forge/tools/* — V2-005c T_c6
 *
 * Same shape as api-v1-forge-slicers.test.ts (real SQLite + auth shim +
 * vi.mock NextResponse). The install/update routes get mocked installer
 * deps via setInstallerDeps; the mock immediately patches the row to
 * 'ready' so we can assert end-to-end progression without touching GitHub.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import { setInstallerDeps } from '../../src/forge/slicer/route-helpers';

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

const DB_PATH = '/tmp/lootgoblin-api-forge-tools.db';
const DB_URL = `file:${DB_PATH}`;

let toolsRoot: string;

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

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      await fsp.unlink(`${DB_PATH}${suffix}`);
    } catch {
      /* ignore */
    }
  }
  process.env.DATABASE_URL = DB_URL;
  resetDbCache();
  await runMigrations(DB_URL);
});

afterAll(() => {
  setInstallerDeps(null);
  if (toolsRoot) {
    try {
      rmSync(toolsRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

beforeEach(async () => {
  toolsRoot = mkdtempSync(path.join(tmpdir(), 'forge-tools-routes-'));
  process.env.FORGE_TOOLS_ROOT = toolsRoot;
  await db().delete(schema.forgeSlicerInstalls);
  await db().delete(schema.user);
  mockAuthenticate.mockReset();
  setInstallerDeps(null);
});

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Forge Tools Test User',
    email: `${id}@forge-tools.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function makeGet(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'GET' }) as unknown as import('next/server').NextRequest;
}
function makePost(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'POST' }) as unknown as import('next/server').NextRequest;
}
function makeDelete(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'DELETE' }) as unknown as import('next/server').NextRequest;
}

// ===========================================================================
// GET /api/v1/forge/tools
// ===========================================================================

describe('GET /api/v1/forge/tools', () => {
  it('401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/forge/tools/route');
    const res = await GET(makeGet('http://local/api/v1/forge/tools'));
    expect(res.status).toBe(401);
  });

  it('403 non-admin', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId, 'user'));
    const { GET } = await import('../../src/app/api/v1/forge/tools/route');
    const res = await GET(makeGet('http://local/api/v1/forge/tools'));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('forbidden');
  });

  it('200 admin with no installs', async () => {
    const adminId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/forge/tools/route');
    const res = await GET(makeGet('http://local/api/v1/forge/tools'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.available).toEqual(['prusaslicer', 'orcaslicer', 'bambustudio']);
    expect(json.installed).toEqual([]);
  });

  it('200 admin reflects installed row', async () => {
    const adminId = await seedUser();
    await db().insert(schema.forgeSlicerInstalls).values({
      id: uid(),
      slicerKind: 'orcaslicer',
      installedVersion: '2.1.0',
      binaryPath: '/data/forge-tools/orcaslicer/2.1.0/orca-slicer',
      installRoot: '/data/forge-tools/orcaslicer/2.1.0',
      installStatus: 'ready',
      updateAvailable: false,
      installedAt: new Date(),
      sha256: 'deadbeef',
    });
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/forge/tools/route');
    const res = await GET(makeGet('http://local/api/v1/forge/tools'));
    const json = await res.json();
    expect(json.installed).toHaveLength(1);
    expect(json.installed[0].slicerKind).toBe('orcaslicer');
    expect(json.installed[0].installStatus).toBe('ready');
  });
});

// ===========================================================================
// POST /api/v1/forge/tools/[slicer]/install
// ===========================================================================

describe('POST /api/v1/forge/tools/[slicer]/install', () => {
  it('400 invalid slicer kind', async () => {
    const adminId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(
      '../../src/app/api/v1/forge/tools/[slicer]/install/route'
    );
    const res = await POST(makePost('http://local/api/v1/forge/tools/cura/install'), {
      params: Promise.resolve({ slicer: 'cura' }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid-slicer-kind');
  });

  it('202 kicks off installer (mocked deps drive row to ready)', async () => {
    const adminId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));

    // Mocked installer deps: never actually called by installSlicer because
    // we hijack the install flow at the HTTP layer — installSlicer drives
    // the upsert path, but probeLatestRelease will hit the mocked http
    // client we inject, and we return a deterministic minimal release that
    // exercises the AppImage code path with a sha256 we can compute.
    const assetBytes = new Uint8Array([1, 2, 3, 4]);
    const sha = crypto.createHash('sha256').update(assetBytes).digest('hex');
    const mockHttp = {
      fetchJson: vi.fn().mockResolvedValue({
        tag_name: 'v0.0.1',
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

    const { POST } = await import(
      '../../src/app/api/v1/forge/tools/[slicer]/install/route'
    );
    const res = await POST(
      makePost('http://local/api/v1/forge/tools/prusaslicer/install'),
      { params: Promise.resolve({ slicer: 'prusaslicer' }) },
    );
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.slicerKind).toBe('prusaslicer');
    expect(json.installStatus).toBe('downloading');

    // Wait for the background installer to finish. installSlicer is async,
    // so we poll until the row reaches a terminal status.
    const deadline = Date.now() + 5000;
    let final: typeof schema.forgeSlicerInstalls.$inferSelect | undefined;
    while (Date.now() < deadline) {
      const rows = await db()
        .select()
        .from(schema.forgeSlicerInstalls)
        .where(eq(schema.forgeSlicerInstalls.slicerKind, 'prusaslicer'));
      if (rows.length > 0 && (rows[0]!.installStatus === 'ready' || rows[0]!.installStatus === 'failed')) {
        final = rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(final).toBeDefined();
    expect(final!.installStatus).toBe('ready');
    expect(final!.installedVersion).toBe('0.0.1');
  });

  it('409 install-in-progress when status is downloading', async () => {
    const adminId = await seedUser();
    await db().insert(schema.forgeSlicerInstalls).values({
      id: uid(),
      slicerKind: 'orcaslicer',
      installStatus: 'downloading',
      updateAvailable: false,
    });
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(
      '../../src/app/api/v1/forge/tools/[slicer]/install/route'
    );
    const res = await POST(
      makePost('http://local/api/v1/forge/tools/orcaslicer/install'),
      { params: Promise.resolve({ slicer: 'orcaslicer' }) },
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('install-in-progress');
    expect(json.current.slicerKind).toBe('orcaslicer');
  });
});

// ===========================================================================
// DELETE /api/v1/forge/tools/[slicer]/uninstall
// ===========================================================================

describe('DELETE /api/v1/forge/tools/[slicer]/uninstall', () => {
  it('400 invalid slicer kind', async () => {
    const adminId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { DELETE } = await import(
      '../../src/app/api/v1/forge/tools/[slicer]/uninstall/route'
    );
    const res = await DELETE(
      makeDelete('http://local/api/v1/forge/tools/cura/uninstall'),
      { params: Promise.resolve({ slicer: 'cura' }) },
    );
    expect(res.status).toBe(400);
  });

  it('200 removes ready row', async () => {
    const adminId = await seedUser();
    await db().insert(schema.forgeSlicerInstalls).values({
      id: uid(),
      slicerKind: 'bambustudio',
      installedVersion: '1.0.0',
      installStatus: 'ready',
      installRoot: null, // no fs cleanup
      updateAvailable: false,
      installedAt: new Date(),
    });
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { DELETE } = await import(
      '../../src/app/api/v1/forge/tools/[slicer]/uninstall/route'
    );
    const res = await DELETE(
      makeDelete('http://local/api/v1/forge/tools/bambustudio/uninstall'),
      { params: Promise.resolve({ slicer: 'bambustudio' }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.removed).toBe(true);
    expect(json.deletedRoot).toBeNull();

    const remaining = await db()
      .select()
      .from(schema.forgeSlicerInstalls)
      .where(eq(schema.forgeSlicerInstalls.slicerKind, 'bambustudio'));
    expect(remaining).toHaveLength(0);
  });
});

// ===========================================================================
// POST /api/v1/forge/tools/[slicer]/update
// ===========================================================================

describe('POST /api/v1/forge/tools/[slicer]/update', () => {
  it('202 re-runs install pipeline (mocked deps drive ready row to ready)', async () => {
    const adminId = await seedUser();
    // Seed an existing 'ready' row so we exercise the update-on-ready path.
    await db().insert(schema.forgeSlicerInstalls).values({
      id: uid(),
      slicerKind: 'orcaslicer',
      installedVersion: '0.0.0',
      installStatus: 'ready',
      updateAvailable: false,
    });

    const assetBytes = new Uint8Array([9, 9, 9]);
    const sha = crypto.createHash('sha256').update(assetBytes).digest('hex');
    const mockHttp = {
      fetchJson: vi.fn().mockResolvedValue({
        tag_name: 'v0.0.2',
        assets: [
          {
            name: 'OrcaSlicer-linux-x64.AppImage',
            browser_download_url: 'https://example/orca',
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
        .mockResolvedValue(`${sha}  OrcaSlicer-linux-x64.AppImage\n`),
      fetchBytes: vi.fn().mockResolvedValue(assetBytes),
    };
    setInstallerDeps({ http: mockHttp as never, run: vi.fn() as never });

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(
      '../../src/app/api/v1/forge/tools/[slicer]/update/route'
    );
    const res = await POST(
      makePost('http://local/api/v1/forge/tools/orcaslicer/update'),
      { params: Promise.resolve({ slicer: 'orcaslicer' }) },
    );
    expect(res.status).toBe(202);

    const deadline = Date.now() + 5000;
    let final: typeof schema.forgeSlicerInstalls.$inferSelect | undefined;
    while (Date.now() < deadline) {
      const rows = await db()
        .select()
        .from(schema.forgeSlicerInstalls)
        .where(eq(schema.forgeSlicerInstalls.slicerKind, 'orcaslicer'));
      if (rows.length > 0 && (rows[0]!.installStatus === 'ready' || rows[0]!.installStatus === 'failed')) {
        final = rows[0];
        if (final.installedVersion === '0.0.2') break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(final).toBeDefined();
    expect(final!.installStatus).toBe('ready');
    expect(final!.installedVersion).toBe('0.0.2');
  });
});
