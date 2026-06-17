// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// UI types + constants for the /ledger viewer.
//
// LedgerEventDto / LedgerListResponseDto are re-exported from the server
// route's shared module so the UI tracks any DTO drift automatically. The
// re-export is type-only (`import type` / `export type`) so no server code
// (`logger`, `getServerDb`, etc. transitively reachable from _shared.ts)
// ends up in the client bundle — with `isolatedModules: true` the imports
// are erased at build time.
import type {
  LedgerEventDto,
  LedgerListResponseDto,
} from '@/app/api/v1/ledger/_shared';

export type { LedgerEventDto, LedgerListResponseDto };

/**
 * Convenience alias for an entry in `LedgerEventDto.relatedResources`. Kept
 * local so the UI has a name to reach for; derives from the canonical DTO so
 * any shape change there flows through.
 */
export type RelatedResource = NonNullable<LedgerEventDto['relatedResources']>[number];

/** Subject-type → friendly label + sometimes a domain page. */
export const KNOWN_SUBJECT_TYPES = [
  'material',
  'collection',
  'loot',
  'quarantine_item',
  'watchlist_subscription',
  'printer',
  'slicer',
  'slicer_profile',
  'print_setting',
] as const;

export type KnownSubjectType = (typeof KNOWN_SUBJECT_TYPES)[number];

/**
 * Filter state held on the page. Snake_case keys match the server's
 * ListQuery zod schema so we can pass them straight through.
 */
export interface LedgerFilterState {
  subject_type: string;
  kind: string;
  actor_user_id: string;
  occurred_after: string; // local-datetime as `YYYY-MM-DD` (HTML date input)
  occurred_before: string;
}

export const EMPTY_FILTERS: LedgerFilterState = {
  subject_type: '',
  kind: '',
  actor_user_id: '',
  occurred_after: '',
  occurred_before: '',
};
