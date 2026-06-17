// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for resolveQuarantineAcl — Quarantine HTTP Layer Task 1
 *
 * Tests:
 *   - owner of parent stashRoot can read + write
 *   - admin can read cross-owner
 *   - admin write cross-owner → denied (not-found to hide existence)
 *   - non-owner non-admin → not-found (404 semantics, hides existence)
 *   - unknown quarantine id → not-found
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { runMigrations, resetDbCache, getDb } from '../../src/db/client';
import { user, stashRoots, quarantineItems } from '../../src/db/schema';
import { resolveQuarantineAcl } from '../../src/acl/quarantine';
import type { AuthenticatedActor } from '../../src/auth/request-auth';

const DB_PATH = '/tmp/lootgoblin-quarantine-acl.db';
const DB_URL = `file:${DB_PATH}`;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
}, 30_000);

function db() {
  return getDb(DB_URL) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
}

function uid() {
  return crypto.randomUUID();
}

async function seedUser(id = uid()) {
  await db().insert(user).values({
    id,
    name: 'Test User',
    email: `${id}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashRoot(ownerId: string, id = uid()) {
  await db().insert(stashRoots).values({
    id,
    ownerId,
    name: 'Test Root',
    path: `/tmp/test-quarantine-root-${id}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedQuarantineItem(stashRootId: string, id = uid()) {
  await db().insert(quarantineItems).values({
    id,
    stashRootId,
    path: `/tmp/quarantine-test/${id}.stl`,
    reason: 'integrity-failed',
    details: null,
    createdAt: new Date(),
    resolvedAt: null,
  });
  return id;
}

function actor(id: string, role: 'admin' | 'user' = 'user'): AuthenticatedActor {
  return { id, role, source: 'session' };
}

// ---------------------------------------------------------------------------
// Test: owner can read
// ---------------------------------------------------------------------------

describe('resolveQuarantineAcl — owner can read', () => {
  it('returns allowed:true and the ownerId when the actor owns the stashRoot', async () => {
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const itemId = await seedQuarantineItem(rootId);

    const result = await resolveQuarantineAcl(actor(ownerId), itemId, 'read', DB_URL);

    expect(result.allowed).toBe(true);
    expect(result.ownerId).toBe(ownerId);
    expect(result.item).toBeDefined();
    expect(result.item?.id).toBe(itemId);
  });
});

// ---------------------------------------------------------------------------
// Test: owner can write
// ---------------------------------------------------------------------------

describe('resolveQuarantineAcl — owner can write', () => {
  it('returns allowed:true for write action when the actor owns the stashRoot', async () => {
    const ownerId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const itemId = await seedQuarantineItem(rootId);

    const result = await resolveQuarantineAcl(actor(ownerId), itemId, 'write', DB_URL);

    expect(result.allowed).toBe(true);
    expect(result.ownerId).toBe(ownerId);
    expect(result.item).toBeDefined();
    expect(result.item?.id).toBe(itemId);
  });
});

// ---------------------------------------------------------------------------
// Test: admin can read cross-owner
// ---------------------------------------------------------------------------

describe('resolveQuarantineAcl — admin read cross-owner', () => {
  it('returns allowed:true for admin reading another user\'s quarantine item', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser(uid());
    const rootId = await seedStashRoot(ownerId);
    const itemId = await seedQuarantineItem(rootId);

    const result = await resolveQuarantineAcl(actor(adminId, 'admin'), itemId, 'read', DB_URL);

    expect(result.allowed).toBe(true);
    expect(result.ownerId).toBe(ownerId);
    expect(result.item).toBeDefined();
    expect(result.item?.id).toBe(itemId);
  });
});

// ---------------------------------------------------------------------------
// Test: admin write cross-owner → denied (not-found to hide existence)
// ---------------------------------------------------------------------------

describe('resolveQuarantineAcl — admin write cross-owner is denied', () => {
  it('returns allowed:false with reason not-found when admin writes to another user\'s item', async () => {
    const ownerId = await seedUser();
    const adminId = await seedUser(uid());
    const rootId = await seedStashRoot(ownerId);
    const itemId = await seedQuarantineItem(rootId);

    const result = await resolveQuarantineAcl(actor(adminId, 'admin'), itemId, 'write', DB_URL);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not-found');
  });
});

// ---------------------------------------------------------------------------
// Test: non-owner non-admin → denied (not-found)
// ---------------------------------------------------------------------------

describe('resolveQuarantineAcl — non-owner non-admin is denied', () => {
  it('returns allowed:false with reason not-found for a different user', async () => {
    const ownerId = await seedUser();
    const otherUserId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const itemId = await seedQuarantineItem(rootId);

    const result = await resolveQuarantineAcl(actor(otherUserId), itemId, 'read', DB_URL);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not-found');
  });

  it('returns not-found (not 403) so the item existence is hidden', async () => {
    const ownerId = await seedUser();
    const otherUserId = await seedUser();
    const rootId = await seedStashRoot(ownerId);
    const itemId = await seedQuarantineItem(rootId);

    const result = await resolveQuarantineAcl(actor(otherUserId), itemId, 'write', DB_URL);

    expect(result.allowed).toBe(false);
    // Must be 'not-found', NOT 'not-owner' — to avoid leaking id existence
    expect(result.reason).toBe('not-found');
    expect((result as { reason?: string }).reason).not.toBe('not-owner');
  });
});

// ---------------------------------------------------------------------------
// Test: unknown quarantine id → not-found
// ---------------------------------------------------------------------------

describe('resolveQuarantineAcl — unknown id', () => {
  it('returns allowed:false with reason not-found for a non-existent quarantine item', async () => {
    const userId = await seedUser();

    const result = await resolveQuarantineAcl(
      actor(userId),
      'does-not-exist-00000000-0000-0000-0000-000000000000',
      'read',
      DB_URL,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not-found');
  });
});
