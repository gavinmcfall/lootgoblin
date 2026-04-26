/**
 * PrintSetting CRUD — V2-007a-T10
 *
 * Pure-domain functions for managing per-model print setting overrides.
 * Differs from SlicerProfile: no slicer/printer/material kind columns —
 * a PrintSetting is a sparse override JSON layered on top of a profile at
 * dispatch time (V2-005 Forge merges).
 *
 * Manual JSON entry only in v2-007a; opaqueUnsupported is not a column on
 * print_settings (it's a SlicerProfile concept). All other discipline
 * mirrors slicer-profile.ts:
 *   - discriminated-union results
 *   - owner-scoped (cross-owner = `setting-not-found`)
 *   - no ledger emission (T13 may revisit)
 *   - PATCH-shaped updates; id/ownerId/createdAt immutable
 *   - hard delete cascades to grimoire_attachments via FK
 */

import * as crypto from 'node:crypto';
import { and, asc, eq, gt } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import { logger } from '../logger';
import { isPlainObject } from './slicer-profile';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreatePrintSettingInput {
  ownerId: string;
  name: string;
  settingsPayload: Record<string, unknown>;
  notes?: string;
}

export type CreatePrintSettingResult =
  | { ok: true; settingId: string }
  | { ok: false; reason: string; details?: string };

export interface UpdatePrintSettingInput {
  id: string;
  ownerId: string;
  name?: string;
  settingsPayload?: Record<string, unknown>;
  notes?: string | null;
}

export type UpdatePrintSettingResult =
  | { ok: true }
  | { ok: false; reason: string; details?: string };

export interface DeletePrintSettingInput {
  id: string;
  ownerId: string;
}

export type DeletePrintSettingResult =
  | { ok: true; deletedAttachments: number }
  | { ok: false; reason: string; details?: string };

export interface ListPrintSettingsInput {
  ownerId: string;
  limit?: number;
  cursor?: string;
}

export interface ListPrintSettingsResult {
  settings: Array<typeof schema.printSettings.$inferSelect>;
  nextCursor?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function clampLimit(input: number | undefined): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(Math.floor(input), MAX_LIST_LIMIT);
}

// ---------------------------------------------------------------------------
// createPrintSetting
// ---------------------------------------------------------------------------

/**
 * Reason codes:
 *   owner-required
 *   invalid-name
 *   invalid-settings-payload
 *   persist-failed
 */
