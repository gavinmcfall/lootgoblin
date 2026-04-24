/**
 * API key scope enforcement integration tests — V2-001-T5
 *
 * Tests route-level scope enforcement via mocked auth helpers.
 * The helper-level tests (isValidApiKeyWithScope with real DB + argon2) are in
 * tests/integration/api-key-helper-scope.test.ts to avoid mock interference.
 *
 * Strategy:
 *   - Mock getSessionOrNull (null = force API-key path) and
 *     isValidApiKeyWithScope to controlled return values.
 *   - Verify that queue POST: accepts extension_pairing, rejects others with
 *     appropriate HTTP status and error body.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { runMigrations, resetDbCache } from '../../src/db/client';

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
const mockIsValidApiKeyWithScope = vi.fn();

vi.mock('../../src/auth/helpers', () => ({
  getSessionOrNull: (...args: unknown[]) => mockGetSession(...args),
  isValidApiKeyWithScope: (...args: unknown[]) => mockIsValidApiKeyWithScope(...args),
  isValidApiKey: vi.fn().mockResolvedValue(false),
}));

// ── Request helpers ────────────────────────────────────────────────────────
function makeReq(method = 'POST', body?: unknown, apiKey?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return new Request('http://local/test', {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const queueBody = {
  sourceId: 'makerworld',
  sourceItemId: `scope-test-${Date.now()}`,
  sourceUrl: 'https://makerworld.com/test',
  contentType: 'model-3d',
};

// T7: role field added to user shape.
const VALID_SESSION = {
  session: { id: 'sess-1', userId: 'user-1', expiresAt: new Date(Date.now() + 86400_000), token: 'tok' },
  user: { id: 'user-1', email: 'admin@example.com', name: 'Admin', emailVerified: true, role: 'admin' as const },
};

beforeAll(async () => {
  process.env.DATABASE_URL = 'file:/tmp/lootgoblin-scope-enforcement.db';
  resetDbCache();
  await runMigrations('file:/tmp/lootgoblin-scope-enforcement.db');
});

// ── Route-level scope enforcement tests ───────────────────────────────────
describe('POST /api/v1/queue — scope enforcement', () => {
  const getRoute = () => import('../../src/app/api/v1/queue/route').then((m) => m.POST);

  it('returns 200 when extension_pairing key hits queue POST', async () => {
    mockGetSession.mockResolvedValue(null);
    mockIsValidApiKeyWithScope.mockResolvedValue({
      valid: true,
      scope: 'extension_pairing',
      keyId: 'key-1',
    });
    const POST = await getRoute();
    const res = await POST(
      makeReq('POST', { ...queueBody, sourceItemId: `ext-ok-${Date.now()}` }, 'lg_ext_validkey'),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id ?? json.duplicate).toBeDefined();
  });

  it('returns 403 wrong-scope when programmatic key hits queue POST', async () => {
    mockGetSession.mockResolvedValue(null);
    mockIsValidApiKeyWithScope.mockResolvedValue({
      valid: false,
      reason: 'wrong-scope',
      expected: ['extension_pairing'],
      actual: 'programmatic',
    });
    const POST = await getRoute();
    const res = await POST(makeReq('POST', queueBody, 'lg_api_wrongkey'));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('wrong-scope');
    expect(json.actual).toBe('programmatic');
    expect(json.expected).toContain('extension_pairing');
  });

  it('returns 403 wrong-scope when courier_pairing key hits queue POST', async () => {
    mockGetSession.mockResolvedValue(null);
    mockIsValidApiKeyWithScope.mockResolvedValue({
      valid: false,
      reason: 'wrong-scope',
      expected: ['extension_pairing'],
      actual: 'courier_pairing',
    });
    const POST = await getRoute();
    const res = await POST(makeReq('POST', queueBody, 'lg_cou_wrongkey'));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('wrong-scope');
    expect(json.actual).toBe('courier_pairing');
  });

  it('returns 401 when key is invalid (not found / hash mismatch)', async () => {
    mockGetSession.mockResolvedValue(null);
    mockIsValidApiKeyWithScope.mockResolvedValue({
      valid: false,
      reason: 'invalid',
    });
    const POST = await getRoute();
    const res = await POST(makeReq('POST', queueBody, 'lg_ext_badkey'));
    expect(res.status).toBe(401);
  });

  it('returns 401 when key is expired', async () => {
    mockGetSession.mockResolvedValue(null);
    mockIsValidApiKeyWithScope.mockResolvedValue({
      valid: false,
      reason: 'expired',
    });
    const POST = await getRoute();
    const res = await POST(makeReq('POST', queueBody, 'lg_ext_expiredkey'));
    expect(res.status).toBe(401);
  });

  it('returns 200 with a valid session (skips API-key check entirely)', async () => {
    mockGetSession.mockResolvedValue(VALID_SESSION);
    const POST = await getRoute();
    const res = await POST(
      makeReq('POST', { ...queueBody, sourceItemId: `sess-${Date.now()}` }),
    );
    expect(res.status).toBe(200);
  });
});
