/**
 * Integration tests — POST /api/v1/stash-roots/[id]/adoption/preview
 *
 * Real SQLite DB. Proposals seeded directly via putProposal (fast + deterministic).
 * Auth mocked via the standard request-auth shim.
 *
 * Test coverage:
 *   1.  Happy path: 200, options[] each with 5 DTO fields
 *   2.  selectedCandidateIds subset → only subset considered
 *   3.  selectedCandidateIds omitted → all candidates considered
 *   4.  Unknown proposalId → 404
 *   5.  proposalId belonging to a different user → 404
 *   6.  proposalId belonging to a different stash root (right user, wrong [id]) → 404
 *   7.  Invalid/unresolvable template → incompatibleCount = all candidates
 *   8a. Invalid body: missing proposalId → 400
 *   8b. Invalid body: empty templates array → 400
 *   8c. Invalid body: unknown key (strict mode) → 400
 *   9.  Non-owner (valid proposal, caller is not owner) → 403
 *  10.  Unauthenticated → 401
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import {
  putProposal,
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

const DB_PATH = '/tmp/lootgoblin-adoption-preview.db';
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
    name: 'Preview Test User',
    email: `${id}@preview.test`,
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
    name: 'Preview Test Root',
    path: '/tmp/preview-test',
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
        absolutePath: `/tmp/preview-test/${folderRelativePath}/model.stl`,
        relativePath: `${folderRelativePath}/model.stl`,
        size: 100,
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

function makePostRequest(body: unknown, stashRootId = 'test'): Request {
  return new Request(
    `http://local/api/v1/stash-roots/${stashRootId}/adoption/preview`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/stash-roots/[id]/adoption/preview', () => {
  it('1. happy path → 200, options[] each with 5 DTO fields', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const c1 = makeCandidate(uid(), 'DragonModel', 'Dragon Model');
    const c2 = makeCandidate(uid(), 'SpaceShip', 'Space Ship');
    const proposalId = seedProposal(userId, rootId, [c1, c2]);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/preview/route'
    );
    const res = await POST(
      makePostRequest({
        proposalId,
        templates: ['{title|slug}', '{creator|slug}/{title|slug}'],
      }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.options)).toBe(true);
    expect(body.options.length).toBeGreaterThan(0);

    for (const opt of body.options) {
      expect(typeof opt.template).toBe('string');
      expect(typeof opt.predictedLootCount).toBe('number');
      expect(typeof opt.collisionCount).toBe('number');
      expect(typeof opt.incompatibleCount).toBe('number');
      expect(Array.isArray(opt.examples)).toBe(true);
    }
  }, 15_000);

  it('2. selectedCandidateIds subset → only those candidates in options', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const c1 = makeCandidate(uid(), 'ModelA', 'Model A');
    const c2 = makeCandidate(uid(), 'ModelB', 'Model B');
    const c3 = makeCandidate(uid(), 'ModelC', 'Model C');
    const proposalId = seedProposal(userId, rootId, [c1, c2, c3]);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/preview/route'
    );

    // Full set: all 3 candidates, each with a distinct title → all resolve cleanly.
    const fullRes = await POST(
      makePostRequest({ proposalId, templates: ['{title|slug}'] }),
      { params: Promise.resolve({ id: rootId }) },
    );
    expect(fullRes.status).toBe(200);
    const fullBody = await fullRes.json();

    // Subset: only c1 → the route must operate on exactly 1 candidate.
    const subsetRes = await POST(
      makePostRequest({
        proposalId,
        templates: ['{title|slug}'],
        selectedCandidateIds: [c1.id],
      }),
      { params: Promise.resolve({ id: rootId }) },
    );
    expect(subsetRes.status).toBe(200);
    const subsetBody = await subsetRes.json();

    // The fixture candidates all have distinct titles, so each resolves to a
    // unique path without collisions or incompatibles. Asserting exact counts
    // (not arithmetic) proves selectedCandidateIds actually reduces the working set.
    expect(fullBody.options[0].predictedLootCount).toBe(3);
    expect(subsetBody.options[0].predictedLootCount).toBe(1);
    expect(subsetBody.options[0].predictedLootCount).toBeLessThan(
      fullBody.options[0].predictedLootCount,
    );
  }, 15_000);

  it('3. selectedCandidateIds omitted → all candidates considered', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const candidates = [
      makeCandidate(uid(), 'Alpha', 'Alpha Model'),
      makeCandidate(uid(), 'Beta', 'Beta Model'),
      makeCandidate(uid(), 'Gamma', 'Gamma Model'),
    ];
    const proposalId = seedProposal(userId, rootId, candidates);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/preview/route'
    );
    const res = await POST(
      makePostRequest({ proposalId, templates: ['{title|slug}'] }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    // The fixture uses three candidates with distinct slugified titles
    // (alpha-model, beta-model, gamma-model), so every candidate resolves to a
    // unique path. No collisions, no incompatibles — all three land in
    // predictedLootCount.
    //
    // NOTE: collisionCount is the count of *collision paths* (paths shared by
    // >1 candidate), not a per-candidate count. Adding predictedLootCount +
    // incompatibleCount + collisionCount does NOT equal total candidate count
    // when collisions exist. We assert predictedLootCount directly to avoid
    // that fragile arithmetic.
    for (const opt of body.options) {
      expect(opt.predictedLootCount).toBe(3);
      expect(opt.incompatibleCount).toBe(0);
      expect(opt.collisionCount).toBe(0);
    }
  }, 15_000);

  it('4. unknown proposalId → 404', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/preview/route'
    );
    const res = await POST(
      makePostRequest({ proposalId: uid(), templates: ['{title|slug}'] }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not-found');
  }, 15_000);

  it('5. proposalId belonging to different user → 404', async () => {
    // The ACL fires before getProposal. To test that getProposal returns null
    // for a userId mismatch, the caller must OWN the stash root (so ACL passes)
    // but the proposal was seeded by a different user.
    //
    // Setup: callerUserId owns the stash root; proposalSeederId is someone else
    // who somehow seeded a proposal under that root (unusual, but the cache
    // accepts it — we're testing the ACL on getProposal, not putProposal).
    const callerUserId = await seedUser();
    const proposalSeederId = await seedUser();
    const rootId = await seedStashRoot(callerUserId); // caller owns the root
    const c = makeCandidate(uid(), 'SomeModel', 'Some Model');
    // Proposal was seeded for proposalSeederId, not callerUserId
    const proposalId = seedProposal(proposalSeederId, rootId, [c]);

    mockAuthenticate.mockResolvedValue(makeActor(callerUserId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/preview/route'
    );
    const res = await POST(
      makePostRequest({ proposalId, templates: ['{title|slug}'] }),
      { params: Promise.resolve({ id: rootId }) },
    );

    // ACL passes (caller owns the root), but getProposal returns null because
    // userId doesn't match the proposal's userId — hide-existence → 404.
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not-found');
  }, 15_000);

  it('6. proposalId belonging to different stash root (right user, wrong [id]) → 404', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const otherRootId = await seedStashRoot(userId);
    const c = makeCandidate(uid(), 'SomeModel', 'Some Model');
    // Proposal is for rootId, but we call with otherRootId in the path
    const proposalId = seedProposal(userId, rootId, [c]);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/preview/route'
    );
    const res = await POST(
      makePostRequest({ proposalId, templates: ['{title|slug}'] }),
      { params: Promise.resolve({ id: otherRootId }) },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not-found');
  }, 15_000);

  it('7. invalid/unresolvable template → all candidates in incompatibleCount', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);
    const candidates = [
      makeCandidate(uid(), 'ThingOne', 'Thing One'),
      makeCandidate(uid(), 'ThingTwo', 'Thing Two'),
    ];
    const proposalId = seedProposal(userId, rootId, candidates);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/preview/route'
    );
    // '{nonexistent_field}' will cause missing-field for every candidate
    const res = await POST(
      makePostRequest({ proposalId, templates: ['{nonexistent_field}'] }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    // '{nonexistent_field}' is syntactically valid — parseTemplate succeeds.
    // At resolution time, 'nonexistent_field' is absent from every candidate's
    // metadata record, so resolveTemplate returns { ok: false, reason: 'missing-field' }
    // for all candidates. buildTemplateOptions does NOT skip the template (the
    // `continue` only fires on parse errors, not resolution failures). It produces
    // exactly one TemplateOptionDto with all candidates in incompatible[].
    expect(body.options).toHaveLength(1);
    expect(body.options[0].incompatibleCount).toBe(candidates.length);
    expect(body.options[0].predictedLootCount).toBe(0);
    expect(body.options[0].collisionCount).toBe(0);
  }, 15_000);

  it('8a. invalid body: missing proposalId → 400', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/preview/route'
    );
    const res = await POST(
      makePostRequest({ templates: ['{title|slug}'] }), // missing proposalId
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-body');
  }, 15_000);

  it('8b. invalid body: empty templates array → 400', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/preview/route'
    );
    const res = await POST(
      makePostRequest({ proposalId: uid(), templates: [] }), // empty array violates min(1)
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-body');
  }, 15_000);

  it('8c. invalid body: unknown key (strict mode) → 400', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/preview/route'
    );
    const res = await POST(
      makePostRequest({ proposalId: uid(), templates: ['{title|slug}'], unknownKey: 'oops' }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-body');
  }, 15_000);

  it('9. non-owner (valid proposal, caller is not owner) → 403', async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const c = makeCandidate(uid(), 'OwnerModel', 'Owner Model');
    // We need the proposal to be for the other user but the stash root is owned by ownerId.
    // The ACL check fires BEFORE getProposal, so a non-owner should get 403.
    const proposalId = seedProposal(otherId, rootId, [c]);

    mockAuthenticate.mockResolvedValue(makeActor(otherId));

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/preview/route'
    );
    const res = await POST(
      makePostRequest({ proposalId, templates: ['{title|slug}'] }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
  }, 15_000);

  it('10. unauthenticated → 401', async () => {
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId);

    mockAuthenticate.mockResolvedValue(null);

    const { POST } = await import(
      '../../src/app/api/v1/stash-roots/[id]/adoption/preview/route'
    );
    const res = await POST(
      makePostRequest({ proposalId: uid(), templates: ['{title|slug}'] }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(401);
  }, 15_000);
});
