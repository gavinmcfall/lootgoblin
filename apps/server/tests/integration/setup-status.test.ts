/**
 * Integration tests for /api/v1/setup/status + /api/v1/setup/wizard — V2-001-T8
 *
 * Tests:
 *   - Fresh DB → /api/v1/setup/status returns no-admin.
 *   - After seeded admin + no pending → needsSetup: false.
 *   - After seeded admin + forced pending key → pending-wizard.
 *   - POST /api/v1/setup/wizard writes a key, pending set shrinks.
 *   - POST /api/v1/setup/wizard returns 409 when setup already done.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import { eq } from 'drizzle-orm';

// ── Next.js shim — same pattern as instance-bootstrap.test.ts ─────────────────
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

const DB_PATH = '/tmp/lootgoblin-integration-setup.db';

const REQUIRED_ENV = {
  DATABASE_URL: `file:${DB_PATH}`,
  BETTER_AUTH_SECRET: 'integration-test-secret-long-enough',
  BETTER_AUTH_URL: 'http://localhost:7393',
  CONFIG_FILE_PATH: '/tmp/nonexistent-config-integration-setup.yml',
};

beforeAll(async () => {
  Object.assign(process.env, REQUIRED_ENV);
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  await runMigrations(`file:${DB_PATH}`);
});

// ---------------------------------------------------------------------------
// GET /api/v1/setup/status
// ---------------------------------------------------------------------------

describe('GET /api/v1/setup/status', () => {
  it('returns no-admin on a fresh DB', async () => {
    // Ensure no pending keys (STASH_ROOTS set)
    process.env.STASH_ROOTS = '/mnt/stash';

    // Import resolver and resolve so pending set is current
    const { ConfigResolver, nullDbAdapter } = await import('../../src/config/resolver');
    const resolver = new ConfigResolver(nullDbAdapter);
    await resolver.resolve();

    // Patch the singleton used by getFirstRunState
    const configModule = await import('../../src/config/index');
    vi.spyOn(configModule.configResolver, 'getPendingWizardKeys').mockReturnValue([]);

    const { GET } = await import('../../src/app/api/v1/setup/status/route');
    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.needsSetup).toBe(true);
    expect(body.reason).toBe('no-admin');

    vi.restoreAllMocks();
    delete process.env.STASH_ROOTS;
  });

  it('returns needsSetup: false after admin is seeded and no pending keys', async () => {
    const db = getDb() as any;
    await db.insert(schema.user).values({
      id: 'status-test-admin',
      name: 'Status Test Admin',
      email: 'status-admin@test.example',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Mock resolver to report no pending keys
    const configModule = await import('../../src/config/index');
    vi.spyOn(configModule.configResolver, 'getPendingWizardKeys').mockReturnValue([]);

    const { GET } = await import('../../src/app/api/v1/setup/status/route');
    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.needsSetup).toBe(false);

    vi.restoreAllMocks();
    await db.delete(schema.user).where(eq(schema.user.id, 'status-test-admin'));
  });

  it('returns pending-wizard after admin seeded and forced pending key', async () => {
    const db = getDb() as any;
    await db.insert(schema.user).values({
      id: 'status-test-admin-2',
      name: 'Status Test Admin 2',
      email: 'status-admin-2@test.example',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Mock resolver to report a pending key
    const configModule = await import('../../src/config/index');
    vi.spyOn(configModule.configResolver, 'getPendingWizardKeys').mockReturnValue(['STASH_ROOTS']);

    const { GET } = await import('../../src/app/api/v1/setup/status/route');
    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.needsSetup).toBe(true);
    expect(body.reason).toBe('pending-wizard');
    expect(body.pendingKeys).toContain('STASH_ROOTS');

    vi.restoreAllMocks();
    await db.delete(schema.user).where(eq(schema.user.id, 'status-test-admin-2'));
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/setup/wizard
// ---------------------------------------------------------------------------

describe('POST /api/v1/setup/wizard', () => {
  it('writes a pending key and returns shrunken pendingKeys in response', async () => {
    const db = getDb() as any;
    await db.insert(schema.user).values({
      id: 'wizard-test-admin',
      name: 'Wizard Test Admin',
      email: 'wizard-admin@test.example',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Mock: first call returns pending, second call (after write) returns no-pending
    const configModule = await import('../../src/config/index');
    let callCount = 0;
    vi.spyOn(configModule.configResolver, 'getPendingWizardKeys').mockImplementation(() => {
      callCount++;
      return callCount === 1 ? ['STASH_ROOTS'] : [];
    });
    vi.spyOn(configModule.configResolver, 'resolve').mockResolvedValue({} as any);

    const { POST } = await import('../../src/app/api/v1/setup/wizard/route');
    const req = new Request('http://localhost/api/v1/setup/wizard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'STASH_ROOTS', value: '/mnt/stash' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    // After writing the last pending key, setup is done
    expect(body.needsSetup).toBe(false);

    // Verify the row was actually written
    const { instanceConfig } = await import('../../src/db/schema.config');
    const rows = await db
      .select()
      .from(instanceConfig)
      .where(eq(instanceConfig.key, 'STASH_ROOTS'));
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('/mnt/stash');

    vi.restoreAllMocks();
    await db.delete(schema.user).where(eq(schema.user.id, 'wizard-test-admin'));
    await db.delete(instanceConfig).where(eq(instanceConfig.key, 'STASH_ROOTS'));
  });

  it('returns 409 when setup is already done (no pending keys, admin exists)', async () => {
    const db = getDb() as any;
    await db.insert(schema.user).values({
      id: 'wizard-409-admin',
      name: 'Wizard 409 Admin',
      email: 'wizard-409@test.example',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Mock: no pending keys = setup done
    const configModule = await import('../../src/config/index');
    vi.spyOn(configModule.configResolver, 'getPendingWizardKeys').mockReturnValue([]);

    const { POST } = await import('../../src/app/api/v1/setup/wizard/route');
    const req = new Request('http://localhost/api/v1/setup/wizard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'STASH_ROOTS', value: '/mnt/stash' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(409);

    vi.restoreAllMocks();
    await db.delete(schema.user).where(eq(schema.user.id, 'wizard-409-admin'));
  });

  it('returns 400 for invalid JSON body', async () => {
    // First make sure we're in setup-required state (no admin)
    const configModule = await import('../../src/config/index');
    vi.spyOn(configModule.configResolver, 'getPendingWizardKeys').mockReturnValue(['STASH_ROOTS']);

    const { POST } = await import('../../src/app/api/v1/setup/wizard/route');
    const req = new Request('http://localhost/api/v1/setup/wizard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-valid-json',
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    vi.restoreAllMocks();
  });
});
