// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Courier auth resolver integration tests — V2-006a-T2
 *
 * Verifies `authenticateCourier` without relying on argon2 hashing internals
 * by mocking `isValidApiKeyWithScope` to return controlled values.
 *
 * Covers:
 *   (a) valid courier_pairing key + matching agent → { agentId }
 *   (b) wrong scope key → INVALID_API_KEY
 *   (c) missing x-api-key header → null
 *   (d) valid courier_pairing key but no agent references the keyId → INVALID_API_KEY
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { runMigrations, getServerDb, schema, resetDbCache } from '../../src/db/client';

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
const mockIsValidApiKeyWithScope = vi.fn();

vi.mock('../../src/auth/helpers', () => ({
  getSessionOrNull: vi.fn(),
  isValidApiKey: vi.fn(),
  isValidApiKeyWithScope: (...args: unknown[]) => mockIsValidApiKeyWithScope(...args),
}));

// ── Test DB constants ──────────────────────────────────────────────────────
const DB_URL = 'file:/tmp/lootgoblin-v2006a-t2.db';

const COURIER_KEY_ID = 'key-courier-001';
const COURIER_AGENT_ID = 'agent-courier-001';
const OTHER_KEY_ID = 'key-other-002';

function makeReq(apiKey?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return new Request('http://local/api/v1/courier/test', { method: 'GET', headers });
}

beforeAll(async () => {
  process.env.DATABASE_URL = DB_URL;
  resetDbCache();
  await runMigrations(DB_URL);

  // Seed an agent row whose pairCredentialRef points to COURIER_KEY_ID.
  // Use onConflictDoNothing so re-runs against a stale DB file are idempotent.
  const db = getServerDb(DB_URL);
  await db.insert(schema.agents).values({
    id: COURIER_AGENT_ID,
    kind: 'courier',
    pairCredentialRef: COURIER_KEY_ID,
    reachableLanHint: 'Test Courier',
    lastSeenAt: new Date(),
    createdAt: new Date(),
  }).onConflictDoNothing();
});

describe('authenticateCourier', () => {
  // Clear mock call counts before each test so accumulated calls from earlier
  // tests don't bleed into assertions (e.g. `.not.toHaveBeenCalled()` in test (c)).
  beforeEach(() => {
    mockIsValidApiKeyWithScope.mockClear();
  });

  // Import the resolver after mocks are in place.
  const getResolver = () =>
    import('../../src/auth/courier-auth').then((m) => ({
      authenticateCourier: m.authenticateCourier,
      INVALID_API_KEY: m.INVALID_API_KEY,
    }));

  it('(a) returns { agentId } when key is valid courier_pairing and agent exists', async () => {
    mockIsValidApiKeyWithScope.mockResolvedValueOnce({
      valid: true,
      scope: 'courier_pairing',
      keyId: COURIER_KEY_ID,
    });

    const { authenticateCourier } = await getResolver();
    const result = await authenticateCourier(makeReq('lg_cou_validkey'));

    expect(result).toEqual({ agentId: COURIER_AGENT_ID });
  });

  it('(b) returns INVALID_API_KEY when key has wrong scope', async () => {
    mockIsValidApiKeyWithScope.mockResolvedValueOnce({
      valid: false,
      reason: 'wrong-scope',
      expected: ['courier_pairing'],
      actual: 'extension_pairing',
    });

    const { authenticateCourier, INVALID_API_KEY } = await getResolver();
    const result = await authenticateCourier(makeReq('lg_ext_wrongscope'));

    expect(result).toBe(INVALID_API_KEY);
  });

  it('(c) returns null when no x-api-key header is present', async () => {
    const { authenticateCourier } = await getResolver();
    // No API key header — do not even call isValidApiKeyWithScope.
    const result = await authenticateCourier(makeReq());

    expect(result).toBeNull();
    expect(mockIsValidApiKeyWithScope).not.toHaveBeenCalled();
  });

  it('(d) returns INVALID_API_KEY when key is valid but no agent references it', async () => {
    // A genuine courier_pairing key whose ID does NOT appear in any agents row.
    mockIsValidApiKeyWithScope.mockResolvedValueOnce({
      valid: true,
      scope: 'courier_pairing',
      keyId: OTHER_KEY_ID,
    });

    const { authenticateCourier, INVALID_API_KEY } = await getResolver();
    const result = await authenticateCourier(makeReq('lg_cou_orphankey'));

    expect(result).toBe(INVALID_API_KEY);
  });
});
