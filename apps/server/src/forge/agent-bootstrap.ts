/**
 * Forge Agent bootstrap — V2-005a-T2
 *
 * Ensures exactly one `agents` row with `kind = 'central_worker'` exists in the
 * database. Called from `instrumentation.ts` on every boot, after migrations
 * and after the V2-001-T6 instance-identity bootstrap.
 *
 * Idempotency contract:
 *   - First call: inserts the row, returns `{created: true}`.
 *   - Subsequent calls (with the row already present): no-op, returns
 *     `{created: false}` plus the existing row's id.
 *
 * Race-safety:
 *   - In v2.0 there is one Node process per container (see V2-001-T6 module
 *     header). The check-then-insert sequence is therefore safe under the
 *     single-process assumption. If the deployment topology ever shifts to
 *     multi-replica with shared DB, a UNIQUE partial index on
 *     `agents.kind WHERE kind = 'central_worker'` is the suggested upgrade
 *     path — but that is V3+ territory.
 *
 * No `pair_credential_ref`:
 *   - The central_worker authenticates back to its own server via process
 *     identity (same DB connection, no remote calls). It does not need a
 *     pair_credential_ref API key. NULL is the correct value.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import { logger } from '../logger';

export interface BootstrapResult {
  /** True if a new central_worker agent was created. False if already existed (no-op). */
  created: boolean;
  /** The agent row's id (whether newly created or pre-existing). */
  agentId: string;
}

/**
 * Bootstrap the in-process central_worker Agent row. Safe to call on every
 * boot — no-op when the row already exists.
 *
 * @param opts.dbUrl Optional override (test-time injection); defaults to
 *   `process.env.DATABASE_URL` via `getServerDb()`.
 */
export async function bootstrapCentralWorker(opts?: {
  dbUrl?: string;
}): Promise<BootstrapResult> {
  const db = getServerDb(opts?.dbUrl);

  const existing = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.kind, 'central_worker'))
    .limit(1);

  if (existing.length > 0) {
    return { created: false, agentId: existing[0]!.id };
  }

  const id = randomUUID();
  const now = new Date();
  await db.insert(schema.agents).values({
    id,
    kind: 'central_worker',
    pairCredentialRef: null,
    lastSeenAt: now,
    reachableLanHint: null,
    createdAt: now,
  });

  logger.info({ agentId: id }, 'central_worker agent bootstrapped');
  return { created: true, agentId: id };
}
