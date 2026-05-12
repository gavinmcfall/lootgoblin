/**
 * Integration tests — POST /api/v1/quarantine/[id]/retry — Quarantine HTTP Layer T5
 *
 * Real SQLite. Auth mocked via the request-auth shim.
 *
 * Coverage:
 *   - 200 owner retry on unresolved item: new ingest_job inserted, quarantine resolved,
 *         ledger event recorded with related_resources
 *   - 200 idempotent re-retry on already-retried item: same ingestJobId, no new ingest_job,
 *         no second ledger event
 *   - 409 retry on already-dismissed item: error: 'already-dismissed'
 *   - 401 unauthenticated
 *   - 404 non-owner POST (existence hidden)
 *   - 404 unknown id
 *   - 404 admin cross-owner POST (admin may read, not write cross-tenant)
 *   - 200 empty body accepted (RetryBodySchema all-optional)
 *   - 200 body with override_classifier_hint accepted
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

  it('owner retry on unresolved item: 200, new ingest_job inserted, quarantine resolved, ledger event recorded', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const itemPath = `/tmp/quarantine/retry-owner-test-${uid()}.stl`;
    const itemId = await seedQuarantineItem(root, {
      reason: 'needs-user-input',
      path: itemPath,
    });

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

    // Quarantine item must be resolved.
    const row = await getQuarantineRow(itemId);
    expect(row).not.toBeNull();
    expect(row!.resolvedAt).not.toBeNull();
    expect(row!.resolvedAt!.getTime()).toBeGreaterThanOrEqual(beforeRetry.getTime());

    // New ingest_job must exist with correct fields.
    const job = await getIngestJob(body.ingestJobId);
    expect(job).not.toBeNull();
    expect(job!.ownerId).toBe(userId);
    expect(job!.status).toBe('queued');
    // targetPayload must include the file:// URL derived from the quarantined path.
    const parsed = JSON.parse(job!.targetPayload) as { kind: string; url: string };
    expect(parsed.kind).toBe('url');
    expect(parsed.url).toBe(`file://${itemPath}`);

    // Ledger event must be recorded.
    const ev = await getLedgerEvent(itemId, 'quarantine.retried');
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('quarantine.retried');
    expect(ev!.subjectType).toBe('quarantine_item');
    expect(ev!.subjectId).toBe(itemId);
    expect(ev!.actorUserId).toBe(userId);

    // relatedResources must include the new ingest_job.
    const related = ev!.relatedResources as Array<{
      kind: string;
      id: string;
      role: string;
    }>;
    expect(Array.isArray(related)).toBe(true);
    const jobRef = related.find((r) => r.kind === 'ingest_job');
    expect(jobRef).toBeDefined();
    expect(jobRef!.id).toBe(body.ingestJobId);
    expect(jobRef!.role).toBe('retry-of');
  });

  it('idempotent re-retry: same ingestJobId returned, no new ingest_job, no second ledger event', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const itemPath = `/tmp/quarantine/retry-idem-${uid()}.stl`;
    const itemId = await seedQuarantineItem(root, {
      reason: 'integrity-failed',
      path: itemPath,
    });

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

  it('returns 409 with error: already-dismissed when item was dismissed, not retried', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const itemId = await seedQuarantineItem(root, {
      reason: 'template-incompatible',
      resolvedAt: new Date(), // pre-dismissed
    });

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

  it('accepts an empty body (all fields optional)', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const itemId = await seedQuarantineItem(root, {
      path: `/tmp/quarantine/retry-empty-body-${uid()}.stl`,
    });

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

  it('accepts body with override_classifier_hint', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const itemId = await seedQuarantineItem(root, {
      path: `/tmp/quarantine/retry-hint-${uid()}.stl`,
    });

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
