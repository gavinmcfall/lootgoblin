// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration tests — GET + DELETE /api/v1/stash-roots/[id]/adoption/proposals/[proposalId]
 *
 * Real SQLite DB. Proposals seeded directly via putProposal (fast + deterministic).
 * Auth mocked via the standard request-auth shim.
 *
 * Test coverage:
 *   1.  GET owner → 200, response shape matches ScanResponseDto
 *   2.  GET returns candidates equivalent to what was cached
 *   3.  GET unknown proposalId → 404
 *   4.  GET proposalId belonging to a different user → 404
 *   5.  GET proposalId belonging to a different stash root (right user, wrong [id]) → 404
 *   6.  GET non-owner of the stash root → 403
 *   7.  GET unauthenticated → 401
 *   8.  DELETE owner → 200 {ok:true}, proposal is gone afterward
 *   9.  DELETE unknown proposalId → 404
 *  10.  DELETE non-owner → 403
 *  11.  DELETE then DELETE again → second is 404
 *  12.  DELETE unauthenticated → 401
 *  13.  DELETE proposalId belonging to a different user → 404, proposal not side-effected
 *  14.  DELETE proposalId belonging to a different stash root (right user, wrong [id]) → 404, proposal not side-effected
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import {
  putProposal,
  getProposal,
  __resetProposalCacheForTests,
  type AdoptionProposal as CacheProposal,
} from '../../src/stash/adoption/proposal-cache';
import type { AdoptionCandidate } from '../../src/stash/adoption';

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

const DB_PATH = '/tmp/lootgoblin-adoption-lifecycle.db';
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
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Lifecycle Test User',
    email: `${id}@lifecycle.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.stashRoots).values({
    id,
    ownerId,
    name: 'Lifecycle Test Root',
    path: '/tmp/lifecycle-test',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function makeActor(userId: string, role: 'admin' | 'user' = 'user') {
  return { id: userId, role, source: 'session' as const };
}

/** Builds a minimal AdoptionCandidate with a classifiable title. */
function makeCandidate(id: string, folderRelativePath: string, title: string): AdoptionCandidate {
  return {
    id,
    folderRelativePath,
    files: [
      {
        absolutePath: `/tmp/lifecycle-test/${folderRelativePath}/model.stl`,
        relativePath: `${folderRelativePath}/model.stl`,
        size: 512,
        mtime: new Date(),
      },
    ],
    classification: {
      title: { value: title, confidence: 0.9, source: 'filename' },
      creator: { value: 'TestCreator', confidence: 0.7, source: 'folder-pattern' },
    },
  };
}

/** Seeds a proposal in the cache for the given user + stash root. */
function seedProposal(
  userId: string,
  stashRootId: string,
  candidates: AdoptionCandidate[],
): string {
  const proposalId = uid();
  const now = new Date();
  const entry: CacheProposal = {
    id: proposalId,
    userId,
    stashRootId,
    createdAt: now,
    lastAccessedAt: now,
    candidates,
    derivedTemplates: { templates: ['{creator|slug}/{title|slug}'], patternDetected: true },
  };
  putProposal(entry);
  return proposalId;
}

function makeGetRequest(stashRootId: string, proposalId: string): Request {
  return new Request(
    `http://local/api/v1/stash-roots/${stashRootId}/adoption/proposals/${proposalId}`,
    { method: 'GET' },
  );
}

function makeDeleteRequest(stashRootId: string, proposalId: string): Request {
  return new Request(
    `http://local/api/v1/stash-roots/${stashRootId}/adoption/proposals/${proposalId}`,
    { method: 'DELETE' },
  );
}

// ---------------------------------------------------------------------------
// Tests — GET
// ---------------------------------------------------------------------------

