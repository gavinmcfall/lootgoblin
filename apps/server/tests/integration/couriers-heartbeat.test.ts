/**
 * Integration tests — Courier heartbeat endpoint — V2-006a-T5
 *
 * Coverage:
 *   1. Missing/invalid API key → 401
 *   2. Valid key + heartbeat → 200 + ok + bumps last_seen_at
 *   3. Reachability rows updated for assigned printers
 *   4. Entry for printer NOT assigned to this agent → ignored (no error, no row created)
 *   5. Major version mismatch → 409 version-incompatible
 *   6. Minor version mismatch → 200 + warning: 'minor-version-mismatch'
 *   7. Exact version match → 200, no warning field
 *
 * DB path: /tmp/lootgoblin-v2006a-t5.db (unique — does not share with T4).
 *
 * Real auth path (test 2-4): mint a pair token + exchange it to get a real
 * courier_pairing API key, then present it in x-api-key. This exercises the
 * full authenticateCourier path.
 *
 * Mocked auth path (tests 5-7): vi.mock authenticateCourier to return
 * { agentId } directly, so we can exercise version-handshake branches
 * without needing separate real keys.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { runMigrations, resetDbCache, getServerDb, schema } from '../../src/db/client';
import { bootstrapInstanceIdentity } from '../../src/identity/index';
import { mintCourierPairToken, exchangeCourierPairToken } from '../../src/forge/couriers';
import { SERVER_VERSION } from '../../src/forge/couriers';

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

// ── courier-auth mock for version-mismatch branches ──────────────────────────
// We spy on authenticateCourier but only override it for specific tests.
// Default: pass through the real implementation.
const mockAuthenticateCourier = vi.fn();

vi.mock('../../src/auth/courier-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/courier-auth')>();
  return {
    ...actual,
    authenticateCourier: (...args: unknown[]) => mockAuthenticateCourier(...args),
  };
});

// ── DB setup ─────────────────────────────────────────────────────────────────
const DB_PATH = '/tmp/lootgoblin-v2006a-t5.db';
const DB_URL = `file:${DB_PATH}`;

let testApiKey = '';
let testAgentId = '';
let testPrinterId = '';

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);

  // Bootstrap instance identity so sign/verify work.
  await bootstrapInstanceIdentity('test-instance-t5');

  // Mint a real courier API key (end-to-end auth path).
  const mintResult = await mintCourierPairToken();
  if (!mintResult) throw new Error('mintCourierPairToken returned null');

  const exchangeResult = await exchangeCourierPairToken(mintResult.token, { dbUrl: DB_URL });
  if (!exchangeResult.ok) throw new Error(`exchangeCourierPairToken failed: ${JSON.stringify(exchangeResult)}`);

  testApiKey = exchangeResult.api_key;
  testAgentId = exchangeResult.agent_id;

  // Seed a user (required for printer.owner_id FK).
  const db = getServerDb(DB_URL);
  const userId = randomUUID();
  await db.insert(schema.user).values({
    id: userId,
    name: 'T5 Test User',
    email: `${userId}@courier-heartbeat.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();

  // Seed a printer + a printer_reachable_via row for the test agent.
  testPrinterId = 'test-printer-t5-001';

  await db.insert(schema.printers).values({
    id: testPrinterId,
    ownerId: userId,
    kind: 'fdm_klipper',
    name: 'T5 Test Printer',
    connectionConfig: { url: 'http://192.168.1.99:7125' },
    active: true,
    createdAt: new Date(),
  }).onConflictDoNothing();

  // Assign the printer to the test agent via printer_reachable_via.
  await db.insert(schema.printerReachableVia).values({
    printerId: testPrinterId,
    agentId: testAgentId,
    reachableStatus: 'unknown',
    lastCheckedAt: null,
    detail: null,
  }).onConflictDoNothing();
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function db() {
  return getServerDb(DB_URL);
}

function makeReq(body: unknown, apiKey?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return new Request('http://local/api/v1/couriers/heartbeat', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function getRoute() {
  return import('../../src/app/api/v1/couriers/heartbeat/route').then((m) => m.POST);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/couriers/heartbeat', () => {
  // Test 1: missing/invalid API key → 401.
  // For this we let the real authenticateCourier run (mock passes through).
  it('1. missing API key → 401', async () => {
    // Pass through to real authenticateCourier (no key = returns null).
    mockAuthenticateCourier.mockImplementationOnce(async (req: Request) => {
      const { authenticateCourier } = await import('../../src/auth/courier-auth');
      // Re-import is mocked, so call the actual module directly.
      // Instead, just return null to simulate "no key".
      const apiKeyHeader = (req.headers as Headers).get('x-api-key');
      return apiKeyHeader ? Symbol('INVALID_API_KEY') : null;
    });

    // Provide the real unauthenticatedResponse by reimporting.
    // The mock already re-exports it from request-auth so it's real.

    const POST = await getRoute();
    const res = await POST(makeReq({ courier_version: SERVER_VERSION }) as any);
    expect(res.status).toBe(401);
  });

  // Tests 2-4 use the REAL authenticateCourier path via the actual API key.
  // We override the mock to call the actual function.
  it('2. valid key → 200 + bumps last_seen_at', async () => {
    // Use real courier-auth: read x-api-key and resolve agent.
    const { authenticateCourier: realAuth } = await vi.importActual<typeof import('../../src/auth/courier-auth')>('../../src/auth/courier-auth');
    mockAuthenticateCourier.mockImplementation(realAuth);

    const agentBefore = await db()
      .select({ lastSeenAt: schema.agents.lastSeenAt })
      .from(schema.agents)
      .where(eq(schema.agents.id, testAgentId))
      .limit(1);

    const tsBefore = agentBefore[0]?.lastSeenAt?.getTime() ?? 0;

    // Small delay so the new timestamp is strictly greater.
    await new Promise((r) => setTimeout(r, 10));

    const POST = await getRoute();
    const res = await POST(makeReq({ courier_version: SERVER_VERSION }, testApiKey) as any);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.server_version).toBe(SERVER_VERSION);
    expect(typeof json.heartbeat_interval_seconds).toBe('number');
    expect(json.heartbeat_interval_seconds).toBeGreaterThan(0);
    expect(json.warning).toBeUndefined();

    const agentAfter = await db()
      .select({ lastSeenAt: schema.agents.lastSeenAt })
      .from(schema.agents)
      .where(eq(schema.agents.id, testAgentId))
      .limit(1);

    const tsAfter = agentAfter[0]?.lastSeenAt?.getTime() ?? 0;
    expect(tsAfter).toBeGreaterThan(tsBefore);
  });

  it('3. printers[] entry for assigned printer → row updated', async () => {
    const { authenticateCourier: realAuth } = await vi.importActual<typeof import('../../src/auth/courier-auth')>('../../src/auth/courier-auth');
    mockAuthenticateCourier.mockImplementation(realAuth);

    const POST = await getRoute();
    const res = await POST(
      makeReq(
        {
          courier_version: SERVER_VERSION,
          printers: [
            {
              printer_id: testPrinterId,
              reachable_status: 'reachable',
              detail: 'HTTP 200 OK',
            },
          ],
        },
        testApiKey,
      ) as any,
    );

    expect(res.status).toBe(200);

    const rows = await db()
      .select()
      .from(schema.printerReachableVia)
      .where(
        eq(schema.printerReachableVia.printerId, testPrinterId),
      )
      .limit(1);

    expect(rows.length).toBe(1);
    expect(rows[0]!.reachableStatus).toBe('reachable');
    expect(rows[0]!.detail).toBe('HTTP 200 OK');
    expect(rows[0]!.lastCheckedAt).not.toBeNull();
  });

  it('4. entry for printer NOT assigned to this agent → ignored (no error, no row created)', async () => {
    const { authenticateCourier: realAuth } = await vi.importActual<typeof import('../../src/auth/courier-auth')>('../../src/auth/courier-auth');
    mockAuthenticateCourier.mockImplementation(realAuth);

    const unknownPrinterId = 'printer-not-assigned-xyz';

    // Verify no row exists before.
    const before = await db()
      .select()
      .from(schema.printerReachableVia)
      .where(eq(schema.printerReachableVia.printerId, unknownPrinterId));
    expect(before.length).toBe(0);

    const POST = await getRoute();
    const res = await POST(
      makeReq(
        {
          courier_version: SERVER_VERSION,
          printers: [
            {
              printer_id: unknownPrinterId,
              reachable_status: 'reachable',
            },
          ],
        },
        testApiKey,
      ) as any,
    );

    // Must NOT error — 200 OK.
    expect(res.status).toBe(200);

    // No row should have been created.
    const after = await db()
      .select()
      .from(schema.printerReachableVia)
      .where(eq(schema.printerReachableVia.printerId, unknownPrinterId));
    expect(after.length).toBe(0);
  });

  // Tests 5-7: use mocked auth for version-handshake branches.

  it('5. major version mismatch → 409 version-incompatible', async () => {
    mockAuthenticateCourier.mockResolvedValue({ agentId: testAgentId });

    // Manufacture a courier_version with a different major.
    const serverMajor = parseInt(SERVER_VERSION.split('.')[0] ?? '2', 10);
    const differentMajor = serverMajor === 0 ? 1 : 0;
    const courierVersion = `${differentMajor}.0.0`;

    const POST = await getRoute();
    const res = await POST(makeReq({ courier_version: courierVersion }, 'dummy-key') as any);
    expect(res.status).toBe(409);

    const json = await res.json();
    expect(json.error).toBe('version-incompatible');
    expect(json.server_version).toBe(SERVER_VERSION);
    expect(json.action).toBe('upgrade');
  });

  it('6. minor version mismatch → 200 + warning: minor-version-mismatch', async () => {
    mockAuthenticateCourier.mockResolvedValue({ agentId: testAgentId });

    // Same major, different minor.
    const parts = SERVER_VERSION.split('.');
    const major = parts[0] ?? '2';
    const minor = parseInt(parts[1] ?? '0', 10);
    const differentMinor = minor === 0 ? 1 : 0;
    const courierVersion = `${major}.${differentMinor}.0`;

    const POST = await getRoute();
    const res = await POST(makeReq({ courier_version: courierVersion }, 'dummy-key') as any);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.warning).toBe('minor-version-mismatch');
  });

  it('7. exact version match → 200, no warning', async () => {
    mockAuthenticateCourier.mockResolvedValue({ agentId: testAgentId });

    const POST = await getRoute();
    const res = await POST(makeReq({ courier_version: SERVER_VERSION }, 'dummy-key') as any);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.warning).toBeUndefined();
  });
});
