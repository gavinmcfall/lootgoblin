/**
 * Consumption reports — V2-007a-T13.
 *
 * Aggregation query helpers over `material.consumed` ledger events (and
 * `recycle_events` for the by-outcome 'recycled' bucket) that surface the
 * provenance distribution alongside every aggregate row.
 *
 * Design decisions (LOCKED — see plan §"Consumption reports"):
 *
 * 1. **Query helpers, not SQL views.** SQLite views don't materialize and
 *    re-execute on every read; they buy nothing over a typed query helper.
 *    Migrations stay schema-only — report logic lives in code that can
 *    evolve without DB changes.
 *
 * 2. **Pure aggregation, no caching in T13.** The HTTP layer (T14) is free
 *    to add caching if v2-007a's expected hundreds-per-month volume ever
 *    exceeds what these helpers do happily in-memory.
 *
 * 3. **Time-window param is REQUIRED.** Without it, queries can fan out to
 *    unbounded all-time aggregates. Use `{since, until}` Date pair, with
 *    half-open semantics (`ingestedAt >= since AND ingestedAt < until`).
 *
 * 4. **Provenance distribution included with EVERY aggregate.** Each row
 *    returns `{value, provenance: {measured, entered, estimated, derived,
 *    computed, system}}`. The sum of provenance values equals `value`.
 *
 * 5. **Source = `material.consumed` events ONLY** for "consumption". Mix /
 *    recycle events are internal transformations and don't count as
 *    consumption-from-inventory. The ONE exception is `consumptionByOutcome`
 *    bucket 'recycled', which sums `recycle_events.inputs[].weight` for
 *    inputs with non-null sourceMaterialId — that's the inventory-leaving-
 *    inventory-as-recycle channel. Untracked scrap (sourceMaterialId=null)
 *    never was inventory and is not counted.
 *
 * 6. **`totalConsumption` = print-output + waste only.** Recycled is a
 *    transformation back into inventory (a recycled_spool material is
 *    created), not terminal consumption. The UI surfaces "consumed: X" and
 *    "recycled: Y" as separate metrics.
 *
 * 7. **Brand/color/printer attribution joins to the source Material row at
 *    report time.** `loadedInPrinterRef` is the "what printer ate this"
 *    attribution. Caveat: if a material is unloaded then re-loaded, the
 *    snapshot at consumption time may differ from the current snapshot.
 *    v2-007a does not denormalize printer attribution onto the ledger
 *    payload — a follow-up task (when print-job FKs land) can revisit.
 *
 * 8. **Owner-scoping is enforced in every query.** Cross-owner data is
 *    excluded by joining to `materials.ownerId = ownerId` (and for the
 *    recycle path, `recycle_events.ownerId = ownerId`).
 *
 * Aggregation strategy:
 *
 *   - Pull all `material.consumed` ledger events for the owner in the
 *     window via a join on subjectId → materials.id (which carries
 *     ownerId). Parse each payload (`payload` is a TEXT column holding a
 *     JSON document).
 *   - Bucket into `Map<keyJSON, mutableAccumulator>` by the relevant key.
 *   - On each event, increment `value`, the matching `provenance[class]`,
 *     and `eventCount`. Track unit; promote to 'mixed' if a bucket sees
 *     both 'g' and 'ml'.
 *   - Convert Map → sorted array using the per-report sort order.
 */

import { and, eq, gte, lt } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import type { MaterialUnit } from '../db/schema.materials';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProvenanceBreakdown {
  measured: number;
  entered: number;
  estimated: number;
  derived: number;
  computed: number;
  system: number;
}

export type AggregateUnit = MaterialUnit | 'mixed';

export interface ConsumptionAggregateRow<TKey> {
  key: TKey;
  totalAmount: number;
  unit: AggregateUnit;
  provenance: ProvenanceBreakdown;
  /** Number of underlying source events the aggregate was computed from. */
  eventCount: number;
}

export interface TimeWindow {
  since: Date;
  until: Date;
}

export type BrandKey = { brand: string | null };
export type ColorKey = { primaryColor: string | null };
export type PrinterKey = { printerRef: string | null };
export type OutcomeKey = { outcome: 'print-output' | 'waste' | 'recycled' };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ALL_PROVENANCE_KEYS: ReadonlyArray<keyof ProvenanceBreakdown> = [
  'measured',
  'entered',
  'estimated',
  'derived',
  'computed',
  'system',
];

