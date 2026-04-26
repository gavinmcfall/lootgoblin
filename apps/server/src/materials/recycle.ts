/**
 * Recycle flow — V2-007a-T6.
 *
 * One domain function: `applyRecycleEvent` — atomically:
 *   - validates a heterogeneous list of inputs (mix of tracked Materials and
 *     untracked loose-scrap entries),
 *   - decrements each tracked source by its declared weight,
 *   - creates a new `recycled_spool` Material for the output (mass-tracked, g),
 *   - records a `recycle_events` row preserving the FULL inputs JSON
 *     (including null sourceMaterialId entries with notes),
 *   - emits a `material.recycled` ledger event with related-resource
 *     references for each tracked source plus a synthetic
 *     `untracked-scrap:<recycle-event-id>:scrap-N` entry per untracked input.
 *
 * Sister to T5 mix flow but with relaxed source-tracking rules — recycling
 * captures loose offcuts that were never tracked as Materials, so a non-trivial
 * fraction of inputs can be `sourceMaterialId: null`. There is no recipe (each
 * recycle is unique).
 *
 * Atomicity contract (mirrors T4/T5): all writes happen inside ONE
 * better-sqlite3 sync transaction. Any failure rolls back EVERYTHING — no
 * source decrement, no recycled_spool material, no recycle_events row, no
 * ledger event. Validation runs BEFORE the transaction opens.
 *
 * Mass conservation invariant:
 *   sum(decrements-on-tracked) + sum(untracked-input-weights) === outputWeight
 *     ± 0.1 (no-anomaly path).
 *   The unit test (`materials-recycle.test.ts`) asserts this with a
 *   randomized property loop seeded for determinism.
 *
 * Output-anomaly model (warn + ack):
 *   If the output weight exceeds (sum of inputs * 1.05), the caller MUST set
 *   `acknowledgeWeightAnomaly: true` to confirm intentional virgin-stock
 *   addition. Without ack → reject. With ack → accept and record the anomaly
 *   in the ledger payload + downgrade provenance one notch (virgin stock
 *   dilutes the precision of the inputs we DO know).
 *
 * Provenance escalation (weakest-link, sister to T5):
 *   if any input is 'estimated' → 'estimated'
 *   else if any input is 'entered' → 'entered'
 *   else → 'measured'
 *   Then if anomaly+ack: downgrade one notch
 *     ('measured' → 'entered', 'entered' → 'estimated', 'estimated' →
 *      'estimated' (floor)).
 */

import * as crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import { logger } from '../logger';
import type { ColorPattern } from '../db/schema.materials';
import { validateColors } from './validate';
import type { LifecycleFailure } from './lifecycle';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_INPUTS = 1;
const MAX_INPUTS = 20;
/** Allow output weight up to 5% above sum-of-inputs without an explicit ack. */
const WEIGHT_ANOMALY_THRESHOLD = 1.05;

const PROVENANCE_CLASSES = ['measured', 'entered', 'estimated'] as const;
type ProvenanceClass = (typeof PROVENANCE_CLASSES)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecycleInput {
  /** FK to a tracked Material; null for untracked loose scrap. */
  sourceMaterialId: string | null;
  /** Weight in grams. Must be > 0. */
  weight: number;
  provenanceClass: ProvenanceClass;
  /** Optional note (e.g. "scrap from purges across 3 prints"). */
  note?: string;
}

export interface ApplyRecycleEventInput {
  ownerId: string;
  actorUserId: string;
  inputs: RecycleInput[];
  outputWeight: number;
  /** If outputWeight > sum-of-inputs * 1.05, must be true. */
  acknowledgeWeightAnomaly?: boolean;
  /** Optional descriptors for the new recycled_spool Material. */
  outputSpoolBrand?: string;
  outputSpoolColors?: string[];
  outputSpoolColorPattern?: ColorPattern;
  outputSpoolColorName?: string;
  notes?: string;
}

