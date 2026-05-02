/**
 * Mix flow — V2-007a-T5.
 *
 * Two domain functions:
 *   - createMixRecipe: persist a reusable recipe template.
 *   - applyMixBatch:   atomically draw from N source bottles, create a new
 *                      mix_batch Material, link via mix_batches row, and
 *                      record a `material.mix_created` ledger event.
 *
 * Atomicity contract (mirrors T4 lifecycle):
 *   - All four writes (N updates + 1 material insert + 1 mix_batches insert
 *     + 1 ledger insert) happen inside ONE better-sqlite3 sync transaction.
 *   - If ANY write throws, the entire batch rolls back. No partial state.
 *   - All validation runs BEFORE the transaction opens — single-pass
 *     validate then single-pass apply.
 *
 * Mass conservation invariant (the headliner):
 *   - sum(drawAmount across draws) MUST equal totalVolume of the new
 *     mix_batch (within ±0.1 tolerance for analog-scale rounding).
 *   - The unit test (`materials-mix.test.ts` test 29) asserts this with a
 *     randomized property loop.
 *
 * Recipe component shape (opaque in v2-007a):
 *   - `materialProductRef` is a free-form string (e.g.
 *     "polymaker-resin-purple"). v2-007a does NOT FK-validate it. v2-007b
 *     will promote it to a real FK to resin_products.id.
 *   - Recipes are validated for component COUNT (2..10) at create time but
 *     NOT for component SUM (recipes are reusable across batch sizes; the
 *     batch-apply step enforces sum-vs-totalVolume).
 *
 * Color on mix_batch material:
 *   - A mix has no inherent single color (it's a combination). v2-007a
 *     defaults to colors=null/colorPattern=null on the new material. The
 *     caller MAY override via `colors`+`colorPattern`+`colorName`; if so,
 *     we run validateColors. (T4 update flow may surface this in UI.)
 *
 * Provenance escalation (weakest-link rule):
 *   - if any draw is 'estimated' → batch provenance is 'estimated'
 *   - else if any draw is 'entered' → 'entered'
 *   - else → 'measured'
 *   The whole mix is no more precise than its weakest input.
 */

import * as crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import { logger } from '../logger';
import type { ColorPattern } from '../db/schema.materials';
import { validateColors } from './validate';
import type { LifecycleFailure } from './lifecycle';
import { persistLedgerEventInTx, type LedgerTxHandle } from '../stash/ledger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const MIN_COMPONENTS = 2;
const MAX_COMPONENTS = 10;
const MASS_TOLERANCE_ML = 0.1;

const PROVENANCE_CLASSES = ['measured', 'entered', 'estimated'] as const;
type ProvenanceClass = (typeof PROVENANCE_CLASSES)[number];

export interface CreateMixRecipeInput {
  ownerId: string;
  name: string;
  components: Array<{ materialProductRef: string; ratioOrGrams: number }>;
  notes?: string;
}

export type CreateMixRecipeResult =
  | { ok: true; recipeId: string }
  | { ok: false; reason: string; details?: string };

export interface ApplyMixBatchDraw {
  sourceMaterialId: string;
  drawAmount: number;
  provenanceClass: ProvenanceClass;
}

export interface ApplyMixBatchInput {
  recipeId: string;
  actorUserId: string;
  totalVolume: number;
  perComponentDraws: ApplyMixBatchDraw[];
  /** Optional override for the mix_batch material's colors. v2-007a default: null. */
  colors?: string[];
  colorPattern?: ColorPattern;
  colorName?: string;
}

export type ApplyMixBatchResult =
  | { ok: true; mixBatchMaterialId: string; mixBatchId: string; ledgerEventId: string }
  | { ok: false; reason: string; details?: string };

// ---------------------------------------------------------------------------
// createMixRecipe
// ---------------------------------------------------------------------------

