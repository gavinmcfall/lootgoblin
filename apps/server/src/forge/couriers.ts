/**
 * Courier domain module — V2-006a-T4
 *
 * Pure-ish domain functions for the two Courier pairing endpoints:
 *
 *   mintCourierPairToken  — admin-mints a one-time pair token (JWT-like, Ed25519)
 *   exchangeCourierPairToken — Courier exchanges the token for a long-lived API key
 *
 * Both functions accept injectable `now` and `nonce` parameters so tests can
 * exercise expiry and replay scenarios deterministically without real-clock or
 * real-random dependencies.
 *
 * Key-minting follows the exact same pattern as the extension pairing flow in
 * /api/v1/pair/approve/route.ts: argon2 hash of a prefixed random value, stored
 * in the `api_keys` table with scope `courier_pairing`. The plaintext key is
 * returned once and never persisted. The stored `id` (UUID) is what gets written
 * to `agents.pair_credential_ref`, matching what `authenticateCourier` resolves.
 *
 * Safety ordering (criterion 9):
 *   1. Create agent row.
 *   2. Mint API key (hash + insert).
 *   3. Update agent.pairCredentialRef = keyId.
 *   4. Insert courier_pair_nonces row (consumes the nonce).
 *
 * Steps 3 and 4 are the "point of no return": if step 3 fails the key exists
 * but is not referenced, so the nonce is NOT consumed and the caller can retry
 * with the same token. If step 4 fails the key and agent are already linked;
 * the nonce is NOT consumed and the caller can retry (idempotent as long as the
 * same token is used — but the agent+key pair from the first attempt will become
 * orphaned; a future cleanup job can GC unreferenced agents). Step 4 success
 * gates the 200 response.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { signPairToken, verifyPairToken, getInstanceIdentityPublic } from '@/identity';
import { API_KEY_SCOPES } from '@/auth/scopes';
import { createAgent, updateAgent } from './agents';
import { logger } from '@/logger';
import type { PairTokenPayload } from '@/identity';
import type { PrinterReachableStatus } from '@/db/schema.forge';

// ---------------------------------------------------------------------------
// SERVER_VERSION — shared with heartbeat (T5) and future endpoints
// ---------------------------------------------------------------------------

/**
 * Application version string. Read from the npm_package_version env var set
 * by Node when the process is started via npm scripts, with a fallback to
 * a static sentinel for non-npm contexts (Docker CMD, unit tests, etc.).
 */
export const SERVER_VERSION: string = process.env.npm_package_version ?? '2.0.0';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MintPairTokenOptions {
  /** Injectable clock — defaults to Date.now(). Used by tests for determinism. */
  now?: number;
  /** Injectable nonce — defaults to randomBytes(16).toString('hex'). */
  nonce?: string;
}

export interface MintPairTokenResult {
  token: string;
  expires_at: number;
}

export interface ExchangePairTokenOptions {
  name?: string;
  reachable_lan_hint?: string | null;
  /** Injectable clock — defaults to Date.now(). */
  now?: number;
  /** DB URL override for test isolation. */
  dbUrl?: string;
}

export type ExchangePairTokenResult =
  | { ok: true; api_key: string; agent_id: string; instance_id: string; server_version: string }
  | { ok: false; status: 400; error: string; reason: string }
  | { ok: false; status: 409; error: string }
  | { ok: false; status: 500; error: string; reason?: string };

// ---------------------------------------------------------------------------
// mintCourierPairToken
// ---------------------------------------------------------------------------

/**
 * Mint a one-time Courier pair token.
 *
 * The token is signed with the instance's Ed25519 private key (same mechanism
 * as extension pairing). It carries kind='courier' so the exchange endpoint can
 * reject extension tokens.
 *
 * Returns null if the instance identity has not been bootstrapped yet.
 */
export async function mintCourierPairToken(
  opts: MintPairTokenOptions = {},
): Promise<MintPairTokenResult | null> {
  const issuedAt = opts.now ?? Date.now();
  const expiresAt = issuedAt + 30 * 60 * 1000; // 30 minutes
  const nonce = opts.nonce ?? randomBytes(16).toString('hex');

  const token = await signPairToken({
    kind: 'courier',
    issued_at: issuedAt,
    expires_at: expiresAt,
    nonce,
    purpose: 'courier-pair',
  });

  if (!token) return null;

  return { token, expires_at: expiresAt };
}

// ---------------------------------------------------------------------------
// exchangeCourierPairToken
// ---------------------------------------------------------------------------

/**
 * Exchange a valid pair token for a long-lived `courier_pairing` API key.
 *
 * Steps (see module header for the safety-ordering rationale):
 *   1. Verify token signature + expiry.
 *   2. Enforce kind === 'courier'.
 *   3. Check nonce replay guard.
 *   4. Create a new `courier` Agent.
 *   5. Mint a `courier_pairing` API key.
 *   6. Link agent ← key (updateAgent).
 *   7. Consume the nonce (insert courier_pair_nonces).
 *   8. Return { api_key, agent_id, instance_id, server_version }.
 *
 * Safety: nonce is only consumed (step 7) AFTER the agent↔key link is
 * committed (step 6). If step 6 fails the nonce is not consumed and the
 * caller can retry with the same token.
 */
