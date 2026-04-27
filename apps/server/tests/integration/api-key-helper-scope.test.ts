/**
 * isValidApiKeyWithScope helper tests — V2-001-T5
 *
 * Exercises the full stack: real DB + real argon2 verify + scope extraction.
 * No mocks of auth/helpers — imports the implementation directly.
 *
 * Separated from api-key-scope-enforcement.test.ts because that file mocks
 * the helpers module, making it impossible to test the real implementation in
 * the same file.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import argon2 from 'argon2';
import { randomUUID, randomBytes } from 'node:crypto';
import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import { isValidApiKeyWithScope } from '../../src/auth/helpers';

// argon2id is intentionally slow (~1-2s per hash/verify on loaded runners).
// Several tests in this file create keys + verify them, easily exceeding the
// 5s default. Bump the per-test timeout to keep flakes off the suite. (G-CF-2)
vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  process.env.DATABASE_URL = 'file:/tmp/lootgoblin-helper-scope.db';
  resetDbCache();
  await runMigrations('file:/tmp/lootgoblin-helper-scope.db');
  // Warm up argon2 native binding so the first real hash isn't paying JIT cost.
  await argon2.hash('warmup');
});

function makeReq(apiKey?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return new Request('http://local/test', { method: 'POST', headers });
}

describe('isValidApiKeyWithScope — real DB + argon2', () => {
  it('returns { valid: true, scope } for a valid extension_pairing key', async () => {
    const plaintext = `lg_ext_${randomBytes(12).toString('base64url')}`;
    const id = randomUUID();
    const db = getDb() as any;
    await db.insert(schema.apiKeys).values({
      id,
      name: 'test-ext-key',
      scope: 'extension_pairing',
      keyHash: await argon2.hash(plaintext),
      expiresAt: null,
    });

    const result = await isValidApiKeyWithScope(makeReq(plaintext), ['extension_pairing']);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.scope).toBe('extension_pairing');
      expect(result.keyId).toBe(id);
    }
  });

  it('returns wrong-scope for courier_pairing key on extension_pairing route', async () => {
    const plaintext = `lg_cou_${randomBytes(12).toString('base64url')}`;
    const id = randomUUID();
    const db = getDb() as any;
    await db.insert(schema.apiKeys).values({
      id,
      name: 'test-courier-key',
      scope: 'courier_pairing',
      keyHash: await argon2.hash(plaintext),
      expiresAt: null,
    });

    const result = await isValidApiKeyWithScope(makeReq(plaintext), ['extension_pairing']);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('wrong-scope');
      if (result.reason === 'wrong-scope') {
        expect(result.actual).toBe('courier_pairing');
        expect(result.expected).toEqual(['extension_pairing']);
      }
    }
  });

  it('returns wrong-scope for programmatic key on extension_pairing route', async () => {
    const plaintext = `lg_api_${randomBytes(12).toString('base64url')}`;
    const id = randomUUID();
    const db = getDb() as any;
    await db.insert(schema.apiKeys).values({
      id,
      name: 'test-prog-key',
      scope: 'programmatic',
      keyHash: await argon2.hash(plaintext),
      expiresAt: null,
    });

    const result = await isValidApiKeyWithScope(makeReq(plaintext), ['extension_pairing']);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('wrong-scope');
    }
  });

  it('returns expired for a key past expiresAt', async () => {
    const plaintext = `lg_ext_${randomBytes(12).toString('base64url')}`;
    const id = randomUUID();
    const db = getDb() as any;
    const pastDate = new Date(Date.now() - 1000); // 1 second ago
    await db.insert(schema.apiKeys).values({
      id,
      name: 'test-expired-key',
      scope: 'extension_pairing',
      keyHash: await argon2.hash(plaintext),
      expiresAt: pastDate,
    });

    const result = await isValidApiKeyWithScope(makeReq(plaintext), ['extension_pairing']);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('expired');
    }
  });

  it('returns missing when no x-api-key header', async () => {
    const result = await isValidApiKeyWithScope(makeReq(undefined), ['extension_pairing']);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('missing');
    }
  });

  it('returns invalid for a key that does not exist in DB', async () => {
    const plaintext = `lg_ext_${randomBytes(12).toString('base64url')}`;
    const result = await isValidApiKeyWithScope(makeReq(plaintext), ['extension_pairing']);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('invalid');
    }
  });

  it('extension_pairing key is also valid for a route accepting multiple scopes', async () => {
    const plaintext = `lg_ext_${randomBytes(12).toString('base64url')}`;
    const id = randomUUID();
    const db = getDb() as any;
    await db.insert(schema.apiKeys).values({
      id,
      name: 'test-multi-scope-key',
      scope: 'extension_pairing',
      keyHash: await argon2.hash(plaintext),
      expiresAt: null,
    });

    const result = await isValidApiKeyWithScope(makeReq(plaintext), [
      'extension_pairing',
      'courier_pairing',
    ]);
    expect(result.valid).toBe(true);
  });
});
