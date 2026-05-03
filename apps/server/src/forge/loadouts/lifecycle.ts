/**
 * V2-005f-CF-1 T_g2: Material loadout lifecycle.
 *
 * Replaces the V2-007a-T4 free-text `materials.loaded_in_printer_ref`
 * implementation (column dropped in migration 0030). Load/unload now write
 * rows in `printer_loadouts`, with at-most-one open row per (printer, slot)
 * enforced by partial unique index `idx_printer_loadouts_current` (T_g1).
 *
 * Each load/unload also emits a `material.loaded` / `material.unloaded`
 * ledger event INSIDE the same sync transaction as the table write — the
 * ledger is the audit trail and must roll back together with the row.
 *
 * Atomic swap:
 *   When loading material B into a slot already occupied by material A, the
 *   incumbent row is stamped `unloaded_at` and the new row inserted in ONE
 *   transaction, with TWO ledger events emitted — `material.unloaded` for A
 *   (reason='swap') + `material.loaded` for B (with `swappedOutMaterialId`
 *   pointing at A). Either both happen or neither.
 *
 * Idempotency:
 *   Re-loading the same material into the same printer + slot is a no-op:
 *   the existing open `loadoutId` is returned, no new row is written, no
 *   ledger event is emitted.
 *
 * Cross-slot conflict:
 *   A material can only be in ONE place at a time. Attempting to load while
 *   the material is already open elsewhere (different printer OR different
 *   slot on the same printer) returns
 *   `material-already-loaded-elsewhere`.
 */

import * as crypto from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';

import { getServerDb, schema } from '../../db/client';
import { logger } from '../../logger';
import { persistLedgerEventInTx, type LedgerTxHandle } from '../../stash/ledger';
import {
  MATERIAL_LOADED_EVENT_KIND,
  MATERIAL_UNLOADED_EVENT_KIND,
} from '../../db/schema.forge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoadInPrinterReason =
  | 'material-not-found'
  | 'printer-not-found'
  | 'material-already-loaded-elsewhere'
  | 'invalid-slot'
  | 'material-retired';

export type LoadInPrinterResult =
  | { ok: true; loadoutId: string; swappedOutMaterialId?: string }
  | { ok: false; reason: LoadInPrinterReason; details?: string };

export type UnloadFromPrinterReason = 'material-not-found' | 'material-not-loaded';

export type UnloadFromPrinterResult =
  | {
      ok: true;
      loadoutId: string;
      previousPrinterId: string;
      previousSlotIndex: number;
    }
  | { ok: false; reason: UnloadFromPrinterReason; details?: string };

export interface LoadInPrinterArgs {
  materialId: string;
  printerId: string;
  slotIndex: number;
  userId: string;
  notes?: string;
}

export interface UnloadFromPrinterArgs {
  materialId: string;
  userId: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// loadInPrinter
// ---------------------------------------------------------------------------

/**
 * Load `materialId` into `printerId` slot `slotIndex`.
 *
 * Pre-tx validation:
 *   - slotIndex must be a non-negative integer (`invalid-slot`).
 *   - materialId must resolve (`material-not-found`).
 *   - material must be active=true (`material-retired`).
 *   - printerId must resolve (`printer-not-found`).
 *   - if material is already in an open loadout row:
 *       - same printer + same slot → idempotent ok with existing loadoutId.
 *       - anywhere else → `material-already-loaded-elsewhere`.
 *
 * Atomic body:
 *   1. If the target slot has an incumbent, stamp `unloaded_at` + emit
 *      `material.unloaded` (reason='swap') for it; capture the old material
 *      id to return as `swappedOutMaterialId`.
 *   2. Insert the new loadout row.
 *   3. Emit `material.loaded` for the new material; payload includes
 *      `swappedOutMaterialId` when a swap occurred.
 */
export async function loadInPrinter(
  args: LoadInPrinterArgs,
  opts?: { dbUrl?: string; now?: Date },
): Promise<LoadInPrinterResult> {
  if (!Number.isInteger(args.slotIndex) || args.slotIndex < 0) {
    return {
      ok: false,
      reason: 'invalid-slot',
      details: `slotIndex must be a non-negative integer; got ${args.slotIndex}`,
    };
  }

  const db = getServerDb(opts?.dbUrl);

  const matRows = await db
    .select()
    .from(schema.materials)
    .where(eq(schema.materials.id, args.materialId))
    .limit(1);
  if (matRows.length === 0) return { ok: false, reason: 'material-not-found' };
  const mat = matRows[0]!;
  if (mat.active === false) {
    return {
      ok: false,
      reason: 'material-retired',
      details: 'cannot load a retired material',
    };
  }

  const printerRows = await db
    .select()
    .from(schema.printers)
    .where(eq(schema.printers.id, args.printerId))
    .limit(1);
  if (printerRows.length === 0) return { ok: false, reason: 'printer-not-found' };

  // Is this material currently loaded SOMEWHERE?
  const existingForMat = await db
    .select()
    .from(schema.printerLoadouts)
    .where(
      and(
        eq(schema.printerLoadouts.materialId, args.materialId),
        isNull(schema.printerLoadouts.unloadedAt),
      ),
    );
  if (existingForMat.length > 0) {
    const existing = existingForMat[0]!;
    if (
      existing.printerId === args.printerId &&
      existing.slotIndex === args.slotIndex
    ) {
      // Idempotent: already in this exact slot.
      return { ok: true, loadoutId: existing.id };
    }
    return {
      ok: false,
      reason: 'material-already-loaded-elsewhere',
      details: `already in printer ${existing.printerId} slot ${existing.slotIndex}`,
    };
  }

  // Resolve any incumbent in the target slot — atomic-swap source.
  const incumbentRows = await db
    .select()
    .from(schema.printerLoadouts)
    .where(
      and(
        eq(schema.printerLoadouts.printerId, args.printerId),
        eq(schema.printerLoadouts.slotIndex, args.slotIndex),
        isNull(schema.printerLoadouts.unloadedAt),
      ),
    );

  const newLoadoutId = crypto.randomUUID();
  const now = opts?.now ?? new Date();
  let swappedOutMaterialId: string | undefined;

  try {
    (db as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }).transaction(
      (tx) => {
        const t = tx as ReturnType<typeof getServerDb>;

        if (incumbentRows.length > 0) {
          const incumbent = incumbentRows[0]!;
          t.update(schema.printerLoadouts)
            .set({ unloadedAt: now, unloadedByUserId: args.userId })
            .where(eq(schema.printerLoadouts.id, incumbent.id))
            .run();
          swappedOutMaterialId = incumbent.materialId;
          persistLedgerEventInTx(t as LedgerTxHandle, {
            kind: MATERIAL_UNLOADED_EVENT_KIND,
            actorUserId: args.userId,
            subjectType: 'material',
            subjectId: incumbent.materialId,
            payload: {
              printerId: args.printerId,
              slotIndex: args.slotIndex,
              loadoutId: incumbent.id,
              reason: 'swap',
            },
            provenanceClass: 'entered',
            occurredAt: now,
            ingestedAt: now,
          });
        }

        t.insert(schema.printerLoadouts)
          .values({
            id: newLoadoutId,
            printerId: args.printerId,
            slotIndex: args.slotIndex,
            materialId: args.materialId,
            loadedAt: now,
            loadedByUserId: args.userId,
            notes: args.notes ?? null,
          })
          .run();

        persistLedgerEventInTx(t as LedgerTxHandle, {
          kind: MATERIAL_LOADED_EVENT_KIND,
          actorUserId: args.userId,
          subjectType: 'material',
          subjectId: args.materialId,
          payload: {
            printerId: args.printerId,
            slotIndex: args.slotIndex,
            loadoutId: newLoadoutId,
            ...(swappedOutMaterialId ? { swappedOutMaterialId } : {}),
          },
          provenanceClass: 'entered',
          occurredAt: now,
          ingestedAt: now,
        });
      },
    );
  } catch (err) {
    logger.warn(
      {
        err,
        materialId: args.materialId,
        printerId: args.printerId,
        slotIndex: args.slotIndex,
      },
      'loadInPrinter: tx rolled back',
    );
    throw err;
  }

