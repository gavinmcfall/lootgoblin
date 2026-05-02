/**
 * consumption-emitter.ts — V2-005f-T_dcf11
 *
 * Bridge between V2-005f Forge status events and V2-007a's consumption ledger.
 * Closes carry-forward G-CF-3.
 *
 * ## Two-phase consumption flow
 *
 * - **Phase A — at dispatch time** (`emitConsumptionForDispatch`):
 *   The claim worker extracts a `SlicerEstimate` from the sliced/converted
 *   file, persists it into `dispatch_jobs.materials_used`, then for each slot
 *   with a non-empty `material_id` emits one `material.consumed` event with
 *   `provenanceClass='estimated'` and `weightConsumed = slot.estimated_grams`.
 *   Slots with empty `material_id` are skipped (V2-005f-CF-1 — material
 *   loadout tracking is not yet wired; we still write the cache row so the
 *   data shape is ready when CF-1 lands).
 *
 * - **Phase B — at completion time** (`emitConsumptionForCompletion`):
 *   Wired into the status sink via `deps.emitConsumption`. Fires only on a
 *   successful `dispatched → completed` transition (the sink already gates
 *   on `event.kind === 'completed'` AND a winning state-machine
 *   transition). For each slot in `event.measuredConsumption`, computes the
 *   measured grams using whichever signal the protocol carries:
 *
 *     * `entry.grams > 0` → use directly (Bambu surfaces this on AMS
 *       protocols when available).
 *     * `entry.remain_percent !== undefined` AND
 *       `slot.estimated_grams > 0` → approximate via
 *       `measured = estimated * (100 - remain_percent) / 100`. This is the
 *       documented V2-005f simplification — without per-spool tracking we
 *       can't know `remain_percent_at_print_start`, so we treat the slicer
 *       estimate as the "starting point" for the percentage delta.
 *     * Otherwise: skip (no usable measured signal).
 *
 *   Emits `provenanceClass='measured'`, leaving the Phase-A estimated event
 *   untouched. Both rows live in the ledger with distinct provenance values
 *   — that's intentional. V2-007a-T13 reports query by provenance.
 *
 * ## Idempotency (closes G-CF-3 carry-forward)
 *
 * V2-007a's ledger schema does NOT enforce uniqueness on
 * `(dispatch_job_id, slot_index, provenance)`. Rather than alter the ledger
 * schema (which is shared with five other event kinds), we enforce
 * idempotency at the emitter via a SQL pre-check using SQLite's
 * `json_extract`:
 *
 *     SELECT 1 FROM ledger_events
 *      WHERE kind = 'material.consumed'
 *        AND provenance_class = ?
 *        AND json_extract(payload, '$.attributedTo.jobId')   = ?
 *        AND json_extract(payload, '$.attributedTo.note')    = ?
 *      LIMIT 1;
 *
 * The note field carries `slot:<N>` so each (job, slot, provenance) triple
 * has a unique fingerprint. If a row matches, the emitter skips the call to
 * `handleMaterialConsumed` and counts it as `skipped`. Reconnect-storm
 * duplicates therefore never double-decrement a Material.
 *
 * ## Why no schema change
 *
 * - Adding a UNIQUE INDEX on json_extract expressions is supported by SQLite
 *   but not by every Drizzle-generated migration target we run in tests.
 * - Adding a separate `idempotency_key` column to `ledger_events` would
 *   touch every persistLedgerEventInTx call-site and migrate existing data.
 * - The pre-check approach is read-cheap, well-indexed (the
 *   `ledger_events_kind_idx` covers the `kind = 'material.consumed'`
 *   predicate; the per-job result set is tiny), and isolates the V2-005f
 *   surface from the rest of the ledger pipeline.
 *
 * ## Material lookup
 *
 * For V2-005f as it ships, `material_id` in `materials_used` is `''` for
 * every slot until V2-005f-CF-1 (material-loadout tracking) wires the
 * Material→slot map. Both Phase A and Phase B silently skip slots with
 * empty material_id (logging at debug). This means the integration is a
 * no-op until CF-1 lands, which is the documented V2-005f scope.
 */

import { and, eq, sql } from 'drizzle-orm';

import { logger } from '@/logger';
import { getServerDb, schema } from '@/db/client';
import {
  handleMaterialConsumed,
  type ConsumptionProvenance,
  type ConsumptionResult,
  type MaterialConsumedEvent,
} from '@/materials/consumption';
import type { MaterialsUsed, MaterialsUsedEntry } from '@/db/schema.forge';
import type { StatusEvent, MeasuredConsumptionSlot } from './types';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ConsumptionEmitterDeps {
  /** Override DB url for tests. */
  dbUrl?: string;
  /**
   * Override the underlying handler. Tests inject this to assert call shape
   * without seeding a Material row, or to simulate transient
   * persist-failures. Defaults to V2-007a `handleMaterialConsumed`.
   */
  handler?: (
    event: MaterialConsumedEvent,
    opts?: { dbUrl?: string },
  ) => Promise<ConsumptionResult>;
  /** Override the now() clock — defaults to `new Date()`. */
  now?: () => Date;
}

