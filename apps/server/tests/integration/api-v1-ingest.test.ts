/**
 * Integration tests — POST /api/v1/ingest + GET /api/v1/ingest[/:jobId] — V2-003-T9
 *
 * Real SQLite. Auth is mocked via the same `request-auth` shim used by the
 * other v2-001-T12 / v2-003-T4 route tests.
 *
 * Cases:
 *   - 401 unauthenticated, 401 invalid-api-key
 *   - 201 happy path (URL form) — job row created, status='queued'
 *   - 201 happy path (source-item-id form)
 *   - 422 unsupported URL
 *   - 422 unknown sourceId
 *   - 404 collection not found
 *   - 403 ACL denial (non-owner POST)
 *   - 200 idempotency replay (same body → same jobId, no extra row)
 *   - 409 idempotency mismatch (same key, different body)
 *   - GET /:jobId — 401, 404, happy path, cross-user-access returns 404
 *   - GET / list — pagination cursor, status filter, owner-scoped
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import { eq } from 'drizzle-orm';

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

const DB_PATH = '/tmp/lootgoblin-api-ingest.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB { return getDb(DB_URL) as DB; }
function uid(): string { return crypto.randomUUID(); }

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { await fsp.unlink(`${DB_PATH}${suffix}`); } catch { /* ignore */ }
  }
  process.env.DATABASE_URL = DB_URL;
  resetDbCache();
  await runMigrations(DB_URL);
});

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Ingest Test User',
    email: `${id}@ingest.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string): Promise<string> {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-ingest-stash-'));
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

function makePost(body: unknown, idempotencyKey?: string): import('next/server').NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const req = new Request('http://local/api/v1/ingest', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return req as unknown as import('next/server').NextRequest;
}

function makeGet(qs = ''): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/ingest${qs}`, { method: 'GET' }) as unknown as import('next/server').NextRequest;
}

