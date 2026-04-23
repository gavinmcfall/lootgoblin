/**
 * Instance Identity — V2-001-T6
 *
 * Provides:
 *   generateEd25519Keypair       — low-level key generation (exported for bootstrap + tests)
 *   bootstrapInstanceIdentity    — idempotent first-boot row creation (called from instrumentation.ts)
 *   getInstanceIdentityPublic    — returns the public projection (safe to expose on endpoints)
 *   signPairToken                — signs a PairTokenPayload with the instance private key
 *   verifyPairToken              — verifies a token signed by this instance
 *
 * Key encoding (both public and private):
 *   Ed25519 is generated via Node's `crypto.generateKeyPairSync('ed25519')`.
 *   Public key: exported as raw 32-byte buffer → base64url string.
 *   Private key: exported as JWK, the `d` field is already the raw 32-byte
 *     private scalar in base64url — no DER stripping needed. We store this
 *     `d` value directly so storage is symmetric (32 bytes base64url on both sides).
 *
 * Token format:
 *   <base64url(JSON payload)>.<base64url(Ed25519 signature)>
 *   The payload JSON is canonicalized via JSON.stringify with sorted keys before
 *   signing. This is a minimal custom format — not JWT — because we control both
 *   sides (server signs, Courier/extension verifies using the public endpoint).
 *   Future work may swap to compact JWS/EdDSA if we need interop with third-party
 *   verifiers.
 *
 * Single-process assumption:
 *   The bootstrap guard (check row → insert) is not race-safe across concurrent
 *   processes. In v2 we run a single Node.js process per container and call
 *   bootstrap once from instrumentation.ts before any request handlers start.
 *   If multiple replicas ever share a database, the UNIQUE constraint on
 *   `singleton` ensures at most one row is persisted — the second INSERT will
 *   throw and the second process can re-read the existing row.
 *
 * SECURITY:
 *   - private_key is NEVER returned from getInstanceIdentityPublic().
 *   - private_key is NEVER logged.
 *   - InstanceIdentityFull (the full row type) is NOT exported from this module.
 *     Only InstanceIdentityPublic is exported.
 */

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import os from 'node:os';
import { getDb, schema } from '@/db/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Public projection — safe to expose on endpoints and pass to consumers. */
export interface InstanceIdentityPublic {
  id: string;
  public_key: string;
  name: string | null;
  created_at: Date | null;
}

/**
 * Full DB row type — internal only. NOT exported.
 * Using a private interface rather than the Drizzle inferred type to keep
 * the private_key field away from module consumers.
 */
interface InstanceIdentityFull extends InstanceIdentityPublic {
  private_key: string;
}

/** Payload for a pair token (extension or Courier pairing). */
export interface PairTokenPayload {
  kind: 'extension' | 'courier';
  /** Unix milliseconds. */
  issued_at: number;
  /** Unix milliseconds. Must be > now for verifyPairToken to accept. */
  expires_at: number;
  /** Random nonce — ensures single-use property downstream. */
  nonce: string;
  /** Free-form purpose label (optional). */
  purpose?: string;
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

export interface Ed25519Keypair {
  /** Raw 32-byte public key, base64url-encoded. */
  publicKey: string;
  /** Raw 32-byte private scalar (JWK `d`), base64url-encoded. */
  privateKey: string;
}

/**
 * Generate a new Ed25519 keypair.
 *
 * Encoding rationale:
 *   - Public key: Node exports Ed25519 public keys as 44-byte DER (SubjectPublicKeyInfo).
 *     The raw key material is the last 32 bytes. We extract those and base64url-encode them.
 *   - Private key: We export as JWK and take the `d` field, which Node already provides
 *     as a base64url string of the raw 32-byte private scalar. No manual DER stripping needed.
 *
 * Both fields decode to exactly 32 bytes.
 */
export function generateEd25519Keypair(): Ed25519Keypair {
  const { publicKey: pubKeyObj, privateKey: privKeyObj } = generateKeyPairSync('ed25519');

  // Public key: DER (SubjectPublicKeyInfo) is 12-byte header + 32-byte key.
  // We export as DER and take the last 32 bytes.
  const pubDer = pubKeyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  const publicKey = pubDer.subarray(pubDer.length - 32).toString('base64url');

  // Private key: JWK `d` is the raw 32-byte scalar in base64url — use it directly.
  const privJwk = privKeyObj.export({ format: 'jwk' }) as { d: string };
  const privateKey = privJwk.d;

  return { publicKey, privateKey };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Ensures exactly one instance_identity row exists in the database.
 * Safe to call on every boot — is a no-op if the row already exists.
 *
 * Called from instrumentation.ts after migrations have run.
 *
 * Single-process assumption: see module header. The UNIQUE constraint on
 * `singleton` is the last line of defense if the process-level guard races.
 *
 * @param instanceName Optional override for the instance name. Falls back to
 *   os.hostname(). Pass the resolved INSTANCE_NAME from configResolver.
 */
export async function bootstrapInstanceIdentity(instanceName?: string | null): Promise<void> {
  const db = getDb() as any;
  const existing = await db.select().from(schema.instanceIdentity).limit(1);
  if (existing.length > 0) return;

  const id = crypto.randomUUID();
  const { publicKey, privateKey } = generateEd25519Keypair();
  const name = instanceName ?? os.hostname();

  await db.insert(schema.instanceIdentity).values({
    id,
    singleton: 1,
    public_key: publicKey,
    private_key: privateKey,
    name,
  });
}

// ---------------------------------------------------------------------------
// DB accessors
// ---------------------------------------------------------------------------

/** Returns the full DB row. Internal only — not exported. */
async function getInstanceIdentityFull(): Promise<InstanceIdentityFull | null> {
  const db = getDb() as any;
  const rows = await db.select().from(schema.instanceIdentity).limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    public_key: row.public_key,
    private_key: row.private_key,
    name: row.name ?? null,
    created_at: row.created_at ?? null,
  };
}

/**
 * Returns the public projection of the instance identity row.
 * Returns null if the row has not been bootstrapped yet.
 */
export async function getInstanceIdentityPublic(): Promise<InstanceIdentityPublic | null> {
  const full = await getInstanceIdentityFull();
  if (!full) return null;
  return {
    id: full.id,
    public_key: full.public_key,
    name: full.name,
    created_at: full.created_at,
  };
}

// ---------------------------------------------------------------------------
// Signing helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalize a PairTokenPayload to a deterministic JSON string.
 * Keys are sorted so the byte representation is stable across runtimes.
 */
function canonicalize(payload: PairTokenPayload): string {
  const raw = payload as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(raw).sort()) {
    ordered[key] = raw[key];
  }
  return JSON.stringify(ordered);
}

