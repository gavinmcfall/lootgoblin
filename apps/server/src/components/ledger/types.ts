// Shared types for the /ledger viewer.
// These mirror LedgerEventDto / LedgerListResponseDto from
// apps/server/src/app/api/v1/ledger/_shared.ts.

export interface RelatedResource {
  kind: string;
  id: string;
  role: string;
}

export interface LedgerEventDto {
  id: string;
  kind: string;
  actorUserId: string | null;
  subjectType: string;
  subjectId: string;
  relatedResources: RelatedResource[] | null;
  payload: unknown;
  provenanceClass: string | null;
  occurredAt: string | null;
  ingestedAt: string;
}

export interface LedgerListResponseDto {
  items: LedgerEventDto[];
  nextCursor: string | null;
}

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