/**
 * Persist a reusable mix recipe.
 *
 * Reason codes (validation):
 *   owner-required                  — ownerId blank
 *   name-required                   — name blank
 *   component-count-out-of-range    — components.length < 2 or > 10
 *   component-malformed             — entry missing fields or non-numeric/<=0 ratio
 *   persist-failed                  — DB insert raised (programming/infra error)
 */
export async function createMixRecipe(
  input: CreateMixRecipeInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<CreateMixRecipeResult> {
  if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    return { ok: false, reason: 'owner-required' };
  }
  if (typeof input.name !== 'string' || input.name.length === 0) {
    return { ok: false, reason: 'name-required' };
  }
  if (!Array.isArray(input.components)) {
    return { ok: false, reason: 'component-count-out-of-range' };
  }
  if (
    input.components.length < MIN_COMPONENTS ||
    input.components.length > MAX_COMPONENTS
  ) {
    return { ok: false, reason: 'component-count-out-of-range' };
  }
  for (const c of input.components) {
    if (
      c === null ||
      typeof c !== 'object' ||
      typeof (c as { materialProductRef?: unknown }).materialProductRef !== 'string' ||
      ((c as { materialProductRef: string }).materialProductRef).length === 0 ||
      typeof (c as { ratioOrGrams?: unknown }).ratioOrGrams !== 'number' ||
      !Number.isFinite((c as { ratioOrGrams: number }).ratioOrGrams) ||
      (c as { ratioOrGrams: number }).ratioOrGrams <= 0
    ) {
      return { ok: false, reason: 'component-malformed' };
    }
  }

  const id = crypto.randomUUID();
  const now = opts?.now ?? new Date();

  try {
    const db = getServerDb(opts?.dbUrl);
    await db.insert(schema.mixRecipes).values({
      id,
      ownerId: input.ownerId,
      name: input.name,
      components: input.components,
      notes: input.notes ?? null,
      createdAt: now,
    });
    return { ok: true, recipeId: id };
  } catch (err) {
    logger.warn(
      { err, ownerId: input.ownerId, recipeName: input.name },
      'createMixRecipe: persist failed',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// applyMixBatch
// ---------------------------------------------------------------------------

function escalateProvenance(draws: ApplyMixBatchDraw[]): ProvenanceClass {
  // Weakest-link rule. Documented in the file header.
  if (draws.some((d) => d.provenanceClass === 'estimated')) return 'estimated';
  if (draws.some((d) => d.provenanceClass === 'entered')) return 'entered';
  return 'measured';
}

/**
 * Atomically apply a mix batch:
 *   1. Decrement remainingAmount on each source Material.
 *   2. Insert a new Material row (kind='mix_batch', initial=remaining=totalVolume).
 *   3. Insert a mix_batches row linking recipe + new material + draws.
 *   4. Insert a `material.mix_created` ledger event.
 *
 * All four writes happen in ONE transaction; any failure rolls back all.
 *
 * Reason codes:
 *   total-volume-invalid       — totalVolume not a positive finite number
 *   recipe-not-found           — recipe missing OR belongs to a different owner
 *   draw-count-mismatch        — draws.length !== recipe.components.length OR out of [2..10]
 *   draw-malformed             — draw missing fields, drawAmount<=0, bad provenance
 *   draw-sum-mismatch          — |sum(draws) - totalVolume| > 0.1
 *   colors-* / color-pattern-* — see validateColors (only when colors override provided)
 *   source-not-found           — a sourceMaterialId doesn't exist
 *   source-not-owned           — source.ownerId !== recipe.ownerId
 *   source-retired             — source.active === false
 *   source-insufficient        — source.remainingAmount < draw.drawAmount
 *   persist-failed             — the transaction raised; entire batch rolled back
 */
export async function applyMixBatch(
  input: ApplyMixBatchInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<ApplyMixBatchResult> {
  // --- Pre-DB validation ---------------------------------------------------

  if (
    typeof input.totalVolume !== 'number' ||
    !Number.isFinite(input.totalVolume) ||
    input.totalVolume <= 0
  ) {
    return { ok: false, reason: 'total-volume-invalid' };
  }

  if (!Array.isArray(input.perComponentDraws)) {
    return { ok: false, reason: 'draw-count-mismatch' };
  }
  if (
    input.perComponentDraws.length < MIN_COMPONENTS ||
    input.perComponentDraws.length > MAX_COMPONENTS
  ) {
    return { ok: false, reason: 'draw-count-mismatch' };
  }

  for (const d of input.perComponentDraws) {
    if (
      d === null ||
      typeof d !== 'object' ||
      typeof (d as { sourceMaterialId?: unknown }).sourceMaterialId !== 'string' ||
      ((d as { sourceMaterialId: string }).sourceMaterialId).length === 0 ||
      typeof (d as { drawAmount?: unknown }).drawAmount !== 'number' ||
      !Number.isFinite((d as { drawAmount: number }).drawAmount) ||
      (d as { drawAmount: number }).drawAmount <= 0 ||
      typeof (d as { provenanceClass?: unknown }).provenanceClass !== 'string' ||
      !(PROVENANCE_CLASSES as readonly string[]).includes(
        (d as { provenanceClass: string }).provenanceClass,
      )
    ) {
      return { ok: false, reason: 'draw-malformed' };
    }
  }

  const draws = input.perComponentDraws as ApplyMixBatchDraw[];
  const sumDraws = draws.reduce((acc, d) => acc + d.drawAmount, 0);
  if (Math.abs(sumDraws - input.totalVolume) > MASS_TOLERANCE_ML) {
    return {
      ok: false,
      reason: 'draw-sum-mismatch',
      details: `sum(draws)=${sumDraws} vs totalVolume=${input.totalVolume} (tolerance=${MASS_TOLERANCE_ML})`,
    };
  }

  // Optional color override validation. If any color field is provided we
  // run the full T4 color validator (defense-in-depth). Default = NULL.
  let resolvedColors: string[] | null = null;
  let resolvedColorPattern: ColorPattern | null = null;
  if (
    input.colors !== undefined ||
    input.colorPattern !== undefined ||
    (input.colorName !== undefined && input.colorName !== null)
  ) {
    if (input.colors === undefined || input.colorPattern === undefined) {
      return { ok: false, reason: 'color-pattern-mismatch' };
    }
    const c = validateColors(input.colors, input.colorPattern);
    if (!c.ok) return c;
    resolvedColors = c.colors;
    resolvedColorPattern = c.colorPattern;
  }

  // --- DB-side validation (recipe + sources) -------------------------------

  const db = getServerDb(opts?.dbUrl);

  const recipeRows = await db
    .select()
    .from(schema.mixRecipes)
    .where(eq(schema.mixRecipes.id, input.recipeId));
  if (recipeRows.length === 0) {
    return { ok: false, reason: 'recipe-not-found' };
  }
  const recipe = recipeRows[0]!;
  // 404-shaped owner check (don't leak existence)
  if (recipe.ownerId !== input.actorUserId) {
    return { ok: false, reason: 'recipe-not-found' };
  }

  if (draws.length !== recipe.components.length) {
    return {
      ok: false,
      reason: 'draw-count-mismatch',
      details: `draws=${draws.length} vs recipe.components=${recipe.components.length}`,
    };
  }

  // Fetch each source material individually. This is a single-pass validate;
  // we accept N small queries over a complex IN+filter for clarity. N is
  // bounded by MAX_COMPONENTS (10).
  for (const d of draws) {
    const rows = await db
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.id, d.sourceMaterialId));
    if (rows.length === 0) {
      return {
        ok: false,
        reason: 'source-not-found',
        details: `sourceMaterialId=${d.sourceMaterialId}`,
      };
    }
    const src = rows[0]!;
    if (src.ownerId !== recipe.ownerId) {
      return {
        ok: false,
        reason: 'source-not-owned',
        details: `sourceMaterialId=${d.sourceMaterialId}`,
      };
    }
    if (src.active === false) {
      return {
        ok: false,
        reason: 'source-retired',
        details: `sourceMaterialId=${d.sourceMaterialId}`,
      };
    }
    if (src.remainingAmount < d.drawAmount) {
      return {
        ok: false,
        reason: 'source-insufficient',
        details: `sourceMaterialId=${d.sourceMaterialId} remaining=${src.remainingAmount} draw=${d.drawAmount}`,
      };
    }
  }

  // --- Build the writes ----------------------------------------------------

  const newMaterialId = crypto.randomUUID();
  const newMixBatchId = crypto.randomUUID();
  const now = opts?.now ?? new Date();

  const batchProvenance = escalateProvenance(draws);

  const newMaterialRow: typeof schema.materials.$inferInsert = {
    id: newMaterialId,
    ownerId: recipe.ownerId,
    kind: 'mix_batch',
    productId: null,
    brand: null,
    subtype: null,
    colors: resolvedColors,
    colorPattern: resolvedColorPattern,
    colorName: input.colorName ?? null,
    density: null,
    initialAmount: input.totalVolume,
    remainingAmount: input.totalVolume,
    unit: 'ml', // mixes are volumetric (locked in validateUnitKind matrix)
    purchaseData: undefined,
    active: true,
    retirementReason: null,
    retiredAt: null,
    extra: undefined,
    createdAt: now,
  };

  const ledgerPayload = {
    totalVolume: input.totalVolume,
    unit: 'ml' as const,
    perComponentDraws: draws,
  };

  const ledgerRelatedResources: Array<{ kind: string; id: string; role: string }> = [
    ...draws.map((d) => ({
      kind: 'material',
      id: d.sourceMaterialId,
      role: 'source',
    })),
    { kind: 'mix_recipe', id: recipe.id, role: 'recipe' },
  ];

  // --- Atomic apply --------------------------------------------------------

  try {
    const ledgerEventId = (
      db as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }
    ).transaction((tx) => {
      const t = tx as ReturnType<typeof getServerDb>;
      // 1. Decrement each source. Use sql template to avoid SELECT-then-UPDATE
      //    race even within a single tx (defense-in-depth).
      for (const d of draws) {
        t.update(schema.materials)
          .set({ remainingAmount: sql`remaining_amount - ${d.drawAmount}` })
          .where(eq(schema.materials.id, d.sourceMaterialId))
          .run();
      }
      // 2. Create the new mix_batch material.
      t.insert(schema.materials).values(newMaterialRow).run();
      // 3. Link via mix_batches.
      t.insert(schema.mixBatches)
        .values({
          id: newMixBatchId,
          recipeId: recipe.id,
          materialId: newMaterialId,
          totalVolume: input.totalVolume,
          perComponentDraws: draws,
          createdAt: now,
        })
        .run();
      // 4. Record ledger event via the helper so the payload Zod schema
      //    runs at the boundary (G-CF-1). LedgerValidationError → tx rollback.
      const { eventId } = persistLedgerEventInTx(t as LedgerTxHandle, {
        kind: 'material.mix_created',
        actorUserId: input.actorUserId,
        subjectType: 'material',
        subjectId: newMaterialId,
        relatedResources: ledgerRelatedResources,
        payload: ledgerPayload,
        provenanceClass: batchProvenance,
        ingestedAt: now,
      });
      return eventId;
    });

    return {
      ok: true,
      mixBatchMaterialId: newMaterialId,
      mixBatchId: newMixBatchId,
      ledgerEventId,
    };
  } catch (err) {
    logger.warn(
      {
        err,
        recipeId: input.recipeId,
        ownerId: recipe.ownerId,
        totalVolume: input.totalVolume,
      },
      'applyMixBatch: persist failed — entire batch rolled back',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// Re-export for downstream consumers that want to differentiate failure shapes.
export type { LifecycleFailure };
