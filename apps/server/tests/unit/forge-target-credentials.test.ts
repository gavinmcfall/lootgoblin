/**
 * Unit tests for V2-005d-a T_da2 — forge_target_credentials CRUD module.
 *
 * Covers roundtrip encryption, upsert/overwrite, missing/short-secret guards,
 * decrypt-with-wrong-secret propagation, kind validation, removal, last-used
 * touch, and at-rest blob opacity (the stored bytes must never contain the
 * plaintext payload).
 *
 * Uses a temp sqlite file + per-test wipe so we don't share state with the
 * schema-only test (forge-target-credentials-schema.test.ts) running against
 * the same migrations.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync, rmSync } from 'node:fs';
import * as crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { getDb, resetDbCache, runMigrations, schema } from '@/db/client';
import { forgeTargetCredentials } from '@/db/schema.forge';
import {
  setCredential,
  getCredential,
  removeCredential,
  touchLastUsed,
} from '@/forge/dispatch/credentials';

const DB_PATH = '/tmp/lootgoblin-forge-target-credentials.db';
const DB_URL = `file:${DB_PATH}`;
const TEST_SECRET = 'x'.repeat(32);

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Forge Creds Test User',
    email: `${id}@test.example`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedPrinter(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.printers).values({
    id,
    ownerId,
    kind: 'fdm_klipper',
    name: `Printer-${id.slice(0, 8)}`,
    connectionConfig: { url: 'http://1.2.3.4:7125' },
    active: true,
    createdAt: new Date(),
  });
  return id;
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
}, 30_000);

beforeEach(async () => {
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  // Order matters for FKs: creds → printers → user.
  await db().delete(schema.forgeTargetCredentials);
  await db().delete(schema.printers);
  await db().delete(schema.user);
  // Don't leak LOOTGOBLIN_SECRET between tests; each test sets what it needs.
  delete process.env.LOOTGOBLIN_SECRET;
});

afterAll(() => {
  resetDbCache();
  try {
    rmSync(DB_PATH, { force: true });
  } catch {
    // ignore
  }
});

describe('setCredential / getCredential roundtrip', () => {
  it('encrypts on write and decrypts on read', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);

    const { id } = setCredential({
      printerId,
      kind: 'moonraker_api_key',
      payload: { apiKey: 'abc123' },
      label: 'home-voron',
      dbUrl: DB_URL,
      secret: TEST_SECRET,
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const got = getCredential<{ apiKey: string }>({
      printerId,
      dbUrl: DB_URL,
      secret: TEST_SECRET,
    });
    expect(got).not.toBeNull();
    expect(got?.id).toBe(id);
    expect(got?.printerId).toBe(printerId);
    expect(got?.kind).toBe('moonraker_api_key');
    expect(got?.label).toBe('home-voron');
    expect(got?.payload).toEqual({ apiKey: 'abc123' });
  });

  it('falls back to LOOTGOBLIN_SECRET env when secret arg omitted', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    process.env.LOOTGOBLIN_SECRET = TEST_SECRET;

    setCredential({
      printerId,
      kind: 'moonraker_api_key',
      payload: { apiKey: 'env-secret-path' },
      dbUrl: DB_URL,
    });
    const got = getCredential<{ apiKey: string }>({
      printerId,
      dbUrl: DB_URL,
    });
    expect(got?.payload).toEqual({ apiKey: 'env-secret-path' });
  });
});

describe('overwrite (UPSERT on printer_id)', () => {
  it('keeps a single row and returns the second payload on subsequent set', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);

    const { id: id1 } = setCredential({
      printerId,
      kind: 'moonraker_api_key',
      payload: { apiKey: 'first' },
      label: 'first-label',
      dbUrl: DB_URL,
      secret: TEST_SECRET,
    });

    const { id: id2 } = setCredential({
      printerId,
      kind: 'moonraker_api_key',
      payload: { apiKey: 'second' },
      label: 'second-label',
      dbUrl: DB_URL,
      secret: TEST_SECRET,
    });

    // Same id (UPSERT preserves the existing row).
    expect(id2).toBe(id1);

    const countRows = db()
      .select({ c: sql<number>`count(*)` })
      .from(forgeTargetCredentials)
      .where(eq(forgeTargetCredentials.printerId, printerId))
      .all();
    expect(countRows[0]?.c).toBe(1);

    const got = getCredential<{ apiKey: string }>({
      printerId,
      dbUrl: DB_URL,
      secret: TEST_SECRET,
    });
    expect(got?.payload).toEqual({ apiKey: 'second' });
    expect(got?.label).toBe('second-label');
  });
});

describe('getCredential null path', () => {
  it('returns null when no row exists for the printerId', () => {
    const got = getCredential({
      printerId: 'no-such-printer',
      dbUrl: DB_URL,
      secret: TEST_SECRET,
    });
    expect(got).toBeNull();
  });
});

describe('secret validation', () => {
  it('throws on setCredential with no secret available', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    expect(() =>
      setCredential({
        printerId,
        kind: 'moonraker_api_key',
        payload: { apiKey: 'x' },
        dbUrl: DB_URL,
      }),
    ).toThrow(/LOOTGOBLIN_SECRET is not set/);
  });

  it('throws on getCredential with no secret available', () => {
    expect(() =>
      getCredential({ printerId: 'anything', dbUrl: DB_URL }),
    ).toThrow(/LOOTGOBLIN_SECRET is not set/);
  });

  it('throws when secret is shorter than 32 chars', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    expect(() =>
      setCredential({
        printerId,
        kind: 'moonraker_api_key',
        payload: { apiKey: 'x' },
        dbUrl: DB_URL,
        secret: 'shortsecret',
      }),
    ).toThrow(/at least 32 chars/);
  });
});

describe('removeCredential', () => {
  it('returns { removed: true } and deletes the row when present', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    setCredential({
      printerId,
      kind: 'moonraker_api_key',
      payload: { apiKey: 'doomed' },
      dbUrl: DB_URL,
      secret: TEST_SECRET,
    });

    const result = removeCredential({ printerId, dbUrl: DB_URL });
    expect(result).toEqual({ removed: true });

    const got = getCredential({ printerId, dbUrl: DB_URL, secret: TEST_SECRET });
    expect(got).toBeNull();
  });

  it('returns { removed: false } when the row does not exist', () => {
    const result = removeCredential({
      printerId: 'no-such-printer',
      dbUrl: DB_URL,
    });
    expect(result).toEqual({ removed: false });
  });
});

describe('touchLastUsed', () => {
  it('sets last_used_at and is monotonic on repeat (>=)', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    setCredential({
      printerId,
      kind: 'moonraker_api_key',
      payload: { apiKey: 'x' },
      dbUrl: DB_URL,
      secret: TEST_SECRET,
    });

    touchLastUsed({ printerId, dbUrl: DB_URL });
    const first = getCredential({ printerId, dbUrl: DB_URL, secret: TEST_SECRET });
    expect(first?.lastUsedAt).toBeInstanceOf(Date);
    const t1 = first!.lastUsedAt!.getTime();

    // Wait long enough for ms-resolution clock to advance.
    await new Promise((r) => setTimeout(r, 5));
    touchLastUsed({ printerId, dbUrl: DB_URL });
    const second = getCredential({ printerId, dbUrl: DB_URL, secret: TEST_SECRET });
    const t2 = second!.lastUsedAt!.getTime();
    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  it('is a no-op when no row exists (does not throw)', () => {
    expect(() =>
      touchLastUsed({ printerId: 'no-such-printer', dbUrl: DB_URL }),
    ).not.toThrow();
  });
});

describe('at-rest opacity', () => {
  it('the stored encrypted_blob does not contain the plaintext payload', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);

    setCredential({
      printerId,
      kind: 'moonraker_api_key',
      payload: { apiKey: 'abc123' },
      dbUrl: DB_URL,
      secret: TEST_SECRET,
    });

    const rows = db()
      .select({ encryptedBlob: forgeTargetCredentials.encryptedBlob })
      .from(forgeTargetCredentials)
      .where(eq(forgeTargetCredentials.printerId, printerId))
      .all();
    expect(rows).toHaveLength(1);
    const buf = Buffer.from(rows[0]!.encryptedBlob as Uint8Array);
    expect(buf.toString('utf8').includes('abc123')).toBe(false);
    expect(buf.toString('binary').includes('abc123')).toBe(false);
  });
});

describe('decrypt safety', () => {
  it('throws when reading with a different secret than the one used to write', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    const secretA = 'a'.repeat(32);
    const secretB = 'b'.repeat(32);

    setCredential({
      printerId,
      kind: 'moonraker_api_key',
      payload: { apiKey: 'mismatched' },
      dbUrl: DB_URL,
      secret: secretA,
    });

    expect(() =>
      getCredential({ printerId, dbUrl: DB_URL, secret: secretB }),
    ).toThrow();
  });
});

describe('kind validation', () => {
  it('throws when kind is not in FORGE_TARGET_CREDENTIAL_KINDS', async () => {
    const userId = await seedUser();
    const printerId = await seedPrinter(userId);
    expect(() =>
      setCredential({
        printerId,
        // Cast through unknown so the runtime check is what fails, not TS.
        kind: 'not-a-real-kind' as unknown as 'moonraker_api_key',
        payload: { apiKey: 'x' },
        dbUrl: DB_URL,
        secret: TEST_SECRET,
      }),
    ).toThrow(/invalid kind not-a-real-kind/);
  });
});