export async function exchangeCourierPairToken(
  token: string,
  opts: ExchangePairTokenOptions = {},
): Promise<ExchangePairTokenResult> {
  const now = opts.now ?? Date.now();
  const db = getServerDb(opts.dbUrl);

  // --- Step 1: verify token ---
  const payload: PairTokenPayload | null = await verifyPairToken(token);
  if (!payload) {
    return {
      ok: false,
      status: 400,
      error: 'invalid-pair-token',
      // verifyPairToken returns null for both bad-signature and expired — cannot distinguish.
      reason: 'invalid-or-expired',
    };
  }

  // --- Step 2: enforce courier kind ---
  if (payload.kind !== 'courier') {
    return {
      ok: false,
      status: 400,
      error: 'invalid-pair-token',
      reason: 'wrong-kind',
    };
  }

  // --- Step 3: replay guard ---
  const existing = await db
    .select({ nonce: schema.courierPairNonces.nonce })
    .from(schema.courierPairNonces)
    .where(eq(schema.courierPairNonces.nonce, payload.nonce))
    .limit(1);

  if (existing.length > 0) {
    return { ok: false, status: 409, error: 'pair-token-already-used' };
  }

  // --- Step 4: create Courier agent ---
  const agentResult = await createAgent(
    { kind: 'courier', reachableLanHint: opts.reachable_lan_hint ?? null },
    { dbUrl: opts.dbUrl, now: new Date(now) },
  );
  if (!agentResult.ok) {
    return {
      ok: false,
      status: 500,
      error: 'internal',
      reason: `createAgent failed: ${agentResult.reason}`,
    };
  }
  const agentId = agentResult.agentId;

  // --- Step 5: mint courier_pairing API key ---
  const scopeConfig = API_KEY_SCOPES.courier_pairing;
  const plaintext = `${scopeConfig.prefix}${randomBytes(24).toString('base64url')}`;
  const keyId = randomUUID();
  const expiresAt =
    scopeConfig.defaultExpirationDays !== null
      ? new Date(now + scopeConfig.defaultExpirationDays * 24 * 60 * 60 * 1000)
      : null;

  try {
    await (db as any).insert(schema.apiKeys).values({
      id: keyId,
      name: opts.name ?? 'courier',
      scope: 'courier_pairing',
      keyHash: await argon2.hash(plaintext),
      expiresAt,
    });
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: 'internal',
      reason: `key-mint failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // --- Step 6: link agent ← key (MUST succeed before nonce is consumed) ---
  const updateResult = await updateAgent(
    { id: agentId, pairCredentialRef: keyId },
    { dbUrl: opts.dbUrl, now: new Date(now) },
  );
  if (!updateResult.ok) {
    // Key exists but agent↔key link failed. Nonce is NOT consumed so the caller
    // can retry with the same token. The orphaned key will be GC'd by a future
    // cleanup job (the key is not referenced by any agent, so authenticateCourier
    // will return INVALID_API_KEY for it — it cannot be used to authenticate).
    return {
      ok: false,
      status: 500,
      error: 'internal',
      reason: `updateAgent failed: ${updateResult.reason}`,
    };
  }

  // --- Step 7: consume nonce (only reached if steps 1–6 succeeded) ---
  await db.insert(schema.courierPairNonces).values({
    nonce: payload.nonce,
    consumedAt: new Date(now),
    agentId,
  });

  // --- Step 8: resolve instance identity for response ---
  const identity = await getInstanceIdentityPublic();
  if (!identity) {
    // Identity not bootstrapped — this is a server misconfiguration but should
    // never happen in production (instrumentation.ts bootstraps it on startup).
    // Nonce is already consumed; return 500 so the caller retries with a new token.
    return { ok: false, status: 500, error: 'internal', reason: 'identity-not-bootstrapped' };
  }

  return {
    ok: true,
    api_key: plaintext,
    agent_id: agentId,
    instance_id: identity.id,
    server_version: SERVER_VERSION,
  };
}

// ---------------------------------------------------------------------------
// recordReachability — V2-006a-T5
// ---------------------------------------------------------------------------

export interface ReachabilityEntry {
  printer_id: string;
  reachable_status: PrinterReachableStatus;
  detail?: string;
}

/**
 * Update `printer_reachable_via` rows for a given agent.
 *
 * For each entry, UPDATEs the row WHERE printer_id = entry.printer_id AND
 * agent_id = agentId. If no row exists (printer not assigned to this agent),
 * the entry is silently ignored — the agent cannot self-assign printers.
 *
 * @param agentId   The Courier agent performing the reachability report.
 * @param entries   The probe results to persist.
 * @param now       Injectable clock for deterministic tests.
 * @param dbUrl     DB override for test isolation.
 */
export function recordReachability(
  agentId: string,
  entries: ReachabilityEntry[],
  now: Date,
  dbUrl?: string,
): void {
  if (entries.length === 0) return;

  const db = getServerDb(dbUrl);

  for (const entry of entries) {
    const result = db
      .update(schema.printerReachableVia)
      .set({
        reachableStatus: entry.reachable_status,
        lastCheckedAt: now,
        detail: entry.detail ?? null,
      })
      .where(
        and(
          eq(schema.printerReachableVia.printerId, entry.printer_id),
          eq(schema.printerReachableVia.agentId, agentId),
        ),
      )
      .run();

    const changes = (result as unknown as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      logger.info(
        { agentId, printerId: entry.printer_id },
        'recordReachability: printer not assigned to this agent — ignoring entry',
      );
    }
  }
}