export async function createPrintSetting(
  input: CreatePrintSettingInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<CreatePrintSettingResult> {
  if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    return { ok: false, reason: 'owner-required' };
  }
  const trimmedName = typeof input.name === 'string' ? input.name.trim() : '';
  if (trimmedName.length === 0) {
    return { ok: false, reason: 'invalid-name' };
  }
  if (!isPlainObject(input.settingsPayload)) {
    return { ok: false, reason: 'invalid-settings-payload' };
  }

  const id = crypto.randomUUID();
  const now = opts?.now ?? new Date();

  try {
    const db = getServerDb(opts?.dbUrl);
    await db.insert(schema.printSettings).values({
      id,
      ownerId: input.ownerId,
      name: trimmedName,
      settingsPayload: input.settingsPayload,
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, settingId: id };
  } catch (err) {
    logger.warn(
      { err, settingId: id, ownerId: input.ownerId },
      'createPrintSetting: persist failed',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// updatePrintSetting
// ---------------------------------------------------------------------------

/**
 * Reason codes:
 *   setting-not-found
 *   invalid-name
 *   invalid-settings-payload
 *   persist-failed
 */
export async function updatePrintSetting(
  input: UpdatePrintSettingInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<UpdatePrintSettingResult> {
  if (typeof input.id !== 'string' || input.id.length === 0) {
    return { ok: false, reason: 'setting-not-found' };
  }
  if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    return { ok: false, reason: 'owner-required' };
  }

  const updates: Partial<typeof schema.printSettings.$inferInsert> = {};

  if (input.name !== undefined) {
    const trimmedName = typeof input.name === 'string' ? input.name.trim() : '';
    if (trimmedName.length === 0) {
      return { ok: false, reason: 'invalid-name' };
    }
    updates.name = trimmedName;
  }
  if (input.settingsPayload !== undefined) {
    if (!isPlainObject(input.settingsPayload)) {
      return { ok: false, reason: 'invalid-settings-payload' };
    }
    updates.settingsPayload = input.settingsPayload;
  }
  if (input.notes !== undefined) {
    updates.notes = input.notes;
  }

  const db = getServerDb(opts?.dbUrl);
  const existing = await db
    .select()
    .from(schema.printSettings)
    .where(
      and(
        eq(schema.printSettings.id, input.id),
        eq(schema.printSettings.ownerId, input.ownerId),
      ),
    );
  if (existing.length === 0) {
    return { ok: false, reason: 'setting-not-found' };
  }

  const now = opts?.now ?? new Date();
  updates.updatedAt = now;

  try {
    await db
      .update(schema.printSettings)
      .set(updates)
      .where(
        and(
          eq(schema.printSettings.id, input.id),
          eq(schema.printSettings.ownerId, input.ownerId),
        ),
      );
    return { ok: true };
  } catch (err) {
    logger.warn(
      { err, settingId: input.id, ownerId: input.ownerId },
      'updatePrintSetting: persist failed',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// deletePrintSetting
// ---------------------------------------------------------------------------

/**
 * Hard delete. Cascades to grimoire_attachments via FK ON DELETE CASCADE.
 *
 * Reason codes:
 *   setting-not-found
 *   persist-failed
 */
export async function deletePrintSetting(
  input: DeletePrintSettingInput,
  opts?: { dbUrl?: string },
): Promise<DeletePrintSettingResult> {
  if (typeof input.id !== 'string' || input.id.length === 0) {
    return { ok: false, reason: 'setting-not-found' };
  }
  if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    return { ok: false, reason: 'owner-required' };
  }

  const db = getServerDb(opts?.dbUrl);
  const existing = await db
    .select()
    .from(schema.printSettings)
    .where(
      and(
        eq(schema.printSettings.id, input.id),
        eq(schema.printSettings.ownerId, input.ownerId),
      ),
    );
  if (existing.length === 0) {
    return { ok: false, reason: 'setting-not-found' };
  }

  const attachmentRows = await db
    .select({ id: schema.grimoireAttachments.id })
    .from(schema.grimoireAttachments)
    .where(eq(schema.grimoireAttachments.printSettingId, input.id));
  const deletedAttachments = attachmentRows.length;

  try {
    await db
      .delete(schema.printSettings)
      .where(
        and(
          eq(schema.printSettings.id, input.id),
          eq(schema.printSettings.ownerId, input.ownerId),
        ),
      );
    return { ok: true, deletedAttachments };
  } catch (err) {
    logger.warn(
      { err, settingId: input.id, ownerId: input.ownerId },
      'deletePrintSetting: persist failed',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// getPrintSetting
// ---------------------------------------------------------------------------

export async function getPrintSetting(
  args: { id: string; ownerId: string },
  opts?: { dbUrl?: string },
): Promise<typeof schema.printSettings.$inferSelect | null> {
  if (typeof args.id !== 'string' || args.id.length === 0) return null;
  if (typeof args.ownerId !== 'string' || args.ownerId.length === 0) return null;

  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select()
    .from(schema.printSettings)
    .where(
      and(
        eq(schema.printSettings.id, args.id),
        eq(schema.printSettings.ownerId, args.ownerId),
      ),
    );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// listPrintSettings
// ---------------------------------------------------------------------------

export async function listPrintSettings(
  input: ListPrintSettingsInput,
  opts?: { dbUrl?: string },
): Promise<ListPrintSettingsResult> {
  if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    return { settings: [] };
  }

  const limit = clampLimit(input.limit);
  const db = getServerDb(opts?.dbUrl);

  const conditions = [eq(schema.printSettings.ownerId, input.ownerId)];
  if (typeof input.cursor === 'string' && input.cursor.length > 0) {
    conditions.push(gt(schema.printSettings.id, input.cursor));
  }

  const rows = await db
    .select()
    .from(schema.printSettings)
    .where(and(...conditions))
    .orderBy(asc(schema.printSettings.id))
    .limit(limit + 1);

  if (rows.length > limit) {
    const page = rows.slice(0, limit);
    return { settings: page, nextCursor: page[page.length - 1]!.id };
  }
  return { settings: rows };
}
