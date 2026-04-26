/**
 * SlicerProfile CRUD — V2-007a-T10
 *
 * Pure-domain functions for managing SlicerProfile rows. Manual JSON entry
 * only — native-format slicer config import (Bambu Studio, OrcaSlicer,
 * PrusaSlicer) is OUT of scope per stakeholder decision and tracked as a
 * separate future feature. v2-007a entries always have
 * `opaqueUnsupported = false`; the future native-format path will be the
 * one to flip that bit.
 *
 * Validation discipline:
 *   - Every mutating function returns a discriminated union
 *     (`{ ok: true, ... } | { ok: false, reason, details? }`).
 *   - We THROW only on programming/infra errors (DB connection lost, etc.).
 *
 * Owner-scoping:
 *   - Every operation requires `ownerId`. Cross-owner reads return `null`,
 *     cross-owner mutations return `{ ok: false, reason: 'profile-not-found' }`
 *     (404 semantics — don't leak existence). Matches V2-004-T9 watchlist
 *     subscription pattern.
 *
 * Ledger:
 *   - SKIPS ledger emission. Profiles are user-authored config, not domain
 *     operations like mix/recycle/consume. T13 may revisit if needed.
 */

import * as crypto from 'node:crypto';
import { and, asc, eq, gt } from 'drizzle-orm';

import { getServerDb, schema } from '../db/client';
import { logger } from '../logger';
import {
  isProfileMaterialKind,
  isPrinterKind,
  isSlicerKind,
} from './types';
import type {
  PrinterKind,
  ProfileMaterialKind,
  SlicerKind,
} from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateSlicerProfileInput {
  ownerId: string;
  name: string;
  slicerKind: SlicerKind;
  printerKind: PrinterKind;
  materialKind: ProfileMaterialKind;
  settingsPayload: Record<string, unknown>;
  notes?: string;
}

export type CreateSlicerProfileResult =
  | { ok: true; profileId: string }
  | { ok: false; reason: string; details?: string };

export interface UpdateSlicerProfileInput {
  id: string;
  ownerId: string;
  name?: string;
  slicerKind?: SlicerKind;
  printerKind?: PrinterKind;
  materialKind?: ProfileMaterialKind;
  settingsPayload?: Record<string, unknown>;
  /** Explicit null clears notes; omitted preserves. */
  notes?: string | null;
}

export type UpdateSlicerProfileResult =
  | { ok: true }
  | { ok: false; reason: string; details?: string };

export interface DeleteSlicerProfileInput {
  id: string;
  ownerId: string;
}

export type DeleteSlicerProfileResult =
  | { ok: true; deletedAttachments: number }
  | { ok: false; reason: string; details?: string };

export interface ListSlicerProfilesInput {
  ownerId: string;
  printerKind?: PrinterKind;
  materialKind?: ProfileMaterialKind;
  slicerKind?: SlicerKind;
  limit?: number;
  /** Last id from prior page (keyset pagination). */
  cursor?: string;
}

export interface ListSlicerProfilesResult {
  profiles: Array<typeof schema.slicerProfiles.$inferSelect>;
  nextCursor?: string;
}

// ---------------------------------------------------------------------------
// Helpers (file-local)
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/**
 * Validate that `value` is a non-null plain object (not null, not array,
 * not primitive). Slicer-internal field shape is opaque to lootgoblin, but
 * the top-level container must be an object.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  return true;
}

function clampLimit(input: number | undefined): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(Math.floor(input), MAX_LIST_LIMIT);
}

// ---------------------------------------------------------------------------
// createSlicerProfile
// ---------------------------------------------------------------------------

/**
 * Create a new SlicerProfile owned by `ownerId`.
 *
 * Reason codes:
 *   owner-required             — ownerId blank
 *   invalid-name               — empty after trim
 *   invalid-slicer-kind        — not in SLICER_KINDS
 *   invalid-printer-kind       — not in PRINTER_KINDS
 *   invalid-material-kind      — not in PROFILE_MATERIAL_KINDS
 *   invalid-settings-payload   — null, primitive, array, etc.
 *   persist-failed             — DB raised
 */
