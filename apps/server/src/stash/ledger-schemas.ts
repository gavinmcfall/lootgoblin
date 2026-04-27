/**
 * ledger-schemas.ts — Per-event-type Zod payload schemas (V2-007a-T12).
 *
 * Goals
 * -----
 * Every state-changing action in lootgoblin produces a `LedgerEvent`. Each
 * `kind` has a documented payload shape, and that shape is validated at the
 * `persistLedgerEvent` boundary BEFORE the row is written. Schemas are the
 * source of truth: a payload that doesn't match its registered schema is a
 * caller bug.
 *
 * Behaviour
 * ---------
 *   - Lookup is O(1) via Map.
 *   - Unknown kinds pass through (no schema registered → assumed forward
 *     compat; future plans register their kinds via `registerLedgerEventSchema`).
 *   - When a registered kind FAILS validation, `persistLedgerEvent` logs warn
 *     and returns `{ eventId: null }` without writing. Caller's atomic-rollback
 *     contract (where applicable) engages.
 *
 * Provenance rule (T12 + T3)
 * --------------------------
 * Numeric fields representing measurable quantities live next to a
 * `provenanceClass`:
 *   - Top-level event provenance is the LedgerEvent.provenanceClass column
 *     (see ledger.ts). T12 schemas don't duplicate it inside the payload.
 *   - When the payload contains an array of contributions (mix draws, recycle
 *     inputs), EACH item carries its own `provenanceClass` and is validated
 *     here.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

const PROVENANCE_CLASS = z.enum([
  'measured',
  'entered',
  'estimated',
  'derived',
  'computed',
  'system',
]);

const MATERIAL_KIND = z.enum([
  'filament_spool',
  'resin_bottle',
  'mix_batch',
  'recycled_spool',
  'other',
]);

const COLOR_PATTERN = z.enum(['solid', 'dual-tone', 'gradient', 'multi-section']);

const UNIT = z.enum(['g', 'ml']);

// ---------------------------------------------------------------------------
// Stash schemas (V2-002 + V2-007a follow-on)
// ---------------------------------------------------------------------------

/**
 * Manifest from bulk-restructure.ts — `{applied, skipped, failed}` arrays of
 * loot ids. Kept loose (`z.unknown()`-shaped object) so future manifest
 * extensions don't trip the validator.
 */
const BulkManifest = z.unknown();

const BulkMoveToCollectionPayload = z.object({
  action: z.object({
    kind: z.literal('move-to-collection'),
    targetCollectionId: z.string(),
  }),
  manifest: BulkManifest,
  timestamp: z.string(),
});

const BulkChangeTemplatePayload = z.object({
  action: z.object({
    kind: z.literal('change-template'),
    newTemplate: z.string(),
  }),
  manifest: BulkManifest,
  timestamp: z.string(),
});

const ReconcilerRemovedExternallyPayload = z.object({
  lootId: z.string(),
  path: z.string(),
});

const ReconcilerContentChangedPayload = z.object({
  lootId: z.string(),
  path: z.string(),
  newHash: z.string(),
  newSize: z.number().int().nonnegative(),
});

/**
 * Template-migration emits this kind from `template-migration.ts`. Production
 * payload: `{lootFileId, collectionId, oldPath, newPath, timestamp}`.
 */
const MigrationExecutePayload = z.object({
  lootFileId: z.string(),
  collectionId: z.string(),
  oldPath: z.string(),
  newPath: z.string(),
  timestamp: z.string(),
});

// ---------------------------------------------------------------------------
// Materials schemas (V2-007a)
// ---------------------------------------------------------------------------

const MaterialAddedPayload = z.object({
  initialAmount: z.number().positive(),
  unit: UNIT,
  kind: MATERIAL_KIND,
  brand: z.string().nullable().optional(),
  subtype: z.string().nullable().optional(),
  // colors is an array of hex strings; nullable to mirror the column.
  colors: z.array(z.string()).nullable().optional(),
  colorPattern: COLOR_PATTERN.nullable().optional(),
});

const MaterialRetiredPayload = z.object({
  retirementReason: z.string(),
  remainingAtRetirement: z.number(),
  kind: MATERIAL_KIND,
});

const MaterialLoadedPayload = z.object({
  printerRef: z.string(),
});

const MaterialUnloadedPayload = z.object({
  printerRef: z.string(),
});

const MixDraw = z.object({
  sourceMaterialId: z.string(),
  drawAmount: z.number().positive(),
  provenanceClass: PROVENANCE_CLASS,
});

