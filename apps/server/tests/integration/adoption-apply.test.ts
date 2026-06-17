// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration tests — POST /api/v1/stash-roots/[id]/adoption/apply
 *
 * Real SQLite DB + real filesystem fixtures. The applier actually reads/moves
 * files, so candidates are seeded pointing at real temp files.
 *
 * Auth mocked via the standard request-auth shim. The proposal cache is seeded
 * directly via `putProposal` (the scan step is exercised separately in
 * adoption-scan.test.ts).
 *
 * Test coverage:
 *   1.  Owner apply, mode 'in-place' → 200 ApplyReportDto; Collection + Loot
 *       rows exist; proposal cleared; ledger event row with correct payload.
 *   2.  Owner apply, mode 'copy-then-cleanup' → 200; files moved, originals gone.
 *   3.  Partial candidate selection → only selected candidates materialized.
 *   4.  selectedCandidateIds containing an unknown id → 400 invalid-candidate-ids.
 *   5.  Unknown proposalId → 404, no DB writes.
 *   6.  proposalId belonging to a different user → 404.
 *   7.  proposalId belonging to a different stash root → 404.
 *   8.  Non-owner → 403.
 *   9.  Unauthenticated → 401.
 *   10. Invalid body (bad enum / empty collectionName / unknown key) → 400.
 *   11. Apply twice with same proposalId → second call 404 (proposal consumed).
 *   12. applyAdoptionPlan throws (Collection name uniqueness collision) → 500,
 *       proposal NOT deleted, no ledger event.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import {
  putProposal,
  getProposal,
  __resetProposalCacheForTests,
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

const DB_PATH = '/tmp/lootgoblin-adoption-apply.db';
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
  mockAuthenticate.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Apply Test User',
    email: `${id}@apply.test`,
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
    name: 'Apply Test Root',
    path: rootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function makeScratchDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lg-apply-'));
}

async function writeFile(absPath: string, content = 'lootgoblin test\n'): Promise<void> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, content, 'utf8');
}

function makeActor(userId: string, role: 'admin' | 'user' = 'user') {
  return { id: userId, role, source: 'session' as const };
}

