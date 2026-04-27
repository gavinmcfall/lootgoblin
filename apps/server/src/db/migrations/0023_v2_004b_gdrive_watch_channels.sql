-- V2-004b-T1: Google Drive `changes.watch` push-notification channels.
--
-- Tracks an active push channel registered with Google for a watchlist
-- subscription. Push complements polling — when a notification arrives at
-- /api/v1/watchlist/gdrive/notification, the worker enqueues a watchlist_job
-- bypassing cadence. If channel registration fails the subscription falls
-- back to cadence polling (identical to V2-004 behaviour).
--
-- See apps/server/src/db/schema.watchlist.ts for the full design rationale.
CREATE TABLE `gdrive_watch_channels` (
	`id` TEXT PRIMARY KEY,
	`subscription_id` TEXT NOT NULL REFERENCES `watchlist_subscriptions`(id) ON DELETE CASCADE,
	`channel_id` TEXT NOT NULL,
	`resource_id` TEXT NOT NULL,
	`resource_type` TEXT NOT NULL,
	`address` TEXT NOT NULL,
	`token` TEXT NOT NULL,
	`expiration_ms` INTEGER NOT NULL,
	`status` TEXT NOT NULL,
	`error_reason` TEXT,
	`refreshed_at` INTEGER,
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `gdrive_watch_channels_subscription_idx` ON `gdrive_watch_channels`(`subscription_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `gdrive_watch_channels_channel_id_uniq` ON `gdrive_watch_channels`(`channel_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `gdrive_watch_channels_expiration_idx` ON `gdrive_watch_channels`(`expiration_ms`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `gdrive_watch_channels_status_idx` ON `gdrive_watch_channels`(`status`);
