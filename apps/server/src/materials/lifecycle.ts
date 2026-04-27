/**
 * Material lifecycle — V2-007a-T4.
 *
 * Pure-domain functions that mutate Material rows + record matching ledger
 * events. The HTTP surface (T14) wires routes to these; T5/T6/T7 (mix,
 * recycle, retire flows) and T8 (consumption handler) compose them.
 *
 * Validation discipline:
 *   - Every function returns a discriminated union — `{ ok: true, ... }`
 *     on success, `{ ok: false, reason, details? }` on validation failure.
 *   - We THROW only on programming errors (DB connection lost, etc).
 *
 * Atomicity divergence from V2-002 ledger pattern:
 *   - persistLedgerEvent (V2-002-T13) is fire-and-continue: a ledger
 *     write failure must never block the primary op (e.g. a reconciler
 *     drift log shouldn't fail an already-completed move).
 *   - Material lifecycle is the OPPOSITE: the ledger event IS the audit
 *     trail of the state mutation. We require atomicity — Material insert
 *     + ledger insert happen inside ONE better-sqlite3 sync transaction.
 *     If the ledger insert fails, the Material row is rolled back; the
 *     caller sees `{ok: false, reason: 'persist-failed'}` and may retry.
 *
 * Stubs:
 *   - V2-005 active-dispatch check is injected via `checkActiveDispatches`;
 *     the default is a no-op `{ exists: false, jobIds: [] }`. T15 e2e
 *     tests or V2-005 wires the real check against `dispatch_jobs`.
 *   - `loadedInPrinterRef` is opaque to T4 — we treat it as a string
 *     (e.g. `'bambu-x1c-#1:tray-2'`). Cross-printer slot semantics are
 *     deferred to V2-005 Forge.
 */

import * as crypto from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import { logger } from '../logger';
import type { ColorPattern, MaterialKind, MaterialUnit } from '../db/schema.materials';
import { validateColors, validateUnitKind } from './validate';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateMaterialInput {
  ownerId: string;
  kind: MaterialKind;
  brand?: string;
  subtype?: string;
  colors: string[];
  colorPattern: ColorPattern;
  colorName?: string;
  density?: number;
  initialAmount: number;
  unit: MaterialUnit;
  purchaseData?: Record<string, unknown>;
  productId?: string | null;
  extra?: Record<string, unknown>;
}

export interface CreateMaterialResult {
  ok: true;
  material: typeof schema.materials.$inferSelect;
  ledgerEventId: string;
}

export type LifecycleFailure = { ok: false; reason: string; details?: string };

export interface RetireMaterialInput {
  materialId: string;
  actorUserId: string;
  retirementReason: string;
  acknowledgeLoaded?: boolean;
}

export interface LoadInPrinterInput {
  materialId: string;
  actorUserId: string;
  printerRef: string;
}

export interface UnloadFromPrinterInput {
  materialId: string;
  actorUserId: string;
}

/**
 * Stub injected by V2-005 Forge to check whether a Material is referenced
 * by an active (queued or running) dispatch_job. T4 default returns "no
 * active dispatches" — it's the caller's responsibility to wire the real
 * implementation when the Forge tables exist.
 */
export type ActiveDispatchChecker = (
  materialId: string,
) => Promise<{ exists: boolean; jobIds: string[] }>;

const NOOP_DISPATCH_CHECKER: ActiveDispatchChecker = async () => ({
  exists: false,
  jobIds: [],
});

// ---------------------------------------------------------------------------
// createMaterial
// ---------------------------------------------------------------------------

/**
 * Create a Material row + matching `material.added` ledger event in one
 * sync transaction. `remainingAmount` is force-set equal to `initialAmount`
 * (the caller cannot override).
 *
 * Reason codes (validation):
 *   colors-*               — see validateColors
 *   color-pattern-*        — see validateColors
 *   kind-invalid           — kind not in MATERIAL_KINDS
 *   unit-invalid           — unit not in MATERIAL_UNITS
 *   unit-kind-mismatch     — incompatible (unit, kind) per matrix
 *   initial-amount-invalid — initialAmount <= 0 or non-finite
 *   owner-required         — ownerId blank
 *   persist-failed         — DB insert raised (programming/infra error)
 */
