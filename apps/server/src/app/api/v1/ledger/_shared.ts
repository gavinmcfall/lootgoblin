/**
 * Shared DTO + helpers for /api/v1/ledger/* routes — Ledger HTTP Layer
 *
 * Exports:
 *   LedgerEventDto        — public-facing JSON shape for a single event
 *   LedgerListResponseDto — paginated list envelope
 *   toLedgerEventDto      — DB row → DTO mapper (JSON.parse's payload safely)
 *   ListQuery             — Zod schema for GET /api/v1/ledger query params
 */

import { z } from 'zod';
import type { schema } from '../../../../db/client';
import { logger } from '../../../../logger';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface LedgerEventDto {
  id: string;
  kind: string;
  actorUserId: string | null;
  subjectType: string;
  subjectId: string;
  relatedResources: Array<{ kind: string; id: string; role: string }> | null;
  payload: unknown | null;        // JSON.parse'd if non-null
  provenanceClass: string | null;
  occurredAt: string | null;      // ISO 8601
  ingestedAt: string;             // ISO 8601
}

export interface LedgerListResponseDto {
  items: LedgerEventDto[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// DTO mapper
// ---------------------------------------------------------------------------

export function toLedgerEventDto(
  row: typeof schema.ledgerEvents.$inferSelect,
): LedgerEventDto {
  let parsedPayload: unknown = null;
  if (row.payload != null) {
    try {
      parsedPayload = JSON.parse(row.payload);
    } catch {
      parsedPayload = row.payload;
      logger.warn({ id: row.id }, 'ledger payload not valid JSON, returning raw');
    }
  }

  return {
    id: row.id,
    kind: row.kind,
    actorUserId: row.actorUserId ?? null,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    relatedResources: row.relatedResources ?? null,
    payload: parsedPayload,
    provenanceClass: row.provenanceClass ?? null,
    occurredAt: row.occurredAt ? row.occurredAt.toISOString() : null,
    ingestedAt: row.ingestedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// List query params
// ---------------------------------------------------------------------------

export const ListQuery = z.object({
  subject_type: z.string().min(1).max(64).optional(),
  subject_id: z.string().min(1).max(128).optional(),
  kind: z.string().min(1).max(64).optional(),
  actor_user_id: z.string().min(1).max(64).optional(),
  occurred_after: z.string().datetime().optional(),
  occurred_before: z.string().datetime().optional(),
  ingested_after: z.string().datetime().optional(),
  ingested_before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
}).strict();
// Note: subject_type and subject_id are independent — passing one without the other is allowed.
//   - subject_id alone uses the subject_idx prefix poorly; warn in logs but don't reject.
//   - For canvas-port #14's default view (latest events) all filters omitted is the common path.

export type ListQueryInput = z.input<typeof ListQuery>;
export type ListQueryOutput = z.output<typeof ListQuery>;
