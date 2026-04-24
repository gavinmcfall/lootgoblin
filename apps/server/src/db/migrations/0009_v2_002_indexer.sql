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
-- NOTE: FTS5 is created in default (content-stored) mode, NOT contentless
-- (content=''). SQLite's contentless FTS5 mode discards UNINDEXED column
-- values — retrieving loot_id via `SELECT loot_id FROM loot_fts WHERE
-- loot_fts MATCH ?` would return NULL. Default mode is required for the
-- indexer's search() query pattern. Disk overhead is accepted as a
-- documented trade-off; see indexer.ts search() for the query shape.
CREATE VIRTUAL TABLE `loot_fts` USING fts5(
	loot_id UNINDEXED,
	title,
	creator,
	description,
	tags,
	formats,
	tokenize = 'porter unicode61'
);
