/**
 * Ledger pillar tables — V2-007a-T3 expansion (originally V2-002-T13).
 *
 * ledger_events is an APPEND-ONLY audit trail of every state-changing
 * operation in the system. UPDATE is permitted only for late-arriving
 * correction metadata (never for retroactive payload mutation); DELETE
 * is forbidden in normal operation.
 *
 * Field semantics:
 *   id                 — UUID primary key.
 *   kind               — namespaced event kind, e.g. 'migration.execute',
 *                        'bulk.move-to-collection', 'reconciler.removed-externally'.
 *   actorUserId        — user id (or synthetic 'api-key:<keyId>'). Nullable for
 *                        system-initiated events (reconciler, scheduler, etc).
 *   subjectType        — kind of resource the event is "about". Examples:
 *                        'loot', 'collection', 'loot-file', 'material',
 *                        'mix-batch', 'bulk-action'.
 *   subjectId          — id of the subject resource (FK shape, no DB constraint).
 *   relatedResources   — JSON array of {kind, id, role} entries for events that
 *                        touch multiple resources (e.g. a mix event referencing
 *                        N source bottles + 1 output batch). Nullable; most
 *                        events have a single subject + no related resources.
 *   payload            — JSON-serialized event-specific payload, kept small
 *                        (< 10 KB typical). Per-kind shape documented at the
 *                        emitter; type-level validation runs on insert.
 *   provenanceClass    — one of 'measured' | 'entered' | 'estimated' |
 *                        'derived' | 'computed' | 'system'. Required when the
 *                        payload carries numeric fields with provenance
 *                        significance (consumption, mix); NULL for purely
 *                        categorical events (config change, ACL change).
 *   occurredAt         — when the event ACTUALLY happened. Nullable — when NULL
 *                        treat as equal to ingestedAt. Diverges from ingestedAt
 *                        for events with delayed reporting (Forge dispatch
 *                        reporting hours after the fact, late-arriving
 *                        measurements, etc).
 *   ingestedAt         — when the event was recorded by lootgoblin. Always set.
 *
 * Timestamps: integer({ mode: 'timestamp_ms' }) — consistent with all other
 * stash tables.
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const ledgerEvents = sqliteTable(
  'ledger_events',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    actorUserId: text('actor_user_id'),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    relatedResources: text('related_resources', { mode: 'json' }).$type<
      Array<{ kind: string; id: string; role: string }>
    >(),
    payload: text('payload'),
    provenanceClass: text('provenance_class'),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }),
    ingestedAt: integer('ingested_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    /** Per-subject event history lookup. */
    index('ledger_events_subject_idx').on(t.subjectType, t.subjectId),
    /** Chronological ingest-time range queries. */
    index('ledger_events_ingested_idx').on(t.ingestedAt),
    /** Event-kind filtering. */
    index('ledger_events_kind_idx').on(t.kind),
    /** Per-actor audit history lookup. */
    index('ledger_events_actor_user_idx').on(t.actorUserId),
    /** Event-time queries (distinguishes occurred_at from ingested_at). */
    index('ledger_events_occurred_idx').on(t.occurredAt),
  ],
);
