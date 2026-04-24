/**
 * Ledger pillar tables — V2-002-T13
 *
 * ledger_events is an APPEND-ONLY audit trail for stash operations.
 * No UPDATEs or DELETEs in normal operation.
 *
 * Timestamps: integer({ mode: 'timestamp_ms' }) — consistent with all other stash tables.
 * Payload: text — JSON-serialized, kept small (< 10 KB typical).
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const ledgerEvents = sqliteTable(
  'ledger_events',
  {
    id: text('id').primaryKey(),
    /**
     * Event kind — namespaced by operation type.
     * Examples: 'migration.execute', 'bulk.move-to-collection', 'bulk.change-template'
     */
    kind: text('kind').notNull(),
    /** Optional actor (user id or synthetic api-key:${keyId}). Nullable for system-initiated events. */
    actorId: text('actor_id'),
    /** Resource type being acted on. Examples: 'loot', 'collection' */
    resourceType: text('resource_type').notNull(),
    /** Resource id — the primary key of the affected row. */
    resourceId: text('resource_id').notNull(),
    /** JSON-serialized payload. Kept small (< 10 KB). Null when no additional context needed. */
    payload: text('payload'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    /** Per-resource event history lookup. */
    index('ledger_events_resource_idx').on(t.resourceType, t.resourceId),
    /** Chronological event range queries. */
    index('ledger_events_created_idx').on(t.createdAt),
    /** Event-kind filtering (e.g. 'migration.execute' log). */
    index('ledger_events_kind_idx').on(t.kind),
  ],
);
