/**
 * Integration tests — DELETE /api/v1/quarantine/[id] — Quarantine HTTP Layer T4
 *
 * Real SQLite. Auth mocked via the request-auth shim.
 *
 * Coverage:
 *   - 401 unauthenticated
 *   - 200 owner dismiss → resolvedAt set + correct DTO shape
 *   - 200 idempotent re-dismiss → resolvedAt unchanged (same row returned)
 *   - 404 non-owner non-admin (hide existence — no 403)
 *   - 404 admin write on cross-owner item (admin may read but not write cross-tenant)
 *   - 404 unknown id
 *   - ledger event recorded on successful dismiss
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { eq, desc, count } from 'drizzle-orm';

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

const DB_PATH = '/tmp/lootgoblin-api-quarantine-dismiss.db';
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
    name: 'Quarantine Dismiss Test User',
    email: `${id}@quarantine-dismiss.test`,
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
    name: 'Dismiss Test Root',
    path: `/tmp/dismiss-test-root-${id}`,
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
    path: overrides.path ?? `/tmp/quarantine/dismiss-${id}.stl`,
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

function makeDelete(url: string): Request {
  return new Request(url, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Helpers to read back rows for assertion
// ---------------------------------------------------------------------------

async function getQuarantineRow(id: string) {
  const rows = await db()
    .select()
    .from(schema.quarantineItems)
    .where(eq(schema.quarantineItems.id, id))
    .limit(1);
  return rows[0] ?? null;
}

async function getLatestLedgerEvent(subjectId: string) {
  const rows = await db()
    .select()
    .from(schema.ledgerEvents)
    .where(eq(schema.ledgerEvents.subjectId, subjectId))
    .orderBy(desc(schema.ledgerEvents.ingestedAt))
    .limit(1);
  return rows[0] ?? null;
}

async function countLedgerEvents(subjectId: string): Promise<number> {
  const rows = await db()
    .select({ n: count() })
    .from(schema.ledgerEvents)
    .where(eq(schema.ledgerEvents.subjectId, subjectId));
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/quarantine/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/quarantine/[id]', () => {
  it('returns 401 for unauthenticated callers', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { DELETE } = await import('../../src/app/api/v1/quarantine/[id]/route');
    const res = await DELETE(makeDelete('http://local/api/v1/quarantine/some-id'), {
      params: Promise.resolve({ id: 'some-id' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown id', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const unknownId = uid();
    const { DELETE } = await import('../../src/app/api/v1/quarantine/[id]/route');
    const res = await DELETE(
      makeDelete(`http://local/api/v1/quarantine/${unknownId}`),
      { params: Promise.resolve({ id: unknownId }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 (not 403) when non-owner non-admin tries to dismiss', async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const root = await seedStashRoot(owner);
    const itemId = await seedQuarantineItem(root);

    mockAuthenticate.mockResolvedValueOnce(actor(stranger));
    const { DELETE } = await import('../../src/app/api/v1/quarantine/[id]/route');
    const res = await DELETE(
      makeDelete(`http://local/api/v1/quarantine/${itemId}`),
      { params: Promise.resolve({ id: itemId }) },
    );
    // Existence is hidden — must be 404, NOT 403.
    expect(res.status).toBe(404);
  });

  it('returns 404 when admin tries to dismiss a cross-owner item (write denied)', async () => {
    const owner = await seedUser();
    const adminId = await seedUser();
    const root = await seedStashRoot(owner);
    const itemId = await seedQuarantineItem(root, { reason: 'unclassifiable' });

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { DELETE } = await import('../../src/app/api/v1/quarantine/[id]/route');
    const res = await DELETE(
      makeDelete(`http://local/api/v1/quarantine/${itemId}`),
      { params: Promise.resolve({ id: itemId }) },
    );
    // Admin may read cross-owner but NOT write — must be 404.
    expect(res.status).toBe(404);
  });

  it('returns 200 + sets resolvedAt when owner dismisses a pending item', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const itemId = await seedQuarantineItem(root, {
      reason: 'needs-user-input',
      path: '/tmp/dismiss-owner-test.stl',
    });

    const beforeDismiss = new Date();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { DELETE } = await import('../../src/app/api/v1/quarantine/[id]/route');
    const res = await DELETE(
      makeDelete(`http://local/api/v1/quarantine/${itemId}`),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      id: string;
      stashRootId: string;
      path: string;
      reason: string;
      createdAt: string;
      resolvedAt: string | null;
    };
    expect(body.id).toBe(itemId);
    expect(body.stashRootId).toBe(root);
    expect(body.path).toBe('/tmp/dismiss-owner-test.stl');
    expect(body.reason).toBe('needs-user-input');
    expect(body.resolvedAt).not.toBeNull();
    // resolvedAt must be >= the timestamp captured before the call
    expect(new Date(body.resolvedAt!).getTime()).toBeGreaterThanOrEqual(
      beforeDismiss.getTime(),
    );

    // DB row must have resolvedAt set
    const row = await getQuarantineRow(itemId);
    expect(row).not.toBeNull();
    expect(row!.resolvedAt).not.toBeNull();
  });

  it('records a ledger event on successful dismiss', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const itemId = await seedQuarantineItem(root, {
      reason: 'template-incompatible',
      path: '/tmp/dismiss-ledger-test.stl',
    });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { DELETE } = await import('../../src/app/api/v1/quarantine/[id]/route');
    const res = await DELETE(
      makeDelete(`http://local/api/v1/quarantine/${itemId}`),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res.status).toBe(200);

    const ev = await getLatestLedgerEvent(itemId);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('quarantine.dismissed');
    expect(ev!.subjectType).toBe('quarantine_item');
    expect(ev!.subjectId).toBe(itemId);
    expect(ev!.actorUserId).toBe(userId);
    // Payload must carry the audit fields
    const payload = JSON.parse(ev!.payload!) as {
      stashRootId: string;
      reason: string;
      path: string;
    };
    expect(payload.stashRootId).toBe(root);
    expect(payload.reason).toBe('template-incompatible');
    expect(payload.path).toBe('/tmp/dismiss-ledger-test.stl');
  });

  it('two-shot idempotency: same resolvedAt + no duplicate ledger event on second DELETE', async () => {
    // Seed an unresolved item.
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const itemId = await seedQuarantineItem(root, {
      reason: 'integrity-failed',
      path: '/tmp/dismiss-idempotent-two-shot.stl',
    });

    const { DELETE } = await import('../../src/app/api/v1/quarantine/[id]/route');

    // First DELETE — must dismiss and write exactly one ledger event.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const res1 = await DELETE(
      makeDelete(`http://local/api/v1/quarantine/${itemId}`),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { resolvedAt: string | null };
    expect(body1.resolvedAt).not.toBeNull();
    const resolvedAt1 = body1.resolvedAt!;

    const countAfterFirst = await countLedgerEvents(itemId);
    expect(countAfterFirst).toBe(1);

    // Second DELETE — must return 200 with the same resolvedAt, no new DB write.
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const res2 = await DELETE(
      makeDelete(`http://local/api/v1/quarantine/${itemId}`),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { resolvedAt: string | null };
    expect(body2.resolvedAt).not.toBeNull();

    // resolvedAt must be the exact same ISO string — proves no second UPDATE.
    expect(body2.resolvedAt).toBe(resolvedAt1);

    // Ledger count must still be 1 — proves no duplicate ledger event.
    const countAfterSecond = await countLedgerEvents(itemId);
    expect(countAfterSecond).toBe(1);
  });
});
