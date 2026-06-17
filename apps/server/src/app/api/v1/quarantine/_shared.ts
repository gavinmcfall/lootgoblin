// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared DTO + helpers for /api/v1/quarantine/* routes — Quarantine HTTP Layer
 *
 * Exports:
 *   QUARANTINE_REASONS  — allowed reason values (mirrors schema.stash.ts comment)
 *   QuarantineReason    — TS union type
 *   QuarantineItemDto   — public-facing JSON shape
 *   toQuarantineItemDto — DB row → DTO mapper
 *   ListQuery           — Zod schema for GET /api/v1/quarantine query params
 */

import { z } from 'zod';
import type { schema } from '../../../../db/client';

// ---------------------------------------------------------------------------
// Reason enum
// ---------------------------------------------------------------------------

export const QUARANTINE_REASONS = [
  'integrity-failed',
  'template-incompatible',
  'unclassifiable',
  'needs-user-input',
] as const;

export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export interface QuarantineItemDto {
  id: string;
  stashRootId: string;
  path: string;
  reason: QuarantineReason;
  details: Record<string, unknown> | null;
  createdAt: string;     // ISO 8601
  resolvedAt: string | null;  // ISO 8601 or null
}

export function toQuarantineItemDto(
  row: typeof schema.quarantineItems.$inferSelect,
): QuarantineItemDto {
  return {
    id: row.id,
    stashRootId: row.stashRootId,
    path: row.path,
    reason: row.reason as QuarantineReason,
    details: (row.details as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// List query params
// ---------------------------------------------------------------------------

export const ListQuery = z.object({
  stash_root_id: z.string().uuid().optional(),
  reason: z.enum(QUARANTINE_REASONS).optional(),
  resolved: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /** Admin-only: filter by owner. Non-admin callers must be rejected at the route level. */
  owner_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export type ListQueryInput = z.input<typeof ListQuery>;
export type ListQueryOutput = z.output<typeof ListQuery>;
