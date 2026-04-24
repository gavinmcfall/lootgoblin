/**
 * Unit tests for getFirstRunState() — V2-001-T8
 *
 * Uses an in-memory SQLite DB to test all branches without needing
 * the full integration test harness. Follows the pattern from
 * tests/integration/instance-bootstrap.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import { ConfigResolver, nullDbAdapter } from '../../src/config/resolver';
import { eq } from 'drizzle-orm';

const DB_PATH = '/tmp/lootgoblin-first-run.db';

const REQUIRED_ENV = {
  DATABASE_URL: `file:${DB_PATH}`,
  BETTER_AUTH_SECRET: 'test-secret-long-enough-for-resolver',
  BETTER_AUTH_URL: 'http://localhost:7393',
  CONFIG_FILE_PATH: '/tmp/nonexistent-config-file-first-run.yml',
};

// ── Resolver factory helpers ──────────────────────────────────────────────────

/** Build a resolver with all required env keys set and no pending keys (STASH_ROOTS set). */
async function makeResolverNoPending(): Promise<ConfigResolver> {
  const saved: Record<string, string | undefined> = {};
  const keys = [...Object.keys(REQUIRED_ENV), 'STASH_ROOTS'];
  for (const k of keys) saved[k] = process.env[k];

  Object.assign(process.env, REQUIRED_ENV, { STASH_ROOTS: '/mnt/stash' });
  const resolver = new ConfigResolver(nullDbAdapter);
  await resolver.resolve();

  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return resolver;
}

/** Build a resolver that has STASH_ROOTS as pending-wizard. */
async function makeResolverWithPending(): Promise<ConfigResolver> {
  const saved: Record<string, string | undefined> = {};
  const keys = [...Object.keys(REQUIRED_ENV), 'STASH_ROOTS'];
  for (const k of keys) saved[k] = process.env[k];

  Object.assign(process.env, REQUIRED_ENV);
  delete process.env.STASH_ROOTS;
  const resolver = new ConfigResolver(nullDbAdapter);
  await resolver.resolve();

  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return resolver;
}

// ── DB setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${DB_PATH}`;
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  await runMigrations(`file:${DB_PATH}`);
});

afterAll(() => {
  delete process.env.DATABASE_URL;
  resetDbCache();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getFirstRunState', () => {
  it('returns no-admin with empty pendingKeys when DB is empty and no pending wizard keys', async () => {
    const db = getDb() as any;
    // Confirm clean slate
    const users = await db.select().from(schema.user);
    expect(users).toHaveLength(0);

    const resolver = await makeResolverNoPending();
    const { getFirstRunState } = await import('../../src/setup/first-run');
    const state = await getFirstRunState(resolver);

    expect(state.needsSetup).toBe(true);
    if (state.needsSetup) {
      expect(state.reason).toBe('no-admin');
      expect(state.pendingKeys).toEqual([]);
    }
  });

  it('returns no-admin with pendingKeys populated when DB is empty and wizard keys are pending', async () => {
    const resolver = await makeResolverWithPending();
    const { getFirstRunState } = await import('../../src/setup/first-run');
    const state = await getFirstRunState(resolver);

    expect(state.needsSetup).toBe(true);
    if (state.needsSetup) {
      expect(state.reason).toBe('no-admin');
      expect(state.pendingKeys).toContain('STASH_ROOTS');
    }
  });

  it('no-admin reason takes priority over pending-wizard when both conditions hold', async () => {
    // Verify DB still has no users (clean state from beforeAll)
    const db = getDb() as any;
    const users = await db.select().from(schema.user);
    expect(users).toHaveLength(0);

    const resolver = await makeResolverWithPending();
    const { getFirstRunState } = await import('../../src/setup/first-run');
    const state = await getFirstRunState(resolver);

    expect(state.needsSetup).toBe(true);
    if (state.needsSetup) {
      expect(state.reason).toBe('no-admin');
      // pendingKeys still reported so the wizard can show remaining work
      expect(state.pendingKeys).toContain('STASH_ROOTS');
    }
  });

  it('returns pending-wizard when admin exists but pending keys remain', async () => {
    const db = getDb() as any;
    await db.insert(schema.user).values({
      id: 'test-user-pending',
      name: 'Test Admin',
      email: 'admin-pending@test.example',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const resolver = await makeResolverWithPending();
    const { getFirstRunState } = await import('../../src/setup/first-run');
    const state = await getFirstRunState(resolver);

    expect(state.needsSetup).toBe(true);
    if (state.needsSetup) {
      expect(state.reason).toBe('pending-wizard');
      expect(state.pendingKeys).toContain('STASH_ROOTS');
    }

    await db.delete(schema.user).where(eq(schema.user.id, 'test-user-pending'));
  });

  it('returns needsSetup: false when admin exists and no pending keys', async () => {
    const db = getDb() as any;
    await db.insert(schema.user).values({
      id: 'test-user-done',
      name: 'Test Admin Done',
      email: 'admin-done@test.example',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const resolver = await makeResolverNoPending();
    const { getFirstRunState } = await import('../../src/setup/first-run');
    const state = await getFirstRunState(resolver);

    expect(state.needsSetup).toBe(false);

    await db.delete(schema.user).where(eq(schema.user.id, 'test-user-done'));
  });
});

describe('ConfigResolver.getPendingWizardKeys', () => {
  it('returns empty array before resolve() is called', () => {
    const resolver = new ConfigResolver(nullDbAdapter);
    expect(resolver.getPendingWizardKeys()).toEqual([]);
  });

  it('returns pending keys after resolve() with missing STASH_ROOTS', async () => {
    const resolver = await makeResolverWithPending();
    expect(resolver.getPendingWizardKeys()).toContain('STASH_ROOTS');
  });

  it('returns empty array when all wizard-deferrable keys are satisfied', async () => {
    const resolver = await makeResolverNoPending();
    expect(resolver.getPendingWizardKeys()).toEqual([]);
  });
});