export async function createSlicerProfile(
  input: CreateSlicerProfileInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<CreateSlicerProfileResult> {
  if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    return { ok: false, reason: 'owner-required' };
  }

  const trimmedName = typeof input.name === 'string' ? input.name.trim() : '';
  if (trimmedName.length === 0) {
    return { ok: false, reason: 'invalid-name' };
  }

  if (typeof input.slicerKind !== 'string' || !isSlicerKind(input.slicerKind)) {
    return { ok: false, reason: 'invalid-slicer-kind' };
  }
  if (typeof input.printerKind !== 'string' || !isPrinterKind(input.printerKind)) {
    return { ok: false, reason: 'invalid-printer-kind' };
  }
  if (typeof input.materialKind !== 'string' || !isProfileMaterialKind(input.materialKind)) {
    return { ok: false, reason: 'invalid-material-kind' };
  }
  if (!isPlainObject(input.settingsPayload)) {
    return { ok: false, reason: 'invalid-settings-payload' };
  }

  const id = crypto.randomUUID();
  const now = opts?.now ?? new Date();

  try {
    const db = getServerDb(opts?.dbUrl);
    await db.insert(schema.slicerProfiles).values({
      id,
      ownerId: input.ownerId,
      name: trimmedName,
      slicerKind: input.slicerKind,
      printerKind: input.printerKind,
      materialKind: input.materialKind,
      settingsPayload: input.settingsPayload,
      opaqueUnsupported: false, // v2-007a always false
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, profileId: id };
  } catch (err) {
    logger.warn(
      { err, profileId: id, ownerId: input.ownerId },
      'createSlicerProfile: persist failed',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// updateSlicerProfile
// ---------------------------------------------------------------------------

/**
 * PATCH-shaped update. Only fields present in `input` are written; omitted
 * fields are preserved. `id`, `ownerId`, `createdAt`, `opaqueUnsupported`
 * are NOT updatable. `updatedAt` is auto-bumped.
 *
 * Reason codes:
 *   profile-not-found          — missing OR cross-owner (404 semantics)
 *   invalid-name               — empty after trim
 *   invalid-slicer-kind
 *   invalid-printer-kind
 *   invalid-material-kind
 *   invalid-settings-payload
 *   no-op                      — no updatable fields supplied (still ok:true is debatable;
 *                                we accept and bump updatedAt for simplicity is
 *                                wasteful — instead reject for clarity)
 *   persist-failed
 */
export async function updateSlicerProfile(
  input: UpdateSlicerProfileInput,
  opts?: { dbUrl?: string; now?: Date },
): Promise<UpdateSlicerProfileResult> {
  if (typeof input.id !== 'string' || input.id.length === 0) {
    return { ok: false, reason: 'profile-not-found' };
  }
  if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    return { ok: false, reason: 'owner-required' };
  }

  // Validate field-by-field BEFORE touching the DB. Keeps reasons clean.
  const updates: Partial<typeof schema.slicerProfiles.$inferInsert> = {};

  if (input.name !== undefined) {
    const trimmedName = typeof input.name === 'string' ? input.name.trim() : '';
    if (trimmedName.length === 0) {
      return { ok: false, reason: 'invalid-name' };
    }
    updates.name = trimmedName;
  }
  if (input.slicerKind !== undefined) {
    if (typeof input.slicerKind !== 'string' || !isSlicerKind(input.slicerKind)) {
      return { ok: false, reason: 'invalid-slicer-kind' };
    }
    updates.slicerKind = input.slicerKind;
  }
  if (input.printerKind !== undefined) {
    if (typeof input.printerKind !== 'string' || !isPrinterKind(input.printerKind)) {
      return { ok: false, reason: 'invalid-printer-kind' };
    }
    updates.printerKind = input.printerKind;
  }
  if (input.materialKind !== undefined) {
    if (typeof input.materialKind !== 'string' || !isProfileMaterialKind(input.materialKind)) {
      return { ok: false, reason: 'invalid-material-kind' };
    }
    updates.materialKind = input.materialKind;
  }
  if (input.settingsPayload !== undefined) {
    if (!isPlainObject(input.settingsPayload)) {
      return { ok: false, reason: 'invalid-settings-payload' };
    }
    updates.settingsPayload = input.settingsPayload;
  }
  if (input.notes !== undefined) {
    updates.notes = input.notes; // explicit null clears
  }

  // Verify ownership BEFORE applying.
  const db = getServerDb(opts?.dbUrl);
  const existing = await db
    .select()
    .from(schema.slicerProfiles)
    .where(
      and(
        eq(schema.slicerProfiles.id, input.id),
        eq(schema.slicerProfiles.ownerId, input.ownerId),
      ),
    );
  if (existing.length === 0) {
    return { ok: false, reason: 'profile-not-found' };
  }

  const now = opts?.now ?? new Date();
  updates.updatedAt = now;

  try {
    await db
      .update(schema.slicerProfiles)
      .set(updates)
      .where(
        and(
          eq(schema.slicerProfiles.id, input.id),
          eq(schema.slicerProfiles.ownerId, input.ownerId),
        ),
      );
    return { ok: true };
  } catch (err) {
    logger.warn(
      { err, profileId: input.id, ownerId: input.ownerId },
      'updateSlicerProfile: persist failed',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// deleteSlicerProfile
// ---------------------------------------------------------------------------

/**
 * Hard delete. Cascades to `grimoire_attachments` rows via FK
 * ON DELETE CASCADE. Returns count of attachments removed for caller
 * observability.
 *
 * Reason codes:
 *   profile-not-found  — missing OR cross-owner
 *   persist-failed
 */
export async function deleteSlicerProfile(
  input: DeleteSlicerProfileInput,
  opts?: { dbUrl?: string },
): Promise<DeleteSlicerProfileResult> {
  if (typeof input.id !== 'string' || input.id.length === 0) {
    return { ok: false, reason: 'profile-not-found' };
  }
  if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    return { ok: false, reason: 'owner-required' };
  }

  const db = getServerDb(opts?.dbUrl);

  const existing = await db
    .select()
    .from(schema.slicerProfiles)
    .where(
      and(
        eq(schema.slicerProfiles.id, input.id),
        eq(schema.slicerProfiles.ownerId, input.ownerId),
      ),
    );
  if (existing.length === 0) {
    return { ok: false, reason: 'profile-not-found' };
  }

  // Pre-count attachments that will be cascaded so the caller knows the
  // blast radius. (Cheaper than RETURNING tricks across dialects.)
  const attachmentRows = await db
    .select({ id: schema.grimoireAttachments.id })
    .from(schema.grimoireAttachments)
    .where(eq(schema.grimoireAttachments.slicerProfileId, input.id));
  const deletedAttachments = attachmentRows.length;

  try {
    await db
      .delete(schema.slicerProfiles)
      .where(
        and(
          eq(schema.slicerProfiles.id, input.id),
          eq(schema.slicerProfiles.ownerId, input.ownerId),
        ),
      );
    return { ok: true, deletedAttachments };
  } catch (err) {
    logger.warn(
      { err, profileId: input.id, ownerId: input.ownerId },
      'deleteSlicerProfile: persist failed',
    );
    return {
      ok: false,
      reason: 'persist-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// getSlicerProfile
// ---------------------------------------------------------------------------

/**
 * Owner-scoped fetch. Cross-owner returns null (don't leak existence).
 */
export async function getSlicerProfile(
  args: { id: string; ownerId: string },
  opts?: { dbUrl?: string },
): Promise<typeof schema.slicerProfiles.$inferSelect | null> {
  if (typeof args.id !== 'string' || args.id.length === 0) return null;
  if (typeof args.ownerId !== 'string' || args.ownerId.length === 0) return null;

  const db = getServerDb(opts?.dbUrl);
  const rows = await db
    .select()
    .from(schema.slicerProfiles)
    .where(
      and(
        eq(schema.slicerProfiles.id, args.id),
        eq(schema.slicerProfiles.ownerId, args.ownerId),
      ),
    );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// listSlicerProfiles
// ---------------------------------------------------------------------------

/**
 * Owner-scoped list with optional kind filters and keyset pagination on `id`.
 * `cursor` = last `id` from prior page; results are ordered by `id ASC`.
 */
export async function listSlicerProfiles(
  input: ListSlicerProfilesInput,
  opts?: { dbUrl?: string },
): Promise<ListSlicerProfilesResult> {
  if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    return { profiles: [] };
  }

  const limit = clampLimit(input.limit);
  const db = getServerDb(opts?.dbUrl);

  const conditions = [eq(schema.slicerProfiles.ownerId, input.ownerId)];
  if (input.printerKind !== undefined) {
    conditions.push(eq(schema.slicerProfiles.printerKind, input.printerKind));
  }
  if (input.materialKind !== undefined) {
    conditions.push(eq(schema.slicerProfiles.materialKind, input.materialKind));
  }
  if (input.slicerKind !== undefined) {
    conditions.push(eq(schema.slicerProfiles.slicerKind, input.slicerKind));
  }
  if (typeof input.cursor === 'string' && input.cursor.length > 0) {
    conditions.push(gt(schema.slicerProfiles.id, input.cursor));
  }

  const rows = await db
    .select()
    .from(schema.slicerProfiles)
    .where(and(...conditions))
    .orderBy(asc(schema.slicerProfiles.id))
    .limit(limit + 1);

  if (rows.length > limit) {
    const page = rows.slice(0, limit);
    return { profiles: page, nextCursor: page[page.length - 1]!.id };
  }
  return { profiles: rows };
}
