/**
 * ledger.ts — Core ledger persistence helper for the Stash pillar.
 *
 * FIRE-AND-CONTINUE: persistLedgerEvent never throws.
 * On DB failure it logs warn and returns { eventId: null } so the
 * caller's primary operation is unaffected.
 *
 * V2-002-T13
 */

import * as crypto from 'node:crypto';

import { logger } from '../logger';
import { getDb, schema } from '../db/client';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LedgerEvent = {
  /** Namespaced event kind, e.g. 'migration.execute', 'bulk.move-to-collection'. */
  kind: string;
  /** Optional actor id (user id, or synthetic 'api-key:<keyId>'). */
  actorId?: string;
  /** Resource type being acted on, e.g. 'loot', 'collection'. */
  resourceType: string;
  /** Primary key of the affected resource. */
  resourceId: string;
  /** Arbitrary payload. JSON-serialized before INSERT. Keep < 10 KB. */
  payload?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Persist a ledger event. Never throws — on failure, logs warn and continues.
 * Caller MUST NOT abort the primary operation based on this returning or not.
 *
 * @param event  The ledger event to persist.
 * @param dbUrl  Optional DATABASE_URL override (used in tests).
 * @returns      { eventId: string } on success, { eventId: null } on failure.
 */
export async function persistLedgerEvent(
  event: LedgerEvent,
  dbUrl?: string,
): Promise<{ eventId: string | null }> {
  const eventId = crypto.randomUUID();
  try {
    const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    await db.insert(schema.ledgerEvents).values({
      id: eventId,
      kind: event.kind,
      actorId: event.actorId ?? null,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      payload: event.payload !== undefined ? JSON.stringify(event.payload) : null,
      createdAt: new Date(),
    });
    return { eventId };
  } catch (err) {
    logger.warn(
      { err, event },
      'ledger: persist failed — primary op unaffected',
    );
    return { eventId: null };
  }
}
