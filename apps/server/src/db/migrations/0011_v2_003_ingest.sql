-- V2-003-T2: Ingest jobs table.
-- Tracks every ingest pipeline run: source fetch → validation → dedup → place/quarantine.
CREATE TABLE `ingest_jobs` (
	`id` TEXT PRIMARY KEY,
	`owner_id` TEXT NOT NULL REFERENCES `user`(id) ON DELETE CASCADE,
	`source_id` TEXT NOT NULL,
	`target_kind` TEXT NOT NULL,
	`target_payload` TEXT NOT NULL,
	`collection_id` TEXT REFERENCES `collections`(id) ON DELETE SET NULL,
	`status` TEXT NOT NULL,
	`loot_id` TEXT REFERENCES `loot`(id) ON DELETE SET NULL,
	`quarantine_item_id` TEXT REFERENCES `quarantine_items`(id) ON DELETE SET NULL,
	`failure_reason` TEXT,
	`failure_details` TEXT,
	`attempt` INTEGER NOT NULL DEFAULT 1,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ingest_jobs_owner_idx` ON `ingest_jobs`(`owner_id`);
--> statement-breakpoint
CREATE INDEX `ingest_jobs_status_idx` ON `ingest_jobs`(`status`);
--> statement-breakpoint
CREATE INDEX `ingest_jobs_source_idx` ON `ingest_jobs`(`source_id`);