const MaterialMixCreatedPayload = z.object({
  totalVolume: z.number().positive(),
  unit: z.literal('ml'),
  perComponentDraws: z.array(MixDraw).min(2).max(10),
});

const RecycleInput = z.object({
  // Tracked source = string; untracked loose scrap = null.
  sourceMaterialId: z.string().nullable(),
  weight: z.number().positive(),
  provenanceClass: PROVENANCE_CLASS,
  note: z.string().optional(),
});

const MaterialRecycledPayload = z.object({
  inputs: z.array(RecycleInput).min(1).max(20),
  outputWeight: z.number().positive(),
  // Recycle handler also writes `sumInputs` for downstream readers (the sum
  // of input weights, computed once at apply time). Optional in the schema
  // because future writers might omit it; recycle.ts itself always writes it.
  sumInputs: z.number().nonnegative().optional(),
  weightAnomaly: z.boolean(),
  anomalyAck: z.boolean(),
});

const MaterialConsumedPayload = z.object({
  weightConsumed: z.number().positive(),
  unit: UNIT,
  attributedTo: z.object({
    kind: z.enum(['print', 'purge', 'priming', 'failed-print', 'waste']),
    jobId: z.string().optional(),
    lootId: z.string().optional(),
    note: z.string().optional(),
  }),
  // Set by consumption.ts when attributedTo.kind ∈ {purge, priming, failed-print, waste}.
  // `undefined` for kind=print. Zod accepts missing OR literal 'waste'.
  subtype: z.literal('waste').optional(),
  source: z.enum(['forge:dispatch', 'forge:scale-reading', 'manual-entry']),
  newRemainingAmount: z.number(),
  reconciliationNeeded: z.boolean(),
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const ledgerEventSchemas = new Map<string, z.ZodTypeAny>([
  // Stash
  ['bulk.move-to-collection', BulkMoveToCollectionPayload],
  ['bulk.change-template', BulkChangeTemplatePayload],
  ['reconciler.removed-externally', ReconcilerRemovedExternallyPayload],
  ['reconciler.content-changed', ReconcilerContentChangedPayload],
  ['migration.execute', MigrationExecutePayload],
  // Materials
  ['material.added', MaterialAddedPayload],
  ['material.retired', MaterialRetiredPayload],
  ['material.loaded', MaterialLoadedPayload],
  ['material.unloaded', MaterialUnloadedPayload],
  ['material.mix_created', MaterialMixCreatedPayload],
  ['material.recycled', MaterialRecycledPayload],
  ['material.consumed', MaterialConsumedPayload],
]);

/**
 * Register a schema for a new event kind. Future plans (V2-005 Forge,
 * V2-006 Courier, V3 Patreon, etc.) call this from their own modules so this
 * file doesn't grow per-pillar.
 *
 * Re-registering an existing kind overwrites the schema (last writer wins);
 * that's intentional for tests but should not happen in production code.
 */
export function registerLedgerEventSchema(kind: string, schema: z.ZodTypeAny): void {
  ledgerEventSchemas.set(kind, schema);
}

/** Look up the schema for a kind. Returns null when unregistered. */
export function getLedgerEventSchema(kind: string): z.ZodTypeAny | null {
  return ledgerEventSchemas.get(kind) ?? null;
}

/** Snapshot of registered kinds — used by tests. */
export function listRegisteredLedgerEventKinds(): string[] {
  return [...ledgerEventSchemas.keys()];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type LedgerPayloadValidation =
  | { ok: true }
  | { ok: false; issues: string[] };

/**
 * Validate a payload against the schema registered for `kind`.
 *
 * - Unknown kind → `{ok: true}` (forward compat; no schema yet).
 * - `payload === undefined` → `{ok: true}` (LedgerEvent.payload is optional;
 *   schemas only apply to events that carry a payload).
 * - Registered + present + invalid → `{ok: false, issues}`.
 */
export function validateLedgerEventPayload(
  kind: string,
  payload: unknown,
): LedgerPayloadValidation {
  if (payload === undefined || payload === null) return { ok: true };
  const schema = getLedgerEventSchema(kind);
  if (!schema) return { ok: true };
  const result = schema.safeParse(payload);
  if (result.success) return { ok: true };
  return {
    ok: false,
    issues: result.error.issues.map(
      (iss) => `${iss.path.join('.') || '<root>'}: ${iss.message}`,
    ),
  };
}
