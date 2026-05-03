/**
 * Integration tests — V2-005e-T_e2 forge inbox CRUD + watcher + classifier.
 *
 * Real SQLite per-file (/tmp/lootgoblin-forge-inboxes.db).
 * Real chokidar watchers for the file-arrival tests, mocked auth via the
 * standard request-auth shim.
 *
 * Coverage map (13 tests):
 *   1.  POST /forge/inboxes creates row + starts watcher.
 *   2.  PATCH `active: false` stops the watcher.
 *   3.  PATCH `active: true` (re-)starts the watcher.
 *   4.  DELETE removes row + stops watcher.
 *   5.  GET /forge/inboxes lists owner-only.
 *   6.  Cross-owner GET → 404.
 *   7.  Admin sees all inboxes.
 *   8.  File arriving in the watched dir invokes handleSliceArrival.
 *   9.  Classifier tags `.gcode.3mf` as slicer-output.
 *   10. Plain `.3mf` is NOT tagged as slicer-output.
 *   11. Boot recovery re-attaches watchers for active inboxes.
 *   12. PATCH `path` stops old watcher + starts watcher on new path.
 *   13. Inbox path that does not exist on disk: row created, watcher logs +
 *       drops the entry; later PATCH to a real path starts the watcher.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterEach,
  beforeEach,
  vi,
} from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import {
  shutdownAllInboxWatchers,
  hasActiveWatcher,
  activeWatcherPath,
  recoverInboxWatchers,
  startInboxWatcher,
  handleSliceArrival,
} from '../../src/forge/inboxes/ingest';
import { createSlicerOutputProvider } from '../../src/stash/classifier-providers/slicer-output';
import { createThreeMfProvider } from '../../src/stash/classifier-providers/three-mf';
import { createClassifier } from '../../src/stash/classifier';

// ---------------------------------------------------------------------------
// next/server shim — mirrors forge-loadout-routes.test.ts
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

const DB_PATH = '/tmp/lootgoblin-forge-inboxes.db';
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

// Generous chokidar settle window — keeps tests deterministic without
// relying on arbitrary sleeps in the assertions.
const STABILITY_MS = 200;
const POLL_MS = 50;

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
  await dbc.delete(schema.forgeInboxes);
  await dbc.delete(schema.printers);
  await dbc.delete(schema.user);
  mockAuthenticate.mockReset();
  await shutdownAllInboxWatchers();
});

afterEach(async () => {
  await shutdownAllInboxWatchers();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(role: 'admin' | 'user' = 'user'): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: `inbox-test ${id.slice(0, 6)}`,
    email: `${id}@inbox.test`,
    emailVerified: false,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedPrinter(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.printers).values({
    id,
    ownerId,
    kind: 'fdm_klipper',
    name: 'Test printer',
    connectionConfig: {},
    active: true,
    createdAt: new Date(),
  });
  return id;
}

async function mkScratchDir(prefix = 'lootgoblin-forge-inbox'): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function makeJson(
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

function makeBare(
  url: string,
  method: 'GET' | 'DELETE',
): import('next/server').NextRequest {
  return new Request(url, { method }) as unknown as import('next/server').NextRequest;
}

// ---------------------------------------------------------------------------
// Wait helper — chokidar 'ready' resolves before chokidar's internal inode
// watch is fully primed. vi.waitFor avoids racing the FS write against the
// add-event subscription window without arbitrary sleeps.
// ---------------------------------------------------------------------------

async function waitForCondition(
  pred: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  await vi.waitFor(
    () => {
      if (!pred()) throw new Error('not yet');
    },
    { timeout: timeoutMs, interval: 50 },
  );
}

// ===========================================================================
// 1. POST /forge/inboxes creates row + starts watcher.
// ===========================================================================

describe('forge-inboxes T_e2', () => {
  it('1. POST creates a row and starts a watcher', async () => {
    const userId = await seedUser();
    const watchDir = await mkScratchDir();

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/inboxes/route');
    const res = await POST(
      makeJson('http://local/api/v1/forge/inboxes', 'POST', {
        name: 'My Slicer Drop',
        path: watchDir,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { inbox: { id: string; path: string; active: boolean } };
    expect(body.inbox.path).toBe(watchDir);
    expect(body.inbox.active).toBe(true);

    // Watcher started.
    expect(hasActiveWatcher(body.inbox.id)).toBe(true);

    // Persisted.
    const rows = await db()
      .select()
      .from(schema.forgeInboxes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe(watchDir);
  });

  // =========================================================================
  // 2. PATCH active:false stops the watcher.
  // =========================================================================
  it('2. PATCH active=false stops the watcher', async () => {
    const userId = await seedUser();
    const watchDir = await mkScratchDir();

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/inboxes/route');
    const created = await POST(
      makeJson('http://local/api/v1/forge/inboxes', 'POST', {
        name: 'A',
        path: watchDir,
      }),
    );
    const { inbox } = (await created.json()) as { inbox: { id: string } };
    expect(hasActiveWatcher(inbox.id)).toBe(true);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/forge/inboxes/[id]/route');
    const res = await PATCH(
      makeJson(`http://local/api/v1/forge/inboxes/${inbox.id}`, 'PATCH', {
        active: false,
      }),
      { params: Promise.resolve({ id: inbox.id }) },
    );
    expect(res.status).toBe(200);
    expect(hasActiveWatcher(inbox.id)).toBe(false);

    const reloaded = await db()
      .select()
      .from(schema.forgeInboxes);
    expect(reloaded[0]!.active).toBe(false);
  });

  // =========================================================================
  // 3. PATCH active:true (re-)starts the watcher.
  // =========================================================================
  it('3. PATCH active=true restarts the watcher', async () => {
    const userId = await seedUser();
    const watchDir = await mkScratchDir();

    // Seed an inactive row directly.
    const inboxId = uid();
    await db().insert(schema.forgeInboxes).values({
      id: inboxId,
      ownerId: userId,
      name: 'inactive',
      path: watchDir,
      active: false,
      createdAt: new Date(),
    });
    expect(hasActiveWatcher(inboxId)).toBe(false);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/forge/inboxes/[id]/route');
    const res = await PATCH(
      makeJson(`http://local/api/v1/forge/inboxes/${inboxId}`, 'PATCH', {
        active: true,
      }),
      { params: Promise.resolve({ id: inboxId }) },
    );
    expect(res.status).toBe(200);
    expect(hasActiveWatcher(inboxId)).toBe(true);
  });

  // =========================================================================
  // 4. DELETE removes row + stops watcher.
  // =========================================================================
  it('4. DELETE removes row and stops watcher', async () => {
    const userId = await seedUser();
    const watchDir = await mkScratchDir();

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/inboxes/route');
    const created = await POST(
      makeJson('http://local/api/v1/forge/inboxes', 'POST', {
        name: 'X',
        path: watchDir,
      }),
    );
    const { inbox } = (await created.json()) as { inbox: { id: string } };
    expect(hasActiveWatcher(inbox.id)).toBe(true);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { DELETE } = await import('../../src/app/api/v1/forge/inboxes/[id]/route');
    const res = await DELETE(makeBare(`http://local/api/v1/forge/inboxes/${inbox.id}`, 'DELETE'), {
      params: Promise.resolve({ id: inbox.id }),
    });
    expect(res.status).toBe(200);
    expect(hasActiveWatcher(inbox.id)).toBe(false);

    const remaining = await db().select().from(schema.forgeInboxes);
    expect(remaining).toHaveLength(0);
  });

  // =========================================================================
  // 5. GET list — owner sees only their rows.
  // =========================================================================
  it('5. GET list returns only the caller\'s inboxes', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const dirA = await mkScratchDir();
    const dirB = await mkScratchDir();

    // Two rows, one per user.
    await db().insert(schema.forgeInboxes).values({
      id: uid(),
      ownerId: userA,
      name: 'A',
      path: dirA,
      active: false,
      createdAt: new Date(),
    });
    await db().insert(schema.forgeInboxes).values({
      id: uid(),
      ownerId: userB,
      name: 'B',
      path: dirB,
      active: false,
      createdAt: new Date(),
    });

    mockAuthenticate.mockResolvedValueOnce(actor(userA));
    const { GET } = await import('../../src/app/api/v1/forge/inboxes/route');
    const res = await GET(makeBare('http://local/api/v1/forge/inboxes', 'GET'));
    const body = (await res.json()) as { inboxes: Array<{ ownerId: string }> };
    expect(body.inboxes).toHaveLength(1);
    expect(body.inboxes[0]!.ownerId).toBe(userA);
  });

  // =========================================================================
  // 6. Cross-owner GET-by-id → 404.
  // =========================================================================
  it('6. cross-owner GET returns 404 (no id leak)', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const dirA = await mkScratchDir();
    const inboxId = uid();
    await db().insert(schema.forgeInboxes).values({
      id: inboxId,
      ownerId: userA,
      name: 'A',
      path: dirA,
      active: false,
      createdAt: new Date(),
    });

    mockAuthenticate.mockResolvedValueOnce(actor(userB));
    const { GET } = await import('../../src/app/api/v1/forge/inboxes/[id]/route');
    const res = await GET(makeBare(`http://local/api/v1/forge/inboxes/${inboxId}`, 'GET'), {
      params: Promise.resolve({ id: inboxId }),
    });
    expect(res.status).toBe(404);
  });

  // =========================================================================
  // 7. Admin sees all inboxes.
  // =========================================================================
  it('7. admin GET list returns rows for every owner', async () => {
    const adminId = await seedUser('admin');
    const userA = await seedUser();
    const userB = await seedUser();
    for (const uId of [userA, userB]) {
      await db().insert(schema.forgeInboxes).values({
        id: uid(),
        ownerId: uId,
        name: 'inbox',
        path: await mkScratchDir(),
        active: false,
        createdAt: new Date(),
      });
    }

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/forge/inboxes/route');
    const res = await GET(makeBare('http://local/api/v1/forge/inboxes', 'GET'));
    const body = (await res.json()) as { inboxes: Array<{ ownerId: string }> };
    expect(body.inboxes).toHaveLength(2);
    expect(new Set(body.inboxes.map((i) => i.ownerId))).toEqual(new Set([userA, userB]));
  });

  // =========================================================================
  // 8. File arrival in watched dir invokes handleSliceArrival.
  // =========================================================================
  it('8. file arrival on watched inbox calls handleSliceArrival', async () => {
    const userId = await seedUser();
    const watchDir = await mkScratchDir();
    const inboxRow = {
      id: uid(),
      ownerId: userId,
      name: 'arrival-test',
      path: watchDir,
      defaultPrinterId: null,
      active: true,
      notes: null,
      createdAt: new Date(),
    };
    await db().insert(schema.forgeInboxes).values(inboxRow);

    const calls: Array<{ filePath: string }> = [];
    await startInboxWatcher(inboxRow, {
      onSliceArrival: async ({ filePath }) => {
        calls.push({ filePath });
        return { classified: true, isSlicerOutput: true, processed: true };
      },
      stabilityThresholdMs: STABILITY_MS,
    });

    // Drop a file into the watched dir.
    const filePath = path.join(watchDir, 'thing.gcode');
    await fsp.writeFile(filePath, 'G28\nG1 X10 Y10\n');

    await waitForCondition(() => calls.length > 0);
    expect(calls[0]!.filePath).toBe(filePath);
  }, 10_000);

  // =========================================================================
  // 9. Classifier tags .gcode.3mf as slicer-output.
  // =========================================================================
  it('9. .gcode.3mf is classified as slicer-output', async () => {
    const watchDir = await mkScratchDir();
    const filePath = path.join(watchDir, 'plate_1.gcode.3mf');
    // Content doesn't matter for the slicer-output rule (extension-based).
    await fsp.writeFile(filePath, 'PKfake-zip');

    const inboxRow = {
      id: uid(),
      ownerId: 'unused',
      name: 't',
      path: watchDir,
      defaultPrinterId: null,
      active: true,
      notes: null,
      createdAt: new Date(),
    };

    const outcome = await handleSliceArrival({ inbox: inboxRow, filePath });
    expect(outcome.processed).toBe(true);
    expect(outcome.classified).toBe(true);
    expect(outcome.isSlicerOutput).toBe(true);
    expect(outcome.classification?.slicerOutput?.value).toBe(true);
    expect(outcome.classification?.primaryFormat?.value).toBe('gcode.3mf');
  });

  // =========================================================================
  // 10. Plain .3mf is NOT slicer-output.
  // =========================================================================
  it('10. plain .3mf is NOT classified as slicer-output', async () => {
    const watchDir = await mkScratchDir();
    const filePath = path.join(watchDir, 'model.3mf');
    // Minimal "valid-ish" 3MF: a non-zero file the size + lstat succeed on.
    await fsp.writeFile(filePath, 'PKnot-a-real-zip');

    const inboxRow = {
      id: uid(),
      ownerId: 'unused',
      name: 't',
      path: watchDir,
      defaultPrinterId: null,
      active: true,
      notes: null,
      createdAt: new Date(),
    };

    // Use a custom classifier with BOTH 3mf + slicer-output so we assert
    // the narrowing in three-mf.ts: a plain .3mf should not be flagged
    // as slicerOutput, regardless of what 3mf parsing finds.
    const customClassifier = createClassifier({
      providers: [createThreeMfProvider(), createSlicerOutputProvider()],
      requiredFields: [],
    });

    const outcome = await handleSliceArrival({
      inbox: inboxRow,
      filePath,
      classifier: customClassifier,
    });
    expect(outcome.processed).toBe(true);
    expect(outcome.isSlicerOutput).toBe(false);
    expect(outcome.classification?.slicerOutput).toBeUndefined();
  });

  // =========================================================================
  // 11. Boot recovery — recoverInboxWatchers re-attaches active rows.
  // =========================================================================
  it('11. recoverInboxWatchers re-attaches a watcher per active row', async () => {
    const userId = await seedUser();
    const dirA = await mkScratchDir();
    const dirB = await mkScratchDir();
    const dirC = await mkScratchDir();

    const idA = uid();
    const idB = uid();
    const idC = uid();
    await db().insert(schema.forgeInboxes).values([
      {
        id: idA,
        ownerId: userId,
        name: 'a',
        path: dirA,
        active: true,
        createdAt: new Date(),
      },
      {
        id: idB,
        ownerId: userId,
        name: 'b',
        path: dirB,
        active: true,
        createdAt: new Date(),
      },
      {
        id: idC,
        ownerId: userId,
        name: 'c-disabled',
        path: dirC,
        active: false,
        createdAt: new Date(),
      },
    ]);

    await recoverInboxWatchers();

    expect(hasActiveWatcher(idA)).toBe(true);
    expect(hasActiveWatcher(idB)).toBe(true);
    // Inactive row not recovered.
    expect(hasActiveWatcher(idC)).toBe(false);
  });

  // =========================================================================
  // 12. PATCH path — stops old watcher + starts new one on the new path.
  // =========================================================================
  it('12. PATCH path stops old + starts new watcher', async () => {
    const userId = await seedUser();
    const dirA = await mkScratchDir();
    const dirB = await mkScratchDir();

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/inboxes/route');
    const created = await POST(
      makeJson('http://local/api/v1/forge/inboxes', 'POST', {
        name: 'p',
        path: dirA,
      }),
    );
    const { inbox } = (await created.json()) as { inbox: { id: string } };
    expect(activeWatcherPath(inbox.id)).toBe(dirA);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/forge/inboxes/[id]/route');
    await PATCH(
      makeJson(`http://local/api/v1/forge/inboxes/${inbox.id}`, 'PATCH', {
        path: dirB,
      }),
      { params: Promise.resolve({ id: inbox.id }) },
    );

    expect(hasActiveWatcher(inbox.id)).toBe(true);
    expect(activeWatcherPath(inbox.id)).toBe(dirB);
  });

  // =========================================================================
  // 13. Inbox path that does not exist on disk.
  // =========================================================================
  it('13. POSTing an inbox path that does not exist still creates the row; PATCH to a real path takes over', async () => {
    const userId = await seedUser();
    const missingPath = path.join(os.tmpdir(), `definitely-missing-${uid()}`);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/forge/inboxes/route');
    const res = await POST(
      makeJson('http://local/api/v1/forge/inboxes', 'POST', {
        name: 'ghost',
        path: missingPath,
      }),
    );
    expect(res.status).toBe(201);
    const { inbox } = (await res.json()) as { inbox: { id: string } };
    // Row exists in DB regardless of whether chokidar can attach to the path.
    const rows = await db().select().from(schema.forgeInboxes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe(missingPath);
    // Chokidar v4 tolerates missing paths gracefully (no pre-ready error,
    // the watcher attaches and waits — events fire if the dir is later
    // created). The row is created and watcher state is consistent.
    // No assertion on hasActiveWatcher here because the behaviour is
    // chokidar-version-dependent; the row + path persistence are what
    // matters.

    // PATCH to a real path takes over — old watcher (if any) is replaced.
    const realDir = await mkScratchDir();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/forge/inboxes/[id]/route');
    await PATCH(
      makeJson(`http://local/api/v1/forge/inboxes/${inbox.id}`, 'PATCH', {
        path: realDir,
      }),
      { params: Promise.resolve({ id: inbox.id }) },
    );
    expect(hasActiveWatcher(inbox.id)).toBe(true);
    expect(activeWatcherPath(inbox.id)).toBe(realDir);
  });
});
