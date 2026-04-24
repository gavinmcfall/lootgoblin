/**
 * Ingest jobs table — V2-003-T2
 *
 * Tracks every ingest pipeline run from source fetch through validation,
 * dedup, and final placement (into Loot) or quarantine.
 *
 * Status lifecycle:
 *   queued → fetching → placing → completed
 *                              → quarantined
 *              → failed
 *              → paused-auth
 *              → rate-limit-deferred
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { user } from './schema.auth';
import { collections } from './schema.stash';
import { loot } from './schema.stash';
import { quarantineItems } from './schema.stash';

// ---------------------------------------------------------------------------
// ingestJobs
// ---------------------------------------------------------------------------

export const ingestJobs = sqliteTable(
  'ingest_jobs',
  {
    id: text('id').primaryKey(),
    /** FK → BetterAuth user.id. Cascade: user delete removes their jobs. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** SourceId value (e.g. 'makerworld', 'upload', 'cults3d'). */
    sourceId: text('source_id').notNull(),
    /**
     * The kind of FetchTarget ('url' | 'source-item-id' | 'raw').
     * Stored separately from target_payload for fast filtering.
     */
    targetKind: text('target_kind').notNull(),
    /**
     * JSON-serialized FetchTarget. Includes the kind + kind-specific fields.
     * E.g. '{"kind":"url","url":"https://makerworld.com/en/models/123"}'.
     */
    targetPayload: text('target_payload').notNull(),
    /**
     * FK → collections.id. SET NULL on collection delete — the job stays for
     * audit, the collection reference is nulled out.
     */
    collectionId: text('collection_id').references(() => collections.id, { onDelete: 'set null' }),
    /**
     * Pipeline status.
     * Values: 'queued' | 'fetching' | 'placing' | 'completed' | 'failed' |
     *         'quarantined' | 'paused-auth' | 'rate-limit-deferred'
     */
    status: text('status').notNull(),
    /**
     * FK → loot.id. Populated once placement succeeds (or dedup resolves to
     * an existing Loot). SET NULL if the Loot is later deleted.
     */
    lootId: text('loot_id').references(() => loot.id, { onDelete: 'set null' }),
    /**
     * FK → quarantine_items.id. Populated when pipeline quarantines the item.
     * SET NULL if the quarantine item is later dismissed/deleted.
     */
    quarantineItemId: text('quarantine_item_id').references(() => quarantineItems.id, {
      onDelete: 'set null',
    }),
    /**
     * Machine-readable failure reason code (AdapterFailureReason or QuarantineReason).
     * Null unless status is 'failed' or 'quarantined'.
     */
    failureReason: text('failure_reason'),
    /** Human-readable detail for the failure. Null unless status is 'failed'. */
    failureDetails: text('failure_details'),
    /**
     * Current attempt number (1-based). Incremented on each rate-limit event.
     * Adapter-level retry state; pipeline never resets this to 0.
     */
    attempt: integer('attempt').notNull().default(1),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    /** All jobs for a user (primary listing query). */
    index('ingest_jobs_owner_idx').on(t.ownerId),
    /** Status-based queue lookups (e.g. all 'queued' jobs). */
    index('ingest_jobs_status_idx').on(t.status),
    /** Per-source job history. */
    index('ingest_jobs_source_idx').on(t.sourceId),
  ],
);
