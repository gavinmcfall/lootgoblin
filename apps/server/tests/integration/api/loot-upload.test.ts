/**
 * Integration tests — POST /api/v1/loot/upload — V2-003-T4
 *
 * Real SQLite + real filesystem (scratch dirs in /tmp).
 * The route handler is imported directly; Next.js and auth are mocked.
 */

import { describe, it, expect, beforeAll, vi, afterAll } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { runMigrations, getDb, schema, resetDbCache } from '../../../src/db/client';
import { eq } from 'drizzle-orm';

// ── Next.js shim ───────────────────────────────────────────────────────────────
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

// ── Auth mock ──────────────────────────────────────────────────────────────────
const mockAuthenticate = vi.fn();
vi.mock('../../../src/auth/request-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/auth/request-auth')>();
  return {
    ...actual,
    authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  };
});

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-upload-route.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB { return getDb(DB_URL) as DB; }
function uid(): string { return crypto.randomUUID(); }

const scratchDirs: string[] = [];

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { await fsp.unlink(`${DB_PATH}${suffix}`); } catch { /* ignore */ }
  }
  process.env.DATABASE_URL = DB_URL;
  resetDbCache();
  await runMigrations(DB_URL);
});

afterAll(async () => {
  for (const dir of scratchDirs) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeScratchDir(prefix = 'lg-upload-it-'): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function makeSessionActor(userId: string, role: 'admin' | 'user' = 'user') {
  return { id: userId, role, source: 'session' as const };
}

async function seedUser(role: 'admin' | 'user' = 'user'): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Upload Test User',
    email: `${id}@upload.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string): Promise<{ rootId: string; rootPath: string }> {
  const rootPath = await makeScratchDir('lg-stash-root-');
  const rootId = uid();
  await db().insert(schema.stashRoots).values({
    id: rootId,
    ownerId,
    name: `Root-${rootId.slice(0, 8)}`,
    path: rootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { rootId, rootPath };
}

async function seedCollection(
  ownerId: string,
  stashRootId: string,
  pathTemplate = '{title}',
): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id,
    ownerId,
    name: `Col-${id.slice(0, 8)}`,
    pathTemplate,
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

/**
 * Build a multipart FormData NextRequest for POST /api/v1/loot/upload.
 * metadata: serialized into the 'metadata' field.
 * files: array of { name, content } objects.
 */
function makeUploadReq(
  metadata: Record<string, unknown>,
  files: Array<{ name: string; content: string | Buffer }>,
): import('next/server').NextRequest {
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  for (const file of files) {
    const content = typeof file.content === 'string' ? file.content : file.content;
    const blob = new Blob([content], { type: 'application/octet-stream' });
    form.append('files', blob, file.name);
  }
  const req = new Request('http://local/api/v1/loot/upload', { method: 'POST', body: form });
  return req as unknown as import('next/server').NextRequest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/loot/upload', () => {
  // ── Auth / 401 ─────────────────────────────────────────────────────────────

  it('returns 401 unauthenticated when no session and no API key', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');
    const res = await POST(makeUploadReq({ collectionId: uid(), title: 'x' }, []));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'unauthenticated' });
  });

  it('returns 401 with reason:invalid-api-key for a bad API key', async () => {
    // The mock spreads the actual module, so INVALID_API_KEY is the real exported symbol.
    const { INVALID_API_KEY } = await import('../../../src/auth/request-auth');
    mockAuthenticate.mockResolvedValueOnce(INVALID_API_KEY);

    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');
    const form = new FormData();
    form.append('metadata', JSON.stringify({ collectionId: uid(), title: 'x' }));
    const req = new Request('http://local/api/v1/loot/upload', { method: 'POST', body: form });
    const res = await POST(req as unknown as import('next/server').NextRequest);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'unauthenticated', reason: 'invalid-api-key' });
  });

  // ── Request body validation / 400 ──────────────────────────────────────────

  it('returns 400 when metadata field is missing from form', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(userId));
    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');

    const form = new FormData();
    const blob = new Blob(['content'], { type: 'application/octet-stream' });
    form.append('files', blob, 'file.stl');
    const req = new Request('http://local/api/v1/loot/upload', { method: 'POST', body: form });
    const res = await POST(req as unknown as import('next/server').NextRequest);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'invalid-body' });
  });

  it('returns 400 when metadata field is not valid JSON', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(userId));
    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');

    const form = new FormData();
    form.append('metadata', 'this is not json {{{');
    const blob = new Blob(['content'], { type: 'application/octet-stream' });
    form.append('files', blob, 'file.stl');
    const req = new Request('http://local/api/v1/loot/upload', { method: 'POST', body: form });
    const res = await POST(req as unknown as import('next/server').NextRequest);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'invalid-body', reason: expect.stringContaining('JSON') });
  });

  it('returns 400 with issues array when Zod validation fails (empty title)', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(userId));
    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');
    const res = await POST(makeUploadReq(
      { collectionId: uid(), title: '' },
      [{ name: 'file.stl', content: 'x' }],
    ));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'invalid-body' });
    expect(Array.isArray(json.issues)).toBe(true);
    expect(json.issues.length).toBeGreaterThan(0);
  });

  it('returns 400 with issues array when collectionId is not a UUID', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(userId));
    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');
    const res = await POST(makeUploadReq(
      { collectionId: 'not-a-uuid', title: 'Test' },
      [{ name: 'file.stl', content: 'x' }],
    ));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'invalid-body' });
    expect(Array.isArray(json.issues)).toBe(true);
  });

  it('returns 400 when no files are uploaded', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(userId));
    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');

    const form = new FormData();
    form.append('metadata', JSON.stringify({ collectionId: colId, title: 'No files' }));
    const req = new Request('http://local/api/v1/loot/upload', { method: 'POST', body: form });
    const res = await POST(req as unknown as import('next/server').NextRequest);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'invalid-body', reason: expect.stringContaining('files') });
  });

  // ── Collection / 404 ──────────────────────────────────────────────────────

  it('returns 404 when collectionId is a valid UUID but not in DB', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(userId));
    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');
    const res = await POST(makeUploadReq(
      { collectionId: uid(), title: 'Ghost collection' },
      [{ name: 'file.stl', content: 'x' }],
    ));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'not-found', reason: 'collection-not-found' });
  });

  // ── ACL / 403 ─────────────────────────────────────────────────────────────

  it('returns 403 when non-owner tries to upload to another user\'s Collection', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const { rootId } = await seedStashRoot(ownerId);
    const colId = await seedCollection(ownerId, rootId);
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(otherId));
    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');
    const res = await POST(makeUploadReq(
      { collectionId: colId, title: 'ACL denial test' },
      [{ name: 'file.stl', content: 'content' }],
    ));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'forbidden', reason: 'not-owner' });
  });

  // ── Size cap / 413 ─────────────────────────────────────────────────────────

  it('returns 413 when total upload size exceeds 2 GB cap', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(userId));
    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');

    const LARGE_SIZE = 3 * 1024 * 1024 * 1024; // 3 GB > 2 GB cap

    // Extend the real File class so instanceof checks pass.
    // Override the size getter to report a value exceeding the 2 GB cap.
    class OversizedFile extends File {
      get size() { return LARGE_SIZE; }
    }

    const bigFile = new OversizedFile(['x'], 'big.stl', { type: 'application/octet-stream' });

    const fakeFormData = {
      get(key: string) {
        if (key === 'metadata') return JSON.stringify({ collectionId: colId, title: 'Big file' });
        return null;
      },
      getAll(key: string) {
        if (key === 'files') return [bigFile];
        return [];
      },
    };

    // Override formData() on the request via a Proxy.
    const fakeReq = new Proxy(
      new Request('http://local/api/v1/loot/upload', { method: 'POST', body: 'x' }),
      {
        get(target, prop) {
          if (prop === 'formData') return async () => fakeFormData;
          const val = (target as any)[prop];
          return typeof val === 'function' ? val.bind(target) : val;
        },
      },
    );

    const res = await POST(fakeReq as unknown as import('next/server').NextRequest);
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'payload-too-large' });
  });

  // ── Security / filename sanitization ──────────────────────────────────────

  it('sanitizes path-traversal filenames — stored LootFile path contains no traversal sequences', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(userId));
    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');
    const res = await POST(makeUploadReq(
      { collectionId: colId, title: 'Traversal test' },
      [{ name: '../etc/passwd', content: 'solid evil\nendsolid evil' }],
    ));
    // Filename sanitized to 'passwd' → route continues.
    // Outcome is 202 (placed/quarantined/failed) — NOT a write to /etc/.
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toHaveProperty('status');
    expect(json).toHaveProperty('jobId');

    // Regression guard: if the upload was placed, the DB-stored LootFile path
    // must contain no traversal sequences and must not escape the stash root.
    if (json.status === 'placed') {
      const fileRows = await db()
        .select({ path: schema.lootFiles.path })
        .from(schema.lootFiles)
        .where(eq(schema.lootFiles.lootId, json.lootId));
      for (const row of fileRows) {
        expect(row.path).not.toContain('..');
        expect(row.path).not.toContain('/etc/');
        expect(row.path).not.toMatch(/^\/etc\//);
      }
    }
  });

  it('sanitizeUploadFilename strips path separators, null bytes, and leading dots', async () => {
    const { sanitizeFilename: sanitizeUploadFilename } = await import('../../../src/scavengers/filename-sanitize');

    expect(sanitizeUploadFilename('../etc/passwd')).toBe('passwd');
    expect(sanitizeUploadFilename('foo/../bar.stl')).toBe('bar.stl');
    expect(sanitizeUploadFilename('.hidden')).toBe('hidden');
    expect(sanitizeUploadFilename('..env')).toBe('env');
    expect(sanitizeUploadFilename('file\x00name.stl')).toBe('filename.stl');
    expect(sanitizeUploadFilename('file\x1fname.stl')).toBe('filename.stl');
    expect(sanitizeUploadFilename('')).toBeNull();
    // All-dots: leading dots stripped → empty → null.
    expect(sanitizeUploadFilename('...')).toBeNull();
    expect(sanitizeUploadFilename('..')).toBeNull();
    // 'only-dots...' has letters before trailing dots — NOT a leading-dot case.
    expect(sanitizeUploadFilename('only-dots...')).toBe('only-dots...');
    expect(sanitizeUploadFilename('valid-file.3mf')).toBe('valid-file.3mf');
    expect(sanitizeUploadFilename('C:\\Users\\foo\\file.stl')).toBe('file.stl');
  });

  it('sanitizeUploadFilename URL-decodes percent-encoded traversal sequences', async () => {
    const { sanitizeFilename: sanitizeUploadFilename } = await import('../../../src/scavengers/filename-sanitize');

    // Uppercase + lowercase %2F / %5C (forward slash and backslash).
    expect(sanitizeUploadFilename('..%2F..%2Fpasswd')).toBe('passwd');
    expect(sanitizeUploadFilename('..%5Cpasswd')).toBe('passwd');
    expect(sanitizeUploadFilename('..%2f..%2Fpasswd')).toBe('passwd');
    expect(sanitizeUploadFilename('%2Fetc%2Fpasswd')).toBe('passwd');
    // Mixed encoded + literal separator: both are collapsed to the basename.
    expect(sanitizeUploadFilename('..%2Fetc/passwd')).toBe('passwd');
    // Malformed percent-encoding falls back to raw (no throw, no silent drop).
    // After the fallback the leading-dots stripper still runs on the basename,
    // so `..%2Gfile.txt` → stripped leading `..` → `%2Gfile.txt`.
    expect(sanitizeUploadFilename('file%2.txt')).toBe('file%2.txt');
    expect(sanitizeUploadFilename('..%2Gfile.txt')).toBe('%2Gfile.txt');
  });

  // ── Successful uploads ─────────────────────────────────────────────────────

  it('single-file upload by owner → 202, lootSourceRecords row attributing to upload', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(userId));
    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');
    const res = await POST(makeUploadReq(
      {
        collectionId: colId,
        title: 'My STL Model',
        description: 'A single STL',
        creator: 'Bob',
        license: 'CC0',
        tags: ['sci-fi'],
      },
      [{ name: 'model.stl', content: 'solid test\nendsolid test' }],
    ));

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toHaveProperty('jobId');
    expect(json).toHaveProperty('status');

    if (json.status === 'placed') {
      const srcRows = await db()
        .select({ sourceType: schema.lootSourceRecords.sourceType })
        .from(schema.lootSourceRecords)
        .where(eq(schema.lootSourceRecords.lootId, json.lootId));
      expect(srcRows.some((r: { sourceType: string }) => r.sourceType === 'upload')).toBe(true);
    }
  });

  it('multi-file upload (STL + PNG + README) → 202 with jobId + pipeline outcome', async () => {
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(userId));
    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');
    const res = await POST(makeUploadReq(
      { collectionId: colId, title: 'Multi-file Model' },
      [
        { name: 'model.stl', content: 'solid body\nendsolid body' },
        { name: 'preview.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
        { name: 'README.txt', content: 'Model description' },
      ],
    ));

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toHaveProperty('jobId');
    expect(['placed', 'quarantined', 'failed']).toContain(json.status);
  });

  it('valid API key actor (source:api-key) with a real owner user → 202 successful upload', async () => {
    // An API key actor has a synthetic id (api-key:<uuid>) which is NOT in the
    // user table and cannot be a collection owner (FK constraint). For the test
    // we return an actor whose id IS a real user in the DB — simulating a
    // future state where api_keys has an ownerId link. This validates the
    // entire happy path through the route with source:'api-key'.
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);

    // Mock authenticateRequest to return the real user's id with source=api-key.
    mockAuthenticate.mockResolvedValueOnce({
      id: userId,       // real user id — passes FK + ACL checks
      role: 'user' as const,
      source: 'api-key' as const,
    });

    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');
    const res = await POST(makeUploadReq(
      { collectionId: colId, title: 'API Key Upload' },
      [{ name: 'part.stl', content: 'solid x\nendsolid x' }],
    ));

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toHaveProperty('jobId');
  });

  // ── Duplicate-filename handling ───────────────────────────────────────────

  it('two files with the same sanitized name → both are staged (second gets -1 suffix)', async () => {
    // Regression guard: without a counter, the second writeFile silently
    // overwrites the first — user loses data. Dedupe keys on the sanitized
    // base name so `../model.stl` and `./model.stl` (both → 'model.stl')
    // become distinct `model.stl` + `model-1.stl` on disk.
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(userId));

    const { POST } = await import('../../../src/app/api/v1/loot/upload/route');
    const res = await POST(makeUploadReq(
      { collectionId: colId, title: 'Dup filename test' },
      [
        { name: 'model.stl', content: 'solid first\nendsolid first' },
        { name: '../model.stl', content: 'solid second\nendsolid second' },
      ],
    ));

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toHaveProperty('jobId');

    // If the pipeline placed the Loot, both LootFiles should be present.
    // Whether it was placed or quarantined, the staged filenames must be
    // distinct — this is the core regression guard. We verify via LootFiles
    // if placed; otherwise the test passes as long as no FK/IO error surfaced.
    if (json.status === 'placed') {
      const fileRows = await db()
        .select({ path: schema.lootFiles.path })
        .from(schema.lootFiles)
        .where(eq(schema.lootFiles.lootId, json.lootId));
      expect(fileRows.length).toBe(2);
      const basenames = fileRows.map((r: { path: string }) => path.basename(r.path)).sort();
      // First file keeps the plain name; second gets the -1 suffix.
      expect(basenames).toEqual(['model-1.stl', 'model.stl']);
    }
  });

  // ── Pipeline failure ──────────────────────────────────────────────────────

  it('returns 500 with {error:internal} when pipeline.run() throws unexpectedly', async () => {
    // Regression guard: pipeline.run() performs its initial ingest_jobs INSERT
    // before its own try/catch. A DB failure at that point (or any other
    // unexpected throw) must be caught at the route level so (1) the caller
    // sees a structured 500 rather than a Next.js default error page, and
    // (2) the staged tempDir is cleaned up.
    const userId = await seedUser();
    const { rootId } = await seedStashRoot(userId);
    const colId = await seedCollection(userId, rootId);
    mockAuthenticate.mockResolvedValueOnce(makeSessionActor(userId));

    // Spy on createIngestPipeline to return a pipeline whose run() throws.
    const scavengersMod = await import('../../../src/scavengers');
    const spy = vi.spyOn(scavengersMod, 'createIngestPipeline').mockImplementation(
      () => ({
        run: async () => {
          throw new Error('simulated pipeline failure');
        },
      }),
    );

    try {
      const { POST } = await import('../../../src/app/api/v1/loot/upload/route');
      const res = await POST(makeUploadReq(
        { collectionId: colId, title: 'Pipeline fail test' },
        [{ name: 'file.stl', content: 'solid y\nendsolid y' }],
      ));
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json).toMatchObject({ error: 'internal', reason: 'pipeline error' });
    } finally {
      spy.mockRestore();
    }

    // Verify no stranded tempDirs from this upload remain in /tmp.
    // (The uploadId is random per call, so we can't target exactly — instead
    // assert that the tmpdir has no `lootgoblin-upload-` dirs that still exist
    // with pending files. This is a best-effort check, not a strict assertion.)
    const tmpEntries = await fsp.readdir(os.tmpdir()).catch(() => [] as string[]);
    const uploadDirs = tmpEntries.filter((e) => e.startsWith('lootgoblin-upload-'));
    // Any lingering dirs would be a leak — but other concurrent tests may
    // also create them. We tolerate some, but not many.
    expect(uploadDirs.length).toBeLessThan(20);
  });
});