function makePostRequest(body: unknown): Request {
  return new Request('http://local/api/v1/stash-roots/test/adoption/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/**
 * Builds a real AdoptionCandidate backed by a real file on disk, with a
 * classification carrying a title (so a `{title|slug}` template resolves).
 */
async function makeCandidate(
  scratch: string,
  folderName: string,
  fileName: string,
  title: string,
): Promise<AdoptionCandidate> {
  const absPath = path.join(scratch, folderName, fileName);
  const content = `content for ${title}\n`;
  await writeFile(absPath, content);
  const stat = await fsp.stat(absPath);
  return {
    id: uid(),
    folderRelativePath: folderName,
    files: [
      {
        absolutePath: absPath,
        relativePath: `${folderName}/${fileName}`,
        size: stat.size,
        mtime: stat.mtime,
      },
    ],
    classification: {
      needsUserInput: [],
      title: { value: title, confidence: 0.9, source: 'filename' },
    },
  };
}

/**
 * Seeds a proposal in the cache with the given candidates.
 */
function seedProposal(
  userId: string,
  stashRootId: string,
  candidates: AdoptionCandidate[],
): string {
  const proposalId = uid();
  const now = new Date();
  putProposal({
    id: proposalId,
    userId,
    stashRootId,
    createdAt: now,
    lastAccessedAt: now,
    candidates,
    derivedTemplates: { templates: ['{title|slug}'], patternDetected: true },
  });
  return proposalId;
}

async function importApplyPost() {
  const mod = await import(
    '../../src/app/api/v1/stash-roots/[id]/adoption/apply/route'
  );
  return mod.POST;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/stash-roots/[id]/adoption/apply', () => {
  it('1. owner apply in-place → 200 ApplyReportDto, Collection + Loot rows, proposal cleared, ledger event', async () => {
    const scratch = await makeScratchDir();
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratch);

    const candidates = [
      await makeCandidate(scratch, 'Dragon', 'dragon.stl', 'Dragon'),
      await makeCandidate(scratch, 'Basilisk', 'basilisk.stl', 'Basilisk'),
    ];
    const proposalId = seedProposal(userId, rootId, candidates);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const POST = await importApplyPost();
    const res = await POST(
      makePostRequest({
        proposalId,
        template: '{title|slug}',
        selectedCandidateIds: candidates.map((c) => c.id),
        mode: 'in-place',
        collectionName: 'Adopted Dragons',
      }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(typeof body.collectionId).toBe('string');
    expect(body.adoptedCount).toBe(2);
    expect(body.skippedCount).toBe(0);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors).toHaveLength(0);

    // Collection row exists.
    const cols = await db().select().from(schema.collections);
    const col = cols.find((c) => c.id === body.collectionId);
    expect(col).toBeDefined();
    expect(col!.stashRootId).toBe(rootId);
    expect(col!.name).toBe('Adopted Dragons');

    // Loot rows exist under that collection.
    const allLoot = await db().select().from(schema.loot);
    const loot = allLoot.filter((l) => l.collectionId === body.collectionId);
    expect(loot).toHaveLength(2);

    // Proposal consumed.
    expect(getProposal(proposalId, userId, rootId)).toBeNull();

    // Ledger event row exists with the correct payload.
    const events = await db().select().from(schema.ledgerEvents);
    const evt = events.find(
      (e) => e.kind === 'adoption.applied' && e.subjectId === body.collectionId,
    );
    expect(evt).toBeDefined();
    expect(evt!.subjectType).toBe('collection');
    expect(evt!.actorUserId).toBe(userId);
    const payload = JSON.parse(evt!.payload as string);
    expect(payload).toMatchObject({
      adoptedCount: 2,
      skippedCount: 0,
      errorCount: 0,
      mode: 'in-place',
      template: '{title|slug}',
    });
  }, 30_000);

  it('2. owner apply copy-then-cleanup → 200, files moved, originals gone', async () => {
    const scratch = await makeScratchDir();
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratch);

    const candidate = await makeCandidate(scratch, 'CoolDragon', 'model.stl', 'Cool Dragon');
    const originalPath = candidate.files[0]!.absolutePath;
    expect(fs.existsSync(originalPath)).toBe(true);

    const proposalId = seedProposal(userId, rootId, [candidate]);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const POST = await importApplyPost();
    const res = await POST(
      makePostRequest({
        proposalId,
        template: '{title|slug}',
        selectedCandidateIds: [candidate.id],
        mode: 'copy-then-cleanup',
        collectionName: 'CTC Collection',
      }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.adoptedCount).toBe(1);
    expect(body.errors).toHaveLength(0);

    // Original file moved away (copy-then-cleanup removes source).
    expect(fs.existsSync(originalPath)).toBe(false);
    // File now lives at the template-resolved path.
    const movedPath = path.join(scratch, 'cool-dragon', 'model.stl');
    expect(fs.existsSync(movedPath)).toBe(true);
  }, 30_000);

  it('3. partial candidate selection → only selected candidates materialized', async () => {
    const scratch = await makeScratchDir();
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratch);

    const candidates = [
      await makeCandidate(scratch, 'Alpha', 'alpha.stl', 'Alpha'),
      await makeCandidate(scratch, 'Beta', 'beta.stl', 'Beta'),
      await makeCandidate(scratch, 'Gamma', 'gamma.stl', 'Gamma'),
    ];
    const proposalId = seedProposal(userId, rootId, candidates);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const POST = await importApplyPost();
    // Only select Alpha + Gamma.
    const res = await POST(
      makePostRequest({
        proposalId,
        template: '{title|slug}',
        selectedCandidateIds: [candidates[0]!.id, candidates[2]!.id],
        mode: 'in-place',
        collectionName: 'Partial Collection',
      }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.adoptedCount).toBe(2);

    const allLoot = await db().select().from(schema.loot);
    const loot = allLoot.filter((l) => l.collectionId === body.collectionId);
    expect(loot).toHaveLength(2);
    const titles = loot.map((l) => l.title).sort();
    expect(titles).toEqual(['Alpha', 'Gamma']);
  }, 30_000);

  it('4. selectedCandidateIds with an unknown id → 400 invalid-candidate-ids', async () => {
    const scratch = await makeScratchDir();
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratch);

    const candidate = await makeCandidate(scratch, 'Known', 'known.stl', 'Known');
    const proposalId = seedProposal(userId, rootId, [candidate]);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const bogusId = uid();
    const POST = await importApplyPost();
    const res = await POST(
      makePostRequest({
        proposalId,
        template: '{title|slug}',
        selectedCandidateIds: [candidate.id, bogusId],
        mode: 'in-place',
        collectionName: 'Bad Ids Collection',
      }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-candidate-ids');
    expect(body.detail).toContain(bogusId);

    // No DB writes — proposal still intact (not consumed).
    expect(getProposal(proposalId, userId, rootId)).not.toBeNull();
  }, 30_000);

  it('5. unknown proposalId → 404, no DB writes', async () => {
    const scratch = await makeScratchDir();
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratch);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const colsBefore = (await db().select().from(schema.collections)).length;

    const POST = await importApplyPost();
    const res = await POST(
      makePostRequest({
        proposalId: uid(),
        template: '{title|slug}',
        selectedCandidateIds: [uid()],
        mode: 'in-place',
        collectionName: 'Ghost Collection',
      }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(404);
    const colsAfter = (await db().select().from(schema.collections)).length;
    expect(colsAfter).toBe(colsBefore);
  }, 30_000);

  it('6. proposalId belonging to a different user → 404', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const rootId = await seedStashRoot(ownerId, scratch);

    const candidate = await makeCandidate(scratch, 'Mine', 'mine.stl', 'Mine');
    // Proposal cached under `otherId`, not the stash-root owner.
    const proposalId = seedProposal(otherId, rootId, [candidate]);

    // Authenticate as the stash-root owner — they own the root (ACL passes)
    // but the proposal was cached under a different user.
    mockAuthenticate.mockResolvedValue(makeActor(ownerId));

    const POST = await importApplyPost();
    const res = await POST(
      makePostRequest({
        proposalId,
        template: '{title|slug}',
        selectedCandidateIds: [candidate.id],
        mode: 'in-place',
        collectionName: 'Wrong User Collection',
      }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(404);
  }, 30_000);

  it('7. proposalId belonging to a different stash root → 404', async () => {
    const scratch1 = await makeScratchDir();
    const scratch2 = await makeScratchDir();
    const userId = await seedUser();
    const rootA = await seedStashRoot(userId, scratch1);
    const rootB = await seedStashRoot(userId, scratch2);

    const candidate = await makeCandidate(scratch1, 'Item', 'item.stl', 'Item');
    // Proposal cached under rootA.
    const proposalId = seedProposal(userId, rootA, [candidate]);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    // Apply against rootB — proposal is for rootA.
    const POST = await importApplyPost();
    const res = await POST(
      makePostRequest({
        proposalId,
        template: '{title|slug}',
        selectedCandidateIds: [candidate.id],
        mode: 'in-place',
        collectionName: 'Wrong Root Collection',
      }),
      { params: Promise.resolve({ id: rootB }) },
    );

    expect(res.status).toBe(404);
  }, 30_000);

  it('8. non-owner → 403', async () => {
    const scratch = await makeScratchDir();
    const ownerId = await seedUser();
    const intruderId = await seedUser();
    const rootId = await seedStashRoot(ownerId, scratch);

    const candidate = await makeCandidate(scratch, 'Secret', 'secret.stl', 'Secret');
    const proposalId = seedProposal(ownerId, rootId, [candidate]);

    // Authenticate as a non-owner, non-admin user.
    mockAuthenticate.mockResolvedValue(makeActor(intruderId));

    const POST = await importApplyPost();
    const res = await POST(
      makePostRequest({
        proposalId,
        template: '{title|slug}',
        selectedCandidateIds: [candidate.id],
        mode: 'in-place',
        collectionName: 'Intruder Collection',
      }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(403);
  }, 30_000);

  it('9. unauthenticated → 401', async () => {
    const scratch = await makeScratchDir();
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratch);

    mockAuthenticate.mockResolvedValue(null);

    const POST = await importApplyPost();
    const res = await POST(
      makePostRequest({
        proposalId: uid(),
        template: '{title|slug}',
        selectedCandidateIds: [uid()],
        mode: 'in-place',
        collectionName: 'Anon Collection',
      }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(401);
  }, 30_000);

  it('10. invalid body (bad enum / empty collectionName / unknown key) → 400', async () => {
    const scratch = await makeScratchDir();
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratch);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const POST = await importApplyPost();

    // Bad mode enum.
    const res1 = await POST(
      makePostRequest({
        proposalId: uid(),
        template: '{title|slug}',
        selectedCandidateIds: [uid()],
        mode: 'teleport',
        collectionName: 'X',
      }),
      { params: Promise.resolve({ id: rootId }) },
    );
    expect(res1.status).toBe(400);

    // Empty collectionName.
    const res2 = await POST(
      makePostRequest({
        proposalId: uid(),
        template: '{title|slug}',
        selectedCandidateIds: [uid()],
        mode: 'in-place',
        collectionName: '',
      }),
      { params: Promise.resolve({ id: rootId }) },
    );
    expect(res2.status).toBe(400);

    // Unknown key (strict()).
    const res3 = await POST(
      makePostRequest({
        proposalId: uid(),
        template: '{title|slug}',
        selectedCandidateIds: [uid()],
        mode: 'in-place',
        collectionName: 'X',
        bonus: 'unexpected',
      }),
      { params: Promise.resolve({ id: rootId }) },
    );
    expect(res3.status).toBe(400);

    // Empty selectedCandidateIds (.min(1)).
    const res4 = await POST(
      makePostRequest({
        proposalId: uid(),
        template: '{title|slug}',
        selectedCandidateIds: [],
        mode: 'in-place',
        collectionName: 'X',
      }),
      { params: Promise.resolve({ id: rootId }) },
    );
    expect(res4.status).toBe(400);

    // Malformed JSON.
    const res5 = await POST(makePostRequest('{not json'), {
      params: Promise.resolve({ id: rootId }),
    });
    expect(res5.status).toBe(400);
  }, 30_000);

  it('11. apply twice with same proposalId → second call 404 (proposal consumed)', async () => {
    const scratch = await makeScratchDir();
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratch);

    const candidate = await makeCandidate(scratch, 'Once', 'once.stl', 'Once');
    const proposalId = seedProposal(userId, rootId, [candidate]);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const POST = await importApplyPost();
    const body = {
      proposalId,
      template: '{title|slug}',
      selectedCandidateIds: [candidate.id],
      mode: 'in-place' as const,
      collectionName: 'Idempotency Collection',
    };

    const res1 = await POST(makePostRequest(body), {
      params: Promise.resolve({ id: rootId }),
    });
    expect(res1.status).toBe(200);

    // Second call — proposal already deleted.
    const res2 = await POST(makePostRequest(body), {
      params: Promise.resolve({ id: rootId }),
    });
    expect(res2.status).toBe(404);
  }, 30_000);

  it('12. applyAdoptionPlan throws (Collection name collision) → 500, proposal NOT deleted, no ledger event', async () => {
    const scratch = await makeScratchDir();
    const userId = await seedUser();
    const rootId = await seedStashRoot(userId, scratch);

    // Pre-create a Collection with the name we'll try to use — the unique
    // index (owner_id, name) will make the applier's Collection insert throw.
    const collisionName = 'Collision Collection';
    await db().insert(schema.collections).values({
      id: uid(),
      ownerId: userId,
      name: collisionName,
      pathTemplate: '{title|slug}',
      stashRootId: rootId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const candidate = await makeCandidate(scratch, 'Doomed', 'doomed.stl', 'Doomed');
    const proposalId = seedProposal(userId, rootId, [candidate]);

    mockAuthenticate.mockResolvedValue(makeActor(userId));

    const eventsBefore = (await db().select().from(schema.ledgerEvents)).length;

    const POST = await importApplyPost();
    const res = await POST(
      makePostRequest({
        proposalId,
        template: '{title|slug}',
        selectedCandidateIds: [candidate.id],
        mode: 'in-place',
        collectionName: collisionName,
      }),
      { params: Promise.resolve({ id: rootId }) },
    );

    expect(res.status).toBe(500);

    // Proposal NOT deleted — user can retry.
    expect(getProposal(proposalId, userId, rootId)).not.toBeNull();

    // No ledger event was written by this failed apply — the row count is
    // unchanged. (A global `kind === 'adoption.applied'` check would be
    // polluted by other tests' successful applies in the shared DB; the
    // before/after count delta is the meaningful assertion here.)
    const events = await db().select().from(schema.ledgerEvents);
    expect(events.length).toBe(eventsBefore);
  }, 30_000);
});