function emptyProvenance(): ProvenanceBreakdown {
  return {
    measured: 0,
    entered: 0,
    estimated: 0,
    derived: 0,
    computed: 0,
    system: 0,
  };
}

interface MutableAccumulator {
  totalAmount: number;
  unit: AggregateUnit | null;
  provenance: ProvenanceBreakdown;
  eventCount: number;
}

function newAccumulator(): MutableAccumulator {
  return {
    totalAmount: 0,
    unit: null,
    provenance: emptyProvenance(),
    eventCount: 0,
  };
}

function bumpUnit(
  current: AggregateUnit | null,
  next: string | null | undefined,
): AggregateUnit | null {
  if (next !== 'g' && next !== 'ml') return current;
  if (current === null) return next;
  if (current === next) return current;
  return 'mixed';
}

/**
 * Increment an accumulator by a single observation.
 *
 * `provenanceClass` may be any of the six classes. Unknown / missing
 * classes are ignored (they should not occur in practice — T12 ledger
 * validation enforces a per-event-kind enum).
 */
function increment(
  acc: MutableAccumulator,
  amount: number,
  provenanceClass: string | null | undefined,
  unit: string | null | undefined,
): void {
  acc.totalAmount += amount;
  acc.eventCount += 1;
  acc.unit = bumpUnit(acc.unit, unit);
  if (
    provenanceClass !== null &&
    provenanceClass !== undefined &&
    (ALL_PROVENANCE_KEYS as readonly string[]).includes(provenanceClass)
  ) {
    const k = provenanceClass as keyof ProvenanceBreakdown;
    acc.provenance[k] += amount;
  }
}

function finalize<TKey>(
  key: TKey,
  acc: MutableAccumulator,
): ConsumptionAggregateRow<TKey> {
  return {
    key,
    totalAmount: acc.totalAmount,
    unit: acc.unit ?? 'g', // empty bucket: pick a default; in practice no row ships empty
    provenance: acc.provenance,
    eventCount: acc.eventCount,
  };
}

/** Shape of the consumption-event payload (from T8). Keys we care about: */
interface ConsumedPayload {
  weightConsumed?: number;
  unit?: string;
  attributedTo?: { kind?: string };
  subtype?: string;
}

/**
 * Materials cached during one report invocation. Avoids N+1 lookups when the
 * same materialId reappears across many ledger events. Built once per call.
 */
type MaterialLite = Pick<
  typeof schema.materials.$inferSelect,
  'id' | 'ownerId' | 'brand' | 'colors' | 'unit'
> & {
  // V2-005f-CF-1 T_g1: stub — materials.loaded_in_printer_ref was dropped in
  // migration 0030. T_g4 will populate this from a LEFT JOIN to the current
  // open `printer_loadouts` row; for now reports always see null and the
  // per-printer bucket aggregation below routes through the `null` bucket.
  loadedInPrinterRef: string | null;
};

async function fetchOwnedConsumptionEvents(
  ownerId: string,
  window: TimeWindow,
  dbUrl: string | undefined,
): Promise<
  Array<{
    materialId: string;
    payload: ConsumedPayload;
    provenanceClass: string | null;
    material: MaterialLite;
  }>
> {
  const db = getServerDb(dbUrl);
  const rows = await db
    .select({
      ledgerSubjectId: schema.ledgerEvents.subjectId,
      payload: schema.ledgerEvents.payload,
      provenanceClass: schema.ledgerEvents.provenanceClass,
      materialId: schema.materials.id,
      ownerId: schema.materials.ownerId,
      brand: schema.materials.brand,
      colors: schema.materials.colors,
      unit: schema.materials.unit,
    })
    .from(schema.ledgerEvents)
    .innerJoin(
      schema.materials,
      eq(schema.materials.id, schema.ledgerEvents.subjectId),
    )
    .where(
      and(
        eq(schema.ledgerEvents.kind, 'material.consumed'),
        eq(schema.materials.ownerId, ownerId),
        gte(schema.ledgerEvents.ingestedAt, window.since),
        lt(schema.ledgerEvents.ingestedAt, window.until),
      ),
    );

  const out: Array<{
    materialId: string;
    payload: ConsumedPayload;
    provenanceClass: string | null;
    material: MaterialLite;
  }> = [];
  for (const r of rows) {
    let payload: ConsumedPayload = {};
    if (r.payload !== null && r.payload !== undefined) {
      try {
        payload = JSON.parse(r.payload) as ConsumedPayload;
      } catch {
        // Malformed payload — skip silently. T12 validation prevents this in
        // practice; defensive fallback keeps the report from blowing up if
        // legacy rows ever sneak in.
        continue;
      }
    }
    out.push({
      materialId: r.materialId,
      payload,
      provenanceClass: r.provenanceClass,
      material: {
        id: r.materialId,
        ownerId: r.ownerId,
        brand: r.brand,
        colors: r.colors,
        // TODO V2-005f-CF-1 T_g4: replace stub with LEFT JOIN to printer_loadouts.
        loadedInPrinterRef: null,
        unit: r.unit,
      },
    });
  }
  return out;
}

