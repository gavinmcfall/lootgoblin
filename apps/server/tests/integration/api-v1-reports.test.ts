/**
 * Integration tests — /api/v1/reports/consumption — V2-007a-T14
 *
 * Verifies the HTTP wrapper around T13 report helpers. T13 itself is
 * exhaustively tested in tests/integration/materials-reports.test.ts —
 * here we cover only the route-layer concerns:
 *   - 401 unauthenticated
 *   - 400 invalid dimension / bad ISO since/until / since>=until
 *   - happy paths for each dimension
 *   - default 30-day window when query params absent
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

const DB_PATH = '/tmp/lootgoblin-api-reports.db';
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

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Reports Test User',
    email: `${id}@reports.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function makeGet(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'GET' }) as unknown as import('next/server').NextRequest;
}

describe('GET /api/v1/reports/consumption', () => {
  it('401 unauthenticated', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/reports/consumption/route');
    const res = await GET(makeGet('http://local/api/v1/reports/consumption?dimension=brand'));
    expect(res.status).toBe(401);
  });

  it('400 missing dimension', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/reports/consumption/route');
    const res = await GET(makeGet('http://local/api/v1/reports/consumption'));
    expect(res.status).toBe(400);
  });

  it('400 invalid dimension', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/reports/consumption/route');
    const res = await GET(
      makeGet('http://local/api/v1/reports/consumption?dimension=cosmic-ray'),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid since', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/reports/consumption/route');
    const res = await GET(
      makeGet('http://local/api/v1/reports/consumption?dimension=brand&since=not-a-date'),
    );
    expect(res.status).toBe(400);
  });

  it('400 since >= until', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/reports/consumption/route');
    const res = await GET(
      makeGet(
        'http://local/api/v1/reports/consumption?dimension=brand&since=2026-01-02T00:00:00Z&until=2026-01-01T00:00:00Z',
      ),
    );
    expect(res.status).toBe(400);
  });

  for (const dim of ['brand', 'color', 'printer', 'outcome', 'total'] as const) {
    it(`200 happy for dimension=${dim} (empty result is fine)`, async () => {
      const userId = await seedUser();
      mockAuthenticate.mockResolvedValueOnce(actor(userId));
      const { GET } = await import('../../src/app/api/v1/reports/consumption/route');
      const res = await GET(
        makeGet(`http://local/api/v1/reports/consumption?dimension=${dim}`),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.dimension).toBe(dim);
      expect(body.window).toBeTruthy();
      if (dim === 'total') expect(body.row).toBeTruthy();
      else expect(Array.isArray(body.rows)).toBe(true);
    });
  }

  it('default window covers ~30 days back', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/reports/consumption/route');
    const res = await GET(
      makeGet('http://local/api/v1/reports/consumption?dimension=brand'),
    );
    const body = (await res.json()) as { window: { since: string; until: string } };
    const since = new Date(body.window.since).getTime();
    const until = new Date(body.window.until).getTime();
    const diffDays = (until - since) / 86400_000;
    expect(diffDays).toBeGreaterThan(29.5);
    expect(diffDays).toBeLessThan(30.5);
  });
});
