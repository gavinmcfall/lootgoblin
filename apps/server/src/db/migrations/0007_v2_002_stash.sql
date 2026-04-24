-- V2-002-T1: Stash pillar tables.
-- Adds: stash_roots, collections, loot, loot_files, loot_source_records,
--       loot_relationships, quarantine_items
-- All tables are new; no existing tables are altered.
CREATE TABLE `stash_roots` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`path_template` text NOT NULL,
	`stash_root_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stash_root_id`) REFERENCES `stash_roots`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `collections_owner_id_idx` ON `collections` (`owner_id`);
--> statement-breakpoint
CREATE INDEX `collections_stash_root_id_idx` ON `collections` (`stash_root_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_owner_name_uniq` ON `collections` (`owner_id`,`name`);
--> statement-breakpoint
CREATE TABLE `loot` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`tags` text DEFAULT (json('[]')) NOT NULL,
	`creator` text,
	`license` text,
	`source_item_id` text,
	`content_summary` text,
	`file_missing` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `loot_collection_id_idx` ON `loot` (`collection_id`);
--> statement-breakpoint
CREATE INDEX `loot_file_missing_idx` ON `loot` (`file_missing`);
--> statement-breakpoint
CREATE TABLE `loot_files` (
	`id` text PRIMARY KEY NOT NULL,
	`loot_id` text NOT NULL,
	`path` text NOT NULL,
	`format` text NOT NULL,
	`size` integer NOT NULL,
	`hash` text NOT NULL,
	`origin` text NOT NULL,
	`provenance` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `loot_files_loot_id_idx` ON `loot_files` (`loot_id`);
--> statement-breakpoint
CREATE INDEX `loot_files_hash_idx` ON `loot_files` (`hash`);
--> statement-breakpoint
CREATE TABLE `loot_source_records` (
	`id` text PRIMARY KEY NOT NULL,
	`loot_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text,
	`source_identifier` text,
	`captured_at` integer NOT NULL,
	FOREIGN KEY (`loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `loot_source_records_loot_id_idx` ON `loot_source_records` (`loot_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `loot_source_records_loot_type_id_uniq` ON `loot_source_records` (`loot_id`,`source_type`,`source_identifier`);
--> statement-breakpoint
CREATE TABLE `loot_relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_loot_id` text NOT NULL,
	`child_loot_id` text NOT NULL,
	`relationship` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`parent_loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`child_loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `quarantine_items` (
	`id` text PRIMARY KEY NOT NULL,
	`stash_root_id` text NOT NULL,
	`path` text NOT NULL,
	`reason` text NOT NULL,
	`details` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`stash_root_id`) REFERENCES `stash_roots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `quarantine_items_stash_root_id_idx` ON `quarantine_items` (`stash_root_id`);
--> statement-breakpoint
CREATE INDEX `quarantine_items_resolved_at_idx` ON `quarantine_items` (`resolved_at`);
