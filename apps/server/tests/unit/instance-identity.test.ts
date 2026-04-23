/**
 * Unit tests for the instance identity module — V2-001-T6
 *
 * Exercises:
 *   - Key generation: public key is 32 bytes, correctly base64url-encoded.
 *   - Sign + verify round-trip: verifyPairToken returns the original payload.
 *   - Signature tampering: flipping a byte in the sig returns null.
 *   - Expired tokens: expires_at < Date.now() returns null.
 *   - Wrong-key signatures: signed with a different keypair, verified against
 *     the instance public key → null.
 *
 * These tests wire up a real in-memory DB so bootstrapInstanceIdentity and the
 * DB-backed sign/verify helpers work end-to-end without mocking.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { runMigrations, resetDbCache } from '../../src/db/client';
import {
  generateEd25519Keypair,
  bootstrapInstanceIdentity,
  signPairToken,
  verifyPairToken,
} from '../../src/identity/index';

const DB_PATH = '/tmp/lootgoblin-unit-identity.db';

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${DB_PATH}`;
  resetDbCache();
  await runMigrations(`file:${DB_PATH}`);
  await bootstrapInstanceIdentity('test-instance');
});

// ---------------------------------------------------------------------------
// generateEd25519Keypair
// ---------------------------------------------------------------------------

describe('generateEd25519Keypair', () => {
  it('returns a public key that decodes to exactly 32 bytes', () => {
    const { publicKey } = generateEd25519Keypair();
    const bytes = Buffer.from(publicKey, 'base64url');
    expect(bytes.byteLength).toBe(32);
  });

  it('returns a private key that decodes to exactly 32 bytes', () => {
    const { privateKey } = generateEd25519Keypair();
    const bytes = Buffer.from(privateKey, 'base64url');
    expect(bytes.byteLength).toBe(32);
  });

  it('generates a different keypair on each call', () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it('public key is valid base64url (no padding, url-safe chars)', () => {
    const { publicKey } = generateEd25519Keypair();
    // base64url uses A-Z, a-z, 0-9, -, _ and no padding
    expect(publicKey).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(publicKey).not.toContain('=');
    expect(publicKey).not.toContain('+');
    expect(publicKey).not.toContain('/');
  });
});

// ---------------------------------------------------------------------------
// signPairToken + verifyPairToken round-trip
// ---------------------------------------------------------------------------

function makePayload(overrides: Partial<{
  kind: 'extension' | 'courier';
  issued_at: number;
  expires_at: number;
  nonce: string;
  purpose: string;
}> = {}) {
  const now = Date.now();
  return {
    kind: 'extension' as const,
    issued_at: now,
    expires_at: now + 60_000, // 1 minute from now
    nonce: randomBytes(16).toString('base64url'),
    ...overrides,
  };
}

describe('signPairToken + verifyPairToken', () => {
  it('round-trip: verifyPairToken returns the original payload', async () => {
    const payload = makePayload({ purpose: 'test-roundtrip' });
    const token = await signPairToken(payload);
    expect(typeof token).toBe('string');
    expect(token).not.toBeNull();

    const decoded = await verifyPairToken(token!);
    expect(decoded).not.toBeNull();
    expect(decoded!.kind).toBe(payload.kind);
    expect(decoded!.issued_at).toBe(payload.issued_at);
    expect(decoded!.expires_at).toBe(payload.expires_at);
    expect(decoded!.nonce).toBe(payload.nonce);
    expect(decoded!.purpose).toBe(payload.purpose);
  });

  it('round-trip with courier kind', async () => {
    const payload = makePayload({ kind: 'courier' });
    const token = await signPairToken(payload);
    const decoded = await verifyPairToken(token!);
    expect(decoded).not.toBeNull();
    expect(decoded!.kind).toBe('courier');
  });

  it('round-trip with optional purpose absent', async () => {
    const { purpose: _, ...payloadNoPurpose } = makePayload({ purpose: 'drop-me' });
    const token = await signPairToken(payloadNoPurpose as any);
    const decoded = await verifyPairToken(token!);
    expect(decoded).not.toBeNull();
    expect(decoded!.purpose).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Signature tampering
// ---------------------------------------------------------------------------

describe('verifyPairToken — tamper detection', () => {
  it('returns null when a byte in the signature is flipped', async () => {
    const token = await signPairToken(makePayload());
    expect(token).not.toBeNull();

    // Token format: <payloadB64>.<sigB64>
    const dotIdx = token!.lastIndexOf('.');
    const payloadPart = token!.slice(0, dotIdx);
    const sigPart = token!.slice(dotIdx + 1);

    // Decode sig, flip the first byte, re-encode.
    const sigBytes = Buffer.from(sigPart, 'base64url');
    sigBytes[0] ^= 0xff;
    const tamperedSig = sigBytes.toString('base64url');

    const tampered = `${payloadPart}.${tamperedSig}`;
    const result = await verifyPairToken(tampered);
    expect(result).toBeNull();
  });

  it('returns null when the payload is modified (different nonce)', async () => {
    const token = await signPairToken(makePayload());
    expect(token).not.toBeNull();

    // Replace the payload segment with a re-encoded different payload.
    const dotIdx = token!.lastIndexOf('.');
    const sigPart = token!.slice(dotIdx + 1);

    const altPayload = makePayload({ nonce: 'tampered-nonce' });
    const altPayloadB64 = Buffer.from(JSON.stringify(altPayload), 'utf8').toString('base64url');

    const tampered = `${altPayloadB64}.${sigPart}`;
    const result = await verifyPairToken(tampered);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

describe('verifyPairToken — expiry', () => {
  it('returns null for a token with expires_at in the past', async () => {
    const expired = makePayload({ expires_at: Date.now() - 1_000 });
    const token = await signPairToken(expired);
    expect(token).not.toBeNull();

    const result = await verifyPairToken(token!);
    expect(result).toBeNull();
  });

  it('returns the payload for a token that expires far in the future', async () => {
    const future = makePayload({ expires_at: Date.now() + 3_600_000 });
    const token = await signPairToken(future);
    const result = await verifyPairToken(token!);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wrong-key verification
// ---------------------------------------------------------------------------

describe('verifyPairToken — wrong-key rejection', () => {
  it('returns null when signature was made with a different keypair', async () => {
    const { getDb, schema, resetDbCache: resetDb, runMigrations: migrate } = await import('../../src/db/client');
    const { bootstrapInstanceIdentity: bootstrap, signPairToken: sign2 } = await import('../../src/identity/index');

    // Spin up a second DB with a fresh identity.
    const altDb = '/tmp/lootgoblin-unit-identity-alt.db';
    process.env.DATABASE_URL = `file:${altDb}`;
    resetDb();
    await migrate(`file:${altDb}`);
    await bootstrap('alt-instance');

    // Sign with the alt identity.
    const altToken = await sign2(makePayload());
    expect(altToken).not.toBeNull();

    // Switch back to the original identity DB.
    process.env.DATABASE_URL = `file:${DB_PATH}`;
    resetDb();
    // Re-run migrations so the original DB cache is re-initialised on next use.
    await migrate(`file:${DB_PATH}`);

    // Verify the alt-signed token against the original instance's public key → null.
    const result = await verifyPairToken(altToken!);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Malformed tokens
// ---------------------------------------------------------------------------

describe('verifyPairToken — malformed tokens', () => {
  it('returns null for an empty string', async () => {
    expect(await verifyPairToken('')).toBeNull();
  });

  it('returns null for a token with no dot separator', async () => {
    expect(await verifyPairToken('nodot')).toBeNull();
  });

  it('returns null for a token with invalid base64url payload', async () => {
    expect(await verifyPairToken('not-json-at-all.abc123')).toBeNull();
  });
});
