/**
 * Watchlist tables — V2-004-T1
 *
 * The Watchlist pillar lets a user subscribe to remote signals (a creator's
 * uploads, a tag feed, a saved-search query, a watched URL, a watched cloud
 * folder) and have them ingested automatically on a cadence — versus the
 * paste-driven, single-shot Scavenger flows that drive `ingest_jobs` directly.
 *
 * Two tables are introduced here:
 *
 *   watchlist_subscriptions — the user-declared subscription (kind, parameters,
 *                             cadence, cursor, active flag).
 *
 *   watchlist_jobs          — one row per scheduler firing (queued → claimed →
 *                             running → completed | failed). Sits *between*
 *                             a subscription and the children ingest_jobs that
 *                             its discovery phase enqueues.
 *
 * Plus one additive change to `ingest_jobs.parent_subscription_id`, declared
 * in `schema.ingest.ts`, that lets a child job point back at the originating
 * subscription for "items from subscription X" UI + failure-handling logic.
 *
 * Architectural decisions locked during V2-004 design:
 *
 *   WL-Q3 — separate `watchlist_jobs` table (NOT piggybacking on ingest_jobs).
 *           Watchlist firings have a different cadence + concurrency profile
 *           from user-paste ingests; the table needs to grow and scale
 *           independently.
 *
 *   WL-Q4 — auth-revoked cascade pauses ALL subscriptions for the affected
 *           source. Single-tenant credentials today (matches T9-D7);
 *           per-user-credential isolation is deferred to T9-CF-1.
 *
 *   WL-Q5 — atomic-on-completion cursor advancement. The watchlist_job knows
 *           the cursor; child ingest_jobs do not. The cursor advances when
 *           the job's discovery phase completes successfully.
 *
 *   WL-Q1 — adapter capability methods live in a separate `SubscribableAdapter`
 *           interface (T2 work).
 */

import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { user } from './schema.auth';
import { collections } from './schema.stash';

// ---------------------------------------------------------------------------
// watchlistSubscriptions
// ---------------------------------------------------------------------------

/**
 * A user-declared subscription to a remote signal.
 *
 * `parameters` is JSON-encoded and adapter-specific; the discriminated union
 * `WatchlistSubscriptionParameters` (in `src/watchlist/types.ts`) defines the
 * shape per `kind`.
 *
 * `cadence_seconds` is enforced application-side to a minimum of 60s — the
 * scheduler refuses lower values and surfaces a 400 to the API caller.
 *
 * `cursor_state` is opaque to the schema layer. Each adapter chooses its own
 * shape (e.g. `{lastSeenItemId: '...'}` for creator feeds, or `{lastFiredAt:
 * 12345}` for tag streams). T2's `SubscribableAdapter.discover()` returns a
 * new cursor on each successful firing; T3's worker writes it atomically with
 * the watchlist_job's terminal status update.
 */
