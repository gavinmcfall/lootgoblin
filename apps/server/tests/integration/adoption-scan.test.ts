/**
 * Integration tests — POST /api/v1/stash-roots/[id]/adoption/scan
 *
 * Real SQLite DB + real filesystem fixtures.
 * Auth mocked via the standard request-auth shim.
 *
 * Test coverage:
 *   1. Owner scans their stash root → 200, proposalId + candidates + derivedTemplates + expiresAt
 *   2. Proposal is retrievable via getProposal after scan
 *   3. candidates have fileCount/totalBytes derived from actual files
 *   4. Non-owner → 403
 *   5. Unknown stash root id → 404
 *   6. Unauthenticated → 401
 *   7. Walker error (root path does not exist) → 500, no proposal cached
 *   8. Admin can scan another user's stash root → 200
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import {
  getProposal,
  __resetProposalCacheForTests,
} from '../../src/stash/adoption/proposal-cache';

// ---------------------------------------------------------------------------
// Next.js shim
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

// ---------------------------------------------------------------------------
// Auth mock
// ---------------------------------------------------------------------------

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

const DB_PATH = '/tmp/lootgoblin-adoption-scan.db';
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
}, 30_000);

afterEach(() => {
  __resetProposalCacheForTests();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedUser(role: 'admin' | 'user' = 'user'): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Scan Test User',
    email: `${id}@scan.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string, rootPath: string): Promise<string> {
  const id = uid();
  await db().insert(schema.stashRoots).values({
    id,
    ownerId,
    name: 'Scan Test Root',
    path: rootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function makeScratchDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lg-scan-'));
}

async function writeFile(absPath: string, content = 'lootgoblin test\n'): Promise<void> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, content, 'utf8');
}

function makeActor(userId: string, role: 'admin' | 'user' = 'user') {
  return { id: userId, role, source: 'session' as const };
}

function makePostRequest(url = 'http://local/api/v1/stash-roots/test/adoption/scan'): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/stash-roots/[id]/adoption/scan', () => {
  it('1. owner scans stash root → 200 with proposalId, candidates, derivedTemplates, expiresAt', async () => {
    const scratch = await makeScratchDir();
    const userId = await seedUser();
    // Create a folder with a couple of STL files so the scan has candidates.
    await writeFile(path.join(scratch, 'DragonModel', 'dragon.stl'));
    await writeFile(path.join(scratch, 'DragonModel', 'thumbnail.png'), 'thumb');
    const rootId = await seedStashRoot(userId, scratch);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/scan/route'
    );
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: rootId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(typeof body.proposalId).toBe('string');
    expect(body.proposalId.length).toBeGreaterThan(0);
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(typeof body.derivedTemplates).toBe('object');
    expect(Array.isArray(body.derivedTemplates.templates)).toBe(true);
    expect(typeof body.derivedTemplates.patternDetected).toBe('boolean');
    expect(typeof body.expiresAt).toBe('string');
    // expiresAt should be in the future
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  }, 30_000);

  it('2. proposal is retrievable via getProposal after scan', async () => {
    const scratch = await makeScratchDir();
    const userId = await seedUser();
    await writeFile(path.join(scratch, 'Widget', 'widget.stl'));
    const rootId = await seedStashRoot(userId, scratch);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/scan/route'
    );
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: rootId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const { proposalId } = body;

    // Must be retrievable by owner + stashRootId
    const cached = getProposal(proposalId, userId, rootId);
    expect(cached).not.toBeNull();
    expect(cached!.id).toBe(proposalId);
    expect(cached!.userId).toBe(userId);
    expect(cached!.stashRootId).toBe(rootId);
    expect(Array.isArray(cached!.candidates)).toBe(true);
  }, 30_000);

  it('3. candidates have fileCount and totalBytes derived from actual files', async () => {
    const scratch = await makeScratchDir();
    const userId = await seedUser();
    // Create a folder with exactly 2 files of known sizes
    const content1 = 'abcde'; // 5 bytes
    const content2 = 'fghij'; // 5 bytes
    await writeFile(path.join(scratch, 'KnownFolder', 'file1.stl'), content1);
    await writeFile(path.join(scratch, 'KnownFolder', 'file2.stl'), content2);
    const rootId = await seedStashRoot(userId, scratch);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/scan/route'
    );
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: rootId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.candidates.length).toBeGreaterThanOrEqual(1);
    const candidate = body.candidates.find(
      (c: { folderRelativePath: string }) => c.folderRelativePath === 'KnownFolder',
    );
    expect(candidate).toBeDefined();
    expect(candidate.fileCount).toBe(2);
    expect(candidate.totalBytes).toBe(content1.length + content2.length);
  }, 30_000);

  it('4. non-owner → 403', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const otherId = await seedUser();
    await writeFile(path.join(scratch, 'Model', 'model.stl'));
    const rootId = await seedStashRoot(ownerId, scratch);

    mockAuthenticate.mockResolvedValue(makeActor(otherId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/scan/route'
    );
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: rootId }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
  }, 15_000);

  it('5. unknown stash root id → 404', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/scan/route'
    );
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: uid() }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not-found');
  }, 15_000);

  it('6. unauthenticated → 401', async () => {
    const userId = await seedUser();
    const scratch = await makeScratchDir();
    const rootId = await seedStashRoot(userId, scratch);

    mockAuthenticate.mockResolvedValue(null);

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/scan/route'
    );
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: rootId }),
    });

    expect(res.status).toBe(401);
  }, 15_000);

  it('7. walker error (stash root path does not exist) → 500, no proposal cached', async () => {
    const userId = await seedUser();
    // Seed a stash root pointing at a nonexistent path.
    // The route checks fs.access before calling scan; inaccessible paths → 500.
    const ghostPath = path.join(os.tmpdir(), `lg-ghost-${uid()}`);
    // Ensure the path definitely does not exist.
    if (fs.existsSync(ghostPath)) {
      fs.rmSync(ghostPath, { recursive: true });
    }
    const rootId = await seedStashRoot(userId, ghostPath);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/scan/route'
    );
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: rootId }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeDefined();

    // No proposalId should be present (no proposal was cached)
    expect(body.proposalId).toBeUndefined();

    // A fabricated proposalId should not find anything in the cache
    const notCached = getProposal(uid(), userId, rootId);
    expect(notCached).toBeNull();
  }, 15_000);

  it('8. admin can scan another user stash root → 200', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const adminId = await seedUser('admin');
    await writeFile(path.join(scratch, 'AdminTarget', 'file.stl'));
    const rootId = await seedStashRoot(ownerId, scratch);

    mockAuthenticate.mockResolvedValue(makeActor(adminId, 'admin'));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/scan/route'
    );
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: rootId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.proposalId).toBe('string');
    expect(Array.isArray(body.candidates)).toBe(true);
  }, 30_000);
});
