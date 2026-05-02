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
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import { logger } from '../logger';
import type { ColorPattern, MaterialKind, MaterialUnit } from '../db/schema.materials';
import { resolveCatalogProduct, validateColors, validateUnitKind } from './validate';
import { persistLedgerEventInTx, type LedgerTxHandle } from '../stash/ledger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateMaterialInput {
  ownerId: string;
  kind: MaterialKind;
  brand?: string;
  subtype?: string;
  /**
   * 1-4 hex colors. Required for manual entry (productId NULL). Optional when
   * `productId` is provided — the catalog product's `colors` is used. Caller-
   * supplied `colors` override the catalog's (multi-section spool selection).
   */
  colors?: string[];
  /** Required for manual entry; optional when `productId` denormalizes it. */
  colorPattern?: ColorPattern;
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
 * Catalog linkage (V2-007b T_B3)
 * ──────────────────────────────
 * When `productId` is provided, the catalog product is loaded + validated:
 *  - kind must allow it (filament_spool ↔ filament_products,
 *    resin_bottle ↔ resin_products; mix_batch / recycled_spool / other reject).
 *  - product must be visible (system row OR owned by `input.ownerId`).
 *  - filament-vs-resin tables must match the kind.
 *
 * Display fields (`brand`, `subtype`, `colors`, `colorPattern`, `colorName`,
 * `density`) are DENORMALIZED from the resolved product onto the new Material
 * row so browse queries can filter without a JOIN. Caller-supplied values
 * win over the resolved product — this is INTENTIONAL: when a user overrides
 * `colors` / `colorName` while keeping `productId` set, that signals a
 * specific section of a multi-color batch (e.g. "I'm spooling the red 50g
 * section of this 4-section gradient batch"). Both the link and the local
 * record of the spool's actual color are preserved.
 *
 * Reason codes (validation):
 *   colors-*                       — see validateColors
 *   color-pattern-*                — see validateColors
 *   kind-invalid                   — kind not in MATERIAL_KINDS
 *   unit-invalid                   — unit not in MATERIAL_UNITS
 *   unit-kind-mismatch             — incompatible (unit, kind) per matrix
 *   initial-amount-invalid         — initialAmount <= 0 or non-finite
 *   owner-required                 — ownerId blank
 *   product-not-allowed-for-kind   — productId set but kind=mix/recycled/other
 *   product-not-found              — productId missing (or cross-owner-custom; no leak)
 *   product-kind-mismatch          — productId points at the wrong product table for kind
 *   product-corrupt                — catalog row missing required brand/subtype/colors
 *   persist-failed                 — DB insert raised (programming/infra error)
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

  // --- Catalog product resolution (V2-007b T_B3) --------------------------

  let resolvedProduct: {
    brand: string;
    subtype: string;
    colors: string[];
    colorPattern: ColorPattern;
    colorName: string | null;
    density: number | null;
  } | null = null;
  if (input.productId !== undefined && input.productId !== null) {
    const productResolution = await resolveCatalogProduct({
      productId: input.productId,
      kind: unitKind.kind,
      ownerId: input.ownerId,
      dbUrl: opts?.dbUrl,
    });
    if (!productResolution.ok) {
      return {
        ok: false,
        reason: productResolution.reason,
        details: productResolution.details,
      };
    }
    resolvedProduct = productResolution.product;
  }

  // Caller-supplied fields win; otherwise fall back to the resolved product.
  // For colors / colorPattern: caller override is INTENTIONAL signal (multi-
  // color section selection). validateColors normalises whatever we end up
  // passing through — the override is accepted as long as it matches its own
  // pattern's length-rule.
  const finalColorsInput = input.colors ?? resolvedProduct?.colors;
  const finalColorPatternInput = input.colorPattern ?? resolvedProduct?.colorPattern;

  const colorCheck = validateColors(finalColorsInput, finalColorPatternInput);
  if (!colorCheck.ok) return colorCheck;

  if (
    typeof input.initialAmount !== 'number' ||
    !Number.isFinite(input.initialAmount) ||
    input.initialAmount <= 0
  ) {
    return { ok: false, reason: 'initial-amount-invalid' };
  }

  // --- Build the row -------------------------------------------------------

  const finalBrand = input.brand ?? resolvedProduct?.brand ?? null;
  const finalSubtype = input.subtype ?? resolvedProduct?.subtype ?? null;
  const finalColorName = input.colorName ?? resolvedProduct?.colorName ?? null;
  const finalDensity = input.density ?? resolvedProduct?.density ?? null;

  const id = crypto.randomUUID();
  const now = opts?.now ?? new Date();

  const row: typeof schema.materials.$inferInsert = {
    id,
    ownerId: input.ownerId,
    kind: unitKind.kind,
    productId: input.productId ?? null,
    brand: finalBrand,
    subtype: finalSubtype,
    colors: colorCheck.colors,
    colorPattern: colorCheck.colorPattern,
    colorName: finalColorName,
    density: finalDensity,
    initialAmount: input.initialAmount,
    remainingAmount: input.initialAmount, // force-set: caller cannot override
    unit: unitKind.unit,
    purchaseData: input.purchaseData,
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
    brand: finalBrand,
    subtype: finalSubtype,
    colors: colorCheck.colors,
    colorPattern: colorCheck.colorPattern,
    productId: input.productId ?? null,
  };

  // --- Atomic insert (Material + ledger event) ----------------------------

  try {
    const db = getServerDb(opts?.dbUrl);
    const result = (
      db as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }
    ).transaction((tx) => {
      const t = tx as ReturnType<typeof getServerDb>;
      t.insert(schema.materials).values(row).run();
      // G-CF-1: route the ledger insert through persistLedgerEventInTx so
      // payload Zod validation runs at the boundary. Validation failure
      // throws LedgerValidationError → outer try/catch turns it into
      // `persist-failed` and the Material insert rolls back.
      const { eventId } = persistLedgerEventInTx(t as LedgerTxHandle, {
        kind: 'material.added',
        actorUserId: input.ownerId,
        subjectType: 'material',
        subjectId: id,
        payload: ledgerPayload,
        provenanceClass: 'entered',
        ingestedAt: now,
      });
      const fetched = t
        .select()
        .from(schema.materials)
        .where(eq(schema.materials.id, id))
        .all();
      return { material: fetched[0]!, ledgerEventId: eventId };
    });

    return { ok: true, material: result.material, ledgerEventId: result.ledgerEventId };
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

  // TODO V2-005f-CF-1 T_g2: replace with printer_loadouts lookup.
  // V2-005f-CF-1 T_g1 dropped materials.loaded_in_printer_ref; the new
  // printer_loadouts table replaces it but isn't wired through lifecycle yet.
  // Until T_g2 ships, retirement skips the "loaded in printer" gate.
  void input.acknowledgeLoaded;

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

  const ledgerPayload = {
    retirementReason: input.retirementReason,
    remainingAtRetirement: current.remainingAmount,
    kind: current.kind,
  };

  try {
    const ledgerEventId = (
      db as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }
    ).transaction((tx) => {
      const t = tx as ReturnType<typeof getServerDb>;
      t.update(schema.materials)
        .set({
          active: false,
          retirementReason: input.retirementReason,
          retiredAt: now,
        })
        .where(eq(schema.materials.id, input.materialId))
        .run();
      // G-CF-1: validate at boundary; throw → tx rollback.
      const { eventId } = persistLedgerEventInTx(t as LedgerTxHandle, {
        kind: 'material.retired',
        actorUserId: input.actorUserId,
        subjectType: 'material',
        subjectId: input.materialId,
        payload: ledgerPayload,
        provenanceClass: 'entered',
        ingestedAt: now,
      });
      return eventId;
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
/**
 * V2-005f-CF-1 T_g1: stubbed pending T_g2.
 *
 * The legacy materials.loaded_in_printer_ref column was dropped in migration
 * 0030; this lifecycle entry-point returns `not-implemented` until T_g2 wires
 * the new `printer_loadouts` table (insert open row + atomic swap). HTTP
 * routes still call this — they'll receive the failure code and surface it
 * until T_g2/T_g3 land.
 */
export async function loadInPrinter(
  input: LoadInPrinterInput,
  _opts?: { dbUrl?: string; now?: Date },
): Promise<{ ok: true; ledgerEventId: string } | LifecycleFailure> {
  void input;
  void _opts;
  return {
    ok: false,
    reason: 'not-implemented',
    details:
      'loadInPrinter is being rewritten against printer_loadouts in V2-005f-CF-1 T_g2',
  };
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
/**
 * V2-005f-CF-1 T_g1: stubbed pending T_g2.
 *
 * See `loadInPrinter` above — same deferral. Returns `not-implemented` until
 * T_g2 wires `materialUnload` against `printer_loadouts`.
 */
export async function unloadFromPrinter(
  input: UnloadFromPrinterInput,
  _opts?: { dbUrl?: string; now?: Date },
): Promise<
  | { ok: true; ledgerEventId: string; previousPrinterRef: string | null }
  | LifecycleFailure
> {
  void input;
  void _opts;
  return {
    ok: false,
    reason: 'not-implemented',
    details:
      'unloadFromPrinter is being rewritten against printer_loadouts in V2-005f-CF-1 T_g2',
  };
}
