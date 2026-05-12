/**
 * Integration tests — GET /api/v1/ledger/[id] — Ledger HTTP Layer T3
 *
 * Real SQLite. Auth mocked via the request-auth shim.
 *
 * ACL model (locked 2026-05-12: hide-existence for denied callers)
 * ─────────────────────────────────────────────────────────────────
 * Admin   → 200 for any event (cross-owner visibility).
 * Owner   → 200 for events whose subject is directly owned by caller.
 * Non-owner non-admin → 404 (existence hidden — mirrors Forge / Quarantine pattern).
 * dispatch_job subjectType → 404 for non-admin (no ACL resolver path yet).
 * Unknown subjectType → 404 for non-admin (ownership unresolvable).
 * Unknown id → 404 for any caller.
 * Unauthenticated → 401.
 *
 * NOTE: plan text said "non-admin → 403" but hide-existence consistency demands 404.
 * This matches Quarantine + Forge patterns and was confirmed by the T2 ACL lock.
 *
 * Coverage:
 *   1.  Unauthenticated → 401.
 *   2.  Unknown id → 404.
 *   3.  Admin fetches any event → 200 with correct DTO.
 *   4.  Owner fetches event on their own resource → 200.
 *   5.  Non-admin fetches event on someone else's resource → 404 (NOT 403).
 *   6.  Non-admin fetches event with unresolvable subjectType ('system_event') → 404.
 *   7.  Non-admin fetches event with dispatch_job subjectType → 404.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';

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

const DB_PATH = '/tmp/lootgoblin-ledger-detail.db';
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
    name: 'Ledger Detail Test User',
    email: `${id}@ledger-detail.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedMaterial(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.materials).values({
    id,
    ownerId,
    kind: 'filament',
    colors: ['#FF0000'],
    colorPattern: 'solid',
    initialAmount: 1000,
    remainingAmount: 1000,
    unit: 'g',
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLedgerEvent(opts: {
  subjectType?: string;
  subjectId?: string;
  kind?: string;
  actorUserId?: string | null;
  ingestedAt?: Date;
  occurredAt?: Date | null;
  payload?: string | null;
}): Promise<string> {
  const id = uid();
  await db().insert(schema.ledgerEvents).values({
    id,
    kind: opts.kind ?? 'test.event',
    actorUserId: opts.actorUserId !== undefined ? opts.actorUserId : null,
    subjectType: opts.subjectType ?? 'material',
    subjectId: opts.subjectId ?? uid(),
    relatedResources: null,
    payload: opts.payload !== undefined ? opts.payload : null,
    provenanceClass: null,
    occurredAt: opts.occurredAt !== undefined ? opts.occurredAt : null,
    ingestedAt: opts.ingestedAt ?? new Date(),
  });
  return id;
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

function makeGet(url: string): Request {
  return new Request(url, { method: 'GET' });
}

function makeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/ledger/[id] — 401 unauthenticated', () => {
  it('returns 401 for unauthenticated callers', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/ledger/[id]/route');
    const id = uid();
    const res = await GET(
      makeGet(`http://local/api/v1/ledger/${id}`),
      makeCtx(id),
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/ledger/[id] — unknown id → 404', () => {
  it('returns 404 for an id that does not exist in ledger_events', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/ledger/[id]/route');
    const unknownId = uid();
    const res = await GET(
      makeGet(`http://local/api/v1/ledger/${unknownId}`),
      makeCtx(unknownId),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/ledger/[id] — admin access', () => {
  it('admin fetches any event (cross-owner) → 200 with correct DTO shape', async () => {
    const adminId = await seedUser();
    const ownerId = await seedUser();
    const matId = await seedMaterial(ownerId);
    const evId = await seedLedgerEvent({
      subjectType: 'material',
      subjectId: matId,
      kind: 'detail.admin.test',
      actorUserId: ownerId,
      payload: JSON.stringify({ foo: 'bar' }),
    });

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/ledger/[id]/route');
    const res = await GET(
      makeGet(`http://local/api/v1/ledger/${evId}`),
      makeCtx(evId),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      id: string;
      kind: string;
      actorUserId: string | null;
      subjectType: string;
      subjectId: string;
      relatedResources: unknown;
      payload: unknown;
      provenanceClass: string | null;
      occurredAt: string | null;
      ingestedAt: string;
    };
    expect(body.id).toBe(evId);
    expect(body.kind).toBe('detail.admin.test');
    expect(body.actorUserId).toBe(ownerId);
    expect(body.subjectType).toBe('material');
    expect(body.subjectId).toBe(matId);
    expect(body.payload).toEqual({ foo: 'bar' });
    expect(body.provenanceClass).toBeNull();
    expect(body.occurredAt).toBeNull();
    expect(() => new Date(body.ingestedAt)).not.toThrow();
  });
});

describe('GET /api/v1/ledger/[id] — owner access', () => {
  it('non-admin owner fetches event on their own material → 200', async () => {
    const ownerId = await seedUser();
    const matId = await seedMaterial(ownerId);
    const evId = await seedLedgerEvent({
      subjectType: 'material',
      subjectId: matId,
      kind: 'detail.owner.test',
    });

    mockAuthenticate.mockResolvedValueOnce(actor(ownerId));
    const { GET } = await import('../../src/app/api/v1/ledger/[id]/route');
    const res = await GET(
      makeGet(`http://local/api/v1/ledger/${evId}`),
      makeCtx(evId),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(evId);
  });
});

describe('GET /api/v1/ledger/[id] — non-admin cross-owner → 404 (not 403)', () => {
  it('non-admin fetching another user\'s resource event gets 404, not 403', async () => {
    const ownerId = await seedUser();
    const callerId = await seedUser();
    const matId = await seedMaterial(ownerId);
    const evId = await seedLedgerEvent({
      subjectType: 'material',
      subjectId: matId,
      kind: 'detail.crossowner.test',
    });

    mockAuthenticate.mockResolvedValueOnce(actor(callerId));
    const { GET } = await import('../../src/app/api/v1/ledger/[id]/route');
    const res = await GET(
      makeGet(`http://local/api/v1/ledger/${evId}`),
      makeCtx(evId),
    );
    // Existence hidden — must be 404, NOT 403.
    expect(res.status).toBe(404);
    // Must NOT be 403
    expect(res.status).not.toBe(403);
  });
});

describe('GET /api/v1/ledger/[id] — unresolvable subjectType → 404 for non-admin', () => {
  it('non-admin fetching event with system_event subjectType gets 404', async () => {
    const callerId = await seedUser();
    // system_event has no ownership resolver → non-admin cannot see it
    const evId = await seedLedgerEvent({
      subjectType: 'system_event',
      subjectId: uid(),
      kind: 'detail.sysev.test',
    });

    mockAuthenticate.mockResolvedValueOnce(actor(callerId));
    const { GET } = await import('../../src/app/api/v1/ledger/[id]/route');
    const res = await GET(
      makeGet(`http://local/api/v1/ledger/${evId}`),
      makeCtx(evId),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/ledger/[id] — dispatch_job subjectType → 404 for non-admin', () => {
  it('non-admin fetching event with dispatch_job subjectType gets 404 (resolver gap)', async () => {
    const callerId = await seedUser();
    // dispatch_job: no ACL kind in resolver (see project_acl_resolver_gaps memory).
    // Non-admin must always see 404 for this kind.
    const evId = await seedLedgerEvent({
      subjectType: 'dispatch_job',
      subjectId: uid(),
      kind: 'detail.dispatchjob.test',
    });

    mockAuthenticate.mockResolvedValueOnce(actor(callerId));
    const { GET } = await import('../../src/app/api/v1/ledger/[id]/route');
    const res = await GET(
      makeGet(`http://local/api/v1/ledger/${evId}`),
      makeCtx(evId),
    );
    expect(res.status).toBe(404);
  });
});
