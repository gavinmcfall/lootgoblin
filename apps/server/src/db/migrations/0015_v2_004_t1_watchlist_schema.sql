-- V2-004-T1: Watchlist pillar foundation.
-- Adds watchlist_subscriptions + watchlist_jobs, plus the optional
-- parent_subscription_id FK on the existing ingest_jobs table.
--
-- See apps/server/src/db/schema.watchlist.ts for the full design rationale,
-- including locked decisions WL-Q3 (separate jobs table), WL-Q4 (auth-revoked
-- cascade pauses ALL subs for the source), and WL-Q5 (atomic-on-completion
-- cursor advancement).
CREATE TABLE `watchlist_subscriptions` (
	`id` TEXT PRIMARY KEY,
	`owner_id` TEXT NOT NULL REFERENCES `user`(id) ON DELETE CASCADE,
	`kind` TEXT NOT NULL,
	`source_adapter_id` TEXT NOT NULL,
	`parameters` TEXT NOT NULL,
	`cadence_seconds` INTEGER NOT NULL DEFAULT 3600,
	`last_fired_at` INTEGER,
	`cursor_state` TEXT,
	`active` INTEGER NOT NULL DEFAULT 1,
	`error_streak` INTEGER NOT NULL DEFAULT 0,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `watchlist_subs_owner_active_idx` ON `watchlist_subscriptions`(`owner_id`, `active`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `watchlist_subs_active_source_idx` ON `watchlist_subscriptions`(`active`, `source_adapter_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `watchlist_subs_active_fired_idx` ON `watchlist_subscriptions`(`active`, `last_fired_at`);
--> statement-breakpoint
CREATE TABLE `watchlist_jobs` (
	`id` TEXT PRIMARY KEY,
	`subscription_id` TEXT NOT NULL REFERENCES `watchlist_subscriptions`(id) ON DELETE CASCADE,
	`status` TEXT NOT NULL DEFAULT 'queued',
	`claimed_at` INTEGER,
	`started_at` INTEGER,
	`completed_at` INTEGER,
	`items_discovered` INTEGER NOT NULL DEFAULT 0,
	`items_enqueued` INTEGER NOT NULL DEFAULT 0,
	`failure_reason` TEXT,
	`failure_details` TEXT,
	`created_at` INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `watchlist_jobs_status_idx` ON `watchlist_jobs`(`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `watchlist_jobs_sub_created_idx` ON `watchlist_jobs`(`subscription_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `watchlist_jobs_status_claimed_idx` ON `watchlist_jobs`(`status`, `claimed_at`);
--> statement-breakpoint
ALTER TABLE `ingest_jobs` ADD COLUMN `parent_subscription_id` TEXT REFERENCES `watchlist_subscriptions`(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ingest_jobs_parent_sub_idx` ON `ingest_jobs`(`parent_subscription_id`) WHERE `parent_subscription_id` IS NOT NULL;
