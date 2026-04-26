/**
 * Integration tests — /api/v1/watchlist/subscriptions/* — V2-004-T9
 *
 * Real SQLite. Auth is mocked via the same `request-auth` shim used by the
 * /api/v1/ingest tests.
 *
 * Coverage:
 *   - POST: 401, 400 invalid body, 422 unknown source / unsupported capability,
 *           404 missing collection, 403 ACL denial, 201 happy path,
 *           idempotency replay (200), idempotency mismatch (409).
 *   - GET list: 401, owner-scoped, admin owner_id override, filters, pagination.
 *   - GET single: 200, 404 missing, 404 cross-user, admin still gets 404.
 *   - PATCH: cadence + active updates, immutable-field 400s, parameters update,
 *            cross-user 404.
 *   - DELETE: 204, cascade verification (watchlist_jobs deleted,
 *             ingest_jobs.parent_subscription_id NULLed), 404 cross-user.
 *   - Pause/Resume: active flag toggling, catch_up flag.
 *   - Fire-now: 201 happy path, 409 in-flight, 409 paused, last_fired_at unchanged.
 *   - Firings list: 200, status filter, pagination, 404 cross-user.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { eq, and, isNull } from 'drizzle-orm';

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

const DB_PATH = '/tmp/lootgoblin-api-watchlist.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}
function uid(): string {
  return crypto.randomUUID();
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

// ─── Seeders ────────────────────────────────────────────────────────────────

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Watchlist Test User',
    email: `${id}@watchlist.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string): Promise<string> {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-wl-stash-'));
  const id = uid();
  await db().insert(schema.stashRoots).values({
    id,
    ownerId,
    name: `Root-${id.slice(0, 8)}`,
    path: rootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(ownerId: string, stashRootId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id,
    ownerId,
    name: `Col-${id.slice(0, 8)}`,
    pathTemplate: '{title}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function actor(userId: string, role: 'admin' | 'user' = 'user') {
  return { id: userId, role, source: 'session' as const };
}

// ─── Request builders ───────────────────────────────────────────────────────

function makePost(body: unknown, idempotencyKey?: string): import('next/server').NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return new Request('http://local/api/v1/watchlist/subscriptions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

function makeListGet(qs = ''): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/watchlist/subscriptions${qs}`, {
    method: 'GET',
  }) as unknown as import('next/server').NextRequest;
}

function makeIdGet(id: string): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/watchlist/subscriptions/${id}`, {
    method: 'GET',
  }) as unknown as import('next/server').NextRequest;
}

function makePatch(id: string, body: unknown): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/watchlist/subscriptions/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

function makeDelete(id: string): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/watchlist/subscriptions/${id}`, {
    method: 'DELETE',
  }) as unknown as import('next/server').NextRequest;
}

function makeAction(id: string, action: string, body?: unknown): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/watchlist/subscriptions/${id}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as unknown as import('next/server').NextRequest;
}

function makeFiringsGet(id: string, qs = ''): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/watchlist/subscriptions/${id}/firings${qs}`, {
    method: 'GET',
  }) as unknown as import('next/server').NextRequest;
}

// ─── Helper: create a subscription via the route ────────────────────────────

async function createSubscription(
  userId: string,
  collectionId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; row: typeof schema.watchlistSubscriptions.$inferSelect }> {
  mockAuthenticate.mockResolvedValueOnce(actor(userId));
  const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
  const res = await POST(
    makePost({
      kind: 'creator',
      source_adapter_id: 'cults3d',
      parameters: { kind: 'creator', creatorId: 'creator-123' },
      cadence_seconds: 3600,
      default_collection_id: collectionId,
      ...overrides,
    }),
  );
  expect(res.status).toBe(201);
  const json = await res.json();
  const id = json.subscription.id as string;
  const rows = await db()
    .select()
    .from(schema.watchlistSubscriptions)
    .where(eq(schema.watchlistSubscriptions.id, id));
  return { id, row: rows[0]! };
}

// ─── POST tests ─────────────────────────────────────────────────────────────

describe('POST /api/v1/watchlist/subscriptions', () => {
  it('returns 401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await POST(
      makePost({
        kind: 'creator',
        source_adapter_id: 'cults3d',
        parameters: { kind: 'creator', creatorId: 'x' },
        default_collection_id: uid(),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 invalid-api-key when an API key is rejected', async () => {
    const { INVALID_API_KEY } = await import('../../src/auth/request-auth');
    mockAuthenticate.mockResolvedValueOnce(INVALID_API_KEY);
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await POST(
      makePost({
        kind: 'creator',
        source_adapter_id: 'cults3d',
        parameters: { kind: 'creator', creatorId: 'x' },
        default_collection_id: uid(),
      }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'unauthenticated', reason: 'invalid-api-key' });
  });

  it('returns 400 for malformed JSON', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const req = new Request('http://local/api/v1/watchlist/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{',
    }) as unknown as import('next/server').NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when kind is missing', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await POST(
      makePost({
        source_adapter_id: 'cults3d',
        parameters: { kind: 'creator', creatorId: 'x' },
        default_collection_id: uid(),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when parameters.kind does not match top-level kind', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await POST(
      makePost({
        kind: 'creator',
        source_adapter_id: 'cults3d',
        parameters: { kind: 'tag', tag: 'mini' },
        default_collection_id: uid(),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for cadence_seconds out of bounds (too small)', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await POST(
      makePost({
        kind: 'creator',
        source_adapter_id: 'cults3d',
        parameters: { kind: 'creator', creatorId: 'x' },
        cadence_seconds: 30,
        default_collection_id: uid(),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 422 when source_adapter_id is unknown', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await POST(
      makePost({
        kind: 'creator',
        source_adapter_id: 'no-such-source',
        parameters: { kind: 'creator', creatorId: 'x' },
        default_collection_id: uid(),
      }),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe('unsupported-source');
  });

  it('returns 422 when adapter does not support the requested kind', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    // gdrive does not support 'creator' (only folder_watch + url_watch).
    const res = await POST(
      makePost({
        kind: 'creator',
        source_adapter_id: 'google-drive',
        parameters: { kind: 'creator', creatorId: 'x' },
        default_collection_id: uid(),
      }),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe('unsupported-capability');
  });

  it('returns 422 when source_adapter_id has a ScavengerAdapter but no SubscribableAdapter', async () => {
    // makerworld is registered as a ScavengerAdapter but NOT as Subscribable —
    // the route's getSubscribable() returns undefined, so it's treated the
    // same as an unknown source.
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await POST(
      makePost({
        kind: 'creator',
        source_adapter_id: 'makerworld',
        parameters: { kind: 'creator', creatorId: 'x' },
        default_collection_id: uid(),
      }),
    );
    expect(res.status).toBe(422);
  });

  it('returns 404 when default_collection_id does not exist', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await POST(
      makePost({
        kind: 'creator',
        source_adapter_id: 'cults3d',
        parameters: { kind: 'creator', creatorId: 'x' },
        default_collection_id: uid(),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when caller does not own the default_collection_id', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const stashId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, stashId);
    mockAuthenticate.mockResolvedValueOnce(actor(otherId));
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await POST(
      makePost({
        kind: 'creator',
        source_adapter_id: 'cults3d',
        parameters: { kind: 'creator', creatorId: 'x' },
        default_collection_id: colId,
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 201 happy path — inserts a watchlist_subscriptions row', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await POST(
      makePost({
        kind: 'creator',
        source_adapter_id: 'cults3d',
        parameters: { kind: 'creator', creatorId: 'creator-1' },
        cadence_seconds: 7200,
        default_collection_id: colId,
      }),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.subscription).toMatchObject({
      kind: 'creator',
      sourceAdapterId: 'cults3d',
      cadenceSeconds: 7200,
      active: true,
      defaultCollectionId: colId,
    });
    expect(json.subscription.parameters).toEqual({ kind: 'creator', creatorId: 'creator-1' });

    const rows = await db()
      .select()
      .from(schema.watchlistSubscriptions)
      .where(eq(schema.watchlistSubscriptions.id, json.subscription.id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.ownerId).toBe(userId);
    expect(rows[0]!.active).toBe(1);
  });

  it('Idempotency-Key replay (same body) returns 200 + same subscription', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const idemKey = `idem-${uid()}`;
    const body = {
      kind: 'creator',
      source_adapter_id: 'cults3d',
      parameters: { kind: 'creator', creatorId: 'idem-creator' },
      default_collection_id: colId,
    };
    mockAuthenticate.mockResolvedValue(actor(userId));
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const r1 = await POST(makePost(body, idemKey));
    expect(r1.status).toBe(201);
    const j1 = await r1.json();

    const r2 = await POST(makePost(body, idemKey));
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.subscription.id).toBe(j1.subscription.id);

    // Only one row in the DB for this key.
    const rows = await db()
      .select({ id: schema.watchlistSubscriptions.id })
      .from(schema.watchlistSubscriptions)
      .where(eq(schema.watchlistSubscriptions.idempotencyKey, idemKey));
    expect(rows.length).toBe(1);

    mockAuthenticate.mockReset();
  });

  it('Idempotency-Key with a different body returns 409', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const idemKey = `idem-${uid()}`;
    mockAuthenticate.mockResolvedValue(actor(userId));
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const r1 = await POST(
      makePost(
        {
          kind: 'creator',
          source_adapter_id: 'cults3d',
          parameters: { kind: 'creator', creatorId: 'a' },
          default_collection_id: colId,
        },
        idemKey,
      ),
    );
    expect(r1.status).toBe(201);

    const r2 = await POST(
      makePost(
        {
          kind: 'creator',
          source_adapter_id: 'cults3d',
          parameters: { kind: 'creator', creatorId: 'b' },
          default_collection_id: colId,
        },
        idemKey,
      ),
    );
    expect(r2.status).toBe(409);
    const json = await r2.json();
    expect(json.error).toBe('idempotency-mismatch');

    mockAuthenticate.mockReset();
  });
});

// ─── GET list tests ─────────────────────────────────────────────────────────

describe('GET /api/v1/watchlist/subscriptions (list)', () => {
  it('returns 401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await GET(makeListGet());
    expect(res.status).toBe(401);
  });

  it("lists only the caller's subscriptions", async () => {
    const userId = await seedUser();
    const otherId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const otherStash = await seedStashRoot(otherId);
    const otherCol = await seedCollection(otherId, otherStash);

    await createSubscription(userId, colId, {
      parameters: { kind: 'creator', creatorId: 'mine-1' },
    });
    await createSubscription(otherId, otherCol, {
      parameters: { kind: 'creator', creatorId: 'other-1' },
    });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await GET(makeListGet());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.subscriptions)).toBe(true);
    for (const s of json.subscriptions as Array<{ ownerId: string }>) {
      expect(s.ownerId).toBe(userId);
    }
  });

  it('admin can scope to another user via ?owner_id=', async () => {
    const targetId = await seedUser();
    const adminId = await seedUser();
    const stashId = await seedStashRoot(targetId);
    const colId = await seedCollection(targetId, stashId);
    await createSubscription(targetId, colId);

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await GET(makeListGet(`?owner_id=${targetId}`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptions.length).toBeGreaterThan(0);
    for (const s of json.subscriptions as Array<{ ownerId: string }>) {
      expect(s.ownerId).toBe(targetId);
    }
  });

  it('non-admin cannot scope to another owner_id', async () => {
    const userId = await seedUser();
    const otherId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await GET(makeListGet(`?owner_id=${otherId}`));
    expect(res.status).toBe(403);
  });

  it('filters by active=true', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id: activeId } = await createSubscription(userId, colId, {
      parameters: { kind: 'creator', creatorId: 'active' },
    });
    const { id: pausedId } = await createSubscription(userId, colId, {
      parameters: { kind: 'creator', creatorId: 'paused' },
    });
    // Pause one.
    await db()
      .update(schema.watchlistSubscriptions)
      .set({ active: 0, updatedAt: new Date() })
      .where(eq(schema.watchlistSubscriptions.id, pausedId));

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const res = await GET(makeListGet(`?active=true`));
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = (json.subscriptions as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(pausedId);
  });

  it('honours limit + nextCursor for pagination', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    // Create 3 subs.
    for (let i = 0; i < 3; i++) {
      await createSubscription(userId, colId, {
        parameters: { kind: 'creator', creatorId: `pag-${i}` },
      });
      // Sleep 2ms so each row has a distinct created_at for cursor stability.
      await new Promise((r) => setTimeout(r, 5));
    }
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/watchlist/subscriptions/route');
    const r1 = await GET(makeListGet(`?limit=2`));
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1.subscriptions.length).toBe(2);
    expect(j1.nextCursor).toBeTruthy();

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const r2 = await GET(makeListGet(`?limit=2&cursor=${j1.nextCursor}`));
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.subscriptions.length).toBeGreaterThan(0);
    // No id overlap between page 1 and page 2.
    const ids1 = (j1.subscriptions as Array<{ id: string }>).map((s) => s.id);
    const ids2 = (j2.subscriptions as Array<{ id: string }>).map((s) => s.id);
    for (const id of ids2) expect(ids1).not.toContain(id);
  });
});

// ─── GET single tests ───────────────────────────────────────────────────────

describe('GET /api/v1/watchlist/subscriptions/:id', () => {
  it('returns 200 for the owner', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/watchlist/subscriptions/[id]/route');
    const res = await GET(makeIdGet(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscription.id).toBe(id);
  });

  it('returns 404 when subscription does not exist', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/watchlist/subscriptions/[id]/route');
    const ghost = uid();
    const res = await GET(makeIdGet(ghost), { params: Promise.resolve({ id: ghost }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the subscription belongs to another user', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const stashId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, stashId);
    const { id } = await createSubscription(ownerId, colId);

    mockAuthenticate.mockResolvedValueOnce(actor(otherId));
    const { GET } = await import('../../src/app/api/v1/watchlist/subscriptions/[id]/route');
    const res = await GET(makeIdGet(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 even for admin (owner-only ACL)', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser();
    const stashId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, stashId);
    const { id } = await createSubscription(ownerId, colId);

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/watchlist/subscriptions/[id]/route');
    const res = await GET(makeIdGet(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
  });
});

// ─── PATCH tests ────────────────────────────────────────────────────────────

describe('PATCH /api/v1/watchlist/subscriptions/:id', () => {
  it('updates cadence_seconds', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/watchlist/subscriptions/[id]/route');
    const res = await PATCH(makePatch(id, { cadence_seconds: 1800 }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscription.cadenceSeconds).toBe(1800);
  });

  it('updates active=false to pause', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/watchlist/subscriptions/[id]/route');
    const res = await PATCH(makePatch(id, { active: false }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscription.active).toBe(false);
  });

  it('updates parameters (matching kind)', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/watchlist/subscriptions/[id]/route');
    const res = await PATCH(
      makePatch(id, { parameters: { kind: 'creator', creatorId: 'updated' } }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscription.parameters).toEqual({ kind: 'creator', creatorId: 'updated' });
  });

  it('rejects parameters with mismatched kind', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/watchlist/subscriptions/[id]/route');
    const res = await PATCH(makePatch(id, { parameters: { kind: 'tag', tag: 'foo' } }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects attempt to change kind', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/watchlist/subscriptions/[id]/route');
    const res = await PATCH(makePatch(id, { kind: 'tag' }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects attempt to change source_adapter_id', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import('../../src/app/api/v1/watchlist/subscriptions/[id]/route');
    const res = await PATCH(makePatch(id, { source_adapter_id: 'sketchfab' }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 on cross-user PATCH', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const stashId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, stashId);
    const { id } = await createSubscription(ownerId, colId);

    mockAuthenticate.mockResolvedValueOnce(actor(otherId));
    const { PATCH } = await import('../../src/app/api/v1/watchlist/subscriptions/[id]/route');
    const res = await PATCH(makePatch(id, { cadence_seconds: 600 }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(404);
  });
});

// ─── DELETE tests ───────────────────────────────────────────────────────────

describe('DELETE /api/v1/watchlist/subscriptions/:id', () => {
  it('returns 204 on happy path and cascades watchlist_jobs + NULLs ingest_jobs.parent_subscription_id', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);

    // Seed a watchlist_job linked to this subscription.
    const jobId = uid();
    await db().insert(schema.watchlistJobs).values({
      id: jobId,
      subscriptionId: id,
      status: 'completed',
      itemsDiscovered: 0,
      itemsEnqueued: 0,
      createdAt: new Date(),
    });
    // Seed an ingest_job referencing this subscription as parent.
    const ingestId = uid();
    await db().insert(schema.ingestJobs).values({
      id: ingestId,
      ownerId: userId,
      sourceId: 'cults3d',
      targetKind: 'source-item-id',
      targetPayload: JSON.stringify({ kind: 'source-item-id', sourceItemId: 'x' }),
      collectionId: colId,
      status: 'queued',
      attempt: 1,
      parentSubscriptionId: id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { DELETE } = await import('../../src/app/api/v1/watchlist/subscriptions/[id]/route');
    const res = await DELETE(makeDelete(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(204);

    // Subscription gone.
    const subs = await db()
      .select()
      .from(schema.watchlistSubscriptions)
      .where(eq(schema.watchlistSubscriptions.id, id));
    expect(subs.length).toBe(0);
    // watchlist_jobs cascade deleted.
    const jobs = await db()
      .select()
      .from(schema.watchlistJobs)
      .where(eq(schema.watchlistJobs.id, jobId));
    expect(jobs.length).toBe(0);
    // ingest_jobs.parent_subscription_id is NULLed.
    const ingest = await db()
      .select({ parent: schema.ingestJobs.parentSubscriptionId })
      .from(schema.ingestJobs)
      .where(eq(schema.ingestJobs.id, ingestId));
    expect(ingest[0]?.parent).toBeNull();
  });

  it('returns 404 on cross-user DELETE', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const stashId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, stashId);
    const { id } = await createSubscription(ownerId, colId);

    mockAuthenticate.mockResolvedValueOnce(actor(otherId));
    const { DELETE } = await import('../../src/app/api/v1/watchlist/subscriptions/[id]/route');
    const res = await DELETE(makeDelete(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);

    // Subscription still exists.
    const subs = await db()
      .select()
      .from(schema.watchlistSubscriptions)
      .where(eq(schema.watchlistSubscriptions.id, id));
    expect(subs.length).toBe(1);
  });
});

// ─── Pause / Resume tests ───────────────────────────────────────────────────

describe('Pause / Resume actions', () => {
  it('pause sets active=false', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/watchlist/subscriptions/[id]/pause/route');
    const res = await POST(makeAction(id, 'pause'), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(204);

    const rows = await db()
      .select({ active: schema.watchlistSubscriptions.active })
      .from(schema.watchlistSubscriptions)
      .where(eq(schema.watchlistSubscriptions.id, id));
    expect(rows[0]!.active).toBe(0);
  });

  it('resume without catch_up leaves last_fired_at intact', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);
    // Pause + stamp a last_fired_at.
    const stamp = new Date(Date.now() - 60_000);
    await db()
      .update(schema.watchlistSubscriptions)
      .set({ active: 0, lastFiredAt: stamp, updatedAt: new Date() })
      .where(eq(schema.watchlistSubscriptions.id, id));

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/resume/route'
    );
    const res = await POST(makeAction(id, 'resume', {}), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(204);

    const rows = await db()
      .select({
        active: schema.watchlistSubscriptions.active,
        lastFiredAt: schema.watchlistSubscriptions.lastFiredAt,
      })
      .from(schema.watchlistSubscriptions)
      .where(eq(schema.watchlistSubscriptions.id, id));
    expect(rows[0]!.active).toBe(1);
    expect(rows[0]!.lastFiredAt?.getTime()).toBe(stamp.getTime());
  });

  it('resume with catch_up=true sets last_fired_at to NULL', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);
    const stamp = new Date(Date.now() - 60_000);
    await db()
      .update(schema.watchlistSubscriptions)
      .set({ active: 0, lastFiredAt: stamp, updatedAt: new Date() })
      .where(eq(schema.watchlistSubscriptions.id, id));

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/resume/route'
    );
    const res = await POST(makeAction(id, 'resume', { catch_up: true }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(204);

    const rows = await db()
      .select({
        active: schema.watchlistSubscriptions.active,
        lastFiredAt: schema.watchlistSubscriptions.lastFiredAt,
      })
      .from(schema.watchlistSubscriptions)
      .where(eq(schema.watchlistSubscriptions.id, id));
    expect(rows[0]!.active).toBe(1);
    expect(rows[0]!.lastFiredAt).toBeNull();
  });

  it('resume accepts an empty body', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);
    await db()
      .update(schema.watchlistSubscriptions)
      .set({ active: 0, updatedAt: new Date() })
      .where(eq(schema.watchlistSubscriptions.id, id));

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/resume/route'
    );
    const req = new Request(`http://local/api/v1/watchlist/subscriptions/${id}/resume`, {
      method: 'POST',
    }) as unknown as import('next/server').NextRequest;
    const res = await POST(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(204);
  });
});

// ─── Fire-now tests ─────────────────────────────────────────────────────────

describe('POST /api/v1/watchlist/subscriptions/:id/fire-now', () => {
  it('returns 201 + creates a queued watchlist_job; subscription last_fired_at unchanged', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);
    const before = (
      await db()
        .select({ lastFiredAt: schema.watchlistSubscriptions.lastFiredAt })
        .from(schema.watchlistSubscriptions)
        .where(eq(schema.watchlistSubscriptions.id, id))
    )[0]!.lastFiredAt;

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/fire-now/route'
    );
    const res = await POST(makeAction(id, 'fire-now'), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.job).toMatchObject({
      subscriptionId: id,
      status: 'queued',
    });

    const jobs = await db()
      .select()
      .from(schema.watchlistJobs)
      .where(eq(schema.watchlistJobs.id, json.job.id));
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.status).toBe('queued');

    const after = (
      await db()
        .select({ lastFiredAt: schema.watchlistSubscriptions.lastFiredAt })
        .from(schema.watchlistSubscriptions)
        .where(eq(schema.watchlistSubscriptions.id, id))
    )[0]!.lastFiredAt;
    expect(after?.getTime() ?? null).toBe(before?.getTime() ?? null);
  });

  it('returns 409 when an in-flight job already exists', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);
    // Seed an in-flight job.
    const existing = uid();
    await db().insert(schema.watchlistJobs).values({
      id: existing,
      subscriptionId: id,
      status: 'running',
      itemsDiscovered: 0,
      itemsEnqueued: 0,
      createdAt: new Date(),
    });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/fire-now/route'
    );
    const res = await POST(makeAction(id, 'fire-now'), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'job-in-flight', jobId: existing });
  });

  it('returns 409 when subscription is paused', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);
    await db()
      .update(schema.watchlistSubscriptions)
      .set({ active: 0, updatedAt: new Date() })
      .where(eq(schema.watchlistSubscriptions.id, id));

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/fire-now/route'
    );
    const res = await POST(makeAction(id, 'fire-now'), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('subscription-paused');
  });
});

// ─── Firings list tests ─────────────────────────────────────────────────────

describe('GET /api/v1/watchlist/subscriptions/:id/firings', () => {
  it('returns 200 with all firings for the subscription', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);

    // Seed two firings.
    for (let i = 0; i < 2; i++) {
      await db().insert(schema.watchlistJobs).values({
        id: uid(),
        subscriptionId: id,
        status: i === 0 ? 'completed' : 'failed',
        itemsDiscovered: 0,
        itemsEnqueued: 0,
        createdAt: new Date(Date.now() + i),
      });
    }

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/firings/route'
    );
    const res = await GET(makeFiringsGet(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.firings.length).toBe(2);
  });

  it('filters by status', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);

    await db().insert(schema.watchlistJobs).values({
      id: uid(),
      subscriptionId: id,
      status: 'completed',
      itemsDiscovered: 0,
      itemsEnqueued: 0,
      createdAt: new Date(),
    });
    await db().insert(schema.watchlistJobs).values({
      id: uid(),
      subscriptionId: id,
      status: 'failed',
      itemsDiscovered: 0,
      itemsEnqueued: 0,
      createdAt: new Date(),
    });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/firings/route'
    );
    const res = await GET(makeFiringsGet(id, '?status=failed'), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    for (const f of json.firings as Array<{ status: string }>) {
      expect(f.status).toBe('failed');
    }
  });

  it('returns 404 for cross-user firings access', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const stashId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, stashId);
    const { id } = await createSubscription(ownerId, colId);

    mockAuthenticate.mockResolvedValueOnce(actor(otherId));
    const { GET } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/firings/route'
    );
    const res = await GET(makeFiringsGet(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
  });

  it('honours pagination', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const { id } = await createSubscription(userId, colId);

    const baseTs = Date.now();
    for (let i = 0; i < 3; i++) {
      await db().insert(schema.watchlistJobs).values({
        id: uid(),
        subscriptionId: id,
        status: 'completed',
        itemsDiscovered: 0,
        itemsEnqueued: 0,
        createdAt: new Date(baseTs + i * 10),
      });
    }

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/watchlist/subscriptions/[id]/firings/route'
    );
    const r1 = await GET(makeFiringsGet(id, '?limit=2'), { params: Promise.resolve({ id }) });
    const j1 = await r1.json();
    expect(j1.firings.length).toBe(2);
    expect(j1.nextCursor).toBeTruthy();

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const r2 = await GET(makeFiringsGet(id, `?limit=2&cursor=${j1.nextCursor}`), {
      params: Promise.resolve({ id }),
    });
    const j2 = await r2.json();
    expect(j2.firings.length).toBeGreaterThan(0);
    const ids1 = (j1.firings as Array<{ id: string }>).map((f) => f.id);
    const ids2 = (j2.firings as Array<{ id: string }>).map((f) => f.id);
    for (const ix of ids2) expect(ids1).not.toContain(ix);
  });
});

// Suppress unused-import ESLint pass — `and` and `isNull` are kept here for
// reuse in future expansion of the cascade cross-checks.
void and;
void isNull;