/**
 * Sign a PairTokenPayload with the instance's Ed25519 private key.
 *
 * Token format: <base64url(JSON)>.<base64url(signature)>
 *
 * The JSON is the canonicalized payload. The signature is computed over the
 * raw UTF-8 bytes of the JSON string.
 *
 * Returns null if the instance identity has not been bootstrapped yet.
 *
 * @throws if the identity row is missing (caller should bootstrap first).
 */
export async function signPairToken(payload: PairTokenPayload): Promise<string | null> {
  const identity = await getInstanceIdentityFull();
  if (!identity) return null;

  const json = canonicalize(payload);
  const payloadB64 = Buffer.from(json, 'utf8').toString('base64url');

  // Reconstruct the private key object from the raw 32-byte scalar stored in DB.
  // We convert from base64url `d` back to a JWK to import via createPrivateKey.
  const privKeyObj = createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: identity.private_key,
      // x is the public key — required in JWK. Derive from stored public_key.
      x: identity.public_key,
    },
    format: 'jwk',
  });

  const sigBuffer = sign(null, Buffer.from(json, 'utf8'), privKeyObj);
  const sigB64 = sigBuffer.toString('base64url');

  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a pair token signed by this instance.
 *
 * Checks:
 *   1. Token is well-formed (two base64url segments separated by '.').
 *   2. Payload decodes to valid JSON with the expected fields.
 *   3. Ed25519 signature is valid against the instance's public key.
 *   4. expires_at is in the future.
 *
 * Returns the decoded payload on success, null on any failure.
 * Does NOT throw — all errors return null.
 */
export async function verifyPairToken(token: string): Promise<PairTokenPayload | null> {
  try {
    const dotIdx = token.lastIndexOf('.');
    if (dotIdx < 1) return null;

    const payloadB64 = token.slice(0, dotIdx);
    const sigB64 = token.slice(dotIdx + 1);

    const jsonStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const sigBuffer = Buffer.from(sigB64, 'base64url');

    // Parse payload before verifying signature so we can return typed data on success.
    let payload: PairTokenPayload;
    try {
      payload = JSON.parse(jsonStr) as PairTokenPayload;
    } catch {
      return null;
    }

    // Validate required fields.
    if (
      typeof payload.kind !== 'string' ||
      typeof payload.issued_at !== 'number' ||
      typeof payload.expires_at !== 'number' ||
      typeof payload.nonce !== 'string'
    ) {
      return null;
    }

    // Expiry check.
    if (payload.expires_at < Date.now()) return null;

    // Signature check against the instance's stored public key.
    const identity = await getInstanceIdentityPublic();
    if (!identity) return null;

    // Reconstruct the public key object from stored base64url raw bytes.
    const pubKeyObj = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: identity.public_key,
      },
      format: 'jwk',
    });

    const valid = verify(null, Buffer.from(jsonStr, 'utf8'), pubKeyObj, sigBuffer);
    if (!valid) return null;

    return payload;
  } catch {
    return null;
  }
}
