PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`packager` text NOT NULL,
	`credential_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`credential_id`) REFERENCES `source_credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_destinations`("id", "name", "type", "config", "packager", "credential_id", "created_at", "updated_at") SELECT "id", "name", "type", "config", "packager", "credential_id", "created_at", "updated_at" FROM `destinations`;--> statement-breakpoint
DROP TABLE `destinations`;--> statement-breakpoint
ALTER TABLE `__new_destinations` RENAME TO `destinations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_item_events` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`message` text,
	`meta` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_item_events`("id", "item_id", "kind", "message", "meta", "created_at") SELECT "id", "item_id", "kind", "message", "meta", "created_at" FROM `item_events`;--> statement-breakpoint
DROP TABLE `item_events`;--> statement-breakpoint
ALTER TABLE `__new_item_events` RENAME TO `item_events`;--> statement-breakpoint
CREATE TABLE `__new_items` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`source_item_id` text NOT NULL,
	`content_type` text NOT NULL,
	`source_url` text NOT NULL,
	`snapshot` text,
	`destination_id` text,
	`credential_id` text,
	`status` text NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`output_path` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_id`) REFERENCES `source_credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_items`("id", "source_id", "source_item_id", "content_type", "source_url", "snapshot", "destination_id", "credential_id", "status", "retry_count", "last_error", "output_path", "created_at", "updated_at", "completed_at") SELECT "id", "source_id", "source_item_id", "content_type", "source_url", "snapshot", "destination_id", "credential_id", "status", "retry_count", "last_error", "output_path", "created_at", "updated_at", "completed_at" FROM `items`;--> statement-breakpoint
DROP TABLE `items`;--> statement-breakpoint
ALTER TABLE `__new_items` RENAME TO `items`;--> statement-breakpoint
CREATE UNIQUE INDEX `items_done_unique` ON `items` (`source_id`,`source_item_id`) WHERE status = 'done';--> statement-breakpoint
CREATE INDEX `items_status_idx` ON `items` (`status`);