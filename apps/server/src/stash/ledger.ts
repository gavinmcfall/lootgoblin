/**
 * ledger.ts — Core ledger persistence helper.
 *
 * FIRE-AND-CONTINUE: persistLedgerEvent never throws.
 * On DB failure it logs warn and returns { eventId: null } so the
 * caller's primary operation is unaffected.
 *
 * Originally V2-002-T13. Expanded in V2-007a-T3:
 *   - actorId          → actorUserId
 *   - resourceType     → subjectType
 *   - resourceId       → subjectId
 *   - createdAt (col)  → ingestedAt
 *   + relatedResources, provenanceClass, occurredAt
 */

import * as crypto from 'node:crypto';

import { logger } from '../logger';
import { getDb, schema } from '../db/client';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Provenance class for numeric fields in the event payload.
 *   measured  — read off a connected sensor (scale, BME, etc).
 *   entered   — typed in by a user.
 *   estimated — user's best guess.
 *   derived   — computed from one stored measurement (e.g. weight − tare).
 *   computed  — computed from multiple stored measurements (e.g. mix mass).
 *   system    — synthesized by lootgoblin internals (no human/sensor input).
 */
export type ProvenanceClass =
  | 'measured'
  | 'entered'
  | 'estimated'
  | 'derived'
  | 'computed'
  | 'system';

/** A related-resource pointer for events that touch more than one entity. */
export type RelatedResource = {
  /** Resource kind: 'material', 'mix-batch', 'loot', 'collection', etc. */
  kind: string;
  /** Resource id (FK shape, no DB constraint). */
  id: string;
  /** Why this resource is on the event: 'source', 'output', 'parent', etc. */
  role: string;
};

export type LedgerEvent = {
  /** Namespaced event kind, e.g. 'migration.execute', 'bulk.move-to-collection'. */
  kind: string;
  /** Optional actor user id (or synthetic 'api-key:<keyId>'). */
  actorUserId?: string | null;
  /** Subject type — kind of resource the event is "about". */
  subjectType: string;
  /** Primary key of the subject resource. */
  subjectId: string;
  /** Optional related-resource pointers for multi-resource events. */
  relatedResources?: RelatedResource[];
  /** Arbitrary payload. JSON-serialized before INSERT. Keep < 10 KB. */
  payload?: Record<string, unknown>;
  /** Provenance class for numeric payload fields, when applicable. */
  provenanceClass?: ProvenanceClass;
  /**
   * When the event ACTUALLY happened. Defaults to NULL — readers should treat
   * NULL occurredAt as equal to ingestedAt. Diverges from ingestedAt for
   * events with delayed reporting (e.g. Forge dispatch reporting hours later).
   */
  occurredAt?: Date;
};

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Placeholder payload used when JSON.stringify fails (e.g. circular references).
 * The ledger event still records the kind/actor/subject — the diagnostic
 * detail is logged separately via `logger.warn`.
 */
const SERIALIZATION_FAILED_PAYLOAD = JSON.stringify({
  _serialization_failed: true,
  reason: 'circular-reference',
});

const SERIALIZATION_FAILED_RELATED = JSON.stringify({
  _serialization_failed: true,
  reason: 'circular-reference',
});

/**
 * Persist a ledger event. Never throws — on failure, logs warn and continues.
 * Caller MUST NOT abort the primary operation based on this returning or not.
 *
 * Caller contract: `payload` and `relatedResources` MUST be JSON-serializable.
 * Circular references are caught here and replaced with a placeholder shape;
 * the original kind/actor/subject fields are preserved on the row, and the
 * failure is logged separately so operators can correlate. Check logs for the
 * original payload diagnostic.
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
          actorUserId: event.actorUserId,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
        },
        'ledger: payload serialization failed (likely circular reference) — persisting placeholder',
      );
      serializedPayload = SERIALIZATION_FAILED_PAYLOAD;
    }
  }

  // Pre-serialize relatedResources with the same circular-ref guard.
  // Drizzle's { mode: 'json' } would otherwise throw on circular input.
  // We bypass Drizzle's auto-serialization by storing as text and casting.
  let serializedRelated: RelatedResource[] | null;
  if (event.relatedResources === undefined || event.relatedResources === null) {
    serializedRelated = null;
  } else {
    try {
      // Round-trip to confirm it's serializable — actual JSON encoding is
      // handled by Drizzle's { mode: 'json' } column when we assign the
      // array directly below.
      JSON.stringify(event.relatedResources);
      serializedRelated = event.relatedResources;
    } catch (serErr) {
      logger.warn(
        {
          err: serErr,
          kind: event.kind,
          actorUserId: event.actorUserId,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
        },
        'ledger: relatedResources serialization failed — dropping related list',
      );
      // Don't poison the row — drop the unserializable list and keep going.
      // The diagnostic placeholder lives in logs, not the column.
      void SERIALIZATION_FAILED_RELATED;
      serializedRelated = null;
    }
  }

  try {
    const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    await db.insert(schema.ledgerEvents).values({
      id: eventId,
      kind: event.kind,
      actorUserId: event.actorUserId ?? null,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      relatedResources: serializedRelated,
      payload: serializedPayload,
      provenanceClass: event.provenanceClass ?? null,
      occurredAt: event.occurredAt ?? null,
      ingestedAt: new Date(),
    });
    return { eventId };
  } catch (err) {
    logger.warn(
      {
        err,
        event: {
          kind: event.kind,
          actorUserId: event.actorUserId,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
        },
      },
      'ledger: persist failed — primary op unaffected',
    );
    return { eventId: null };
  }
}