describe('GET /api/v1/stash-roots/[id]/adoption/proposals/[proposalId]', () => {
  it('1. owner → 200, response shape matches ScanResponseDto', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const c1 = makeCandidate(uid(), 'DragonModel', 'Dragon Model');
    const proposalId = seedProposal(userId, rootId, [c1]);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { GET } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/proposals/[proposalId]/route'
    );
    const res = await GET(
      makeGetRequest(rootId, proposalId),
      { params: Promise.resolve({ id: rootId, proposalId }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    // ScanResponseDto shape: proposalId, candidates[], derivedTemplates, expiresAt
    expect(body.proposalId).toBe(proposalId);
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(typeof body.derivedTemplates).toBe('object');
    expect(Array.isArray(body.derivedTemplates.templates)).toBe(true);
    expect(typeof body.derivedTemplates.patternDetected).toBe('boolean');
    expect(typeof body.expiresAt).toBe('string');
    // Validate ISO timestamp format
    expect(() => new Date(body.expiresAt)).not.toThrow();
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  }, 15_000);

  it('2. GET returns candidates equivalent to what was cached', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const c1 = makeCandidate(uid(), 'SpaceShip', 'Space Ship');
    const c2 = makeCandidate(uid(), 'RocketBooster', 'Rocket Booster');
    const proposalId = seedProposal(userId, rootId, [c1, c2]);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { GET } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/proposals/[proposalId]/route'
    );
    const res = await GET(
      makeGetRequest(rootId, proposalId),
      { params: Promise.resolve({ id: rootId, proposalId }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.candidates).toHaveLength(2);

    // First candidate
    expect(body.candidates[0].id).toBe(c1.id);
    expect(body.candidates[0].folderRelativePath).toBe(c1.folderRelativePath);
    expect(typeof body.candidates[0].fileCount).toBe('number');
    expect(typeof body.candidates[0].totalBytes).toBe('number');
    expect(body.candidates[0].classification.title).toBe('Space Ship');

    // Second candidate
    expect(body.candidates[1].id).toBe(c2.id);
    expect(body.candidates[1].classification.title).toBe('Rocket Booster');

    // derivedTemplates matches what was seeded
    expect(body.derivedTemplates.templates).toEqual(['{creator|slug}/{title|slug}']);
    expect(body.derivedTemplates.patternDetected).toBe(true);
  }, 15_000);

  it('3. unknown proposalId → 404', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { GET } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/proposals/[proposalId]/route'
    );
    const unknownId = uid();
    const res = await GET(
      makeGetRequest(rootId, unknownId),
      { params: Promise.resolve({ id: rootId, proposalId: unknownId }) },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not-found');
  }, 15_000);

  it('4. proposalId belonging to a different user → 404', async () => {
    // Caller owns the stash root (ACL passes), but proposal was seeded for another user.
    const callerUserId = await seedUser();
    const proposalSeederId = await seedUser();
    const rootId = await seedStashRoot(callerUserId);
    const c = makeCandidate(uid(), 'SomeModel', 'Some Model');
    const proposalId = seedProposal(proposalSeederId, rootId, [c]);

    mockAuthenticate.mockResolvedValue(makeActor(callerUserId));

    const { GET } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/proposals/[proposalId]/route'
    );
    const res = await GET(
      makeGetRequest(rootId, proposalId),
      { params: Promise.resolve({ id: rootId, proposalId }) },
    );

    // ACL passes (caller owns root), but getProposal userId mismatch → 404
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not-found');
  }, 15_000);

  it('5. proposalId belonging to different stash root (right user, wrong [id]) → 404', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const otherRootId = await seedStashRoot(userId);
    const c = makeCandidate(uid(), 'SomeModel', 'Some Model');
    // Proposal is for rootId, but we call with otherRootId in the path
    const proposalId = seedProposal(userId, rootId, [c]);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { GET } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/proposals/[proposalId]/route'
    );
    const res = await GET(
      makeGetRequest(otherRootId, proposalId),
      { params: Promise.resolve({ id: otherRootId, proposalId }) },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not-found');
  }, 15_000);

  it('6. non-owner of the stash root → 403', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const c = makeCandidate(uid(), 'OwnerModel', 'Owner Model');
    const proposalId = seedProposal(otherId, rootId, [c]);

    // otherId is NOT the owner of rootId → ACL fires 403 before getProposal
    mockAuthenticate.mockResolvedValue(makeActor(otherId));

    const { GET } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/proposals/[proposalId]/route'
    );
    const res = await GET(
      makeGetRequest(rootId, proposalId),
      { params: Promise.resolve({ id: rootId, proposalId }) },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
  }, 15_000);

  it('7. unauthenticated → 401', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);

    mockAuthenticate.mockResolvedValue(null);

    const { GET } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/proposals/[proposalId]/route'
    );
    const unknownId = uid();
    const res = await GET(
      makeGetRequest(rootId, unknownId),
      { params: Promise.resolve({ id: rootId, proposalId: unknownId }) },
    );

    expect(res.status).toBe(401);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Tests — DELETE
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/stash-roots/[id]/adoption/proposals/[proposalId]', () => {
  it('8. owner → 200 {ok:true}, proposal is gone afterward', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const c = makeCandidate(uid(), 'CancelMe', 'Cancel Me');
    const proposalId = seedProposal(userId, rootId, [c]);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { DELETE } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/proposals/[proposalId]/route'
    );
    const res = await DELETE(
      makeDeleteRequest(rootId, proposalId),
      { params: Promise.resolve({ id: rootId, proposalId }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Proposal must be gone from cache
    const afterDelete = getProposal(proposalId, userId, rootId);
    expect(afterDelete).toBeNull();
  }, 15_000);

  it('9. DELETE unknown proposalId → 404', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { DELETE } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/proposals/[proposalId]/route'
    );
    const unknownId = uid();
    const res = await DELETE(
      makeDeleteRequest(rootId, unknownId),
      { params: Promise.resolve({ id: rootId, proposalId: unknownId }) },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not-found');
  }, 15_000);

  it('10. DELETE non-owner → 403', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const c = makeCandidate(uid(), 'OwnerModel', 'Owner Model');
    const proposalId = seedProposal(otherId, rootId, [c]);

    // otherId is NOT the owner of rootId → ACL fires 403
    mockAuthenticate.mockResolvedValue(makeActor(otherId));

    const { DELETE } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/proposals/[proposalId]/route'
    );
    const res = await DELETE(
      makeDeleteRequest(rootId, proposalId),
      { params: Promise.resolve({ id: rootId, proposalId }) },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
  }, 15_000);

  it('11. DELETE then DELETE again → second is 404', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const c = makeCandidate(uid(), 'DoubleDelete', 'Double Delete');
    const proposalId = seedProposal(userId, rootId, [c]);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { DELETE } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/proposals/[proposalId]/route'
    );

    // First DELETE succeeds
    const res1 = await DELETE(
      makeDeleteRequest(rootId, proposalId),
      { params: Promise.resolve({ id: rootId, proposalId }) },
    );
    expect(res1.status).toBe(200);

    // Second DELETE — proposal is gone, stash root still exists
    const res2 = await DELETE(
      makeDeleteRequest(rootId, proposalId),
      { params: Promise.resolve({ id: rootId, proposalId }) },
    );
    expect(res2.status).toBe(404);
    const body2 = await res2.json();
    expect(body2.error).toBe('not-found');
  }, 15_000);

  it('12. DELETE unauthenticated → 401', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);

    mockAuthenticate.mockResolvedValue(null);

    const { DELETE } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/proposals/[proposalId]/route'
    );
    const unknownId = uid();
    const res = await DELETE(
      makeDeleteRequest(rootId, unknownId),
      { params: Promise.resolve({ id: rootId, proposalId: unknownId }) },
    );

    expect(res.status).toBe(401);
  }, 15_000);

  it('13. DELETE proposalId belonging to a different user → 404, proposal not side-effected', async () => {
    // callerUserId owns the stash root (ACL passes), but proposal was seeded for proposalSeederId.
    const callerUserId = await seedUser();
    const proposalSeederId = await seedUser();
    const rootId = await seedStashRoot(callerUserId);
    const c = makeCandidate(uid(), 'OtherUserModel', 'Other User Model');
    const proposalId = seedProposal(proposalSeederId, rootId, [c]);

    mockAuthenticate.mockResolvedValue(makeActor(callerUserId));

    const { DELETE } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/proposals/[proposalId]/route'
    );
    const res = await DELETE(
      makeDeleteRequest(rootId, proposalId),
      { params: Promise.resolve({ id: rootId, proposalId }) },
    );

    // ACL passes (caller owns root), but getProposal userId mismatch → 404
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not-found');

    // Proposal must still exist under its correct owner keys
    const stillThere = getProposal(proposalId, proposalSeederId, rootId);
    expect(stillThere).not.toBeNull();
  }, 15_000);

  it('14. DELETE proposalId belonging to different stash root (right user, wrong [id]) → 404, proposal not side-effected', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const otherRootId = await seedStashRoot(userId);
    const c = makeCandidate(uid(), 'WrongRootModel', 'Wrong Root Model');
    // Proposal is for rootId, but we DELETE via otherRootId in the path
    const proposalId = seedProposal(userId, rootId, [c]);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { DELETE } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/proposals/[proposalId]/route'
    );
    const res = await DELETE(
      makeDeleteRequest(otherRootId, proposalId),
      { params: Promise.resolve({ id: otherRootId, proposalId }) },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not-found');

    // Proposal must still exist under its correct stash root key
    const stillThere = getProposal(proposalId, userId, rootId);
    expect(stillThere).not.toBeNull();
  }, 15_000);
});
