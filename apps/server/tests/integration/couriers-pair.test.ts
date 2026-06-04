/**
 * Integration tests — Courier pair endpoints — V2-006a-T4
 *
 * Coverage:
 *   pair-tokens (POST /api/v1/couriers/pair-tokens):
 *     1. admin → 200 with token + expires_at
 *     2. non-admin → 403
 *     3. unauthenticated → 401
 *
 *   pair (POST /api/v1/couriers/pair):
 *     4. valid token → 200 with api_key + agent_id + instance_id + server_version
 *     5. the returned api_key authenticates via authenticateCourier to the same agent_id
 *     6. invalid/tampered token → 400 invalid-or-expired
 *     7. expired token (injectable `now`) → 400 invalid-or-expired
 *     8. extension-kind token → 400 wrong-kind
 *     9. reused nonce → 409 pair-token-already-used
 *
 * Setup mirrors db-courier-schema.test.ts: fresh DB, runMigrations, then
 * bootstrapInstanceIdentity so signPairToken / verifyPairToken work.
 *
 * The route handlers are tested through the domain functions (mintCourierPairToken /
 * exchangeCourierPairToken) for the pair endpoint; the pair-tokens route is tested
 * via its POST handler with a mocked authenticateRequest.
 *
 * authenticateCourier cross-check: we construct a real Request with the x-api-key
 * header set to the minted key, then call authenticateCourier directly. It must
 * resolve to the same agentId returned by the pair response.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getServerDb, schema } from '../../src/db/client';
import { bootstrapInstanceIdentity } from '../../src/identity/index';
import { mintCourierPairToken, exchangeCourierPairToken } from '../../src/forge/couriers';
import { signPairToken } from '../../src/identity/index';
import { authenticateCourier, INVALID_API_KEY } from '../../src/auth/courier-auth';

// ── Next.js shim ─────────────────────────────────────────────────────────────
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

// ── Mock authenticateRequest so we control admin/non-admin per test ───────────
const mockAuthenticate = vi.fn();
vi.mock('../../src/auth/request-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/request-auth')>();
  return {
    ...actual,
    authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  };
});

// ── DB setup ─────────────────────────────────────────────────────────────────
const DB_PATH = '/tmp/lootgoblin-v2006a-t4.db';
const DB_URL = `file:${DB_PATH}`;

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
  // Bootstrap instance identity so sign/verify work.
  await bootstrapInstanceIdentity('test-instance');
}, 30_000);

function db() {
  return getServerDb(DB_URL);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(method = 'POST', body?: unknown, apiKey?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return new Request('http://local/test', {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── pair-tokens tests ─────────────────────────────────────────────────────────

describe('POST /api/v1/couriers/pair-tokens', () => {
  // Import after mocks are set up.
  const getRoute = () =>
    import('../../src/app/api/v1/couriers/pair-tokens/route').then((m) => m.POST);

  it('1. admin → 200 with token + expires_at', async () => {
    mockAuthenticate.mockResolvedValue({ id: 'admin-1', role: 'admin', source: 'session' });
    const POST = await getRoute();
    const res = await POST(makeReq('POST') as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.token).toBe('string');
    expect(json.token.split('.').length).toBe(2); // <payload>.<sig>
    expect(typeof json.expires_at).toBe('number');
    expect(json.expires_at).toBeGreaterThan(Date.now());
  });

  it('2. non-admin → 403', async () => {
    mockAuthenticate.mockResolvedValue({ id: 'user-1', role: 'user', source: 'session' });
    const POST = await getRoute();
    const res = await POST(makeReq('POST') as any);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('forbidden');
    expect(json.reason).toBe('admin-only');
  });

  it('3. unauthenticated → 401', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const POST = await getRoute();
    const res = await POST(makeReq('POST') as any);
    expect(res.status).toBe(401);
  });
});

// ── pair tests ────────────────────────────────────────────────────────────────

describe('POST /api/v1/couriers/pair', () => {
  it('4. valid token → 200 with api_key + agent_id + instance_id + server_version', async () => {
    const mintResult = await mintCourierPairToken();
    expect(mintResult).not.toBeNull();

    const result = await exchangeCourierPairToken(mintResult!.token, { dbUrl: DB_URL });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    expect(typeof result.api_key).toBe('string');
    expect(result.api_key.startsWith('lg_cou_')).toBe(true);
    expect(typeof result.agent_id).toBe('string');
    expect(typeof result.instance_id).toBe('string');
    expect(typeof result.server_version).toBe('string');

    // agent row must exist with kind='courier'
    const agentRows = await db()
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, result.agent_id))
      .limit(1);
    expect(agentRows.length).toBe(1);
    expect(agentRows[0]!.kind).toBe('courier');
    expect(agentRows[0]!.pairCredentialRef).toBeTruthy();
  });

  it('5. returned api_key authenticates via authenticateCourier to the same agent_id', async () => {
    const mintResult = await mintCourierPairToken();
    expect(mintResult).not.toBeNull();

    const result = await exchangeCourierPairToken(mintResult!.token, { dbUrl: DB_URL });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    // Build a request carrying the minted key.
    const req = makeReq('GET', undefined, result.api_key);

    // authenticateCourier reads from the DB — override DATABASE_URL to point
    // to our test DB. The module uses getServerDb() which reads process.env.DATABASE_URL.
    // We already set it in beforeAll; just call through.
    const authResult = await authenticateCourier(req);

    expect(authResult).not.toBeNull();
    expect(authResult).not.toBe(INVALID_API_KEY);
    // Type guard: at this point it must be { agentId: string }
    expect((authResult as { agentId: string }).agentId).toBe(result.agent_id);
  });

  it('6. tampered/invalid token → 400 invalid-or-expired', async () => {
    const result = await exchangeCourierPairToken('invalid.token', { dbUrl: DB_URL });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(400);
    expect(result.error).toBe('invalid-pair-token');
    expect(result.reason).toBe('invalid-or-expired');
  });

  it('7. expired token → 400 invalid-or-expired', async () => {
    // Mint with a `now` in the past so expires_at is also in the past.
    const pastNow = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
    const mintResult = await mintCourierPairToken({ now: pastNow, nonce: randomBytes(16).toString('hex') });
    expect(mintResult).not.toBeNull();
    // The token is expired — verifyPairToken will reject it.
    const result = await exchangeCourierPairToken(mintResult!.token, { dbUrl: DB_URL });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(400);
    expect(result.error).toBe('invalid-pair-token');
    expect(result.reason).toBe('invalid-or-expired');
  });

  it('8. extension-kind token → 400 wrong-kind', async () => {
    // Manually sign an extension-kind token.
    const extensionToken = await signPairToken({
      kind: 'extension',
      issued_at: Date.now(),
      expires_at: Date.now() + 30 * 60 * 1000,
      nonce: randomBytes(16).toString('hex'),
      purpose: 'extension-pair',
    });
    expect(extensionToken).not.toBeNull();

    const result = await exchangeCourierPairToken(extensionToken!, { dbUrl: DB_URL });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(400);
    expect(result.error).toBe('invalid-pair-token');
    expect(result.reason).toBe('wrong-kind');
  });

  it('9. reused nonce → 409 pair-token-already-used (fast-path SELECT)', async () => {
    const mintResult = await mintCourierPairToken();
    expect(mintResult).not.toBeNull();

    // First exchange — must succeed.
    const first = await exchangeCourierPairToken(mintResult!.token, { dbUrl: DB_URL });
    expect(first.ok).toBe(true);

    // Second exchange with same token — nonce replay caught by the up-front SELECT.
    const second = await exchangeCourierPairToken(mintResult!.token, { dbUrl: DB_URL });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected failure');
    expect(second.status).toBe(409);
    expect(second.error).toBe('pair-token-already-used');
  });

  it('10. pre-consumed nonce → 409 even when the INSERT (not the SELECT) detects it', async () => {
    // Seed an agent + a courier_pair_nonces row directly, simulating a race
    // winner that already committed the nonce. Then mint a token carrying that
    // SAME nonce and exchange it. The PRIMARY KEY backstop must yield a 409,
    // never an uncaught 500 / PRIMARY-KEY throw. (Even though the up-front SELECT
    // also catches this, the assertion proves the contract: same nonce → 409.)
    const sharedNonce = randomBytes(16).toString('hex');

    // Insert a pre-existing nonce row tied to a freshly-minted courier agent.
    const seedAgent = await exchangeCourierPairToken(
      (await mintCourierPairToken())!.token,
      { dbUrl: DB_URL },
    );
    expect(seedAgent.ok).toBe(true);
    if (!seedAgent.ok) throw new Error('expected ok');

    await db().insert(schema.courierPairNonces).values({
      nonce: sharedNonce,
      consumedAt: new Date(),
      agentId: seedAgent.agent_id,
    });

    // Mint a token with the exact same nonce and exchange it.
    const collidingMint = await mintCourierPairToken({ nonce: sharedNonce });
    expect(collidingMint).not.toBeNull();
    const result = await exchangeCourierPairToken(collidingMint!.token, { dbUrl: DB_URL });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(409);
    expect(result.error).toBe('pair-token-already-used');
  });

  it('11. concurrent same-token race → exactly one 200, the loser 409', async () => {
    const mintResult = await mintCourierPairToken();
    expect(mintResult).not.toBeNull();

    // Fire two exchanges of the same token concurrently. Both may pass the
    // up-front SELECT; the PRIMARY KEY on nonce lets at most one INSERT win.
    // The loser's INSERT throws a UNIQUE/PRIMARY KEY violation that the
    // step-8 try/catch translates to 409 (the race-safe backstop).
    const [a, b] = await Promise.all([
      exchangeCourierPairToken(mintResult!.token, { dbUrl: DB_URL }),
      exchangeCourierPairToken(mintResult!.token, { dbUrl: DB_URL }),
    ]);

    const oks = [a, b].filter((r) => r.ok);
    const conflicts = [a, b].filter((r) => !r.ok && r.status === 409);

    expect(oks.length).toBe(1);
    expect(conflicts.length).toBe(1);
  });
});