export interface EmitConsumptionResult {
  /** Number of slots that resulted in a successful ledger event. */
  emitted: number;
  /** Number of slots skipped because a matching ledger row already exists. */
  skipped: number;
  /** Number of slots whose handler call returned `ok:false`. */
  failed: number;
}

const ZERO_RESULT: EmitConsumptionResult = Object.freeze({
  emitted: 0,
  skipped: 0,
  failed: 0,
});

// ---------------------------------------------------------------------------
// Phase B — completion-time measured emission
// ---------------------------------------------------------------------------

export interface EmitConsumptionForCompletionOpts {
  dispatchJobId: string;
  event: StatusEvent;
  /** Provenance class to record. Defaults to 'measured'. */
  provenance?: ConsumptionProvenance;
}

/**
 * Phase B. Read `dispatch_jobs.materials_used`, correlate each entry with the
 * matching `event.measuredConsumption` slot, compute measured grams, and
 * emit one V2-007a `material.consumed` event per slot with provenance
 * `'measured'`.
 *
 * Caller must have already gated on `event.kind === 'completed'` AND a
 * successful state-machine transition — see status-event-handler.ts.
 */
export async function emitConsumptionForCompletion(
  args: EmitConsumptionForCompletionOpts,
  deps: ConsumptionEmitterDeps = {},
): Promise<EmitConsumptionResult> {
  const provenance: ConsumptionProvenance = args.provenance ?? 'measured';

  const db = getServerDb(deps.dbUrl);
  const rows = await db
    .select({
      lootId: schema.dispatchJobs.lootId,
      materialsUsed: schema.dispatchJobs.materialsUsed,
    })
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.id, args.dispatchJobId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    logger.debug(
      { dispatchJobId: args.dispatchJobId },
      'consumption-emitter[B]: dispatch_job not found — no-op',
    );
    return { ...ZERO_RESULT };
  }

  const materialsUsed = parseMaterialsUsed(row.materialsUsed);
  if (materialsUsed === null || materialsUsed.length === 0) {
    logger.debug(
      { dispatchJobId: args.dispatchJobId },
      'consumption-emitter[B]: materials_used empty — no slicer estimate available, skipping',
    );
    return { ...ZERO_RESULT };
  }

  const measured = args.event.measuredConsumption ?? [];
  if (measured.length === 0) {
    logger.debug(
      { dispatchJobId: args.dispatchJobId },
      'consumption-emitter[B]: event.measuredConsumption empty — protocol did not report per-slot consumption',
    );
    return { ...ZERO_RESULT };
  }

  const measuredBySlot = new Map<number, MeasuredConsumptionSlot>();
  for (const m of measured) {
    measuredBySlot.set(m.slot_index, m);
  }

  const handler = deps.handler ?? handleMaterialConsumed;
  const now = (deps.now ?? (() => new Date()))();

  let emitted = 0;
  let skipped = 0;
  let failed = 0;

  for (const slot of materialsUsed) {
    const m = measuredBySlot.get(slot.slot_index);
    if (!m) {
      // Slicer estimate covers this slot but the printer did not report
      // measured consumption. Phase A's estimated event is the only ledger
      // record — that's correct.
      continue;
    }

    if (!slot.material_id || slot.material_id.length === 0) {
      logger.debug(
        {
          dispatchJobId: args.dispatchJobId,
          slot: slot.slot_index,
        },
        'consumption-emitter[B]: empty material_id — V2-005f-CF-1 loadout tracking not wired, skipping',
      );
      continue;
    }

    const measuredGrams = computeMeasuredGrams(slot, m);
    if (measuredGrams === null || measuredGrams <= 0) {
      logger.debug(
        {
          dispatchJobId: args.dispatchJobId,
          slot: slot.slot_index,
          measuredGrams,
        },
        'consumption-emitter[B]: no usable measured signal for slot — skipping',
      );
      continue;
    }

    const note = `slot:${slot.slot_index}`;
    const existing = await ledgerRowExists({
      jobId: args.dispatchJobId,
      provenance,
      note,
      dbUrl: deps.dbUrl,
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    const result = await handler(
      {
        type: 'material.consumed',
        materialId: slot.material_id,
        weightConsumed: measuredGrams,
        provenanceClass: provenance,
        attributedTo: {
          kind: 'print',
          jobId: args.dispatchJobId,
          lootId: row.lootId,
          note,
        },
        occurredAt: args.event.occurredAt ?? now,
        source: 'forge:dispatch',
      },
      { dbUrl: deps.dbUrl },
    );
    if (result.ok) {
      emitted += 1;
    } else {
      failed += 1;
      logger.warn(
        {
          dispatchJobId: args.dispatchJobId,
          slot: slot.slot_index,
          materialId: slot.material_id,
          reason: result.reason,
          details: result.details,
        },
        'consumption-emitter[B]: handler returned not-ok',
      );
    }
  }

  return { emitted, skipped, failed };
}

// ---------------------------------------------------------------------------
// Phase A — dispatch-time estimated emission
// ---------------------------------------------------------------------------

export interface EmitConsumptionForDispatchOpts {
  dispatchJobId: string;
  lootId: string;
  materialsUsed: MaterialsUsed;
  /** Override occurredAt — defaults to deps.now() / `new Date()`. */
  occurredAt?: Date;
}

/**
 * Phase A. For each slot in `materialsUsed` with a non-empty `material_id`
 * AND a positive `estimated_grams`, emit one V2-007a `material.consumed`
 * event with provenance `'estimated'`.
 *
 * Slots without a `material_id` (the common V2-005f case before
 * V2-005f-CF-1 lands) are silently skipped at debug level — the
 * `materials_used` JSON is still useful for Phase B's calculation.
 */
export async function emitConsumptionForDispatch(
  args: EmitConsumptionForDispatchOpts,
  deps: ConsumptionEmitterDeps = {},
): Promise<EmitConsumptionResult> {
  if (args.materialsUsed.length === 0) {
    return { ...ZERO_RESULT };
  }

  const handler = deps.handler ?? handleMaterialConsumed;
  const now = (deps.now ?? (() => new Date()))();
  const provenance: ConsumptionProvenance = 'estimated';

  let emitted = 0;
  let skipped = 0;
  let failed = 0;

  for (const slot of args.materialsUsed) {
    if (!slot.material_id || slot.material_id.length === 0) {
      logger.debug(
        {
          dispatchJobId: args.dispatchJobId,
          slot: slot.slot_index,
        },
        'consumption-emitter[A]: empty material_id — V2-005f-CF-1 loadout tracking not wired, skipping',
      );
      continue;
    }
    if (!Number.isFinite(slot.estimated_grams) || slot.estimated_grams <= 0) {
      logger.debug(
        {
          dispatchJobId: args.dispatchJobId,
          slot: slot.slot_index,
          estimated_grams: slot.estimated_grams,
        },
        'consumption-emitter[A]: estimated_grams not positive — skipping',
      );
      continue;
    }

    const note = `slot:${slot.slot_index}`;
    const existing = await ledgerRowExists({
      jobId: args.dispatchJobId,
      provenance,
      note,
      dbUrl: deps.dbUrl,
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    const result = await handler(
      {
        type: 'material.consumed',
        materialId: slot.material_id,
        weightConsumed: slot.estimated_grams,
        provenanceClass: provenance,
        attributedTo: {
          kind: 'print',
          jobId: args.dispatchJobId,
          lootId: args.lootId,
          note,
        },
        occurredAt: args.occurredAt ?? now,
        source: 'forge:dispatch',
      },
      { dbUrl: deps.dbUrl },
    );
    if (result.ok) {
      emitted += 1;
    } else {
      failed += 1;
      logger.warn(
        {
          dispatchJobId: args.dispatchJobId,
          slot: slot.slot_index,
          materialId: slot.material_id,
          reason: result.reason,
          details: result.details,
        },
        'consumption-emitter[A]: handler returned not-ok',
      );
    }
  }

  return { emitted, skipped, failed };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drizzle returns `materials_used` as either a parsed object (json mode) or
 * a string (depending on driver flavour). Normalize defensively — duplicate
 * columns across migrations have surprised tests before.
 */
function parseMaterialsUsed(raw: unknown): MaterialsUsed | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw as MaterialsUsed;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as MaterialsUsed) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Compute measured grams for a slot. Prefers a directly-reported grams
 * value; falls back to remain_percent * estimated_grams when the printer
 * surfaces percent-remaining (Bambu AMS).
 *
 * Returns null when no usable signal is available.
 */
function computeMeasuredGrams(
  slot: MaterialsUsedEntry,
  m: MeasuredConsumptionSlot,
): number | null {
  if (Number.isFinite(m.grams) && m.grams > 0) {
    return m.grams;
  }
  if (
    m.remain_percent !== undefined &&
    Number.isFinite(m.remain_percent) &&
    Number.isFinite(slot.estimated_grams) &&
    slot.estimated_grams > 0
  ) {
    const consumedPct = Math.max(0, Math.min(100, 100 - m.remain_percent));
    if (consumedPct <= 0) return null;
    return slot.estimated_grams * (consumedPct / 100);
  }
  return null;
}

/**
 * Idempotency pre-check. SQLite's `json_extract` indexes the typed payload
 * shape we always write from this module, so the per-job result set is
 * tiny and the kind-index narrows the scan. Returns true if a matching
 * `material.consumed` row already exists.
 */
async function ledgerRowExists(args: {
  jobId: string;
  provenance: ConsumptionProvenance;
  note: string;
  dbUrl?: string;
}): Promise<boolean> {
  const db = getServerDb(args.dbUrl);
  const rows = await db
    .select({ id: schema.ledgerEvents.id })
    .from(schema.ledgerEvents)
    .where(
      and(
        eq(schema.ledgerEvents.kind, 'material.consumed'),
        eq(schema.ledgerEvents.provenanceClass, args.provenance),
        sql`json_extract(${schema.ledgerEvents.payload}, '$.attributedTo.jobId') = ${args.jobId}`,
        sql`json_extract(${schema.ledgerEvents.payload}, '$.attributedTo.note') = ${args.note}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