export const watchlistSubscriptions = sqliteTable(
  'watchlist_subscriptions',
  {
    /** UUID. Generated app-side via `crypto.randomUUID()`. */
    id: text('id').primaryKey(),
    /**
     * FK → BetterAuth user.id. Cascade: deleting the user removes their
     * subscriptions and (transitively, via the FK on watchlist_jobs) any
     * jobs that originated from them.
     */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /**
     * Discriminator for the subscription kind. One of:
     *   'creator'      — track a creator's uploads
     *   'tag'          — track a tag/category feed
     *   'saved_search' — re-run a search query
     *   'url_watch'    — re-poll a single URL for changes
     *   'folder_watch' — track a cloud-storage folder (e.g. GDrive)
     */
    kind: text('kind').notNull(),
    /**
     * SourceId value (e.g. 'makerworld', 'sketchfab', 'google-drive') —
     * matches the SourceId used elsewhere in the codebase. Combined with
     * `kind` + `parameters`, this uniquely determines the adapter call.
     */
    sourceAdapterId: text('source_adapter_id').notNull(),
    /**
     * JSON-encoded, adapter-specific. See `WatchlistSubscriptionParameters`
     * in `src/watchlist/types.ts` for the discriminated union.
     */
    parameters: text('parameters').notNull(),
    /**
     * Polling cadence in seconds. Default 1 hour (3600).
     * Enforced minimum of 60s in the application layer (NOT the DB), to keep
     * migrations free of CHECK constraints that would block future tuning.
     */
    cadenceSeconds: integer('cadence_seconds').notNull().default(3600),
    /**
     * Last time the scheduler fired a job for this subscription, in ms epoch.
     * NULL means the subscription has never fired (e.g. just-created).
     * Used by the scheduler to compute "due" — see the
     * `(active, last_fired_at)` index below.
     */
    lastFiredAt: integer('last_fired_at', { mode: 'timestamp_ms' }),
    /**
     * Adapter-opaque JSON cursor advanced atomically when a watchlist_job's
     * discovery phase completes. NULL on first run.
     */
    cursorState: text('cursor_state'),
    /**
     * 0/1 boolean. 0 = paused (manual user action OR auth-revoked cascade
     * OR error-streak threshold). The auth-revoked cascade matches T9-D7's
     * single-tenant credential model: when a source's credentials are
     * revoked or expire, the worker walks `(active=1, source_adapter_id=X)`
     * via the index below and flips them all to 0.
     */
    active: integer('active').notNull().default(1),
    /**
     * Consecutive failure count. Reset to 0 on each successful firing.
     * T8 (failure handling) flips `active` to 0 when this crosses a
     * threshold; the threshold lives in the application layer so it can be
     * tuned without a migration.
     */
    errorStreak: integer('error_streak').notNull().default(0),
    /**
     * V2-004-T4: target collection for child ingest_jobs spawned by this
     * subscription's discovery phase. Nullable on purpose — T1 shipped before
     * this column existed; the application layer enforces non-NULL at
     * subscription-creation time (T9 HTTP API). The watchlist worker fails
     * the firing with a clear "subscription missing default_collection_id"
     * error if the column is NULL at run time.
     *
     * SET NULL on collection delete: deleting a collection must not orphan
     * the subscription history. The next firing fails fast and the user can
     * re-target via the UI.
     */
    defaultCollectionId: text('default_collection_id').references(
      () => collections.id,
      { onDelete: 'set null' },
    ),
    /** ms epoch of subscription creation. App-side default. */
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    /** ms epoch of the most recent UPDATE. App-side bumped on every write. */
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    /** "List a user's active subscriptions" — primary listing query. */
    index('watchlist_subs_owner_active_idx').on(t.ownerId, t.active),
    /**
     * Auth-revoked cascade — find all currently-active subscriptions for a
     * given source so they can be paused in bulk when the source's
     * credentials are invalidated. See WL-Q4 above.
     */
    index('watchlist_subs_active_source_idx').on(t.active, t.sourceAdapterId),
    /**
     * Scheduler "find due" query:
     *   WHERE active=1 AND last_fired_at + cadence_seconds*1000 <= now()
     * The compound (active, last_fired_at) lets the planner walk the index
     * directly instead of scanning the whole table on every tick.
     */
    index('watchlist_subs_active_fired_idx').on(t.active, t.lastFiredAt),
  ],
);

// ---------------------------------------------------------------------------
// watchlistJobs
// ---------------------------------------------------------------------------

/**
 * One row per scheduler firing.
 *
 * Status flow:
 *   queued → claimed → running → completed
 *                              ↘ failed
 *
 * The job atomically records discovery results (items_discovered,
 * items_enqueued) on transition to terminal status. Children (the per-item
 * `ingest_jobs` rows) reference back via `ingest_jobs.parent_subscription_id`
 * — NOT via this table. The parent_subscription_id lives at the subscription
 * level so a deletion of a single job row never orphans in-flight ingests.
 */
export const watchlistJobs = sqliteTable(
  'watchlist_jobs',
  {
    /** UUID. */
    id: text('id').primaryKey(),
    /** FK → watchlist_subscriptions.id. Cascade on subscription delete. */
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => watchlistSubscriptions.id, { onDelete: 'cascade' }),
    /**
     * Job status.
     *   'queued'    — created by scheduler tick; awaiting a worker.
     *   'claimed'   — atomically picked up by a worker (claimed_at set).
     *   'running'   — worker is executing the discovery phase.
     *   'completed' — discovery finished; cursor advanced; children enqueued.
     *   'failed'    — discovery error; failure_reason / failure_details set.
     *
     * No CHECK constraint at the DB level — values are validated by the
     * `WatchlistJobStatus` type at all entry points.
     */
    status: text('status').notNull().default('queued'),
    /** ms epoch when atomically claimed. Used for stale-recovery sweeps. */
    claimedAt: integer('claimed_at', { mode: 'timestamp_ms' }),
    /** ms epoch when worker began the discovery phase. */
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    /** ms epoch when the job reached a terminal state (completed/failed). */
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    /** Number of items the adapter reported during discovery. */
    itemsDiscovered: integer('items_discovered').notNull().default(0),
    /** Number of children ingest_jobs successfully enqueued. */
    itemsEnqueued: integer('items_enqueued').notNull().default(0),
    /** Machine-readable failure code. NULL unless status='failed'. */
    failureReason: text('failure_reason'),
    /** Human-readable failure detail. NULL unless status='failed'. */
    failureDetails: text('failure_details'),
    /** ms epoch when the scheduler enqueued this job. */
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    /** Worker queue lookup: WHERE status='queued' ORDER BY created_at ASC. */
    index('watchlist_jobs_status_idx').on(t.status),
    /** "List a subscription's recent firings" — UI history query. */
    index('watchlist_jobs_sub_created_idx').on(t.subscriptionId, t.createdAt),
    /**
     * Stale-recovery sweep: find jobs that have been claimed/running too
     * long. Worker queries `WHERE status='running' AND claimed_at < ?`.
     */
    index('watchlist_jobs_status_claimed_idx').on(t.status, t.claimedAt),
  ],
);
