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
 *
 * Atomic-caller mode (G-CF-1): when `opts.tx` is provided (i.e. the caller is
 * already inside a sync better-sqlite3 transaction — e.g. T4 createMaterial,
 * T5 applyMixBatch, T6 applyRecycleEvent, T8 handleMaterialConsumed), the
 * helper uses the caller's tx handle and skips the outer try/catch. Schema
 * validation still runs in both paths. Validation failure returns
 * `{ eventId: null, validationFailed: true }` so atomic callers can decide
 * whether to throw and roll back.
 */

import * as crypto from 'node:crypto';

import { logger } from '../logger';
import { getDb, schema } from '../db/client';
import { validateLedgerEventPayload } from './ledger-schemas';

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
  /**
   * When the event was written to the ledger. Defaults to `new Date()` at
   * insert time. Atomic callers (T4-T8 lifecycle) pass their `opts.now` here
   * so ledger ingestedAt matches the Material/MixBatch row's createdAt.
   */
  ingestedAt?: Date;
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
 * Drizzle better-sqlite3 transaction handle shape. Sync API. We type it as a
 * structural minimum (insert + select) so callers don't have to import the
 * Drizzle internal type.
 */
export type LedgerTxHandle = {
  insert: (table: typeof schema.ledgerEvents) => {
    values: (row: typeof schema.ledgerEvents.$inferInsert) => { run: () => void };
  };
};

/**
 * Options for persistLedgerEvent. Backwards-compatible: callers may pass a
 * bare string as the 2nd positional arg (legacy `dbUrl`-string form) — that
 * is normalised to `{ dbUrl: string }` internally.
 */
export type PersistLedgerEventOpts = {
  /** Optional DATABASE_URL override (used in tests). Ignored when `tx` is set. */
  dbUrl?: string;
  /**
   * Optional caller-supplied transaction handle. When provided, the helper
   * inserts via this handle (no own connection, no outer try/catch — the
   * caller's transaction owns the rollback). Atomic-caller mode (G-CF-1).
   */
  tx?: LedgerTxHandle;
};

/**
 * Result of a persistLedgerEvent call.
 *   - `eventId`: the UUID written, or `null` if the row wasn't written.
 *   - `validationFailed`: only `true` when Zod schema validation rejected the
 *     payload (atomic callers should rollback). Absent on DB-write failure
 *     (which is fire-and-continue).
 */
export type PersistLedgerEventResult = {
  eventId: string | null;
  validationFailed?: boolean;
};

/**
 * Internal — runs schema validation + builds the row to insert. Returns
 * `null` when validation fails (caller treats this as not-written). Shared
 * between the async (`persistLedgerEvent`) and sync-tx (`persistLedgerEventInTx`)
 * entrypoints so they apply the SAME validation / serialization rules.
 */
