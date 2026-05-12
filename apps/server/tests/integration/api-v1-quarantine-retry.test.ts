/**
 * Integration tests — POST /api/v1/quarantine/[id]/retry — Quarantine HTTP Layer T5
 *
 * Real SQLite. Auth mocked via the request-auth shim.
 *
 * Coverage:
 *   - 200 owner retry on unresolved item: new ingest_job inserted (clone of original),
 *         quarantine resolved, ledger event recorded with related_resources + originalIngestJobId
 *   - 200 idempotent re-retry on already-retried item: same ingestJobId, no new ingest_job,
 *         no second ledger event
 *   - 409 retry on already-dismissed item (via real DELETE flow): error: 'already-dismissed'
 *   - 422 retry on orphaned quarantine item (no original ingest_job): no-source-job
 *   - 401 unauthenticated
 *   - 404 non-owner POST (existence hidden)
 *   - 404 unknown id
 *   - 404 admin cross-owner POST (admin may read, not write cross-tenant)
 *   - 200 empty body accepted (RetryBodySchema all-optional)
 *   - 200 body with override_classifier_hint accepted + hint lands in ledger payload
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { eq, desc, count, and } from 'drizzle-orm';

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

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-api-quarantine-retry.db';
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

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Quarantine Retry Test User',
    email: `${id}@quarantine-retry.test`,
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
    name: 'Retry Test Root',
    path: `/tmp/retry-test-root-${id}`,
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
    stashRootId,
    name: `Retry Test Collection ${id}`,
    pathTemplate: '{creator|slug}/{title|slug}',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedQuarantineItem(
  stashRootId: string,
  overrides: {
    reason?: string;
    resolvedAt?: Date | null;
    path?: string;
    details?: Record<string, unknown> | null;
  } = {},
): Promise<string> {
  const id = uid();
  await db().insert(schema.quarantineItems).values({
    id,
    stashRootId,
    path: overrides.path ?? `/tmp/quarantine/retry-${id}.stl`,
    reason: overrides.reason ?? 'integrity-failed',
    details: overrides.details !== undefined ? overrides.details : null,
    createdAt: new Date(),
    resolvedAt: overrides.resolvedAt !== undefined ? overrides.resolvedAt : null,
  });
  return id;
}

/**
 * Seed a realistic original ingest_job that caused a quarantine item to exist.
 *
 * Uses 'cults3d' as sourceId (a real registered adapter). targetKind is 'url'
 * and targetPayload contains a real Cults3D URL. collectionId is optional —
 * pass the id of a seeded collection to exercise the FK carry-through.
 */
