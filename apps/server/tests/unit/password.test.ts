/**
 * Tests for argon2id password helpers — V2-001-T4
 *
 * Validates that the custom hasher/verifier wired into BetterAuth's
 * emailAndPassword plugin produces and checks argon2id hashes correctly.
 */

import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password';

describe('hashPassword', () => {
  it('produces an argon2id hash (starts with $argon2id$)', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('produces a different hash each call (salt is random)', async () => {
    const pw = 'same-password-every-time';
    const hash1 = await hashPassword(pw);
    const hash2 = await hashPassword(pw);
    expect(hash1).not.toBe(hash2);
  });
});

describe('verifyPassword', () => {
  it('returns true for the correct password', async () => {
    const pw = 'my-secure-password-123!';
    const hash = await hashPassword(pw);
    expect(await verifyPassword({ password: pw, hash })).toBe(true);
  });

  it('returns false for the wrong password', async () => {
    const hash = await hashPassword('correct-password');
    expect(await verifyPassword({ password: 'wrong-password', hash })).toBe(false);
  });

  it('returns false for a malformed / empty hash string', async () => {
    expect(await verifyPassword({ password: 'any', hash: '' })).toBe(false);
    expect(await verifyPassword({ password: 'any', hash: 'not-a-hash' })).toBe(false);
    expect(await verifyPassword({ password: 'any', hash: '$argon2d$truncated' })).toBe(false);
  });

  it('returns false for empty password against a valid hash', async () => {
    const hash = await hashPassword('real-password');
    expect(await verifyPassword({ password: '', hash })).toBe(false);
  });
});
