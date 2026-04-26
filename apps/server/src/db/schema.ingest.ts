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

import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
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
    /**
     * Caller-supplied Idempotency-Key header value (V2-003-T9). Optional.
     *
     * When present, the POST /api/v1/ingest route enforces RFC 7240-style
     * idempotency: a second POST with the same `(owner_id, idempotency_key)`
     * either returns the existing jobId (on body match) or 409 (on body
     * mismatch). The partial unique index below enforces uniqueness only
     * for non-NULL values so legacy + non-idempotent jobs coexist.
     */
    idempotencyKey: text('idempotency_key'),
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
    /**
     * Compound index for the GET /api/v1/ingest list query — filters by
     * `owner_id` and orders by `created_at DESC`. The single-column owner
     * index above forces the planner to scan the owner-bucket and re-sort;
     * this lets it walk the index directly in the listing's natural order.
     */
    index('ingest_jobs_owner_created_idx').on(t.ownerId, t.createdAt),
    /**
     * Idempotency-Key uniqueness — partial index, only enforced where the
     * key is non-NULL. Lets jobs without an Idempotency-Key remain free of
     * uniqueness constraints.
     */
    uniqueIndex('ingest_jobs_owner_idem_uniq')
      .on(t.ownerId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);
