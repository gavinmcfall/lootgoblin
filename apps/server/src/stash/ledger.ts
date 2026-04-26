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
 * Placeholder payload used when JSON.stringify fails (e.g. circular references).
 * The ledger event still records the kind/actor/resource — the diagnostic
 * detail is logged separately via `logger.warn`.
 */
const SERIALIZATION_FAILED_PAYLOAD = JSON.stringify({
  _serialization_failed: true,
  reason: 'circular-reference',
});

/**
 * Persist a ledger event. Never throws — on failure, logs warn and continues.
 * Caller MUST NOT abort the primary operation based on this returning or not.
 *
 * Caller contract: `payload` MUST be JSON-serializable. Circular references
 * are caught here and replaced with a placeholder shape; the original
 * kind/actor/resource fields are preserved on the row, and the failure is
 * logged separately so operators can correlate. Check logs for the original
 * payload diagnostic.
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

  // Pre-serialize the payload so a TypeError from circular references doesn't
  // leak out of this function. The DB write below is wrapped in its own
  // try/catch to honour the fire-and-continue contract.
  let serializedPayload: string | null;
  if (event.payload === undefined) {
    serializedPayload = null;
  } else {
    try {
      serializedPayload = JSON.stringify(event.payload);
    } catch (serErr) {
      // Most common cause: circular reference (TypeError).
      // Log only the diagnostic fields — the original payload is by definition
      // not safely serializable, so it isn't included in the log object.
      logger.warn(
        {
          err: serErr,
          kind: event.kind,
          actorId: event.actorId,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
        },
        'ledger: payload serialization failed (likely circular reference) — persisting placeholder',
      );
      serializedPayload = SERIALIZATION_FAILED_PAYLOAD;
    }
  }

  try {
    const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    await db.insert(schema.ledgerEvents).values({
      id: eventId,
      kind: event.kind,
      actorId: event.actorId ?? null,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      payload: serializedPayload,
      createdAt: new Date(),
    });
    return { eventId };
  } catch (err) {
    logger.warn(
      { err, event: { kind: event.kind, actorId: event.actorId, resourceType: event.resourceType, resourceId: event.resourceId } },
      'ledger: persist failed — primary op unaffected',
    );
    return { eventId: null };
  }
}
