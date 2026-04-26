/**
 * Consumption event handler — V2-007a-T8.
 *
 * V2-005 Forge will emit `material.consumed` events when prints complete or
 * scale-readings detect material draw. This handler is the producer-side
 * contract: V2-005 conforms to `MaterialConsumedEvent`, this handler applies
 * the decrement + records the ledger event in one atomic transaction.
 *
 * In V2-007a we ship the contract + handler against a stub event type. Tests
 * synthesise events directly. No emitter / pub-sub — `emitMaterialConsumed`
 * is a thin re-export of `handleMaterialConsumed` so V2-005 has a clean
 * import surface and we can swap in a real bus later without churning
 * call-sites.
 *
 * Atomicity contract (mirrors T4/T5/T6):
 *   - Decrement + ledger insert happen inside ONE better-sqlite3 sync
 *     transaction. Any failure rolls back BOTH.
 *
 * Negative balance is honest:
 *   - If the decrement would go negative, the handler STILL applies it and
 *     records `newRemainingAmount: -50` (or whatever) truthfully in the
 *     ledger payload. It returns `reconciliationNeeded: true` as a SIGNAL
 *     to the UI / notifications layer (T13 reports / future ledger-UI).
 *     The handler does not fail.
 *
 * Retired materials are honored:
 *   - A printer can still finish a job started before retirement. We record
 *     consumption against retired Materials. The ledger is the truth.
 *
 * MixBatch consumption (the plan's special case):
 *   - The handler decrements WHATEVER material `materialId` points at. If the
 *     event targets a `mix_batch` material, the mix_batch decrements; the
 *     source bottles are NOT touched (they were already decremented at T5
 *     mix-apply time). The "do not re-decrement source bottles" rule is
 *     automatic — the handler doesn't know or care about source bottles.
 *
 * Provenance pass-through:
 *   - The handler does NOT escalate provenance. T5's escalation is for
 *     transformations (output precision is bounded by inputs). Consumption
 *     is a single signal at a single precision — preserve what the event
 *     reports.
 *
 * `attributedTo.jobId` / `attributedTo.lootId`:
 *   - Free-form strings in v2-007a (no FK enforcement). V2-005 will add
 *     `print_jobs` FK in its own task.
 */

import * as crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getServerDb, schema } from '../db/client';
import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Event contract (V2-005 will conform)
// ---------------------------------------------------------------------------

/**
 * Provenance of a consumption value. Mirrors T5 mix flow. NOTE: the ledger
 * column allows additional values ('derived' | 'computed' | 'system') for
 * other event kinds, but a consumption event is always one of these three.
 */
const PROVENANCE_CLASSES = ['measured', 'entered', 'estimated'] as const;
export type ConsumptionProvenance = (typeof PROVENANCE_CLASSES)[number];

/**
 * What the consumption is attributed to. `kind` discriminates the subtype:
 *   - 'print' → no waste subtype on the ledger payload.
 *   - 'purge' | 'priming' | 'failed-print' | 'waste' → ledger
 *     payload.subtype = 'waste'.
 */
const ATTRIBUTED_TO_KINDS = [
  'print',
  'purge',
  'priming',
  'failed-print',
  'waste',
] as const;
export type AttributedToKind = (typeof ATTRIBUTED_TO_KINDS)[number];

const SOURCES = [
  'forge:dispatch',
  'forge:scale-reading',
  'manual-entry',
] as const;
export type ConsumptionSource = (typeof SOURCES)[number];

export interface MaterialConsumedEvent {
  /** Event type discriminator. ALWAYS 'material.consumed'. */
  type: 'material.consumed';
  /** FK to materials.id. The material whose remaining_amount is being decremented. */
  materialId: string;
  /** Grams or ml consumed. Must be > 0. Unit matches the material's unit. */
  weightConsumed: number;
  /** Provenance of the weightConsumed value. */
  provenanceClass: ConsumptionProvenance;
  /** What the consumption is attributed to. */
  attributedTo: {
    kind: AttributedToKind;
    /** Optional FK to a print job entity (V2-005 will define this). */
    jobId?: string;
    /** Optional FK to a Loot — what was being printed. */
    lootId?: string;
    /** Optional human-readable note ("AMS purge between filament changes"). */
    note?: string;
  };
  /** When the consumption actually happened. May lag the ingest time. */
  occurredAt: Date;
  /** Source signal that produced this event. */
  source: ConsumptionSource;
}

// ---------------------------------------------------------------------------
// Zod schema (strict — no coercion)
// ---------------------------------------------------------------------------

const attributedToSchema = z
  .object({
    kind: z.enum(ATTRIBUTED_TO_KINDS),
    jobId: z.string().min(1).optional(),
    lootId: z.string().min(1).optional(),
    note: z.string().optional(),
  })
  .strict();

