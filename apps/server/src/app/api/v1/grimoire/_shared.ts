/**
 * Shared helpers for /api/v1/grimoire/* routes — V2-007a-T14
 *
 * Auth + DTO mappers + idempotency helpers for slicer profiles, print
 * settings, and grimoire attachments. Mirrors the materials/_shared.ts
 * pattern.
 *
 * Auth model
 * ──────────
 * `authenticateRequest` — BetterAuth session OR x-api-key 'programmatic'.
 * ACL: `grimoire_entry` resource kind — owner-only CRUD; admin does NOT
 * bypass (matches V2-001-T7 contract).
 *
 * Owner-mismatch policy
 * ─────────────────────
 * Domain helpers already return reason='profile-not-found' /
 * 'setting-not-found' / 'attachment-not-found' for cross-owner — the route
 * surfaces those as 404 (id-leak prevention).
 */

import { NextResponse } from 'next/server';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
  type AuthenticatedActor,
} from '@/auth/request-auth';
import { schema } from '@/db/client';

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

export type AuthOk = { ok: true; actor: AuthenticatedActor };
export type AuthErr = { ok: false; response: Response };
export type AuthResult = AuthOk | AuthErr;

export async function requireAuth(req: Request): Promise<AuthResult> {
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return {
      ok: false,
      response: unauthenticatedResponse(actor as null | typeof INVALID_API_KEY),
    };
  }
  return { ok: true, actor };
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface SlicerProfileDto {
  id: string;
  ownerId: string;
  name: string;
  slicerKind: string;
  printerKind: string;
  materialKind: string;
  settingsPayload: Record<string, unknown>;
  opaqueUnsupported: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toSlicerProfileDto(
  row: typeof schema.slicerProfiles.$inferSelect,
): SlicerProfileDto {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    slicerKind: row.slicerKind,
    printerKind: row.printerKind,
    materialKind: row.materialKind,
    settingsPayload: row.settingsPayload,
    opaqueUnsupported: row.opaqueUnsupported === true,
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface PrintSettingDto {
  id: string;
  ownerId: string;
  name: string;
  settingsPayload: Record<string, unknown>;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPrintSettingDto(
  row: typeof schema.printSettings.$inferSelect,
): PrintSettingDto {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    settingsPayload: row.settingsPayload,
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface GrimoireAttachmentDto {
  id: string;
  lootId: string;
  slicerProfileId: string | null;
  printSettingId: string | null;
  note: string | null;
  ownerId: string;
  attachedAt: string;
}

export function toGrimoireAttachmentDto(
  row: typeof schema.grimoireAttachments.$inferSelect,
): GrimoireAttachmentDto {
  return {
    id: row.id,
    lootId: row.lootId,
    slicerProfileId: row.slicerProfileId ?? null,
    printSettingId: row.printSettingId ?? null,
    note: row.note ?? null,
    ownerId: row.ownerId,
    attachedAt: row.attachedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Error response helper (matches materials/_shared)
// ---------------------------------------------------------------------------

export function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: string,
): Response {
  const body: Record<string, unknown> = { error: code, message };
  if (details !== undefined) body.details = details;
  return NextResponse.json(body, { status });
}

export function statusForReason(reason: string): number {
  if (reason === 'persist-failed') return 500;
  if (
    reason === 'profile-not-found' ||
    reason === 'setting-not-found' ||
    reason === 'loot-not-found' ||
    reason === 'attachment-not-found'
  ) {
    return 404;
  }
  return 400;
}
