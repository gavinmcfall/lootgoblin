/**
 * End-to-end Forge compatibility tests — V2-005a-T7.
 *
 * Drives the GET /api/v1/forge/dispatch/compatibility route through the full
 * HTTP stack (auth + loot lookup + matrix verdict). Existing
 * `api-v1-forge-dispatch-compatibility.test.ts` covers route-level concerns;
 * this file is the e2e companion that asserts the verdict shape after the
 * full create-loot → register-target → query chain.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';

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

const DB_PATH = '/tmp/lootgoblin-e2e-forge-compat.db';
const DB_URL = `file:${DB_PATH}`;

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

beforeEach(async () => {
  await db().delete(schema.dispatchJobs);
  await db().delete(schema.printerReachableVia);
  await db().delete(schema.printerAcls);
  await db().delete(schema.slicerAcls);
  await db().delete(schema.printers);
  await db().delete(schema.forgeSlicers);
  await db().delete(schema.agents);
  await db().delete(schema.lootFiles);
  await db().delete(schema.loot);
  await db().delete(schema.collections);
  await db().delete(schema.stashRoots);
  await db().delete(schema.user);
  mockAuthenticate.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'E2E Compat User',
    email: `${id}@e2e-compat.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLootWithFile(
  ownerId: string,
  format: string,
  filePath?: string,
): Promise<string> {
  const rootId = uid();
  await db().insert(schema.stashRoots).values({
    id: rootId,
    ownerId,
    name: 'root',
    path: `/tmp/forge-compat-${rootId.slice(0, 8)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `c-${collectionId.slice(0, 6)}`,
    pathTemplate: '{title|slug}',
    stashRootId: rootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootId = uid();
  await db().insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: `model ${lootId.slice(0, 6)}`,
    tags: [],
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootFileId = uid();
  await db().insert(schema.lootFiles).values({
    id: lootFileId,
    lootId,
    path: filePath ?? `model.${format}`,
    format,
    size: 1024,
    hash: `sha256-${lootFileId}`,
    origin: 'manual',
    createdAt: new Date(),
  });
  return lootId;
}

async function seedSlicer(ownerId: string, kind = 'orcaslicer'): Promise<string> {
  const id = uid();
  await db().insert(schema.forgeSlicers).values({
    id,
    ownerId,
    kind,
    name: `slicer-${id.slice(0, 6)}`,
    invocationMethod: 'url-scheme',
    createdAt: new Date(),
  });
  return id;
}

async function getCompatibility(opts: {
  userId: string;
  lootId: string;
  targetKind: string;
}): Promise<{ status: number; body: { band?: string; conversionTo?: string; reason?: string; format?: string; error?: string } }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.userId));
  const { GET } = await import(
    '../../src/app/api/v1/forge/dispatch/compatibility/route'
  );
  const url = `http://local/api/v1/forge/dispatch/compatibility?lootId=${encodeURIComponent(
    opts.lootId,
  )}&targetKind=${encodeURIComponent(opts.targetKind)}`;
  const res = await GET(new Request(url, { method: 'GET' }) as unknown as import('next/server').NextRequest);
  return { status: res.status, body: await res.json() };
}

// ===========================================================================
// Test scenarios
// ===========================================================================

describe('e2e Forge compatibility — V2-005a-T7', () => {
  it('1. native pair: STL + orcaslicer → 200 band=native', async () => {
    const userId = await seedUser();
    const lootId = await seedLootWithFile(userId, 'stl');
    // Slicer existence isn't required by the compatibility route, but seed
    // one to make the intent of the test obvious (we're asking "can I
    // dispatch this STL to my OrcaSlicer?").
    await seedSlicer(userId, 'orcaslicer');

    const res = await getCompatibility({
      userId,
      lootId,
      targetKind: 'orcaslicer',
    });
    expect(res.status).toBe(200);
    expect(res.body.band).toBe('native');
    expect(res.body.format).toBe('stl');
  });

  it('2. conversion pair: STL + fdm_klipper → 200 band=conversion-required, conversionTo=gcode', async () => {
    const userId = await seedUser();
    const lootId = await seedLootWithFile(userId, 'stl');

    const res = await getCompatibility({
      userId,
      lootId,
      targetKind: 'fdm_klipper',
    });
    expect(res.status).toBe(200);
    expect(res.body.band).toBe('conversion-required');
    expect(res.body.conversionTo).toBe('gcode');
  });

  it('3. unsupported pair: jpeg + fdm_klipper → 200 band=unsupported with reason', async () => {
    const userId = await seedUser();
    const lootId = await seedLootWithFile(userId, 'jpeg', 'cover.jpeg');

    const res = await getCompatibility({
      userId,
      lootId,
      targetKind: 'fdm_klipper',
    });
    expect(res.status).toBe(200);
    expect(res.body.band).toBe('unsupported');
    expect(typeof res.body.reason).toBe('string');
    expect(res.body.reason!.length).toBeGreaterThan(0);
  });

  it('4. cross-owner Loot → 404 not-found', async () => {
    const aliceId = await seedUser();
    const bobId = await seedUser();
    const aliceLootId = await seedLootWithFile(aliceId, 'stl');

    // Bob asking about Alice's loot.
    const res = await getCompatibility({
      userId: bobId,
      lootId: aliceLootId,
      targetKind: 'orcaslicer',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not-found');
  });
});