async function seedOriginalIngestJob(
  ownerId: string,
  quarantineItemId: string,
  collectionId: string | null = null,
): Promise<string> {
  const id = uid();
  await db().insert(schema.ingestJobs).values({
    id,
    ownerId,
    sourceId: 'cults3d',
    targetKind: 'url',
    targetPayload: JSON.stringify({
      kind: 'url',
      url: 'https://cults3d.com/en/3d-model/test',
    }),
    collectionId,
    status: 'quarantined',
    lootId: null,
    quarantineItemId,
    failureReason: 'integrity-failed',
    failureDetails: null,
    attempt: 1,
    idempotencyKey: null,
    parentSubscriptionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

function makePost(url: string, body: unknown = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDelete(url: string): Request {
  return new Request(url, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// DB read-back helpers
// ---------------------------------------------------------------------------

async function getQuarantineRow(id: string) {
  const rows = await db()
    .select()
    .from(schema.quarantineItems)
    .where(eq(schema.quarantineItems.id, id))
    .limit(1);
  return rows[0] ?? null;
}

async function getIngestJob(jobId: string) {
  const rows = await db()
    .select()
    .from(schema.ingestJobs)
    .where(eq(schema.ingestJobs.id, jobId))
    .limit(1);
  return rows[0] ?? null;
}

async function countIngestJobsForOwner(ownerId: string): Promise<number> {
  const rows = await db()
    .select({ n: count() })
    .from(schema.ingestJobs)
    .where(eq(schema.ingestJobs.ownerId, ownerId));
  return rows[0]?.n ?? 0;
}

async function getLedgerEvent(subjectId: string, kind: string) {
  const rows = await db()
    .select()
    .from(schema.ledgerEvents)
    .where(
      and(
        eq(schema.ledgerEvents.subjectId, subjectId),
        eq(schema.ledgerEvents.kind, kind),
      ),
    )
    .orderBy(desc(schema.ledgerEvents.ingestedAt))
    .limit(1);
  return rows[0] ?? null;
}

async function countLedgerEvents(subjectId: string, kind: string): Promise<number> {
  const rows = await db()
    .select({ n: count() })
    .from(schema.ledgerEvents)
    .where(
      and(
        eq(schema.ledgerEvents.subjectId, subjectId),
        eq(schema.ledgerEvents.kind, kind),
      ),
    );
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// POST /api/v1/quarantine/[id]/retry
// ---------------------------------------------------------------------------

describe('POST /api/v1/quarantine/[id]/retry', () => {
  it('returns 401 for unauthenticated callers', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import(
      '../../src/app/api/v1/quarantine/[id]/retry/route'
    );
    const res = await POST(makePost('http://local/api/v1/quarantine/some-id/retry'), {
      params: Promise.resolve({ id: 'some-id' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown id', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const unknownId = uid();
    const { POST } = await import(
      '../../src/app/api/v1/quarantine/[id]/retry/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/quarantine/${unknownId}/retry`),
      { params: Promise.resolve({ id: unknownId }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 (not 403) when non-owner non-admin calls retry', async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const root = await seedStashRoot(owner);
    const itemId = await seedQuarantineItem(root);

    mockAuthenticate.mockResolvedValueOnce(actor(stranger));
    const { POST } = await import(
      '../../src/app/api/v1/quarantine/[id]/retry/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/quarantine/${itemId}/retry`),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when admin tries to retry a cross-owner item (write denied)', async () => {
    const owner = await seedUser();
    const adminId = await seedUser();
    const root = await seedStashRoot(owner);
    const itemId = await seedQuarantineItem(root, { reason: 'unclassifiable' });

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { POST } = await import(
      '../../src/app/api/v1/quarantine/[id]/retry/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/quarantine/${itemId}/retry`),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res.status).toBe(404);
  });

  it('owner retry on unresolved item: 200, clones original ingest_job, quarantine resolved, ledger event recorded', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const collectionId = await seedCollection(userId, root);
    const itemPath = `/tmp/quarantine/retry-owner-test-${uid()}.stl`;
    const itemId = await seedQuarantineItem(root, {
      reason: 'needs-user-input',
      path: itemPath,
    });
    // Seed the original job that quarantined this item.
    const originalJobId = await seedOriginalIngestJob(userId, itemId, collectionId);

    const beforeRetry = new Date();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/quarantine/[id]/retry/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/quarantine/${itemId}/retry`),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; ingestJobId: string };
    expect(body.ok).toBe(true);
    expect(typeof body.ingestJobId).toBe('string');
    expect(body.ingestJobId.length).toBeGreaterThan(0);
    // Must be a NEW job — not the original.
    expect(body.ingestJobId).not.toBe(originalJobId);

    // Quarantine item must be resolved.
    const row = await getQuarantineRow(itemId);
    expect(row).not.toBeNull();
    expect(row!.resolvedAt).not.toBeNull();
    expect(row!.resolvedAt!.getTime()).toBeGreaterThanOrEqual(beforeRetry.getTime());

    // New ingest_job must be a clone of the original.
    const job = await getIngestJob(body.ingestJobId);
    expect(job).not.toBeNull();
    expect(job!.ownerId).toBe(userId);
    expect(job!.status).toBe('queued');
    // Clone must carry original sourceId, targetKind, targetPayload, collectionId.
    expect(job!.sourceId).toBe('cults3d');
    expect(job!.targetKind).toBe('url');
    const parsed = JSON.parse(job!.targetPayload) as { kind: string; url: string };
    expect(parsed.kind).toBe('url');
    expect(parsed.url).toBe('https://cults3d.com/en/3d-model/test');
    expect(job!.collectionId).toBe(collectionId);
    // idempotencyKey must NOT be copied.
    expect(job!.idempotencyKey).toBeNull();
    // quarantineItemId must be null on the new job.
    expect(job!.quarantineItemId).toBeNull();

    // Ledger event must be recorded.
    const ev = await getLedgerEvent(itemId, 'quarantine.retried');
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('quarantine.retried');
    expect(ev!.subjectType).toBe('quarantine_item');
    expect(ev!.subjectId).toBe(itemId);
    expect(ev!.actorUserId).toBe(userId);

    // relatedResources must include both the new job and the original.
    const related = ev!.relatedResources as Array<{
      kind: string;
      id: string;
      role: string;
    }>;
    expect(Array.isArray(related)).toBe(true);
    const retryRef = related.find((r) => r.kind === 'ingest_job' && r.role === 'retry-of');
    expect(retryRef).toBeDefined();
    expect(retryRef!.id).toBe(body.ingestJobId);
    const originalRef = related.find((r) => r.kind === 'ingest_job' && r.role === 'original');
    expect(originalRef).toBeDefined();
    expect(originalRef!.id).toBe(originalJobId);

    // Payload must carry originalIngestJobId.
    const payload = JSON.parse(ev!.payload!) as {
      stashRootId: string;
      newIngestJobId: string;
      originalIngestJobId: string;
    };
    expect(payload.newIngestJobId).toBe(body.ingestJobId);
    expect(payload.originalIngestJobId).toBe(originalJobId);
  });

  it('idempotent re-retry: same ingestJobId returned, no new ingest_job, no second ledger event', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const itemId = await seedQuarantineItem(root, {
      reason: 'integrity-failed',
    });
    // Seed original job.
    await seedOriginalIngestJob(userId, itemId);

    const { POST } = await import(
      '../../src/app/api/v1/quarantine/[id]/retry/route'
    );

    // First retry — must succeed and create the ingest_job.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const res1 = await POST(
      makePost(`http://local/api/v1/quarantine/${itemId}/retry`),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { ok: boolean; ingestJobId: string };
    expect(body1.ok).toBe(true);
    const firstJobId = body1.ingestJobId;

    const jobCountOwner = await countIngestJobsForOwner(userId);
    const ledgerCountAfterFirst = await countLedgerEvents(itemId, 'quarantine.retried');
    expect(ledgerCountAfterFirst).toBe(1);

    // Second retry — item is already resolved; must return the same ingestJobId.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const res2 = await POST(
      makePost(`http://local/api/v1/quarantine/${itemId}/retry`),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { ok: boolean; ingestJobId: string };
    expect(body2.ok).toBe(true);
    // Must be the same job id as the first retry — no new row inserted.
    expect(body2.ingestJobId).toBe(firstJobId);

    // No additional ingest_jobs for this owner from this call.
    const jobCountOwnerAfter = await countIngestJobsForOwner(userId);
    expect(jobCountOwnerAfter).toBe(jobCountOwner);

    // No second ledger event.
    const ledgerCountAfterSecond = await countLedgerEvents(itemId, 'quarantine.retried');
    expect(ledgerCountAfterSecond).toBe(1);
  });

  it('returns 409 with error: already-dismissed when item was dismissed via DELETE (not retried)', async () => {
    // Seed resolvedAt via DELETE (real dismiss flow) — exercises
    // "no quarantine.retried event in ledger → was dismissed" path.
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const itemId = await seedQuarantineItem(root, {
      reason: 'template-incompatible',
    });
    // Seed original job so the item is in a realistic state.
    await seedOriginalIngestJob(userId, itemId);

    // Use the real DELETE endpoint to dismiss — writes a quarantine.dismissed
    // ledger event but NOT a quarantine.retried event.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { DELETE } = await import('../../src/app/api/v1/quarantine/[id]/route');
    const dismissRes = await DELETE(makeDelete(`http://local/api/v1/quarantine/${itemId}`), {
      params: Promise.resolve({ id: itemId }),
    });
    expect(dismissRes.status).toBe(200);

    // Now attempt retry — must get 409 because no quarantine.retried event exists.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/quarantine/[id]/retry/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/quarantine/${itemId}/retry`),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toBe('already-dismissed');
  });

  it('returns 422 with error: no-source-job when quarantine item has no original ingest_job', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    // Orphaned item — no original ingest_job seeded.
    const itemId = await seedQuarantineItem(root, {
      reason: 'integrity-failed',
    });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/quarantine/[id]/retry/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/quarantine/${itemId}/retry`),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('no-source-job');
    expect(typeof body.message).toBe('string');
  });

  it('accepts an empty body (all fields optional)', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const itemId = await seedQuarantineItem(root, {
      path: `/tmp/quarantine/retry-empty-body-${uid()}.stl`,
    });
    await seedOriginalIngestJob(userId, itemId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/quarantine/[id]/retry/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/quarantine/${itemId}/retry`, {}),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ingestJobId: string };
    expect(body.ok).toBe(true);
  });

  it('accepts body with override_classifier_hint and hint lands in ledger payload', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const itemId = await seedQuarantineItem(root, {
      path: `/tmp/quarantine/retry-hint-${uid()}.stl`,
    });
    await seedOriginalIngestJob(userId, itemId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/quarantine/[id]/retry/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/quarantine/${itemId}/retry`, {
        override_classifier_hint: 'filament-model',
      }),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ingestJobId: string };
    expect(body.ok).toBe(true);

    // Verify hint is recorded in the ledger payload.
    const ev = await getLedgerEvent(itemId, 'quarantine.retried');
    expect(ev).not.toBeNull();
    const payload = JSON.parse(ev!.payload!) as { overrideClassifierHint?: string };
    expect(payload.overrideClassifierHint).toBe('filament-model');
  });

  it('rejects body with unknown keys (z.strict())', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const itemId = await seedQuarantineItem(root, {
      path: `/tmp/quarantine/retry-strict-${uid()}.stl`,
    });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/quarantine/[id]/retry/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/quarantine/${itemId}/retry`, {
        unknown_field: 'should-fail',
      }),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res.status).toBe(400);
  });
});