export async function createMaterial(
  input: CreateMaterialInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<CreateMaterialResult | LifecycleFailure> {
  // --- Pre-DB validation ---------------------------------------------------

  if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    return { ok: false, reason: 'owner-required' };
  }

  const unitKind = validateUnitKind(input.unit, input.kind);
  if (!unitKind.ok) return unitKind;

  const colorCheck = validateColors(input.colors, input.colorPattern);
  if (!colorCheck.ok) return colorCheck;

  if (
    typeof input.initialAmount !== 'number' ||
    !Number.isFinite(input.initialAmount) ||
    input.initialAmount <= 0
  ) {
    return { ok: false, reason: 'initial-amount-invalid' };
  }

  // --- Build the row -------------------------------------------------------

  const id = crypto.randomUUID();
  const ledgerEventId = crypto.randomUUID();
  const now = opts?.now ?? new Date();

  const row: typeof schema.materials.$inferInsert = {
    id,
    ownerId: input.ownerId,
    kind: unitKind.kind,
    productId: input.productId ?? null,
    brand: input.brand ?? null,
    subtype: input.subtype ?? null,
    colors: colorCheck.colors,
    colorPattern: colorCheck.colorPattern,
    colorName: input.colorName ?? null,
    density: input.density ?? null,
    initialAmount: input.initialAmount,
    remainingAmount: input.initialAmount, // force-set: caller cannot override
    unit: unitKind.unit,
    purchaseData: input.purchaseData,
    loadedInPrinterRef: null,
    active: true,
    retirementReason: null,
    retiredAt: null,
    extra: input.extra,
    createdAt: now,
  };

  const ledgerPayload = {
    initialAmount: input.initialAmount,
    unit: unitKind.unit,
    kind: unitKind.kind,
    brand: input.brand ?? null,
    subtype: input.subtype ?? null,
    colors: colorCheck.colors,
    colorPattern: colorCheck.colorPattern,
  };

  // --- Atomic insert (Material + ledger event) ----------------------------

  try {
    const db = getServerDb(opts?.dbUrl);
    const inserted = (
      db as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }
    ).transaction((tx) => {
      const t = tx as ReturnType<typeof getServerDb>;
      t.insert(schema.materials).values(row).run();
      t.insert(schema.ledgerEvents)
        .values({
          id: ledgerEventId,
          kind: 'material.added',
          actorUserId: input.ownerId,
          subjectType: 'material',
          subjectId: id,
          relatedResources: null,
          payload: JSON.stringify(ledgerPayload),
          provenanceClass: 'entered',
          occurredAt: null,
          ingestedAt: now,
        })
        .run();
      const fetched = t
        .select()
        .from(schema.materials)
        .where(eq(schema.materials.id, id))
        .all();
      return fetched[0]!;
    });

    return { ok: true, material: inserted, ledgerEventId };
  } catch (err) {
    logger.warn(
      {
        err,
        materialId: id,
        ownerId: input.ownerId,
        kind: unitKind.kind,
      },
      'createMaterial: persist failed — Material + ledger rolled back',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// retireMaterial
// ---------------------------------------------------------------------------

/**
 * Retire a Material. Sets `active=false`, records `retirementReason` and
 * `retiredAt`. `remainingAmount` is preserved (historical reporting).
 * `loadedInPrinterRef` is left as-is — V2-005 will handle physical unload
 * via dispatch reconciliation.
 *
 * Reason codes:
 *   material-not-found            — no row with that id
 *   already-retired               — active=false already
 *   loaded-in-printer-no-ack      — loadedInPrinterRef set but caller did
 *                                   not pass acknowledgeLoaded:true
 *   active-dispatch               — V2-005 stub returned {exists:true}
 *   persist-failed                — DB raised
 */
export async function retireMaterial(
  input: RetireMaterialInput,
  opts?: {
    dbUrl?: string;
    now?: Date;
    checkActiveDispatches?: ActiveDispatchChecker;
  },
): Promise<{ ok: true; ledgerEventId: string } | LifecycleFailure> {
  if (typeof input.materialId !== 'string' || input.materialId.length === 0) {
    return { ok: false, reason: 'material-id-required' };
  }
  if (typeof input.retirementReason !== 'string' || input.retirementReason.length === 0) {
    return { ok: false, reason: 'reason-required' };
  }

  const db = getServerDb(opts?.dbUrl);
  const existing = await db
    .select()
    .from(schema.materials)
    .where(eq(schema.materials.id, input.materialId));

  if (existing.length === 0) {
    return { ok: false, reason: 'material-not-found' };
  }
  const current = existing[0]!;

  if (current.active === false) {
    return { ok: false, reason: 'already-retired' };
  }

  if (current.loadedInPrinterRef !== null && input.acknowledgeLoaded !== true) {
    return { ok: false, reason: 'loaded-in-printer-no-ack' };
  }

  // V2-005 dispatch check — defaults to no-op until Forge ships.
  // TODO(V2-005): pass the real Forge dispatch checker from the HTTP layer.
  const dispatchChecker = opts?.checkActiveDispatches ?? NOOP_DISPATCH_CHECKER;
  const dispatch = await dispatchChecker(input.materialId);
  if (dispatch.exists) {
    return {
      ok: false,
      reason: 'active-dispatch',
      details: `active dispatches: ${dispatch.jobIds.join(', ')}`,
    };
  }

  const now = opts?.now ?? new Date();
  const ledgerEventId = crypto.randomUUID();

  const ledgerPayload = {
    retirementReason: input.retirementReason,
    remainingAtRetirement: current.remainingAmount,
    kind: current.kind,
  };

  try {
    (db as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }).transaction((tx) => {
      const t = tx as ReturnType<typeof getServerDb>;
      t.update(schema.materials)
        .set({
          active: false,
          retirementReason: input.retirementReason,
          retiredAt: now,
        })
        .where(eq(schema.materials.id, input.materialId))
        .run();
      t.insert(schema.ledgerEvents)
        .values({
          id: ledgerEventId,
          kind: 'material.retired',
          actorUserId: input.actorUserId,
          subjectType: 'material',
          subjectId: input.materialId,
          relatedResources: null,
          payload: JSON.stringify(ledgerPayload),
          provenanceClass: 'entered',
          occurredAt: null,
          ingestedAt: now,
        })
        .run();
    });
    return { ok: true, ledgerEventId };
  } catch (err) {
    logger.warn(
      { err, materialId: input.materialId },
      'retireMaterial: persist failed — update + ledger rolled back',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// loadInPrinter
// ---------------------------------------------------------------------------

/**
 * Mark a Material as loaded in a printer. For `kind='filament_spool'`, we
 * additionally enforce that no OTHER active filament spool of the same
 * owner is loaded at the same `printerRef`. This is an app-layer constraint
 * — no DB UNIQUE constraint exists because the field is sparse and the
 * uniqueness scope depends on `kind`.
 *
 * Reason codes:
 *   material-id-required
 *   printer-ref-required
 *   material-not-found
 *   material-retired
 *   printer-slot-occupied         — filament_spool conflict on same owner+printerRef
 *   persist-failed
 */
export async function loadInPrinter(
  input: LoadInPrinterInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<{ ok: true; ledgerEventId: string } | LifecycleFailure> {
  if (typeof input.materialId !== 'string' || input.materialId.length === 0) {
    return { ok: false, reason: 'material-id-required' };
  }
  if (typeof input.printerRef !== 'string' || input.printerRef.length === 0) {
    return { ok: false, reason: 'printer-ref-required' };
  }

  const db = getServerDb(opts?.dbUrl);
  const existing = await db
    .select()
    .from(schema.materials)
    .where(eq(schema.materials.id, input.materialId));

  if (existing.length === 0) {
    return { ok: false, reason: 'material-not-found' };
  }
  const current = existing[0]!;
  if (current.active === false) {
    return { ok: false, reason: 'material-retired' };
  }

  // Filament-spool exclusivity check (per owner + printerRef). Resin bottles
  // and other kinds intentionally skip this — V2-005 may extend later.
  if (current.kind === 'filament_spool') {
    const conflicts = await db
      .select({ id: schema.materials.id })
      .from(schema.materials)
      .where(
        and(
          eq(schema.materials.ownerId, current.ownerId),
          eq(schema.materials.kind, 'filament_spool'),
          eq(schema.materials.active, true),
          eq(schema.materials.loadedInPrinterRef, input.printerRef),
          ne(schema.materials.id, input.materialId),
        ),
      );
    if (conflicts.length > 0) {
      return {
        ok: false,
        reason: 'printer-slot-occupied',
        details: `conflicting material id: ${conflicts[0]!.id}`,
      };
    }
  }

  const now = opts?.now ?? new Date();
  const ledgerEventId = crypto.randomUUID();

  try {
    (db as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }).transaction((tx) => {
      const t = tx as ReturnType<typeof getServerDb>;
      t.update(schema.materials)
        .set({ loadedInPrinterRef: input.printerRef })
        .where(eq(schema.materials.id, input.materialId))
        .run();
      t.insert(schema.ledgerEvents)
        .values({
          id: ledgerEventId,
          kind: 'material.loaded',
          actorUserId: input.actorUserId,
          subjectType: 'material',
          subjectId: input.materialId,
          relatedResources: null,
          payload: JSON.stringify({ printerRef: input.printerRef }),
          provenanceClass: 'entered',
          occurredAt: null,
          ingestedAt: now,
        })
        .run();
    });
    return { ok: true, ledgerEventId };
  } catch (err) {
    logger.warn(
      { err, materialId: input.materialId, printerRef: input.printerRef },
      'loadInPrinter: persist failed — update + ledger rolled back',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// unloadFromPrinter
// ---------------------------------------------------------------------------

/**
 * Clear `loadedInPrinterRef` on a Material. The previous value is captured
 * in the ledger event payload + return value (so callers / V2-005 can
 * correlate without re-querying).
 *
 * Reason codes:
 *   material-id-required
 *   material-not-found
 *   not-loaded                   — loadedInPrinterRef is already NULL
 *   persist-failed
 */
export async function unloadFromPrinter(
  input: UnloadFromPrinterInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<
  | { ok: true; ledgerEventId: string; previousPrinterRef: string | null }
  | LifecycleFailure
> {
  if (typeof input.materialId !== 'string' || input.materialId.length === 0) {
    return { ok: false, reason: 'material-id-required' };
  }

  const db = getServerDb(opts?.dbUrl);
  const existing = await db
    .select()
    .from(schema.materials)
    .where(eq(schema.materials.id, input.materialId));

  if (existing.length === 0) {
    return { ok: false, reason: 'material-not-found' };
  }
  const current = existing[0]!;
  if (current.loadedInPrinterRef === null) {
    return { ok: false, reason: 'not-loaded' };
  }

  const previous = current.loadedInPrinterRef;
  const now = opts?.now ?? new Date();
  const ledgerEventId = crypto.randomUUID();

  try {
    (db as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }).transaction((tx) => {
      const t = tx as ReturnType<typeof getServerDb>;
      t.update(schema.materials)
        .set({ loadedInPrinterRef: null })
        .where(eq(schema.materials.id, input.materialId))
        .run();
      t.insert(schema.ledgerEvents)
        .values({
          id: ledgerEventId,
          kind: 'material.unloaded',
          actorUserId: input.actorUserId,
          subjectType: 'material',
          subjectId: input.materialId,
          relatedResources: null,
          payload: JSON.stringify({ printerRef: previous }),
          provenanceClass: 'entered',
          occurredAt: null,
          ingestedAt: now,
        })
        .run();
    });
    return { ok: true, ledgerEventId, previousPrinterRef: previous };
  } catch (err) {
    logger.warn(
      { err, materialId: input.materialId },
      'unloadFromPrinter: persist failed — update + ledger rolled back',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}
