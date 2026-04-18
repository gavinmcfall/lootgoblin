import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../../src/crypto';

const KEY = 'a'.repeat(32);

describe('crypto', () => {
  it('encrypts and decrypts round-trip', () => {
    const plain = 'hello world';
    const cipher = encrypt(plain, KEY);
    expect(cipher).not.toBe(plain);
    expect(decrypt(cipher, KEY)).toBe(plain);
  });

  it('produces different ciphertexts for same plaintext (random nonce)', () => {
    const a = encrypt('x', KEY);
    const b = encrypt('x', KEY);
    expect(a).not.toBe(b);
  });

  it('fails to decrypt with wrong key', () => {
    const cipher = encrypt('secret', KEY);
    expect(() => decrypt(cipher, 'b'.repeat(32))).toThrow();
  });

  it('rejects key shorter than 32 bytes', () => {
    expect(() => encrypt('x', 'short')).toThrow(/32/);
  });
});