/**
 * Resolve the consumed amount for one event. Falls back to 0 when the
 * payload is malformed (defensive — should not happen post-T12).
 */
function consumedAmount(payload: ConsumedPayload): number {
  if (typeof payload.weightConsumed !== 'number' || !Number.isFinite(payload.weightConsumed)) {
    return 0;
  }
  return payload.weightConsumed;
}

function consumedUnit(
  payload: ConsumedPayload,
  fallback: string | null | undefined,
): string | null | undefined {
  return payload.unit ?? fallback;
}

// ---------------------------------------------------------------------------
// consumptionByBrand
// ---------------------------------------------------------------------------

/**
 * Total consumption per Material brand within the window.
 *
 * - Bucketing key: the brand of the material that was consumed.
 * - Materials with `brand=null` bucket under `key.brand=null` (rendered as
 *   "Unknown" by the UI).
 * - Sort order: alphabetical brand, with `null` last.
 * - The sum of provenance distribution per row equals `totalAmount`.
 */
export async function consumptionByBrand(
  args: { ownerId: string; window: TimeWindow },
  opts?: { dbUrl?: string },
): Promise<Array<ConsumptionAggregateRow<BrandKey>>> {
  const events = await fetchOwnedConsumptionEvents(args.ownerId, args.window, opts?.dbUrl);
  const buckets = new Map<string, MutableAccumulator>();
  const keyByBucket = new Map<string, BrandKey>();

  for (const ev of events) {
    const brand: string | null = ev.material.brand ?? null;
    const k = JSON.stringify({ brand });
    if (!buckets.has(k)) {
      buckets.set(k, newAccumulator());
      keyByBucket.set(k, { brand });
    }
    increment(
      buckets.get(k)!,
      consumedAmount(ev.payload),
      ev.provenanceClass,
      consumedUnit(ev.payload, ev.material.unit),
    );
  }

  const rows = [...buckets.entries()].map(([k, acc]) => finalize(keyByBucket.get(k)!, acc));
  rows.sort((a, b) => {
    if (a.key.brand === null && b.key.brand !== null) return 1;
    if (b.key.brand === null && a.key.brand !== null) return -1;
    if (a.key.brand === null && b.key.brand === null) return 0;
    return (a.key.brand as string).localeCompare(b.key.brand as string);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// consumptionByColor
// ---------------------------------------------------------------------------

/**
 * Total consumption per primary color (= `colors[0]`) within the window.
 *
 * - Bucketing key: the first hex color of the material's `colors` array.
 *   Materials with `colors` empty/null bucket under `primaryColor=null`.
 * - Sort order: alphabetical hex (uppercase comparison), with `null` last.
 *
 * For multi-color materials, only colors[0] is considered the primary
 * attribution; v2-007a does not split a single consumption event across
 * multi-section colors.
 */
export async function consumptionByColor(
  args: { ownerId: string; window: TimeWindow },
  opts?: { dbUrl?: string },
): Promise<Array<ConsumptionAggregateRow<ColorKey>>> {
  const events = await fetchOwnedConsumptionEvents(args.ownerId, args.window, opts?.dbUrl);
  const buckets = new Map<string, MutableAccumulator>();
  const keyByBucket = new Map<string, ColorKey>();

  for (const ev of events) {
    const colors = ev.material.colors;
    const primary: string | null =
      Array.isArray(colors) && colors.length > 0 && typeof colors[0] === 'string'
        ? (colors[0] as string).toUpperCase()
        : null;
    const k = JSON.stringify({ primaryColor: primary });
    if (!buckets.has(k)) {
      buckets.set(k, newAccumulator());
      keyByBucket.set(k, { primaryColor: primary });
    }
    increment(
      buckets.get(k)!,
      consumedAmount(ev.payload),
      ev.provenanceClass,
      consumedUnit(ev.payload, ev.material.unit),
    );
  }

  const rows = [...buckets.entries()].map(([k, acc]) => finalize(keyByBucket.get(k)!, acc));
  rows.sort((a, b) => {
    if (a.key.primaryColor === null && b.key.primaryColor !== null) return 1;
    if (b.key.primaryColor === null && a.key.primaryColor !== null) return -1;
    if (a.key.primaryColor === null && b.key.primaryColor === null) return 0;
    return (a.key.primaryColor as string).localeCompare(b.key.primaryColor as string);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// consumptionByPrinter
// ---------------------------------------------------------------------------

/**
 * Total consumption per loaded-in-printer reference within the window.
 *
 * - Bucketing key: the material's `loadedInPrinterRef` AT REPORT TIME.
 *   Materials with no printer attribution bucket under `printerRef=null`.
 * - Sort order: alphabetical, with `null` last.
 *
 * Caveat: `loadedInPrinterRef` reflects the current load state, not the
 * load state AT consumption time. If a material was unloaded after a print
 * the attribution may now be `null`. v2-007a does not denormalize printer
 * onto the ledger payload — a follow-up task (when print-job FKs land in
 * V2-005) can capture the at-the-time printer.
 */
export async function consumptionByPrinter(
  args: { ownerId: string; window: TimeWindow },
  opts?: { dbUrl?: string },
): Promise<Array<ConsumptionAggregateRow<PrinterKey>>> {
  const events = await fetchOwnedConsumptionEvents(args.ownerId, args.window, opts?.dbUrl);
  const buckets = new Map<string, MutableAccumulator>();
  const keyByBucket = new Map<string, PrinterKey>();

  for (const ev of events) {
    const printerRef: string | null = ev.material.loadedInPrinterRef ?? null;
    const k = JSON.stringify({ printerRef });
    if (!buckets.has(k)) {
      buckets.set(k, newAccumulator());
      keyByBucket.set(k, { printerRef });
    }
    increment(
      buckets.get(k)!,
      consumedAmount(ev.payload),
      ev.provenanceClass,
      consumedUnit(ev.payload, ev.material.unit),
    );
  }

  const rows = [...buckets.entries()].map(([k, acc]) => finalize(keyByBucket.get(k)!, acc));
  rows.sort((a, b) => {
    if (a.key.printerRef === null && b.key.printerRef !== null) return 1;
    if (b.key.printerRef === null && a.key.printerRef !== null) return -1;
    if (a.key.printerRef === null && b.key.printerRef === null) return 0;
    return (a.key.printerRef as string).localeCompare(b.key.printerRef as string);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// consumptionByOutcome
// ---------------------------------------------------------------------------

/**
 * Three-way split of "where did the inventory go?".
 *
 * Buckets (always returned in this order):
 *   - 'print-output' — `material.consumed` events with attributedTo.kind='print'.
 *   - 'waste'        — `material.consumed` events with payload.subtype='waste'.
 *   - 'recycled'     — `recycle_events.inputs[].weight` for inputs with a
 *                      non-null sourceMaterialId. Inputs with sourceMaterialId
 *                      === null (untracked loose scrap) are NOT counted —
 *                      they were never inventory.
 *
 * Notes:
 *   - The 'recycled' bucket is split here for visibility but is more accurately
 *     a transformation back into inventory (a recycled_spool material is
 *     created). `totalConsumption` does NOT include 'recycled'.
 *   - Recycle events use `createdAt` for the time-window predicate (recycle
 *     events do not carry an `occurredAt`).
 *
 * Each input contributes by its own `provenanceClass`. A recycle event with
 * three inputs spanning measured / entered / estimated produces three rows
 * of provenance increment within the same 'recycled' bucket.
 */
export async function consumptionByOutcome(
  args: { ownerId: string; window: TimeWindow },
  opts?: { dbUrl?: string },
): Promise<Array<ConsumptionAggregateRow<OutcomeKey>>> {
  const events = await fetchOwnedConsumptionEvents(args.ownerId, args.window, opts?.dbUrl);

  // Each outcome gets its own accumulator. Always present; empty buckets
  // ship with totalAmount=0 / eventCount=0 / empty provenance — caller can
  // filter on totalAmount>0 if desired.
  const printOutput = newAccumulator();
  const waste = newAccumulator();
  const recycled = newAccumulator();

  for (const ev of events) {
    const kind = ev.payload.attributedTo?.kind;
    const subtype = ev.payload.subtype;
    const amount = consumedAmount(ev.payload);
    const unit = consumedUnit(ev.payload, ev.material.unit);
    if (subtype === 'waste') {
      increment(waste, amount, ev.provenanceClass, unit);
    } else if (kind === 'print') {
      increment(printOutput, amount, ev.provenanceClass, unit);
    }
    // Defensive: events with neither subtype='waste' nor attributedTo.kind='print'
    // are dropped from the by-outcome split. T8 guarantees one of the two
    // applies; this branch protects future event kinds.
  }

  // Recycle path: pull recycle_events for the owner in the window.
  const db = getServerDb(opts?.dbUrl);
  const recycleRows = await db
    .select()
    .from(schema.recycleEvents)
    .where(
      and(
        eq(schema.recycleEvents.ownerId, args.ownerId),
        gte(schema.recycleEvents.createdAt, args.window.since),
        lt(schema.recycleEvents.createdAt, args.window.until),
      ),
    );

  // Recycle output material is always 'g' per T6 contract; recycle inputs
  // can be from filament (g) or resin (ml) sources but in practice the
  // recycle flow accepts only g-tracked sources. We still bump unit per
  // input from the source material's unit when we can resolve it.
  // For perf, batch-fetch source-material units in one SELECT.
  const sourceMaterialIds = new Set<string>();
  for (const re of recycleRows) {
    if (!Array.isArray(re.inputs)) continue;
    for (const inp of re.inputs) {
      if (inp.sourceMaterialId !== null && inp.sourceMaterialId !== undefined) {
        sourceMaterialIds.add(inp.sourceMaterialId);
      }
    }
  }
  let sourceUnits = new Map<string, MaterialUnit>();
  if (sourceMaterialIds.size > 0) {
    const rows = await db
      .select({ id: schema.materials.id, unit: schema.materials.unit })
      .from(schema.materials);
    sourceUnits = new Map(
      rows
        .filter((r) => sourceMaterialIds.has(r.id))
        .map((r) => [r.id, r.unit as MaterialUnit]),
    );
  }

  for (const re of recycleRows) {
    if (!Array.isArray(re.inputs)) continue;
    for (const inp of re.inputs) {
      if (inp.sourceMaterialId === null || inp.sourceMaterialId === undefined) continue;
      const w = typeof inp.weight === 'number' && Number.isFinite(inp.weight) ? inp.weight : 0;
      const provClass = typeof inp.provenanceClass === 'string' ? inp.provenanceClass : null;
      const unit = sourceUnits.get(inp.sourceMaterialId) ?? 'g';
      increment(recycled, w, provClass, unit);
    }
  }

  // Fixed order: print-output, waste, recycled.
  return [
    finalize<OutcomeKey>({ outcome: 'print-output' }, printOutput),
    finalize<OutcomeKey>({ outcome: 'waste' }, waste),
    finalize<OutcomeKey>({ outcome: 'recycled' }, recycled),
  ];
}

// ---------------------------------------------------------------------------
// totalConsumption
// ---------------------------------------------------------------------------

/**
 * Single-row aggregate of TERMINAL consumption from inventory in the window.
 *
 * `totalConsumption` = print-output + waste only. Recycled is a transformation
 * back into inventory (a recycled_spool material is created), and the UI
 * surfaces it as a separate metric — see `consumptionByOutcome`. Including
 * recycle here would double-count: the recycle decrements show up as
 * decrements on source materials, but the recycled output spool increments
 * back when its mass is created. Net inventory loss from recycling is zero
 * (modulo expected loss + virgin-stock additions, which T6 handles).
 *
 * Returns one row with `key=null` so the shape stays homogeneous with the
 * other report functions.
 */
export async function totalConsumption(
  args: { ownerId: string; window: TimeWindow },
  opts?: { dbUrl?: string },
): Promise<ConsumptionAggregateRow<null>> {
  const events = await fetchOwnedConsumptionEvents(args.ownerId, args.window, opts?.dbUrl);
  const acc = newAccumulator();
  for (const ev of events) {
    increment(
      acc,
      consumedAmount(ev.payload),
      ev.provenanceClass,
      consumedUnit(ev.payload, ev.material.unit),
    );
  }
  return finalize<null>(null, acc);
}
