-- V2-002-T11: Indexer tables.
-- Adds: loot_thumbnails (per-loot sidecar state), loot_fts (FTS5 virtual table)
-- All tables are new; no existing tables are altered.
CREATE TABLE `loot_thumbnails` (
	`loot_id` text PRIMARY KEY NOT NULL REFERENCES loot(id) ON DELETE CASCADE,
	`thumbnail_path` text,
	`status` text NOT NULL,
	`source_kind` text,
	`error` text,
	`generated_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `loot_thumbnails_status_idx` ON `loot_thumbnails` (`status`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `loot_fts` USING fts5(
	loot_id UNINDEXED,
	title,
	creator,
	description,
	tags,
	formats,
	tokenize = 'porter unicode61'
);
