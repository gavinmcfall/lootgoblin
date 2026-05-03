/**
 * V2-005e-T_e3 integration tests — forge pending-pairings HTTP surface +
 * filename-heuristic end-to-end + FK cascade.
 *
 * Covers:
 *   1. End-to-end ingest with sidecar match → parent_loot_id set, no pending row.
 *   2. End-to-end ingest with filename heuristic → parent_loot_id set.
 *   3. End-to-end ingest with no match → pending-pairings row created.
 *   4. POST /resolve happy path → parent_loot_id stamped, pending row closed.
 *   5. POST /resolve already-resolved → 409.
 *   6. POST /resolve with unknown source loot → 404.
 *   7. POST /resolve cross-owner → 404 (no leak).
 *   8. Source-Loot delete cascades parent_loot_id → NULL on slice.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
} from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import JSZip from 'jszip';

import {
  runMigrations,
  resetDbCache,
  getDb,
  schema,
} from '../../src/db/client';
import { matchSliceArrival } from '../../src/forge/slice-pairings/matcher';

// ---------------------------------------------------------------------------
// next/server shim — mirrors forge-inboxes.test.ts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-forge-pending-pairings.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}
const uid = (): string => crypto.randomUUID();

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
}, 30_000);

beforeEach(async () => {
  const dbc = db();
  await dbc.delete(schema.forgePendingPairings);
  await dbc.delete(schema.lootFiles);
  await dbc.delete(schema.loot);
  await dbc.delete(schema.collections);
  await dbc.delete(schema.stashRoots);
  await dbc.delete(schema.forgeInboxes);
  await dbc.delete(schema.user);
  mockAuthenticate.mockReset();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function actor(userId: string, role: 'admin' | 'user' = 'user') {
  return { id: userId, role, source: 'session' as const };
}

async function seedUser(role: 'admin' | 'user' = 'user'): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: `pp-${id.slice(0, 6)}`,
    email: `${id}@pp.test`,
    emailVerified: false,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(ownerId: string): Promise<string> {
  const stashRootId = uid();
  await db().insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId,
    name: 'root',
    path: '/tmp/pp-root',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `c-${uid().slice(0, 4)}`,
    pathTemplate: '{title|slug}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return collectionId;
}

async function seedLoot(collectionId: string, title: string): Promise<string> {
  const id = uid();
  await db().insert(schema.loot).values({
    id,
    collectionId,
    title,
    description: null,
    tags: [],
    creator: null,
    license: null,
    sourceItemId: null,
    contentSummary: null,
    fileMissing: false,
    parentLootId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedInbox(ownerId: string, watchPath: string) {
  const id = uid();
  await db().insert(schema.forgeInboxes).values({
    id,
    ownerId,
    name: 'i',
    path: watchPath,
    defaultPrinterId: null,
    active: true,
    notes: null,
    createdAt: new Date(),
  });
  return (
    await db().select().from(schema.forgeInboxes).where(eq(schema.forgeInboxes.id, id))
  )[0]!;
}

async function buildThreemfSidecar(
  scratch: string,
  filename: string,
  sourceFile: string,
): Promise<string> {
  const filePath = path.join(scratch, filename);
  const zip = new JSZip();
  zip.file(
    'Metadata/model_settings.config',
    `<?xml version="1.0"?><config><object id="1"><metadata key="source_file" value="${sourceFile}"/></object></config>`,
  );
  await fsp.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  return filePath;
}

async function makeScratch(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'pp-'));
}

function jsonReq(
  url: string,
  method: 'POST' | 'PATCH',
  body: unknown,
): import('next/server').NextRequest {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

function bareReq(
  url: string,
  method: 'GET' | 'DELETE',
): import('next/server').NextRequest {
  return new Request(url, { method }) as unknown as import('next/server').NextRequest;
}

// ===========================================================================
// 1. End-to-end sidecar match
// ===========================================================================

describe('forge pending-pairings T_e3', () => {
  it('1. sidecar match sets parent_loot_id and creates no pending row', async () => {
    const ownerId = await seedUser();
    const collectionId = await seedCollection(ownerId);
    const sourceLootId = await seedLoot(collectionId, 'cube.stl');
    const scratch = await makeScratch();
    const inbox = await seedInbox(ownerId, scratch);

    const filePath = await buildThreemfSidecar(scratch, 'plate_1.gcode.3mf', 'cube.stl');
    const r = await matchSliceArrival({ inbox, filePath });
    expect(r.parentLootId).toBe(sourceLootId);
    expect(r.pendingPairingId).toBeNull();

    const pendings = await db().select().from(schema.forgePendingPairings);
    expect(pendings).toHaveLength(0);
  });

  // =========================================================================
  // 2. End-to-end filename-heuristic match
  // =========================================================================
  it('2. heuristic match sets parent_loot_id when sidecar absent', async () => {
    const ownerId = await seedUser();
    const collectionId = await seedCollection(ownerId);
    const sourceLootId = await seedLoot(collectionId, 'cube');
    const scratch = await makeScratch();
    const inbox = await seedInbox(ownerId, scratch);

    const filePath = path.join(scratch, 'cube_PLA_0.2mm.gcode');
    await fsp.writeFile(filePath, '; nothing useful here\nG28\n');
    const r = await matchSliceArrival({ inbox, filePath });
    expect(r.parentLootId).toBe(sourceLootId);
    expect(r.pendingPairingId).toBeNull();
  });

  // =========================================================================
  // 3. End-to-end no-match fallback to pending pairings
  // =========================================================================
  it('3. no match → forge_pending_pairings row inserted', async () => {
    const ownerId = await seedUser();
    const collectionId = await seedCollection(ownerId);
    await seedLoot(collectionId, 'totally-different-name');
    const scratch = await makeScratch();
    const inbox = await seedInbox(ownerId, scratch);

    const filePath = path.join(scratch, 'mystery_xyz.gcode');
    await fsp.writeFile(filePath, 'G28\n');
    const r = await matchSliceArrival({ inbox, filePath });
    expect(r.parentLootId).toBeNull();
    expect(r.pendingPairingId).not.toBeNull();

    const rows = await db().select().from(schema.forgePendingPairings);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceFilenameHint).toBe('mystery_xyz.gcode');
    expect(rows[0]!.resolvedAt).toBeNull();
  });

  // =========================================================================
  // 4. POST /resolve happy path
  // =========================================================================
  it('4. POST /resolve stamps parent_loot_id + closes pending row in one tx', async () => {
    const ownerId = await seedUser();
    const collectionId = await seedCollection(ownerId);
    const sourceLootId = await seedLoot(collectionId, 'orphan-source');
    const scratch = await makeScratch();
    const inbox = await seedInbox(ownerId, scratch);

    const filePath = path.join(scratch, 'unmatched.gcode');
    await fsp.writeFile(filePath, 'G28\n');
    const r = await matchSliceArrival({ inbox, filePath });
    const pendingId = r.pendingPairingId!;
    const sliceLootId = r.sliceLootId!;
    expect(pendingId).toBeTruthy();

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const { POST } = await import(
      '../../src/app/api/v1/forge/pending-pairings/[id]/resolve/route'
    );
    const res = await POST(
      jsonReq(
        `http://local/api/v1/forge/pending-pairings/${pendingId}/resolve`,
        'POST',
        { sourceLootId },
      ),
      { params: Promise.resolve({ id: pendingId }) },
    );
    expect(res.status).toBe(200);

    const slice = (
      await db().select().from(schema.loot).where(eq(schema.loot.id, sliceLootId))
    )[0]!;
    expect(slice.parentLootId).toBe(sourceLootId);

    const pending = (
      await db()
        .select()
        .from(schema.forgePendingPairings)
        .where(eq(schema.forgePendingPairings.id, pendingId))
    )[0]!;
    expect(pending.resolvedAt).not.toBeNull();
    expect(pending.resolvedToLootId).toBe(sourceLootId);
  });

  // =========================================================================
  // 5. POST /resolve already-resolved → 409
  // =========================================================================
  it('5. POST /resolve on already-resolved row returns 409', async () => {
    const ownerId = await seedUser();
    const collectionId = await seedCollection(ownerId);
    const sourceLootId = await seedLoot(collectionId, 'src-1');
    const scratch = await makeScratch();
    const inbox = await seedInbox(ownerId, scratch);

    const filePath = path.join(scratch, 'unmatched.gcode');
    await fsp.writeFile(filePath, 'G28\n');
    const r = await matchSliceArrival({ inbox, filePath });
    const pendingId = r.pendingPairingId!;

    mockAuthenticate.mockResolvedValue(actor(ownerId));
    const { POST } = await import(
      '../../src/app/api/v1/forge/pending-pairings/[id]/resolve/route'
    );
    const first = await POST(
      jsonReq(
        `http://local/api/v1/forge/pending-pairings/${pendingId}/resolve`,
        'POST',
        { sourceLootId },
      ),
      { params: Promise.resolve({ id: pendingId }) },
    );
    expect(first.status).toBe(200);

    const second = await POST(
      jsonReq(
        `http://local/api/v1/forge/pending-pairings/${pendingId}/resolve`,
        'POST',
        { sourceLootId },
      ),
      { params: Promise.resolve({ id: pendingId }) },
    );
    expect(second.status).toBe(409);
  });

  // =========================================================================
  // 6. POST /resolve unknown source loot → 404
  // =========================================================================
  it('6. POST /resolve with unknown sourceLootId returns 404', async () => {
    const ownerId = await seedUser();
    const collectionId = await seedCollection(ownerId);
    await seedLoot(collectionId, 'unrelated');
    const scratch = await makeScratch();
    const inbox = await seedInbox(ownerId, scratch);

    const filePath = path.join(scratch, 'unmatched.gcode');
    await fsp.writeFile(filePath, 'G28\n');
    const r = await matchSliceArrival({ inbox, filePath });
    const pendingId = r.pendingPairingId!;

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const { POST } = await import(
      '../../src/app/api/v1/forge/pending-pairings/[id]/resolve/route'
    );
    const res = await POST(
      jsonReq(
        `http://local/api/v1/forge/pending-pairings/${pendingId}/resolve`,
        'POST',
        { sourceLootId: 'nope-' + uid() },
      ),
      { params: Promise.resolve({ id: pendingId }) },
    );
    expect(res.status).toBe(404);
  });

  // =========================================================================
  // 7. Cross-owner POST /resolve → 404 (id-leak guard)
  // =========================================================================
  it('7. POST /resolve as a different owner returns 404', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const collectionA = await seedCollection(ownerA);
    const sourceA = await seedLoot(collectionA, 'A-source');
    const scratch = await makeScratch();
    const inbox = await seedInbox(ownerA, scratch);

    const filePath = path.join(scratch, 'unmatched.gcode');
    await fsp.writeFile(filePath, 'G28\n');
    const r = await matchSliceArrival({ inbox, filePath });
    const pendingId = r.pendingPairingId!;

    mockAuthenticate.mockResolvedValueOnce(actor(ownerB));
    const { POST } = await import(
      '../../src/app/api/v1/forge/pending-pairings/[id]/resolve/route'
    );
    const res = await POST(
      jsonReq(
        `http://local/api/v1/forge/pending-pairings/${pendingId}/resolve`,
        'POST',
        { sourceLootId: sourceA },
      ),
      { params: Promise.resolve({ id: pendingId }) },
    );
    expect(res.status).toBe(404);
  });

  // =========================================================================
  // 8. GET list excludes other owners
  // =========================================================================
  it('8. GET /pending-pairings is owner-scoped (admin sees all, user sees own)', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const adminId = await seedUser('admin');
    const collA = await seedCollection(ownerA);
    const collB = await seedCollection(ownerB);
    await seedLoot(collA, 'A-x');
    await seedLoot(collB, 'B-x');

    const scratchA = await makeScratch();
    const scratchB = await makeScratch();
    const inboxA = await seedInbox(ownerA, scratchA);
    const inboxB = await seedInbox(ownerB, scratchB);

    const fA = path.join(scratchA, 'qq_A.gcode');
    await fsp.writeFile(fA, 'G28\n');
    const fB = path.join(scratchB, 'qq_B.gcode');
    await fsp.writeFile(fB, 'G28\n');
    await matchSliceArrival({ inbox: inboxA, filePath: fA });
    await matchSliceArrival({ inbox: inboxB, filePath: fB });

    const { GET } = await import('../../src/app/api/v1/forge/pending-pairings/route');

    // Owner A sees only A.
    mockAuthenticate.mockResolvedValueOnce(actor(ownerA));
    const resA = await GET(bareReq('http://local/api/v1/forge/pending-pairings', 'GET'));
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as { pairings: Array<{ ownerId: string }> };
    expect(bodyA.pairings).toHaveLength(1);
    expect(bodyA.pairings[0]!.ownerId).toBe(ownerA);

    // Admin sees both.
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const resAdmin = await GET(
      bareReq('http://local/api/v1/forge/pending-pairings', 'GET'),
    );
    expect(resAdmin.status).toBe(200);
    const bodyAdmin = (await resAdmin.json()) as {
      pairings: Array<{ ownerId: string }>;
    };
    expect(bodyAdmin.pairings).toHaveLength(2);
  });

  // =========================================================================
  // 9. FK cascade: source delete → slice.parent_loot_id NULL
  // =========================================================================
  it('9. deleting the source Loot SET-NULLs slice.parent_loot_id', async () => {
    const ownerId = await seedUser();
    const collectionId = await seedCollection(ownerId);
    const sourceLootId = await seedLoot(collectionId, 'cube.stl');
    const scratch = await makeScratch();
    const inbox = await seedInbox(ownerId, scratch);

    const filePath = await buildThreemfSidecar(scratch, 'plate_1.gcode.3mf', 'cube.stl');
    const r = await matchSliceArrival({ inbox, filePath });
    expect(r.parentLootId).toBe(sourceLootId);

    // Delete the source. The slice row must persist with parentLootId = null.
    await db().delete(schema.loot).where(eq(schema.loot.id, sourceLootId));

    const slice = (
      await db().select().from(schema.loot).where(eq(schema.loot.id, r.sliceLootId!))
    )[0]!;
    expect(slice.parentLootId).toBeNull();
  });
});