function buildLedgerRow(
  event: LedgerEvent,
):
  | { ok: true; eventId: string; row: typeof schema.ledgerEvents.$inferInsert }
  | { ok: false; eventId: null; validationFailed: true } {
  const eventId = crypto.randomUUID();

  // V2-007a-T12: per-event-type schema validation. Runs before serialization
  // so that bad payloads short-circuit BEFORE we touch JSON.stringify or the
  // DB. Unknown kinds + undefined payloads pass through (forward compat); a
  // registered-and-failing payload returns null + validationFailed=true so
  // atomic callers can surface the rollback signal.
  const validation = validateLedgerEventPayload(event.kind, event.payload);
  if (!validation.ok) {
    logger.warn(
      {
        kind: event.kind,
        actorUserId: event.actorUserId,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        issues: validation.issues,
      },
      'ledger: payload failed schema validation — row not written',
    );
    return { ok: false, eventId: null, validationFailed: true };
  }

  // Pre-serialize the payload so a TypeError from circular references doesn't
  // leak out of this function.
  let serializedPayload: string | null;
  if (event.payload === undefined) {
    serializedPayload = null;
  } else {
    try {
      serializedPayload = JSON.stringify(event.payload);
    } catch (serErr) {
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
  let serializedRelated: RelatedResource[] | null;
  if (event.relatedResources === undefined || event.relatedResources === null) {
    serializedRelated = null;
  } else {
    try {
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
      void SERIALIZATION_FAILED_RELATED;
      serializedRelated = null;
    }
  }

  const row: typeof schema.ledgerEvents.$inferInsert = {
    id: eventId,
    kind: event.kind,
    actorUserId: event.actorUserId ?? null,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    relatedResources: serializedRelated,
    payload: serializedPayload,
    provenanceClass: event.provenanceClass ?? null,
    occurredAt: event.occurredAt ?? null,
    ingestedAt: event.ingestedAt ?? new Date(),
  };

  return { ok: true, eventId, row };
}

/**
 * Persist a ledger event (default fire-and-continue mode).
 *
 * Never throws. On DB failure logs warn and returns `{ eventId: null }` so
 * the caller's primary op is unaffected.
 *
 * Caller contract: `payload` and `relatedResources` MUST be JSON-serializable.
 * Circular references are caught here and replaced with a placeholder shape;
 * the original kind/actor/subject fields are preserved on the row, and the
 * failure is logged separately so operators can correlate.
 *
 * For atomic-transaction callers (T4 createMaterial, T5 applyMixBatch, T6
 * applyRecycleEvent, T8 handleMaterialConsumed) use `persistLedgerEventInTx`
 * instead — that variant is sync, throws on failure (so the caller's tx
 * rolls back), and shares the same validation rules.
 *
 * @param event  The ledger event to persist.
 * @param opts   Optional `{ dbUrl? }` or legacy `dbUrl: string`.
 */
export async function persistLedgerEvent(
  event: LedgerEvent,
  opts?: string | PersistLedgerEventOpts,
): Promise<PersistLedgerEventResult> {
  // Normalise opts: support legacy positional `dbUrl` string form.
  const normalized: PersistLedgerEventOpts =
    typeof opts === 'string'
      ? { dbUrl: opts }
      : (opts ?? {});
  const dbUrl = normalized.dbUrl;

  // tx is intentionally NOT supported on the async entrypoint — the sync
  // entrypoint (`persistLedgerEventInTx`) is for that. If a caller passes
  // tx, fall through to the default mode (own connection) and warn loudly.
  if (normalized.tx !== undefined) {
    logger.warn(
      { kind: event.kind },
      'ledger: persistLedgerEvent(opts.tx) is unsupported on the async entrypoint — use persistLedgerEventInTx',
    );
  }

  const built = buildLedgerRow(event);
  if (!built.ok) {
    return { eventId: null, validationFailed: true };
  }

  try {
    const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    await db.insert(schema.ledgerEvents).values(built.row);
    return { eventId: built.eventId };
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

/**
 * Persist a ledger event INSIDE a sync better-sqlite3 transaction (G-CF-1).
 *
 * Used by atomic-caller mode (T4 createMaterial, T5 applyMixBatch, T6
 * applyRecycleEvent, T8 handleMaterialConsumed). The caller's transaction
 * owns the rollback — we don't wrap in try/catch:
 *   - DB errors propagate (caller's tx rolls back the primary op + this).
 *   - Validation failures throw `LedgerValidationError`; caller's tx rolls
 *     back the primary op too (so a malformed payload can't corrupt state).
 *
 * Returns the eventId on success. Callers do not need to keep a pre-generated
 * id around — use the return value.
 */
export function persistLedgerEventInTx(
  tx: LedgerTxHandle,
  event: LedgerEvent,
): { eventId: string } {
  const built = buildLedgerRow(event);
  if (!built.ok) {
    throw new LedgerValidationError(event.kind);
  }
  tx.insert(schema.ledgerEvents).values(built.row).run();
  return { eventId: built.eventId };
}

/**
 * Thrown by `persistLedgerEventInTx` when payload validation fails. The
 * underlying issues are already logged by `buildLedgerRow` — the error itself
 * carries only the event kind. Atomic callers SHOULD let this propagate so
 * the surrounding transaction rolls back.
 */
export class LedgerValidationError extends Error {
  constructor(public readonly kind: string) {
    super(`ledger payload failed schema validation for kind=${kind}`);
    this.name = 'LedgerValidationError';
  }
}
