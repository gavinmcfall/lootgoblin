-- V2-002-T8: Inbox Triage tables.
-- Adds: inbox_triage_rules, inbox_pending_items
-- All tables are new; no existing tables are altered.
CREATE TABLE `inbox_triage_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`filename_pattern` text NOT NULL,
	`min_confidence` real NOT NULL,
	`collection_id` text NOT NULL,
	`mode` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inbox_triage_rules_owner_idx` ON `inbox_triage_rules` (`owner_id`);
--> statement-breakpoint
CREATE INDEX `inbox_triage_rules_priority_idx` ON `inbox_triage_rules` (`priority`);
--> statement-breakpoint
CREATE TABLE `inbox_pending_items` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_path` text NOT NULL UNIQUE,
	`classification` text NOT NULL,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`reason` text NOT NULL,
	`detected_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inbox_pending_items_detected_idx` ON `inbox_pending_items` (`detected_at`);
