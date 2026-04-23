/**
 * Route auth policy integration tests — V2-001-T4
 *
 * Covers three auth policy classes with at least one route each:
 *
 *   session-only     — /api/v1/destinations       (GET/POST)
 *   session-or-apikey— /api/v1/queue              (POST)
 *   admin-only       — /api/v1/system/tasks        (GET)
 *
 * Pattern: mock @/auth/helpers so that getSessionOrNull and isValidApiKey
 * return controlled values without needing a real BetterAuth instance or DB.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';

// ── Provide minimal Next.js shims ──────────────────────────────────────────
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

// ── Mock auth helpers — controlled per-test ────────────────────────────────
const mockGetSession = vi.fn();
const mockIsValidApiKey = vi.fn();

vi.mock('../../src/auth/helpers', () => ({
  getSessionOrNull: (...args: unknown[]) => mockGetSession(...args),
  isValidApiKey: (...args: unknown[]) => mockIsValidApiKey(...args),
}));

// ── Minimal session fixture ────────────────────────────────────────────────
const VALID_SESSION = {
  session: { id: 'sess-1', userId: 'user-1', expiresAt: new Date(Date.now() + 86400_000), token: 'tok' },
  user: { id: 'user-1', email: 'admin@example.com', name: 'Admin', emailVerified: true },
};

function makeReq(method = 'GET', body?: unknown, apiKey?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return new Request('http://local/test', {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = 'file:/tmp/lootgoblin-route-auth.db';
  resetDbCache();
  await runMigrations('file:/tmp/lootgoblin-route-auth.db');
});

// ── session-only routes ────────────────────────────────────────────────────
describe('session-only: GET /api/v1/destinations', () => {
  // Import after mocks are set up
  const getRoute = () => import('../../src/app/api/v1/destinations/route').then((m) => m.GET);

  it('returns 401 when unauthenticated', async () => {
    mockGetSession.mockResolvedValue(null);
    const GET = await getRoute();
    const res = await GET(makeReq('GET'));
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid session', async () => {
    mockGetSession.mockResolvedValue(VALID_SESSION);
    const GET = await getRoute();
    const res = await GET(makeReq('GET'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty('destinations');
  });

  it('returns 401 with only a valid API key (session-only route)', async () => {
    mockGetSession.mockResolvedValue(null);
    const GET = await getRoute();
    // Even if we pass an API key header, this route only accepts sessions.
    const res = await GET(makeReq('GET', undefined, 'lg_somekey'));
    expect(res.status).toBe(401);
  });
});

// ── session-or-apikey routes ───────────────────────────────────────────────
describe('session-or-apikey: POST /api/v1/queue', () => {
  const getRoute = () => import('../../src/app/api/v1/queue/route').then((m) => m.POST);

  const queueBody = {
    sourceId: 'makerworld',
    sourceItemId: `test-${Date.now()}`,
    sourceUrl: 'https://makerworld.com/test',
    contentType: 'model-3d',
  };

  it('returns 401 when neither session nor API key is valid', async () => {
    mockGetSession.mockResolvedValue(null);
    mockIsValidApiKey.mockResolvedValue(false);
    const POST = await getRoute();
    const res = await POST(makeReq('POST', queueBody));
    expect(res.status).toBe(401);
  });

  it('returns 200 with a valid session', async () => {
    mockGetSession.mockResolvedValue(VALID_SESSION);
    mockIsValidApiKey.mockResolvedValue(false);
    const POST = await getRoute();
    const res = await POST(makeReq('POST', { ...queueBody, sourceItemId: `sess-${Date.now()}` }));
    const json = await res.json();
    // Should succeed (200 with id, or 200 with duplicate).
    expect(res.status).toBe(200);
    expect(json.id ?? json.duplicate).toBeDefined();
  });

  it('returns 200 with a valid API key and no session', async () => {
    mockGetSession.mockResolvedValue(null);
    mockIsValidApiKey.mockResolvedValue(true);
    const POST = await getRoute();
    const res = await POST(makeReq('POST', { ...queueBody, sourceItemId: `apikey-${Date.now()}` }, 'lg_validkey'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id ?? json.duplicate).toBeDefined();
  });
});

// ── admin-only (session-only) routes ──────────────────────────────────────
describe('admin-only: GET /api/v1/system/tasks', () => {
  const getRoute = () => import('../../src/app/api/v1/system/tasks/route').then((m) => m.GET);

  it('returns 401 when unauthenticated', async () => {
    mockGetSession.mockResolvedValue(null);
    const GET = await getRoute();
    const res = await GET(makeReq('GET'));
    expect(res.status).toBe(401);
  });

  it('returns 200 with a valid session', async () => {
    mockGetSession.mockResolvedValue(VALID_SESSION);
    const GET = await getRoute();
    const res = await GET(makeReq('GET'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty('tasks');
  });

  it('returns 401 with API key only (admin route requires session)', async () => {
    mockGetSession.mockResolvedValue(null);
    const GET = await getRoute();
    const res = await GET(makeReq('GET', undefined, 'lg_somekey'));
    expect(res.status).toBe(401);
  });
});
