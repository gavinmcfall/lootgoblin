/**
 * Integration tests for instance identity bootstrap + public endpoint — V2-001-T6
 *
 * Tests:
 *   - Fresh DB → bootstrap creates exactly one row.
 *   - Run bootstrap twice → still exactly one row (idempotent).
 *   - Row has valid UUIDv4 + valid Ed25519 public key (32 bytes) + private key.
 *   - GET /api/v1/instance returns public triple (id, public_key, name).
 *   - GET /api/v1/instance does NOT include private_key.
 *   - GET /api/v1/instance succeeds without any auth cookie or header
 *     (middleware allowlist covers this at the edge; here we test the route handler
 *     directly — it should return 200 without checking credentials).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import {
  bootstrapInstanceIdentity,
  getInstanceIdentityPublic,
} from '../../src/identity/index';

// ── Next.js shim — NextResponse used by the route handler ─────────────────
import { vi } from 'vitest';
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

const DB_PATH = '/tmp/lootgoblin-integration-identity.db';

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${DB_PATH}`;
  resetDbCache();
  await runMigrations(`file:${DB_PATH}`);
});

// ---------------------------------------------------------------------------
// Bootstrap idempotency + row validation
// ---------------------------------------------------------------------------

describe('bootstrapInstanceIdentity', () => {
  it('creates exactly one row in a fresh DB', async () => {
    const db = getDb() as any;
    // Confirm zero rows before bootstrap.
    const before = await db.select().from(schema.instanceIdentity);
    expect(before).toHaveLength(0);

    await bootstrapInstanceIdentity('integration-test');

    const after = await db.select().from(schema.instanceIdentity);
    expect(after).toHaveLength(1);
  });

  it('is idempotent — a second call does not create a second row', async () => {
    await bootstrapInstanceIdentity('integration-test');
    await bootstrapInstanceIdentity('integration-test');

    const db = getDb() as any;
    const rows = await db.select().from(schema.instanceIdentity);
    expect(rows).toHaveLength(1);
  });

  it('stores a valid UUIDv4 in the id field', async () => {
    const identity = await getInstanceIdentityPublic();
    expect(identity).not.toBeNull();
    expect(identity!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('stores a valid Ed25519 public key (base64url, decodes to 32 bytes)', async () => {
    const identity = await getInstanceIdentityPublic();
    expect(identity).not.toBeNull();
    const bytes = Buffer.from(identity!.public_key, 'base64url');
    expect(bytes.byteLength).toBe(32);
  });

  it('stores a valid Ed25519 private key (base64url, decodes to 32 bytes) in the DB', async () => {
    // Access the full row via Drizzle directly — bypassing the public projection.
    const db = getDb() as any;
    const rows = await db.select().from(schema.instanceIdentity);
    expect(rows).toHaveLength(1);
    const privateKeyBytes = Buffer.from(rows[0].private_key, 'base64url');
    expect(privateKeyBytes.byteLength).toBe(32);
  });

  it('records the instance name passed to bootstrap', async () => {
    const identity = await getInstanceIdentityPublic();
    expect(identity!.name).toBe('integration-test');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/instance — route handler
// ---------------------------------------------------------------------------

describe('GET /api/v1/instance', () => {
  it('returns 200 with { id, public_key, name }', async () => {
    const { GET } = await import('../../src/app/api/v1/instance/route');
    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(typeof body.id).toBe('string');
    expect(typeof body.public_key).toBe('string');
    // name may be string or null — just verify the key is present in the response
    expect('name' in body).toBe(true);
  });

  it('does NOT include private_key in the response', async () => {
    const { GET } = await import('../../src/app/api/v1/instance/route');
    const res = await GET();
    const body = await res.json();
    expect(body).not.toHaveProperty('private_key');
  });

  it('does NOT include the singleton guard column in the response', async () => {
    const { GET } = await import('../../src/app/api/v1/instance/route');
    const res = await GET();
    const body = await res.json();
    expect(body).not.toHaveProperty('singleton');
  });

  it('returns 200 without any auth cookie or x-api-key header (unauthenticated)', async () => {
    // The route handler itself does not perform auth checks.
    // Middleware allowlist covers the edge; here we confirm the handler
    // returns data with no credentials at all.
    const { GET } = await import('../../src/app/api/v1/instance/route');
    const res = await GET();
    expect(res.status).toBe(200);
  });

  it('returns valid public_key that decodes to 32 bytes', async () => {
    const { GET } = await import('../../src/app/api/v1/instance/route');
    const res = await GET();
    const body = await res.json();
    const bytes = Buffer.from(body.public_key, 'base64url');
    expect(bytes.byteLength).toBe(32);
  });
});