const eventSchema = z
  .object({
    type: z.literal('material.consumed'),
    materialId: z.string().min(1),
    weightConsumed: z
      .number()
      .refine(Number.isFinite, { message: 'weightConsumed must be finite' })
      .refine((n) => n > 0, { message: 'weightConsumed must be > 0' }),
    provenanceClass: z.enum(PROVENANCE_CLASSES),
    attributedTo: attributedToSchema,
    // `instanceof(Date)` rejects strings/numbers — Zod coercion is OFF on purpose;
    // the contract requires a real Date.
    occurredAt: z.instanceof(Date).refine((d) => !Number.isNaN(d.getTime()), {
      message: 'occurredAt must be a valid Date',
    }),
    source: z.enum(SOURCES),
  })
  .strict();

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ConsumptionResult =
  | {
      ok: true;
      ledgerEventId: string;
      newRemainingAmount: number;
      /**
       * `true` when the decrement produced a negative remainingAmount. SIGNAL
       * for the UI/notifications layer; the handler still applied the
       * decrement and recorded the ledger event truthfully.
       */
      reconciliationNeeded: boolean;
    }
  | { ok: false; reason: string; details?: string };

// ---------------------------------------------------------------------------
// handleMaterialConsumed
// ---------------------------------------------------------------------------

/**
 * Apply a `material.consumed` event:
 *   1. Validate event shape against the Zod schema.
 *   2. Look up the target Material. If missing → `{ok:false,
 *      reason:'material-not-found'}`. Retired materials are PERMITTED.
 *   3. Decrement `remainingAmount = remainingAmount - weightConsumed`.
 *      Negative results are allowed and recorded honestly.
 *   4. Build subtype: 'waste' for purge/priming/failed-print/waste; undefined
 *      for plain 'print'.
 *   5. Record a `material.consumed` ledger event with the full payload.
 *
 * Reason codes:
 *   invalid-event           — Zod rejected the event shape.
 *   material-not-found      — no Material row with that id.
 *   persist-failed          — DB raised mid-transaction; both writes rolled back.
 */
export async function handleMaterialConsumed(
  event: MaterialConsumedEvent,
  opts?: { dbUrl?: string; now?: Date },
): Promise<ConsumptionResult> {
  // --- Validation ----------------------------------------------------------

  const parsed = eventSchema.safeParse(event);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid-event',
      details: JSON.stringify(parsed.error.issues),
    };
  }
  const e = parsed.data;

  // --- Material lookup -----------------------------------------------------

  const db = getServerDb(opts?.dbUrl);
  const existing = await db
    .select()
    .from(schema.materials)
    .where(eq(schema.materials.id, e.materialId));
  if (existing.length === 0) {
    return { ok: false, reason: 'material-not-found' };
  }
  const current = existing[0]!;

  // --- Compute outcome -----------------------------------------------------

  const newRemainingAmount = current.remainingAmount - e.weightConsumed;
  const reconciliationNeeded = newRemainingAmount < 0;

  const subtype: 'waste' | undefined =
    e.attributedTo.kind === 'print' ? undefined : 'waste';

  const now = opts?.now ?? new Date();
  const ledgerEventId = crypto.randomUUID();

  const relatedResources: Array<{ kind: string; id: string; role: string }> = [];
  if (e.attributedTo.jobId !== undefined) {
    relatedResources.push({
      kind: 'print-job',
      id: e.attributedTo.jobId,
      role: 'attributed-to',
    });
  }
  if (e.attributedTo.lootId !== undefined) {
    relatedResources.push({
      kind: 'loot',
      id: e.attributedTo.lootId,
      role: 'printed',
    });
  }

  const ledgerPayload = {
    weightConsumed: e.weightConsumed,
    unit: current.unit,
    attributedTo: e.attributedTo,
    subtype,
    source: e.source,
    newRemainingAmount,
    reconciliationNeeded,
  };

  // --- Atomic apply --------------------------------------------------------

  try {
    (db as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }).transaction((tx) => {
      const t = tx as ReturnType<typeof getServerDb>;
      t.update(schema.materials)
        .set({ remainingAmount: sql`remaining_amount - ${e.weightConsumed}` })
        .where(eq(schema.materials.id, e.materialId))
        .run();
      t.insert(schema.ledgerEvents)
        .values({
          id: ledgerEventId,
          kind: 'material.consumed',
          actorUserId: null,
          subjectType: 'material',
          subjectId: e.materialId,
          relatedResources: relatedResources.length === 0 ? null : relatedResources,
          payload: JSON.stringify(ledgerPayload),
          provenanceClass: e.provenanceClass,
          occurredAt: e.occurredAt,
          ingestedAt: now,
        })
        .run();
    });
    return {
      ok: true,
      ledgerEventId,
      newRemainingAmount,
      reconciliationNeeded,
    };
  } catch (err) {
    logger.warn(
      {
        err,
        materialId: e.materialId,
        weightConsumed: e.weightConsumed,
      },
      'handleMaterialConsumed: persist failed — decrement + ledger rolled back',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// emitMaterialConsumed (V2-005 import surface)
// ---------------------------------------------------------------------------

/**
 * Forge-facing emitter. V2-005 calls this on print-complete / scale-reading.
 * Currently a direct forward to `handleMaterialConsumed`. If V2-005 (or a
 * later task) wants real pub/sub, wrap THIS function — call-sites in Forge
 * will not need to change.
 */
export async function emitMaterialConsumed(
  event: MaterialConsumedEvent,
  opts?: { dbUrl?: string; now?: Date },
): Promise<ConsumptionResult> {
  return handleMaterialConsumed(event, opts);
}