export type ApplyRecycleEventResult =
  | { ok: true; outputSpoolId: string; recycleEventId: string; ledgerEventId: string }
  | { ok: false; reason: string; details?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escalateProvenance(inputs: RecycleInput[]): ProvenanceClass {
  if (inputs.some((i) => i.provenanceClass === 'estimated')) return 'estimated';
  if (inputs.some((i) => i.provenanceClass === 'entered')) return 'entered';
  return 'measured';
}

function downgradeOneNotch(p: ProvenanceClass): ProvenanceClass {
  if (p === 'measured') return 'entered';
  if (p === 'entered') return 'estimated';
  return 'estimated'; // floor
}

// ---------------------------------------------------------------------------
// applyRecycleEvent
// ---------------------------------------------------------------------------

/**
 * Atomically apply a recycle event.
 *
 * Reason codes:
 *   owner-required             — ownerId blank
 *   no-inputs                  — inputs array empty
 *   too-many-inputs            — inputs.length > 20
 *   input-malformed            — entry missing fields, weight<=0, bad provenance
 *   zero-input-weight          — sum of weights is 0 (defensive against div-by-zero)
 *   output-weight-invalid      — outputWeight not a positive finite number
 *   output-anomaly-no-ack      — outputWeight > sum * 1.05 and no ack provided
 *   colors-* / color-pattern-* — see validateColors (only when colors override provided)
 *   source-not-found           — a tracked sourceMaterialId doesn't exist
 *   source-not-owned           — tracked source.ownerId !== input.ownerId
 *   source-retired             — tracked source.active === false
 *   source-insufficient        — tracked source.remainingAmount < input.weight
 *   persist-failed             — the transaction raised; entire batch rolled back
 */
export async function applyRecycleEvent(
  input: ApplyRecycleEventInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<ApplyRecycleEventResult> {
  // --- Pre-DB validation ---------------------------------------------------

  if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    return { ok: false, reason: 'owner-required' };
  }
  if (typeof input.actorUserId !== 'string' || input.actorUserId.length === 0) {
    return { ok: false, reason: 'owner-required' };
  }

  if (!Array.isArray(input.inputs) || input.inputs.length < MIN_INPUTS) {
    return { ok: false, reason: 'no-inputs' };
  }
  if (input.inputs.length > MAX_INPUTS) {
    return { ok: false, reason: 'too-many-inputs' };
  }

  for (const i of input.inputs) {
    if (i === null || typeof i !== 'object') {
      return { ok: false, reason: 'input-malformed' };
    }
    const sid = (i as { sourceMaterialId?: unknown }).sourceMaterialId;
    if (sid !== null && (typeof sid !== 'string' || sid.length === 0)) {
      return { ok: false, reason: 'input-malformed' };
    }
    const w = (i as { weight?: unknown }).weight;
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) {
      return { ok: false, reason: 'input-malformed' };
    }
    const pc = (i as { provenanceClass?: unknown }).provenanceClass;
    if (typeof pc !== 'string' || !(PROVENANCE_CLASSES as readonly string[]).includes(pc)) {
      return { ok: false, reason: 'input-malformed' };
    }
  }

  const inputs = input.inputs as RecycleInput[];
  const sumInputs = inputs.reduce((acc, i) => acc + i.weight, 0);
  if (sumInputs <= 0) {
    // Theoretical (every weight>0 already passed) but protects the divide
    // implicit in the anomaly comparison below.
    return { ok: false, reason: 'zero-input-weight' };
  }

  if (
    typeof input.outputWeight !== 'number' ||
    !Number.isFinite(input.outputWeight) ||
    input.outputWeight <= 0
  ) {
    return { ok: false, reason: 'output-weight-invalid' };
  }

  const anomaly = input.outputWeight > sumInputs * WEIGHT_ANOMALY_THRESHOLD;
  if (anomaly && input.acknowledgeWeightAnomaly !== true) {
    return {
      ok: false,
      reason: 'output-anomaly-no-ack',
      details: `outputWeight=${input.outputWeight} exceeds sumInputs=${sumInputs} * ${WEIGHT_ANOMALY_THRESHOLD}`,
    };
  }

  // Optional color override on the output spool. If any color field is
  // provided we run the full T4 color validator (defense-in-depth).
  let resolvedColors: string[] | null = null;
  let resolvedColorPattern: ColorPattern | null = null;
  if (
    input.outputSpoolColors !== undefined ||
    input.outputSpoolColorPattern !== undefined ||
    (input.outputSpoolColorName !== undefined && input.outputSpoolColorName !== null)
  ) {
    if (input.outputSpoolColors === undefined || input.outputSpoolColorPattern === undefined) {
      return { ok: false, reason: 'color-pattern-mismatch' };
    }
    const c = validateColors(input.outputSpoolColors, input.outputSpoolColorPattern);
    if (!c.ok) return c;
    resolvedColors = c.colors;
    resolvedColorPattern = c.colorPattern;
  }

  // --- DB-side validation (tracked sources) --------------------------------

  const db = getServerDb(opts?.dbUrl);

  // Bounded fan-out: input count <= MAX_INPUTS = 20. We accept N small queries
  // over a complex IN+filter for clarity (mirrors T5 pattern).
  for (const i of inputs) {
    if (i.sourceMaterialId === null) continue;
    const rows = await db
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, i.sourceMaterialId));
    if (rows.length === 0) {
      return {
        ok: false,
        reason: 'source-not-found',
        details: `sourceMaterialId=${i.sourceMaterialId}`,
      };
    }
    const src = rows[0]!;
    if (src.ownerId !== input.ownerId) {
      return {
        ok: false,
        reason: 'source-not-owned',
        details: `sourceMaterialId=${i.sourceMaterialId}`,
      };
    }
    if (src.active === false) {
      return {
        ok: false,
        reason: 'source-retired',
        details: `sourceMaterialId=${i.sourceMaterialId}`,
      };
    }
    if (src.remainingAmount < i.weight) {
      return {
        ok: false,
        reason: 'source-insufficient',
        details: `sourceMaterialId=${i.sourceMaterialId} remaining=${src.remainingAmount} weight=${i.weight}`,
      };
    }
  }

  // --- Build the writes ----------------------------------------------------

  const newMaterialId = crypto.randomUUID();
  const newRecycleEventId = crypto.randomUUID();
  const ledgerEventId = crypto.randomUUID();
  const now = opts?.now ?? new Date();

  // Provenance: weakest-link across inputs, then downgrade one notch on
  // anomaly+ack (virgin stock dilutes precision of known inputs).
  let batchProvenance = escalateProvenance(inputs);
  if (anomaly) {
    batchProvenance = downgradeOneNotch(batchProvenance);
  }

  const newMaterialRow: typeof schema.materials.$inferInsert = {
    id: newMaterialId,
    ownerId: input.ownerId,
    kind: 'recycled_spool',
    productId: null,
    brand: input.outputSpoolBrand ?? null,
    subtype: null, // recycled output is typically mixed-resin / PLA-blend; leave untyped
    colors: resolvedColors,
    colorPattern: resolvedColorPattern,
    colorName: input.outputSpoolColorName ?? null,
    density: null,
    initialAmount: input.outputWeight,
    remainingAmount: input.outputWeight,
    unit: 'g', // recycled_spool is mass-tracked (locked in validateUnitKind matrix)
    purchaseData: undefined,
    loadedInPrinterRef: null,
    active: true,
    retirementReason: null,
    retiredAt: null,
    extra: undefined,
    createdAt: now,
  };

  // Build related-resources: one entry per tracked source + one synthetic
  // entry per untracked input keyed by recycle-event id + scrap index. This
  // lets a future timeline view show "this output came from N tracked
  // materials and M loose-scrap inputs" without losing per-row identity.
  const ledgerRelatedResources: Array<{ kind: string; id: string; role: string }> = [];
  let scrapIdx = 0;
  for (const i of inputs) {
    if (i.sourceMaterialId !== null) {
      ledgerRelatedResources.push({
        kind: 'material',
        id: i.sourceMaterialId,
        role: 'source-input',
      });
    } else {
      ledgerRelatedResources.push({
        kind: 'untracked-scrap',
        id: `${newRecycleEventId}:scrap-${scrapIdx}`,
        role: 'source-input',
      });
      scrapIdx++;
    }
  }

  const ledgerPayload = {
    inputs, // full array preserved (including null sourceMaterialIds + notes)
    outputWeight: input.outputWeight,
    sumInputs,
    weightAnomaly: anomaly,
    anomalyAck: anomaly ? input.acknowledgeWeightAnomaly === true : false,
  };

  // --- Atomic apply --------------------------------------------------------

  try {
    (db as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }).transaction((tx) => {
      const t = tx as ReturnType<typeof getServerDb>;
      // 1. Decrement each TRACKED source. Use sql template so the decrement
      //    is atomic against the row even within the tx (defense-in-depth).
      for (const i of inputs) {
        if (i.sourceMaterialId === null) continue;
        t.update(schema.materials)
          .set({ remainingAmount: sql`remaining_amount - ${i.weight}` })
          .where(eq(schema.materials.id, i.sourceMaterialId))
          .run();
      }
      // 2. Create the new recycled_spool material.
      t.insert(schema.materials).values(newMaterialRow).run();
      // 3. Link via recycle_events (full inputs JSON, including null sources).
      t.insert(schema.recycleEvents)
        .values({
          id: newRecycleEventId,
          ownerId: input.ownerId,
          inputs: inputs,
          outputSpoolId: newMaterialId,
          notes: input.notes ?? null,
          createdAt: now,
        })
        .run();
      // 4. Record ledger event.
      t.insert(schema.ledgerEvents)
        .values({
          id: ledgerEventId,
          kind: 'material.recycled',
          actorUserId: input.actorUserId,
          subjectType: 'material',
          subjectId: newMaterialId,
          relatedResources: ledgerRelatedResources,
          payload: JSON.stringify(ledgerPayload),
          provenanceClass: batchProvenance,
          occurredAt: null,
          ingestedAt: now,
        })
        .run();
    });

    return {
      ok: true,
      outputSpoolId: newMaterialId,
      recycleEventId: newRecycleEventId,
      ledgerEventId,
    };
  } catch (err) {
    logger.warn(
      {
        err,
        ownerId: input.ownerId,
        inputCount: inputs.length,
        outputWeight: input.outputWeight,
      },
      'applyRecycleEvent: persist failed — entire recycle rolled back',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// Re-export for downstream consumers that want the same failure shape.
export type { LifecycleFailure };