function makeGetJob(jobId: string): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/ingest/${jobId}`, { method: 'GET' }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/v1/ingest', () => {
  it('returns 401 unauthenticated when no session and no API key', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import('../../src/app/api/v1/ingest/route');
    const res = await POST(makePost({ url: 'https://www.cults3d.com/x', collectionId: uid() }));
    expect(res.status).toBe(401);
  });

  it('returns 401 reason:invalid-api-key for a rejected key', async () => {
    const { INVALID_API_KEY } = await import('../../src/auth/request-auth');
    mockAuthenticate.mockResolvedValueOnce(INVALID_API_KEY);
    const { POST } = await import('../../src/app/api/v1/ingest/route');
    const res = await POST(makePost({ url: 'https://www.cults3d.com/x', collectionId: uid() }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'unauthenticated', reason: 'invalid-api-key' });
  });

  it('returns 400 invalid-body for malformed JSON', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/ingest/route');
    const req = new Request('http://local/api/v1/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{{',
    });
    const res = await POST(req as unknown as import('next/server').NextRequest);
    expect(res.status).toBe(400);
  });

  it('returns 400 invalid-body when neither URL nor sourceId is present', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/ingest/route');
    const res = await POST(makePost({ collectionId: uid() }));
    expect(res.status).toBe(400);
  });

  it('returns 422 when URL is not claimed by any adapter', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/ingest/route');
    const res = await POST(makePost({ url: 'https://example.org/random', collectionId: colId }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'unsupported-source' });
  });

  it('returns 422 when sourceId is not in the registry', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/ingest/route');
    const res = await POST(makePost({ sourceId: 'nope', sourceItemId: 'x', collectionId: colId }));
    expect(res.status).toBe(422);
  });

  it('returns 404 when collection does not exist', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/ingest/route');
    const res = await POST(makePost({ url: 'https://www.cults3d.com/en/3d-models/x-1', collectionId: uid() }));
    expect(res.status).toBe(404);
  });

  it('returns 403 when caller is not owner of the collection', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const stashId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, stashId);
    mockAuthenticate.mockResolvedValueOnce(actor(otherId));
    const { POST } = await import('../../src/app/api/v1/ingest/route');
    const res = await POST(makePost({ url: 'https://www.cults3d.com/en/3d-models/foo-1', collectionId: colId }));
    expect(res.status).toBe(403);
  });

  it('returns 201 happy path (URL form) — inserts queued ingest_jobs row', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/ingest/route');
    const res = await POST(makePost({ url: 'https://www.cults3d.com/en/3d-models/foo-2', collectionId: colId }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toMatchObject({ status: 'queued', sourceId: 'cults3d' });
    expect(typeof json.jobId).toBe('string');

    const rows = await db()
      .select({
        id: schema.ingestJobs.id,
        ownerId: schema.ingestJobs.ownerId,
        status: schema.ingestJobs.status,
        targetKind: schema.ingestJobs.targetKind,
      })
      .from(schema.ingestJobs)
      .where(eq(schema.ingestJobs.id, json.jobId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.ownerId).toBe(userId);
    expect(rows[0]!.status).toBe('queued');
    expect(rows[0]!.targetKind).toBe('url');
  });

  it('returns 201 happy path (source-item-id form)', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import('../../src/app/api/v1/ingest/route');
    const res = await POST(makePost({
      sourceId: 'cults3d',
      sourceItemId: 'mw-12345',
      collectionId: colId,
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toMatchObject({ status: 'queued', sourceId: 'cults3d' });
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  it('Idempotency-Key replay (same body twice) returns the same jobId without inserting a new row', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const idemKey = `idem-${uid()}`;
    const body = { url: 'https://www.cults3d.com/en/3d-models/idem-1', collectionId: colId };

    mockAuthenticate.mockResolvedValue(actor(userId));
    const { POST } = await import('../../src/app/api/v1/ingest/route');

    const res1 = await POST(makePost(body, idemKey));
    expect(res1.status).toBe(201);
    const json1 = await res1.json();

    const res2 = await POST(makePost(body, idemKey));
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.jobId).toBe(json1.jobId);

    // Only one row in the DB for that key.
    const rows = await db()
      .select({ id: schema.ingestJobs.id })
      .from(schema.ingestJobs)
      .where(eq(schema.ingestJobs.idempotencyKey, idemKey));
    expect(rows.length).toBe(1);

    mockAuthenticate.mockReset();
  });

  it('Idempotency-Key with a different body returns 409', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const idemKey = `idem-${uid()}`;
    mockAuthenticate.mockResolvedValue(actor(userId));
    const { POST } = await import('../../src/app/api/v1/ingest/route');

    const res1 = await POST(makePost({ url: 'https://www.cults3d.com/en/3d-models/idem-2', collectionId: colId }, idemKey));
    expect(res1.status).toBe(201);

    const res2 = await POST(makePost({ url: 'https://www.cults3d.com/en/3d-models/idem-3', collectionId: colId }, idemKey));
    expect(res2.status).toBe(409);
    const json = await res2.json();
    expect(json).toMatchObject({ error: 'idempotency-mismatch' });

    mockAuthenticate.mockReset();
  });
});

describe('GET /api/v1/ingest/:jobId', () => {
  it('returns 401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/ingest/[jobId]/route');
    const res = await GET(makeGetJob('any'), { params: Promise.resolve({ jobId: 'any' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the job does not exist', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/ingest/[jobId]/route');
    const ghost = uid();
    const res = await GET(makeGetJob(ghost), { params: Promise.resolve({ jobId: ghost }) });
    expect(res.status).toBe(404);
  });

  it('returns 200 with job state for the owner', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const postMod = await import('../../src/app/api/v1/ingest/route');
    const postRes = await postMod.POST(makePost({ url: 'https://www.cults3d.com/en/3d-models/get-1', collectionId: colId }));
    const { jobId } = await postRes.json();

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/ingest/[jobId]/route');
    const res = await GET(makeGetJob(jobId), { params: Promise.resolve({ jobId }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ jobId, status: 'queued', sourceId: 'cults3d' });
  });

  it('returns 404 (not 403) when the job belongs to another user', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const stashId = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, stashId);
    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const postMod = await import('../../src/app/api/v1/ingest/route');
    const postRes = await postMod.POST(makePost({ url: 'https://www.cults3d.com/en/3d-models/get-2', collectionId: colId }));
    const { jobId } = await postRes.json();

    mockAuthenticate.mockResolvedValueOnce(actor(otherId));
    const { GET } = await import('../../src/app/api/v1/ingest/[jobId]/route');
    const res = await GET(makeGetJob(jobId), { params: Promise.resolve({ jobId }) });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/ingest (list)', () => {
  it('returns 401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/ingest/route');
    const res = await GET(makeGet());
    expect(res.status).toBe(401);
  });

  it('lists only jobs owned by the caller', async () => {
    const userId = await seedUser();
    const otherId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const otherStash = await seedStashRoot(otherId);
    const otherCol = await seedCollection(otherId, otherStash);

    // Create one job for each user.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const postMod = await import('../../src/app/api/v1/ingest/route');
    await postMod.POST(makePost({ url: 'https://www.cults3d.com/en/3d-models/list-mine-1', collectionId: colId }));

    mockAuthenticate.mockResolvedValueOnce(actor(otherId));
    await postMod.POST(makePost({ url: 'https://www.cults3d.com/en/3d-models/list-other-1', collectionId: otherCol }));

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/ingest/route');
    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.jobs)).toBe(true);
    // Every returned job must be owned by `userId` — verify by re-fetching.
    for (const j of json.jobs as Array<{ jobId: string }>) {
      const rows = await db()
        .select({ ownerId: schema.ingestJobs.ownerId })
        .from(schema.ingestJobs)
        .where(eq(schema.ingestJobs.id, j.jobId));
      expect(rows[0]!.ownerId).toBe(userId);
    }
  });

  it('honors limit + nextCursor for pagination', async () => {
    const userId = await seedUser();
    const stashId = await seedStashRoot(userId);
    const colId = await seedCollection(userId, stashId);
    const postMod = await import('../../src/app/api/v1/ingest/route');

    // Create 3 jobs.
    for (let i = 0; i < 3; i++) {
      mockAuthenticate.mockResolvedValueOnce(actor(userId));
      const r = await postMod.POST(makePost({
        url: `https://www.cults3d.com/en/3d-models/page-${i}-${uid().slice(0, 6)}`,
        collectionId: colId,
      }));
      expect(r.status).toBe(201);
    }

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/ingest/route');
    const res1 = await GET(makeGet('?limit=2'));
    const json1 = await res1.json();
    expect(json1.jobs.length).toBe(2);
    expect(typeof json1.nextCursor).toBe('string');

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const res2 = await GET(makeGet(`?limit=2&cursor=${encodeURIComponent(json1.nextCursor)}`));
    const json2 = await res2.json();
    // The next page is owner-scoped; we created 3 user jobs in this test,
    // plus possibly more from earlier tests in the same file. The cursor
    // gates us to "older than json1's last entry" → at least the 3rd of 3.
    expect(json2.jobs.length).toBeGreaterThanOrEqual(1);
  });
});