  return swappedOutMaterialId !== undefined
    ? { ok: true, loadoutId: newLoadoutId, swappedOutMaterialId }
    : { ok: true, loadoutId: newLoadoutId };
}

// ---------------------------------------------------------------------------
// unloadFromPrinter
// ---------------------------------------------------------------------------

/**
 * Unload `materialId` from whichever (printer, slot) it's currently open in.
 *
 *   - `material-not-found` when the material id doesn't resolve.
 *   - `material-not-loaded` when the material has no open loadout row.
 *
 * Stamps `unloaded_at` on the open row + emits `material.unloaded` with
 * `reason='manual'` inside one tx.
 */
export async function unloadFromPrinter(
  args: UnloadFromPrinterArgs,
  opts?: { dbUrl?: string; now?: Date },
): Promise<UnloadFromPrinterResult> {
  const db = getServerDb(opts?.dbUrl);

  const matRows = await db
    .select()
    .from(schema.materials)
    .where(eq(schema.materials.id, args.materialId))
    .limit(1);
  if (matRows.length === 0) return { ok: false, reason: 'material-not-found' };

  const currentRows = await db
    .select()
    .from(schema.printerLoadouts)
    .where(
      and(
        eq(schema.printerLoadouts.materialId, args.materialId),
        isNull(schema.printerLoadouts.unloadedAt),
      ),
    );
  if (currentRows.length === 0) return { ok: false, reason: 'material-not-loaded' };
  const row = currentRows[0]!;
  const now = opts?.now ?? new Date();

  try {
    (db as unknown as { transaction: <T>(fn: (tx: unknown) => T) => T }).transaction(
      (tx) => {
        const t = tx as ReturnType<typeof getServerDb>;
        t.update(schema.printerLoadouts)
          .set({
            unloadedAt: now,
            unloadedByUserId: args.userId,
            notes: args.notes ?? row.notes,
          })
          .where(eq(schema.printerLoadouts.id, row.id))
          .run();

        persistLedgerEventInTx(t as LedgerTxHandle, {
          kind: MATERIAL_UNLOADED_EVENT_KIND,
          actorUserId: args.userId,
          subjectType: 'material',
          subjectId: args.materialId,
          payload: {
            printerId: row.printerId,
            slotIndex: row.slotIndex,
            loadoutId: row.id,
            reason: 'manual',
          },
          provenanceClass: 'entered',
          occurredAt: now,
          ingestedAt: now,
        });
      },
    );
  } catch (err) {
    logger.warn(
      { err, materialId: args.materialId, loadoutId: row.id },
      'unloadFromPrinter: tx rolled back',
    );
    throw err;
  }

  return {
    ok: true,
    loadoutId: row.id,
    previousPrinterId: row.printerId,
    previousSlotIndex: row.slotIndex,
  };
}
