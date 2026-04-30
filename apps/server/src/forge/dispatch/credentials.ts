/**
 * credentials.ts — V2-005d-a T_da2
 *
 * CRUD layer over `forge_target_credentials`. Encrypts payloads on write
 * (AES-256-GCM via apps/server/src/crypto.ts) and decrypts on read; callers
 * never see ciphertext.
 *
 * One row per printer (UNIQUE on `printer_id`). setCredential UPSERTs against
 * that constraint: a re-write for the same printer rotates the encrypted blob
 * + kind + label in place, preserving the row id and createdAt.
 *
 * Storage idiom matches V2-003 source-credentials (route.ts:57 +
 * source-auth/_shared.ts:147,375): encrypt() returns base64 string, we store
 * its UTF-8 bytes via Buffer.from(...) into the BLOB column, and on read we
 * Buffer-wrap the column value and `.toString('utf8')` to recover the base64
 * string before passing to decrypt().
 *
 * Intentionally silent — no log lines reference payload, plaintext, or the
 * encrypted blob, so credentials cannot leak via stdout/stderr. Decrypt
 * errors propagate to the caller (T_da6 worker / T_da3 routes) for handling
 * rather than being swallowed here.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { getServerDb } from '@/db/client';
import { encrypt, decrypt } from '@/crypto';
import {
  forgeTargetCredentials,
  FORGE_TARGET_CREDENTIAL_KINDS,
  type ForgeTargetCredentialKind,
} from '@/db/schema.forge';

export interface DecryptedCredential<P = unknown> {
  id: string;
  printerId: string;
  kind: ForgeTargetCredentialKind;
  payload: P;
  label: string | null;
  lastUsedAt: Date | null;
}

export interface SetCredentialInput {
  printerId: string;
  kind: ForgeTargetCredentialKind;
  payload: unknown;
  label?: string;
  dbUrl?: string;
  /** Override LOOTGOBLIN_SECRET (used by tests). */
  secret?: string;
}

function resolveSecret(override: string | undefined): string {
  const secret = override ?? process.env.LOOTGOBLIN_SECRET;
  if (!secret) {
    throw new Error('forge.target-creds: LOOTGOBLIN_SECRET is not set');
  }
  if (secret.length < 32) {
    throw new Error('forge.target-creds: LOOTGOBLIN_SECRET must be at least 32 chars');
  }
  return secret;
}

export function setCredential(opts: SetCredentialInput): { id: string } {
  const secret = resolveSecret(opts.secret);

  if (!(FORGE_TARGET_CREDENTIAL_KINDS as readonly string[]).includes(opts.kind)) {
    throw new Error(`forge.target-creds: invalid kind ${opts.kind}`);
  }

  const plaintext = JSON.stringify(opts.payload);
  const encryptedBlob = Buffer.from(encrypt(plaintext, secret));
  const label = opts.label ?? null;

  const db = getServerDb(opts.dbUrl);
  const now = new Date();

  db.insert(forgeTargetCredentials)
    .values({
      id: randomUUID(),
      printerId: opts.printerId,
      kind: opts.kind,
      encryptedBlob,
      label,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: forgeTargetCredentials.printerId,
      set: {
        kind: opts.kind,
        encryptedBlob,
        label,
        updatedAt: now,
      },
    })
    .run();

  // ON CONFLICT DO UPDATE doesn't return the row in better-sqlite3 Drizzle;
  // select-after-upsert to fetch the (possibly pre-existing) id.
  const rows = db
    .select({ id: forgeTargetCredentials.id })
    .from(forgeTargetCredentials)
    .where(eq(forgeTargetCredentials.printerId, opts.printerId))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) {
    // Unreachable: we just upserted. Defensive guard for the type narrow.
    throw new Error(
      `forge.target-creds: row missing post-upsert for printerId=${opts.printerId}`,
    );
  }
  return { id: row.id };
}

export function getCredential<P = unknown>(opts: {
  printerId: string;
  dbUrl?: string;
  secret?: string;
}): DecryptedCredential<P> | null {
  const secret = resolveSecret(opts.secret);
  const db = getServerDb(opts.dbUrl);

  const rows = db
    .select()
    .from(forgeTargetCredentials)
    .where(eq(forgeTargetCredentials.printerId, opts.printerId))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) return null;

  // Stored as Buffer.from(base64-string); recover by Buffer-wrapping the
  // column value and decoding as UTF-8 (it's ASCII base64 either way).
  const buf = Buffer.from(row.encryptedBlob as Uint8Array);
  const plaintext = decrypt(buf.toString('utf8'), secret);
  const payload = JSON.parse(plaintext) as P;

  return {
    id: row.id,
    printerId: row.printerId,
    kind: row.kind as ForgeTargetCredentialKind,
    payload,
    label: row.label,
    lastUsedAt: row.lastUsedAt,
  };
}

export function removeCredential(opts: {
  printerId: string;
  dbUrl?: string;
}): { removed: boolean } {
  const db = getServerDb(opts.dbUrl);

  const existing = db
    .select({ id: forgeTargetCredentials.id })
    .from(forgeTargetCredentials)
    .where(eq(forgeTargetCredentials.printerId, opts.printerId))
    .limit(1)
    .all();
  if (existing.length === 0) {
    return { removed: false };
  }

  db.delete(forgeTargetCredentials)
    .where(eq(forgeTargetCredentials.printerId, opts.printerId))
    .run();

  return { removed: true };
}

export function touchLastUsed(opts: {
  printerId: string;
  dbUrl?: string;
}): void {
  const db = getServerDb(opts.dbUrl);
  // Silent no-op when no row exists — UPDATE with no matching row is a 0-row
  // change in sqlite, which is exactly the contract we want.
  db.update(forgeTargetCredentials)
    .set({ lastUsedAt: new Date() })
    .where(eq(forgeTargetCredentials.printerId, opts.printerId))
    .run();
}
