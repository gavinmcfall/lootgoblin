// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration tests — GET /api/v1/quarantine/[id] — Quarantine HTTP Layer T3
 *
 * Real SQLite. Auth mocked via the request-auth shim.
 *
 * Coverage:
 *   - 401 unauthenticated
 *   - 200 owner reads own item + correct DTO shape
 *   - 404 non-owner non-admin (hide existence — no 403)
 *   - 200 admin reads cross-owner item (admin can read across owners)
 *   - 404 unknown id
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

const DB_PATH = '/tmp/lootgoblin-api-quarantine-detail.db';
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
    name: 'Quarantine Detail Test User',
    email: `${id}@quarantine-detail.test`,
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
    name: 'Detail Test Root',
    path: `/tmp/detail-test-root-${id}`,
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
    path: overrides.path ?? `/tmp/quarantine/${id}.stl`,
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

function makeGet(url: string): Request {
  return new Request(url, { method: 'GET' });
}

// ---------------------------------------------------------------------------
// GET /api/v1/quarantine/[id]
// ---------------------------------------------------------------------------

describe('GET /api/v1/quarantine/[id]', () => {
  it('returns 401 for unauthenticated callers', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/quarantine/[id]/route');
    const res = await GET(makeGet('http://local/api/v1/quarantine/some-id'), {
      params: Promise.resolve({ id: 'some-id' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown id', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const unknownId = uid();
    const { GET } = await import('../../src/app/api/v1/quarantine/[id]/route');
    const res = await GET(
      makeGet(`http://local/api/v1/quarantine/${unknownId}`),
      { params: Promise.resolve({ id: unknownId }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns 200 + correct DTO when owner reads own item', async () => {
    const userId = await seedUser();
    const root = await seedStashRoot(userId);
    const itemId = await seedQuarantineItem(root, {
      reason: 'needs-user-input',
      path: '/tmp/owner-test.stl',
    });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/quarantine/[id]/route');
    const res = await GET(
      makeGet(`http://local/api/v1/quarantine/${itemId}`),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      id: string;
      stashRootId: string;
      path: string;
      reason: string;
      details: unknown;
      createdAt: string;
      resolvedAt: string | null;
    };
    expect(body.id).toBe(itemId);
    expect(body.stashRootId).toBe(root);
    expect(body.path).toBe('/tmp/owner-test.stl');
    expect(body.reason).toBe('needs-user-input');
    expect(typeof body.createdAt).toBe('string');
    // ISO 8601 check
    expect(() => new Date(body.createdAt)).not.toThrow();
    expect(body.resolvedAt).toBeNull();
  });

  it('returns 404 (not 403) when non-owner non-admin reads someone else\'s item', async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const root = await seedStashRoot(owner);
    const itemId = await seedQuarantineItem(root);

    mockAuthenticate.mockResolvedValueOnce(actor(stranger));
    const { GET } = await import('../../src/app/api/v1/quarantine/[id]/route');
    const res = await GET(
      makeGet(`http://local/api/v1/quarantine/${itemId}`),
      { params: Promise.resolve({ id: itemId }) },
    );
    // Existence is hidden — must be 404, NOT 403.
    expect(res.status).toBe(404);
  });

  it('returns 200 when admin reads cross-owner item', async () => {
    const owner = await seedUser();
    const adminId = await seedUser();
    const root = await seedStashRoot(owner);
    const itemId = await seedQuarantineItem(root, { reason: 'unclassifiable' });

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/quarantine/[id]/route');
    const res = await GET(
      makeGet(`http://local/api/v1/quarantine/${itemId}`),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; reason: string };
    expect(body.id).toBe(itemId);
    expect(body.reason).toBe('unclassifiable');
  });
});
