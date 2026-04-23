CREATE TABLE `instance_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `config_provenance` (
	`key` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`resolved_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`source_detail` text
);
